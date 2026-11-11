// Kanti+ im Browser (schulnetz.fasrv.ch): browser sessions on top of the Kanti+ server.
//
// The browser holds one opaque, HttpOnly session cookie. It never receives a Schulnetz cookie, a
// FaNotes token or an app identity token. A session lists the school connections it may read:
// connections the app shared through a pairing code, or the connection of the FaNotes account the
// browser signed in with. Every read goes through the same Schulnetz runtime the app uses, so the
// browser sees the app's snapshot, change feed, alert settings and hidden grades.
//
// Layout under <schulnetz root>/web/ (0700, files 0600):
//   sessions/<sha256(token)>.json   one browser session
//   pairings/<sha256(code)>.json    one pairing code, at most ten minutes old

import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { credentialOr } from './credentials.mjs'
import { CLASS_CODE, MAX_PDF_BYTES, ROOM_NAME } from './class-timetables.mjs'
import { accountAcceptsAuthKey, loadSyncAccountByEmail, syncAuthStamp, syncPreloginKdf } from './sync-api.mjs'
import { prepareGradeNotifications, unrevealedGradeIds, webGradeView } from './schulnetz-logic.mjs'

export const KANTI_WEB_PREFIX = '/api/v1/kanti-web'
export const SESSION_COOKIE = '__Host-kanti'
export const PAIR_COOKIE = '__Host-kanti-pair'
const DAY_MS = 24 * 60 * 60 * 1000
export const SESSION_IDLE_MS = 30 * DAY_MS
export const SESSION_MAX_MS = 90 * DAY_MS
const SESSION_TOUCH_MS = 6 * 60 * 60 * 1000
export const PAIR_TTL_MS = 10 * 60 * 1000
export const MAX_WEB_CONNECTIONS = 6
const MAX_BODY = 16 * 1024
const ADMIN_FAIL_LIMIT = 10
const ADMIN_FAIL_WINDOW_MS = 60 * 60 * 1000
const MAX_SESSIONS = 5000
const SWEEP_MS = 15 * 60 * 1000
const LIMIT_WINDOW_MS = 15 * 60 * 1000
export const PAIRING_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u
const HASH_PATTERN = /^[a-f0-9]{64}$/u
const CONNECTION_ID = /^[a-f0-9]{12}$/u
const EMPTY_SNAPSHOT = Object.freeze({ revision: 0, grades: [], events: [], exams: [], absences: [], homework: [], messages: [], vacations: [], konto: [], startMessages: [] })

const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex')
const webError = (status, message) => {
  const error = new Error('kanti-web')
  error.status = status
  error.publicMessage = message
  return error
}
const fail = (status, message) => { throw webError(status, message) }
const sameText = (left, right) => {
  const a = Buffer.from(String(left ?? ''))
  const b = Buffer.from(String(right ?? ''))
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b)
}

/** "ab12-cd34", "AB12 CD34" and "AB12CD34" are one code. O reads as 0, I and L as 1 (Crockford). */
export const normalizePairingCode = (raw) => {
  const cleaned = String(raw ?? '').toUpperCase().replace(/[\s-]/gu, '').replace(/O/gu, '0').replace(/[IL]/gu, '1')
  if (cleaned.length !== 8) return ''
  for (const char of cleaned) if (!PAIRING_ALPHABET.includes(char)) return ''
  return cleaned
}
export const formatPairingCode = (code) => `${code.slice(0, 4)}-${code.slice(4)}`
const newPairingCode = () => Array.from({ length: 8 }, () => PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)]).join('')

/** A coarse description the app shows before the user approves: browser family and system only. */
export const browserLabel = (userAgent) => {
  const ua = String(userAgent || '').slice(0, 512)
  const browser = /Edg(e|A|iOS)?\//u.test(ua) ? 'Edge'
    : /OPR\/|Opera/u.test(ua) ? 'Opera'
      : /Firefox\/|FxiOS\//u.test(ua) ? 'Firefox'
        : /Chrome\/|CriOS\//u.test(ua) ? 'Chrome'
          : /Safari\//u.test(ua) ? 'Safari' : 'Browser'
  const system = /Windows/u.test(ua) ? 'Windows'
    : /iPhone|iPad|iPod/u.test(ua) ? 'iOS'
      : /Android/u.test(ua) ? 'Android'
        : /CrOS/u.test(ua) ? 'ChromeOS'
          : /Macintosh|Mac OS X/u.test(ua) ? 'macOS'
            : /Linux/u.test(ua) ? 'Linux' : ''
  return system ? `${browser} · ${system}` : browser
}

const cleanLabel = (raw, fallback) => {
  const text = String(raw ?? '').replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 40)
  return text || fallback
}

export const parseCookies = (header) => {
  const out = {}
  for (const part of String(header || '').split(';')) {
    const cut = part.indexOf('=')
    if (cut <= 0) continue
    const name = part.slice(0, cut).trim()
    if (!(name in out)) out[name] = part.slice(cut + 1).trim()
  }
  return out
}

/** Sessions and pairing codes on disk. One process owns the directory; writes are serialised per key. */
export const createKantiWebStore = (options = {}) => {
  const root = resolve(options.root || process.env.FANOTES_SCHULNETZ_DIR || '/var/lib/fanotes-schulnetz', 'web')
  const now = options.now || (() => new Date())
  const sessionsDir = resolve(root, 'sessions')
  const pairingsDir = resolve(root, 'pairings')
  const tails = new Map()
  const locked = (key, task) => {
    const previous = tails.get(key) || Promise.resolve()
    const run = previous.then(task, task)
    const tail = run.then(() => undefined, () => undefined)
    tails.set(key, tail)
    tail.then(() => { if (tails.get(key) === tail) tails.delete(key) })
    return run
  }

  const readJson = async (file) => {
    try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch { return null }
  }
  const writeJson = async (file, value, flag) => {
    await fs.mkdir(resolve(file, '..'), { recursive: true, mode: 0o700 })
    if (flag === 'wx') {
      await fs.writeFile(file, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
      return
    }
    const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`
    await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600 })
    await fs.rename(temporary, file)
  }
  const sessionPath = (hash) => {
    if (!HASH_PATTERN.test(hash)) fail(400, 'Ungültige Sitzung.')
    return resolve(sessionsDir, `${hash}.json`)
  }
  const pairingPath = (hash) => {
    if (!HASH_PATTERN.test(hash)) fail(400, 'Ungültiger Code.')
    return resolve(pairingsDir, `${hash}.json`)
  }
  const nowMs = () => now().getTime()
  const alive = (session) => Boolean(session && session.v === 1 && Date.parse(session.expiresAt) > nowMs() && Date.parse(session.maxUntil) > nowMs())

  // Which sessions read which identity, so the app's status call does not scan the directory.
  let index = null
  const indexEntry = (session) => ({
    publicId: session.publicId,
    accountIds: [...new Set((session.connections || []).map((connection) => connection.accountId))],
    expiresAt: session.expiresAt,
    maxUntil: session.maxUntil,
  })
  const loadIndex = async () => {
    if (index) return index
    const built = new Map()
    const names = await fs.readdir(sessionsDir).catch(() => [])
    for (const name of names.filter((item) => /^[a-f0-9]{64}\.json$/u.test(item)).slice(0, MAX_SESSIONS)) {
      const session = await readJson(resolve(sessionsDir, name))
      if (alive(session)) built.set(name.slice(0, 64), indexEntry(session))
    }
    index ??= built
    return index
  }

  const readSession = async (hash) => {
    const session = await readJson(sessionPath(hash))
    return alive(session) ? session : null
  }
  const saveSession = async (hash, session) => {
    await writeJson(sessionPath(hash), session)
    ;(await loadIndex()).set(hash, indexEntry(session))
  }
  const deleteSession = async (hash) => {
    await fs.rm(sessionPath(hash), { force: true })
    ;(await loadIndex()).delete(hash)
  }

  /** Read, change and write one session under its lock. The mutator returns the session, 'delete' or null (no change). */
  const updateSession = (hash, mutator) => locked(`session:${hash}`, async () => {
    const session = await readSession(hash)
    if (!session) {
      await deleteSession(hash)
      return null
    }
    const result = await mutator(session)
    if (result === 'delete') {
      await deleteSession(hash)
      return null
    }
    if (result) await saveSession(hash, result)
    return result || session
  })

  const sessionFromToken = async (token) => {
    if (!TOKEN_PATTERN.test(String(token || ''))) return null
    const hash = sha256(token)
    const session = await readSession(hash)
    if (!session) {
      await fs.rm(sessionPath(hash), { force: true }).catch(() => undefined)
      return null
    }
    return { hash, session }
  }

  const createSession = async (browser, connections, fanotes = null) => {
    const token = randomBytes(32).toString('base64url')
    const hash = sha256(token)
    const at = now()
    const session = {
      v: 1,
      publicId: randomBytes(8).toString('hex'),
      createdAt: at.toISOString(),
      lastSeenAt: at.toISOString(),
      expiresAt: new Date(at.getTime() + SESSION_IDLE_MS).toISOString(),
      maxUntil: new Date(at.getTime() + SESSION_MAX_MS).toISOString(),
      csrf: randomBytes(24).toString('base64url'),
      browser,
      fanotes,
      connections,
    }
    await saveSession(hash, session)
    return { token, hash, session }
  }

  const newConnection = (fields) => ({ id: randomBytes(6).toString('hex'), addedAt: now().toISOString(), ...fields })

  /** Adds connections an identity not yet in the session brings; keeps at most six. */
  const mergeConnections = (session, incoming) => {
    const connections = [...(session.connections || [])]
    for (const item of incoming) {
      if (connections.some((connection) => connection.accountId === item.accountId)) continue
      if (connections.length >= MAX_WEB_CONNECTIONS) break
      connections.push(newConnection(item))
    }
    return connections
  }

  // ── Pairing codes ─────────────────────────────────────────────────────────

  const readPairing = async (rawCode) => {
    const code = normalizePairingCode(rawCode)
    if (!code) return null
    const file = pairingPath(sha256(`code:${code}`))
    const record = await readJson(file)
    if (!record || record.v !== 1) return null
    if (Date.parse(record.expiresAt) <= nowMs()) {
      await fs.rm(file, { force: true })
      return null
    }
    return { code, file, record }
  }

  const createPairing = async (browser) => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = newPairingCode()
      const secret = randomBytes(32).toString('base64url')
      const expiresAt = new Date(nowMs() + PAIR_TTL_MS).toISOString()
      const record = { v: 1, secretHash: sha256(secret), browser, createdAt: now().toISOString(), expiresAt, connections: [], finished: false }
      try {
        await writeJson(pairingPath(sha256(`code:${code}`)), record, 'wx')
        return { code, cookie: `${code}.${secret}`, expiresAt }
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
      }
    }
    fail(503, 'Bitte gleich nochmals versuchen.')
  }

  /** The pairing this browser started: the cookie holds the code and a secret only that browser has. */
  const pairingFromCookie = async (cookie) => {
    const [code, secret] = String(cookie || '').split('.')
    if (!code || !secret || !TOKEN_PATTERN.test(secret)) return null
    const found = await readPairing(code)
    if (!found || !sameText(found.record.secretHash, sha256(secret))) return null
    return found
  }

  const deletePairing = async (found) => { if (found?.file) await fs.rm(found.file, { force: true }) }

  /** App side: the browser description for a code, before the user approves. */
  const lookupPairing = async (rawCode) => {
    const found = await readPairing(rawCode)
    if (!found || found.record.finished || found.record.offer === true) return null
    return { browser: found.record.browser, expiresAt: found.record.expiresAt, added: found.record.connections.length }
  }

  /** App side: one identity joins the pairing; `finish` approves it for the browser. */
  const joinPairing = async (rawCode, entry, finish) => {
    const code = normalizePairingCode(rawCode)
    if (!code) return { missing: true }
    return locked(`pair:${code}`, async () => {
      const found = await readPairing(code)
      if (!found) return { missing: true }
      const { record, file } = found
      if (record.finished) return { finished: true }
      if (!record.connections.some((connection) => connection.accountId === entry.accountId)) {
        if (record.connections.length >= MAX_WEB_CONNECTIONS) return { full: true }
        record.connections.push(entry)
      }
      if (finish) record.finished = true
      await writeJson(file, record)
      return { record }
    })
  }

  /**
   * App side, the other direction: the app shows a code and the user types it into the browser. The
   * offer has no browser secret; the app adds its connections with joinPairing and finishes it, and
   * the browser claims it with the code alone (single use, 10 minutes, failed claims rate-limited).
   */
  const createOffer = async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = newPairingCode()
      const expiresAt = new Date(nowMs() + PAIR_TTL_MS).toISOString()
      const record = { v: 1, offer: true, secretHash: '', browser: '', createdAt: now().toISOString(), expiresAt, connections: [], finished: false }
      try {
        await writeJson(pairingPath(sha256(`code:${code}`)), record, 'wx')
        return { code, expiresAt }
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
      }
    }
    fail(503, 'Bitte gleich nochmals versuchen.')
  }

  /** Browser side: the code an app showed. Only a finished offer is claimed; anything else is unknown. */
  const claimOffer = async (rawCode, browser, current) => {
    const code = normalizePairingCode(rawCode)
    if (!code) return null
    return locked(`pair:${code}`, async () => {
      const fresh = await readPairing(code)
      if (!fresh || fresh.record.offer !== true) return null
      if (!fresh.record.finished) return { waiting: true }
      await deletePairing(fresh)
      const incoming = fresh.record.connections.map((connection) => ({ ...connection, source: 'pair' }))
      if (!incoming.length) return null
      if (current) {
        const updated = await updateSession(current.hash, (session) => ({ ...session, connections: mergeConnections(session, incoming) }))
        if (updated) return { hash: current.hash, session: updated, token: null, added: incoming.length }
      }
      const created = await createSession(browser, mergeConnections({ connections: [] }, incoming))
      return { ...created, added: incoming.length }
    })
  }

  /** Browser side: an approved pairing becomes (or extends) this browser's session. Single use. */
  const claimPairing = async (found, current) => locked(`pair:${found.code}`, async () => {
    const fresh = await readPairing(found.code)
    if (!fresh || !fresh.record.finished || !sameText(fresh.record.secretHash, found.record.secretHash)) return null
    await deletePairing(fresh)
    const incoming = fresh.record.connections.map((connection) => ({ ...connection, source: 'pair' }))
    if (!incoming.length) return null
    if (current) {
      const updated = await updateSession(current.hash, (session) => ({ ...session, connections: mergeConnections(session, incoming) }))
      if (updated) return { hash: current.hash, session: updated, token: null, added: incoming.length }
    }
    const created = await createSession(fresh.record.browser, mergeConnections({ connections: [] }, incoming))
    return { ...created, added: incoming.length }
  })

  // ── Per identity (the app's view) ───────────────────────────────────────

  const sessionsReading = async (accountId) => {
    const out = []
    for (const [hash, entry] of await loadIndex()) {
      if (!entry.accountIds.includes(accountId)) continue
      if (Date.parse(entry.expiresAt) <= nowMs() || Date.parse(entry.maxUntil) <= nowMs()) continue
      out.push(hash)
    }
    return out
  }

  const sessionsFor = async (accountId) => {
    const out = []
    for (const hash of await sessionsReading(accountId)) {
      const session = await readSession(hash)
      if (!session) continue
      out.push({ id: session.publicId, browser: session.browser, createdAt: session.createdAt, lastSeenAt: session.lastSeenAt })
    }
    return out.sort((left, right) => String(right.lastSeenAt).localeCompare(String(left.lastSeenAt)))
  }

  const countFor = async (accountId) => (await sessionsReading(accountId)).length

  /** The app takes its identity back from one browser. The session ends when nothing is left in it. */
  const revoke = async (accountId, publicId) => {
    for (const hash of await sessionsReading(accountId)) {
      if ((await loadIndex()).get(hash)?.publicId !== publicId) continue
      let removed = false
      await updateSession(hash, (session) => {
        const connections = (session.connections || []).filter((connection) => connection.accountId !== accountId)
        removed = connections.length !== (session.connections || []).length
        if (!connections.length) return 'delete'
        const fanotes = session.fanotes?.accountId === accountId ? null : session.fanotes
        return { ...session, connections, fanotes }
      })
      return removed
    }
    return false
  }

  /** An identity or FaNotes account was deleted: every browser session loses it at once. */
  const forgetAccount = async (accountId) => {
    for (const hash of await sessionsReading(accountId)) {
      await updateSession(hash, (session) => {
        const connections = (session.connections || []).filter((connection) => connection.accountId !== accountId)
        if (!connections.length) return 'delete'
        return { ...session, connections, fanotes: session.fanotes?.accountId === accountId ? null : session.fanotes }
      })
    }
  }

  let lastSweep = 0
  /** Drops expired sessions and pairing codes. Cheap enough to run every quarter hour on a request. */
  const sweep = async (force = false) => {
    if (!force && nowMs() - lastSweep < SWEEP_MS) return
    lastSweep = nowMs()
    for (const name of await fs.readdir(pairingsDir).catch(() => [])) {
      if (!/^[a-f0-9]{64}\.json$/u.test(name)) continue
      const record = await readJson(resolve(pairingsDir, name))
      if (!record || Date.parse(record.expiresAt) <= nowMs()) await fs.rm(resolve(pairingsDir, name), { force: true })
    }
    for (const name of await fs.readdir(sessionsDir).catch(() => [])) {
      if (!/^[a-f0-9]{64}\.json$/u.test(name)) continue
      const hash = name.slice(0, 64)
      const session = await readJson(resolve(sessionsDir, name))
      if (!alive(session)) await locked(`session:${hash}`, () => deleteSession(hash))
    }
  }

  return {
    root,
    sessionFromToken,
    createSession,
    updateSession,
    deleteSession,
    mergeConnections,
    newConnection,
    createPairing,
    pairingFromCookie,
    deletePairing,
    claimPairing,
    createOffer,
    claimOffer,
    lookupPairing,
    joinPairing,
    sessionsFor,
    countFor,
    revoke,
    forgetAccount,
    sweep,
  }
}

/**
 * The app-facing half (mounted inside /api/v1/schulnetz, where the app identity is already checked).
 * Failed code lookups are limited per address so codes cannot be walked.
 */
export const createKantiWebAppRoutes = (store, options = {}) => {
  const misses = new Map()
  const now = options.now || (() => new Date())
  const noteMiss = (address) => {
    const key = String(address || 'unknown').slice(0, 80)
    const at = now().getTime()
    const recent = (misses.get(key) || []).filter((stamp) => at - stamp < LIMIT_WINDOW_MS)
    recent.push(at)
    misses.set(key, recent)
    if (misses.size > 10_000) misses.clear()
  }
  const assertNotWalking = (address) => {
    const key = String(address || 'unknown').slice(0, 80)
    const at = now().getTime()
    const recent = (misses.get(key) || []).filter((stamp) => at - stamp < LIMIT_WINDOW_MS)
    if (recent.length >= 20) fail(429, 'Zu viele falsche Codes. Bitte später erneut versuchen.')
  }
  const unknownCode = () => fail(404, 'Dieser Code ist unbekannt oder abgelaufen.')

  return {
    /** The app shows this code; the user types it into the browser (POST /pair/claim). */
    createOffer: async () => store.createOffer(),
    lookupPairing: async (accountId, rawCode, address) => {
      assertNotWalking(address)
      const found = await store.lookupPairing(rawCode)
      if (!found) {
        noteMiss(address)
        unknownCode()
      }
      return found
    },
    joinPairing: async (accountId, body, address, link = {}) => {
      assertNotWalking(address)
      const provider = link.provider === 'tam' ? 'tam' : 'schulnetz'
      const entry = {
        accountId,
        provider,
        label: cleanLabel(body?.label, provider === 'tam' ? 'TAM' : 'Schulnetz'),
        baseUrl: String(link.baseUrl || '').slice(0, 200),
      }
      const result = await store.joinPairing(body?.code, entry, body?.finish === true)
      if (result.missing) {
        noteMiss(address)
        unknownCode()
      }
      if (result.finished) fail(409, 'Diese Kopplung ist schon abgeschlossen.')
      if (result.full) fail(400, 'Ein Browser kann höchstens sechs Verbindungen zeigen.')
      return { ok: true, browser: result.record.browser, added: result.record.connections.length, finished: result.record.finished }
    },
    sessionsFor: (accountId) => store.sessionsFor(accountId),
    countFor: (accountId) => store.countFor(accountId),
    revoke: (accountId, publicId) => store.revoke(accountId, publicId),
    forgetAccount: (accountId) => store.forgetAccount(accountId),
  }
}

/** The browser-facing API: /api/v1/kanti-web/... on the web host only. */
export const createKantiWebApi = (options = {}) => {
  const { store, access } = options
  const now = options.now || (() => new Date())
  const hosts = (options.hosts || String(process.env.KANTI_WEB_HOSTS || 'schulnetz.fasrv.ch').split(','))
    .map((host) => host.trim().toLowerCase()).filter(Boolean)
  const origins = options.origins || hosts.map((host) => `https://${host}`)
  const log = options.log || ((level, message) => console.log(`${now().toISOString()} kanti-web ${level} ${message}`))
  const authStamp = options.syncAuthStamp || syncAuthStamp
  const findAccount = options.loadSyncAccountByEmail || loadSyncAccountByEmail
  const acceptsKey = options.accountAcceptsAuthKey || accountAcceptsAuthKey
  const preloginKdf = options.syncPreloginKdf || syncPreloginKdf
  const readVersion = options.readVersion || (async () => null)
  // The operator's timetable upload: the server holds only the SHA-256 (hex) of the admin token.
  const timetables = options.timetables || null
  const adminTokenFile = options.adminTokenFile || credentialOr('kanti-admin-token', '/etc/fanotes/kanti-admin-token.sha256')
  const readAdminHash = options.readAdminHash || (async () => {
    try {
      const text = (await readFile(adminTokenFile, 'utf8')).trim().toLowerCase()
      return HASH_PATTERN.test(text) ? text : null
    } catch {
      return null
    }
  })
  const adminFailures = new Map()

  const windows = new Map()
  // Failed code claims per address: a code is 40 random bits, valid 10 minutes; 20 misses per window.
  const claimMisses = new Map()
  const recentClaimMisses = (address) => {
    const key = String(address || 'unknown').slice(0, 80)
    const at = now().getTime()
    const recent = (claimMisses.get(key) || []).filter((stamp) => at - stamp < LIMIT_WINDOW_MS)
    claimMisses.set(key, recent)
    if (claimMisses.size > 10_000) claimMisses.clear()
    return recent
  }
  const noteClaimMiss = (address) => { recentClaimMisses(address).push(now().getTime()) }
  const assertClaimNotWalking = (address) => {
    if (recentClaimMisses(address).length >= 20) fail(429, 'Zu viele falsche Codes. Bitte später erneut versuchen.')
  }

  const rate = (key, maximum, windowMs = LIMIT_WINDOW_MS) => {
    const at = now().getTime()
    if (windows.size > 50_000) for (const [name, window] of windows) if (window.until <= at) windows.delete(name)
    const current = windows.get(key)
    if (!current || current.until <= at) {
      windows.set(key, { count: 1, until: at + windowMs })
      return
    }
    if (current.count >= maximum) fail(429, 'Zu viele Anfragen. Bitte später erneut versuchen.')
    current.count += 1
  }

  const requestHost = (request) => String(request.headers['x-forwarded-host'] || request.headers.host || '')
    .split(',')[0].trim().toLowerCase().replace(/:\d+$/u, '')
  const clientAddress = (request) => {
    const forwarded = request.headers['x-real-ip']
    return typeof forwarded === 'string' && forwarded.length <= 64 ? forwarded : request.socket?.remoteAddress || 'unknown'
  }

  const cookie = (name, value, maxAgeSeconds) => `${name}=${value}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Strict`
  const clearCookie = (name) => `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`
  // The cookie lives as long as the session may; the server ends it earlier after 30 idle days.
  const sessionCookie = (token, session) => cookie(SESSION_COOKIE, token, Math.max(60, Math.floor((Date.parse(session.maxUntil) - now().getTime()) / 1000)))

  const send = (response, status, value, cookies = []) => {
    const payload = JSON.stringify(value)
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    }
    if (cookies.length) headers['Set-Cookie'] = cookies
    response.writeHead(status, headers)
    response.end(payload)
  }

  const readBody = async (request) => {
    const chunks = []
    let size = 0
    for await (const chunk of request) {
      size += chunk.length
      if (size > MAX_BODY) fail(413, 'Die Anfrage ist zu gross.')
      chunks.push(chunk)
    }
    if (!chunks.length) return {}
    try {
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    } catch {
      fail(400, 'Ungültiges JSON.')
    }
  }


  const readRaw = async (request, limit) => {
    if (Number(request.headers['content-length']) > limit) fail(413, 'Die Datei ist zu gross (höchstens 25 MB).')
    const chunks = []
    let size = 0
    for await (const chunk of request) {
      size += chunk.length
      if (size > limit) fail(413, 'Die Datei ist zu gross (höchstens 25 MB).')
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  }

  /** Admin-only: Bearer token whose SHA-256 matches the configured hash; 10 misses per address and hour. */
  const assertAdmin = async (request, address) => {
    const configured = String((await readAdminHash()) || '').trim().toLowerCase()
    const expected = HASH_PATTERN.test(configured) ? configured : ''
    if (!timetables || !expected) fail(503, 'Der Admin-Zugang ist auf diesem Server nicht eingerichtet.')
    const at = now().getTime()
    const key = String(address || 'unknown').slice(0, 80)
    const recent = (adminFailures.get(key) || []).filter((stamp) => at - stamp < ADMIN_FAIL_WINDOW_MS)
    adminFailures.set(key, recent)
    if (adminFailures.size > 10_000) adminFailures.clear()
    if (recent.length >= ADMIN_FAIL_LIMIT) fail(429, 'Zu viele falsche Versuche. Bitte später erneut versuchen.')
    const header = String(request.headers.authorization || '')
    const token = /^Bearer\s+(\S{1,512})$/iu.exec(header)?.[1] || ''
    const given = Buffer.from(sha256(token), 'hex')
    const wanted = Buffer.from(expected, 'hex')
    if (!token || given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
      recent.push(at)
      fail(401, 'Das Admin-Token stimmt nicht.')
    }
  }

  const adminTimetable = async (request, response, method, address) => {
    if (method === 'POST') {
      const origin = String(request.headers.origin || '')
      if (!origins.includes(origin)) fail(403, 'Diese Anfrage ist nicht erlaubt.')
      const site = request.headers['sec-fetch-site']
      if (site && site !== 'same-origin') fail(403, 'Diese Anfrage ist nicht erlaubt.')
      if (String(request.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/pdf') fail(415, 'Bitte eine PDF-Datei senden.')
    } else if (method !== 'GET') fail(405, 'Diese Methode ist hier nicht erlaubt.')
    await assertAdmin(request, address)
    if (method === 'GET') {
      const index = await timetables.readIndex()
      send(response, 200, index
        ? { available: true, uploadedAt: index.uploadedAt, semester: index.semester || '', classes: index.classes, rooms: index.rooms.length, warnings: (index.warnings || []).slice(0, 20), warningCount: (index.warnings || []).length }
        : { available: false })
      return
    }
    const result = await timetables.ingest(await readRaw(request, MAX_PDF_BYTES + 1024))
    send(response, 200, { ...result, warningCount: result.warnings.length, warnings: result.warnings.slice(0, 20) })
  }

  /** Other classes' and rooms' timetables, per connection; only for Alte Kanti (/aksa) links. */
  const timetableRoute = async (response, session, id, kind, rawName) => {
    const connection = connectionOf(session, id)
    const status = await access.readStatus(connection.accountId)
    const store = status.linked ? await access.timetablesFor(connection.accountId) : null
    if (!store) fail(404, 'Diesen Endpunkt gibt es nicht.')
    if (!kind) {
      send(response, 200, await store.summary())
      return
    }
    let name = ''
    try { name = decodeURIComponent(rawName) } catch { fail(404, 'Diesen Stundenplan gibt es nicht.') }
    if (kind === 'class') {
      const code = name.endsWith('.png') ? name.slice(0, -4) : ''
      const png = CLASS_CODE.test(code) ? await store.classPng(code) : null
      if (!png) fail(404, 'Diesen Stundenplan gibt es nicht.')
      response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' })
      response.end(png)
      return
    }
    const found = ROOM_NAME.test(name) ? await store.room(name) : null
    if (!found) fail(404, 'Diesen Raum gibt es nicht.')
    send(response, 200, found)
  }

  /** Every request that changes something: our own origin, a JSON body, no cross-site fetch. */
  const assertSameOrigin = (request) => {
    const origin = String(request.headers.origin || '')
    if (!origins.includes(origin)) fail(403, 'Diese Anfrage ist nicht erlaubt.')
    const site = request.headers['sec-fetch-site']
    if (site && site !== 'same-origin') fail(403, 'Diese Anfrage ist nicht erlaubt.')
    const type = String(request.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
    if (type !== 'application/json') fail(415, 'Bitte JSON senden.')
  }
  const assertCsrf = (request, session) => {
    if (!sameText(request.headers['x-kanti-csrf'], session.csrf)) fail(403, 'Die Sitzung ist abgelaufen. Bitte die Seite neu laden.')
  }

  /**
   * The session behind the cookie, checked against what it borrows: a FaNotes sign-in ends when the
   * password changes or the account goes; a shared connection ends when its app identity goes.
   */
  const authorize = async (request) => {
    const found = await store.sessionFromToken(parseCookies(request.headers.cookie)[SESSION_COOKIE])
    if (!found) fail(401, 'Bitte erneut anmelden.')
    const stamp = found.session.fanotes ? await authStamp(found.session.fanotes.accountId) : ''
    const owners = new Map()
    for (const connection of found.session.connections || []) {
      if (connection.source !== 'fanotes') owners.set(connection.accountId, await access.ownerExists(connection.accountId))
    }
    const session = await store.updateSession(found.hash, (current) => {
      let changed = false
      let { fanotes } = current
      let connections = current.connections || []
      if (fanotes && (!stamp || !sameText(stamp, fanotes.stamp))) {
        connections = connections.filter((connection) => connection.source !== 'fanotes')
        fanotes = null
        changed = true
      }
      const kept = connections.filter((connection) => connection.source === 'fanotes' || owners.get(connection.accountId) !== false)
      if (kept.length !== connections.length) changed = true
      if (!kept.length) return 'delete'
      const at = now().getTime()
      let { lastSeenAt, expiresAt } = current
      if (at - Date.parse(lastSeenAt) >= SESSION_TOUCH_MS) {
        lastSeenAt = new Date(at).toISOString()
        expiresAt = new Date(Math.min(at + SESSION_IDLE_MS, Date.parse(current.maxUntil))).toISOString()
        changed = true
      }
      return changed ? { ...current, fanotes, connections: kept, lastSeenAt, expiresAt } : null
    })
    if (!session) fail(401, 'Bitte erneut anmelden.')
    return { hash: found.hash, session }
  }

  const optionalSession = async (request) => {
    try { return await authorize(request) } catch { return null }
  }

  const connectionOf = (session, id) => {
    if (!CONNECTION_ID.test(String(id || ''))) fail(404, 'Diese Verbindung gibt es in diesem Browser nicht.')
    const connection = (session.connections || []).find((item) => item.id === id)
    if (!connection) fail(404, 'Diese Verbindung gibt es in diesem Browser nicht.')
    return connection
  }

  const connectionView = async (connection) => {
    const status = await access.readStatus(connection.accountId)
    return {
      id: connection.id,
      provider: status.linked ? status.provider || connection.provider : connection.provider,
      label: connection.label,
      source: connection.source,
      linked: status.linked === true,
      baseUrl: status.baseUrl || connection.baseUrl || '',
      needsReauth: status.needsReauth === true,
      lastPollAt: status.lastPollAt || '',
      lastError: status.lastError || '',
      mode: status.linked ? status.mode : '',
    }
  }

  const sessionView = async (session) => ({
    csrf: session.csrf,
    browser: session.browser,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    account: session.fanotes ? 'fanotes' : null,
    connections: await Promise.all((session.connections || []).map(connectionView)),
  })

  const statusView = (status) => ({
    linked: status.linked === true,
    provider: status.provider || 'schulnetz',
    baseUrl: status.baseUrl || '',
    needsReauth: status.needsReauth === true,
    lastPollAt: status.lastPollAt || '',
    lastError: status.lastError || '',
    revision: status.revision || 0,
    settings: status.settings || {},
    settingsUpdatedAt: status.settingsUpdatedAt || '',
    mode: status.mode || '',
  })

  const revealView = async (accountId) => {
    const [status, ledger] = await Promise.all([access.readStatus(accountId), access.readReveals(accountId)])
    const guessGrades = status.settings?.guessGrades === true
    return { guessGrades, hidden: guessGrades ? unrevealedGradeIds(ledger) : [] }
  }

  const changeView = (change) => ({
    id: String(change.id || ''),
    revision: Number(change.revision) || 0,
    category: String(change.category || ''),
    title: String(change.title || ''),
    body: String(change.body || ''),
    at: String(change.at || change.serverAt || ''),
    target: String(change.target || ''),
    targetId: String(change.targetId || ''),
    courseId: String(change.courseId || ''),
  })

  const connectionRoute = async (request, response, url, session, hash, id, tail, method) => {
    const connection = connectionOf(session, id)
    const accountId = connection.accountId
    if (tail === '' && method === 'PATCH') {
      assertSameOrigin(request)
      assertCsrf(request, session)
      const body = await readBody(request)
      const updated = await store.updateSession(hash, (current) => ({
        ...current,
        connections: current.connections.map((item) => (item.id === id ? { ...item, label: cleanLabel(body.label, item.label) } : item)),
      }))
      const renamed = updated?.connections.find((item) => item.id === id)
      send(response, 200, renamed ? await connectionView(renamed) : { removed: true })
      return
    }
    if (tail === '' && method === 'DELETE') {
      assertSameOrigin(request)
      assertCsrf(request, session)
      const updated = await store.updateSession(hash, (current) => {
        const connections = current.connections.filter((item) => item.id !== id)
        if (!connections.length) return 'delete'
        return { ...current, connections, fanotes: connection.source === 'fanotes' ? null : current.fanotes }
      })
      send(response, 200, { removed: true, signedOut: !updated }, updated ? [] : [clearCookie(SESSION_COOKIE)])
      return
    }
    if (tail === '/snapshot' && method === 'GET') {
      const [snapshot, reveals] = await Promise.all([access.readSnapshot(accountId), revealView(accountId)])
      const base = snapshot && typeof snapshot === 'object' ? snapshot : EMPTY_SNAPSHOT
      send(response, 200, { ...base, grades: webGradeView(base.grades, reveals.hidden, reveals.guessGrades) })
      return
    }
    if (tail === '/status' && method === 'GET') {
      send(response, 200, statusView(await access.readStatus(accountId)))
      return
    }
    if (tail === '/settings' && method === 'PUT') {
      assertSameOrigin(request)
      assertCsrf(request, session)
      rate(`settings:${hash}`, 120)
      const status = await access.readStatus(accountId)
      if (!status.linked) fail(404, 'Diese Verbindung ist noch nicht mit der Schule verbunden.')
      send(response, 200, statusView(await access.updateSettings(accountId, await readBody(request))))
      return
    }
    if (tail === '/changes' && method === 'GET') {
      const since = Number(url.searchParams.get('since') || 0)
      const [{ changes }, reveals] = await Promise.all([access.changesSince(accountId, Number.isFinite(since) ? since : 0), revealView(accountId)])
      send(response, 200, { changes: prepareGradeNotifications(changes, reveals.guessGrades).map(changeView) })
      return
    }
    if (tail === '/reveals' && method === 'GET') {
      send(response, 200, await revealView(accountId))
      return
    }
    if (tail === '/reveal' && method === 'POST') {
      assertSameOrigin(request)
      assertCsrf(request, session)
      const body = await readBody(request)
      const ids = (Array.isArray(body.ids) ? body.ids : []).slice(0, 200)
      await access.mergeReveals(accountId, { revealed: ids })
      send(response, 200, await revealView(accountId))
      return
    }
    fail(404, 'Diesen Endpunkt gibt es nicht.')
  }

  const handle = async (request, response, url) => {
    if (url.pathname !== KANTI_WEB_PREFIX && !url.pathname.startsWith(`${KANTI_WEB_PREFIX}/`)) return false
    if (!hosts.includes(requestHost(request))) return false
    const route = url.pathname.slice(KANTI_WEB_PREFIX.length).replace(/\/+$/u, '') || '/'
    const method = request.method || 'GET'
    const address = clientAddress(request)
    try {
      store.sweep().catch(() => undefined)
      if (route === '/health' && method === 'GET') {
        send(response, 200, { status: 'ok', web: await readVersion() })
        return true
      }
      if (route === '/prelogin' && method === 'POST') {
        assertSameOrigin(request)
        rate(`prelogin:${address}`, 60)
        const body = await readBody(request)
        const kdf = await preloginKdf(body.email)
        if (!kdf) fail(400, 'Bitte eine gültige E-Mail-Adresse angeben.')
        send(response, 200, { kdf })
        return true
      }
      if (route === '/login' && method === 'POST') {
        assertSameOrigin(request)
        rate(`login:${address}`, 20)
        const body = await readBody(request)
        const email = String(body.email || '').trim().toLowerCase()
        rate(`login-email:${createHash('sha256').update(email).digest('hex')}`, 10)
        const account = await findAccount(email)
        const ok = account
          ? await acceptsKey(account, body.authKey)
          // Burn the same time as a real check so timing does not reveal unknown addresses.
          : (await acceptsKey({ auth: { salt: randomBytes(16).toString('base64'), hash: randomBytes(32).toString('base64') } }, body.authKey), false)
        if (!ok) fail(401, 'E-Mail-Adresse oder Passwort stimmen nicht.')
        const stamp = await authStamp(account.id)
        if (!stamp) fail(401, 'E-Mail-Adresse oder Passwort stimmen nicht.')
        const fanotes = { accountId: account.id, stamp }
        const entry = { accountId: account.id, provider: 'schulnetz', label: 'Schulnetz', baseUrl: '', source: 'fanotes' }
        const current = await optionalSession(request)
        if (current) {
          const updated = await store.updateSession(current.hash, (session) => ({
            ...session,
            fanotes,
            connections: store.mergeConnections({ connections: (session.connections || []).filter((item) => !(item.source === 'fanotes' && item.accountId !== account.id)) }, [entry]),
          }))
          if (updated) {
            send(response, 200, { ok: true })
            return true
          }
        }
        const created = await store.createSession(browserLabel(request.headers['user-agent']), [store.newConnection(entry)], fanotes)
        send(response, 200, { ok: true }, [sessionCookie(created.token, created.session)])
        return true
      }
      if (route === '/pair' && method === 'POST') {
        assertSameOrigin(request)
        rate(`pair:${address}`, 20)
        await readBody(request)
        const pairing = await store.createPairing(browserLabel(request.headers['user-agent']))
        send(response, 200, { code: formatPairingCode(pairing.code), expiresAt: pairing.expiresAt }, [cookie(PAIR_COOKIE, pairing.cookie, Math.floor(PAIR_TTL_MS / 1000))])
        return true
      }
      if (route === '/pair' && method === 'GET') {
        rate(`pair-poll:${address}`, 900)
        const found = await store.pairingFromCookie(parseCookies(request.headers.cookie)[PAIR_COOKIE])
        if (!found) {
          send(response, 200, { status: 'expired' }, [clearCookie(PAIR_COOKIE)])
          return true
        }
        if (!found.record.finished) {
          send(response, 200, { status: 'waiting', browser: found.record.browser, added: found.record.connections.length, expiresAt: found.record.expiresAt })
          return true
        }
        const claimed = await store.claimPairing(found, await optionalSession(request))
        if (!claimed) {
          send(response, 200, { status: 'expired' }, [clearCookie(PAIR_COOKIE)])
          return true
        }
        const cookies = [clearCookie(PAIR_COOKIE)]
        if (claimed.token) cookies.push(sessionCookie(claimed.token, claimed.session))
        send(response, 200, { status: 'approved', added: claimed.added }, cookies)
        return true
      }
      // The other direction: a code the app showed, typed into this browser.
      if (route === '/pair/claim' && method === 'POST') {
        assertSameOrigin(request)
        rate(`pair-claim:${address}`, 20)
        assertClaimNotWalking(address)
        const body = await readBody(request)
        const claimed = await store.claimOffer(body?.code, browserLabel(request.headers['user-agent']), await optionalSession(request))
        if (!claimed) {
          noteClaimMiss(address)
          fail(404, 'Dieser Code ist unbekannt oder abgelaufen. Zeige in der App einen neuen Code an.')
        }
        if (claimed.waiting) fail(409, 'Bestätige die Freigabe zuerst in der App.')
        send(response, 200, { status: 'approved', added: claimed.added }, claimed.token ? [sessionCookie(claimed.token, claimed.session)] : [])
        return true
      }
      if (route === '/pair' && method === 'DELETE') {
        assertSameOrigin(request)
        const found = await store.pairingFromCookie(parseCookies(request.headers.cookie)[PAIR_COOKIE])
        await store.deletePairing(found)
        send(response, 200, { status: 'cancelled' }, [clearCookie(PAIR_COOKIE)])
        return true
      }

      // The operator's upload of the school's timetable PDF: its own token, no browser session.
      if (route === '/admin/timetable-pdf') {
        await adminTimetable(request, response, method, address)
        return true
      }

      // The page asks this first; a browser without a session is an answer, not an error.
      if (route === '/session' && method === 'GET') {
        const current = await optionalSession(request)
        if (!current) {
          const sent = Boolean(parseCookies(request.headers.cookie)[SESSION_COOKIE])
          send(response, 200, { signedIn: false }, sent ? [clearCookie(SESSION_COOKIE)] : [])
          return true
        }
        rate(`session:${current.hash}`, 900, 60 * 1000)
        send(response, 200, { signedIn: true, ...(await sessionView(current.session)) })
        return true
      }
      const { hash, session } = await authorize(request)
      rate(`session:${hash}`, 900, 60 * 1000)
      if (route === '/logout' && method === 'POST') {
        assertSameOrigin(request)
        assertCsrf(request, session)
        await store.updateSession(hash, () => 'delete')
        send(response, 200, { signedOut: true }, [clearCookie(SESSION_COOKIE)])
        return true
      }
      const timetableMatch = /^\/connections\/([^/]+)\/timetables(?:\/(class|room)\/([^/]+))?$/u.exec(route)
      if (timetableMatch && method === 'GET') {
        await timetableRoute(response, session, timetableMatch[1], timetableMatch[2] || '', timetableMatch[3] || '')
        return true
      }
      const match = /^\/connections\/([^/]+)(\/[a-z]+)?$/u.exec(route)
      if (match) {
        await connectionRoute(request, response, url, session, hash, match[1], match[2] || '', method)
        return true
      }
      fail(404, 'Diesen Endpunkt gibt es nicht.')
    } catch (error) {
      const status = Number(error?.status) || 500
      if (status >= 500) log('warn', `Anfrage fehlgeschlagen (${error?.name || 'error'})`)
      const cookies = status === 401 ? [clearCookie(SESSION_COOKIE)] : []
      send(response, status, { error: error?.publicMessage || 'Kanti+ ist vorübergehend nicht erreichbar.' }, cookies)
    }
    return true
  }

  return { handle }
}
