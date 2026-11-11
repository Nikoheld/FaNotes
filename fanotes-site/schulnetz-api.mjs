// Schulnetz link for one Kanti+ identity. That identity is either a FaNotes
// account or a lightweight anonymous device account (no email, no password).
// The refresh token is sealed with AES-256-GCM and only the single poller
// calls token.php. Devices receive the normalised snapshot and change list,
// never the token.

import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { resolve, sep } from 'node:path'
import { authenticateSyncRequest, syncAccountExists } from './sync-api.mjs'
import { credentialOr } from './credentials.mjs'
import { CLASS_CODE, isAksaBase } from './class-timetables.mjs'
import { localizeSchulnetzPayload, schulnetzLanguage } from './i18n.mjs'
import { GRADE_PARSER_VERSION, SNAPSHOT_BODY_LIMIT, decodeRequestJson, gradeDiffBase, keepServerLessons, uploadDiffBase, legacySnapshotView, TIMETABLE_WEEKS_HEADER, ABSENCES_HEADER, ABSENCE_PARSER_VERSION, POLL_SCHOOL_DEFAULT_MS, POLL_SPACING_MS, GRADE_SLA_MS, createPollScheduler, keepAbsenceRead, legacyAbsenceView, readAbsenceStatement, mergeRevealLedger, newGradeTargetIds, tamSchoolRoot } from './schulnetz-logic.mjs'
import {
  applyEventWindow,
  diffSnapshots,
  resolvedAlertSettings,
  prepareAgendaRead,
  isLesson,
  isExamLike,
  weekMondayKey,
  eventQueryWindow,
  hasFetchedWeeks,
  keepLoadedGrades,
  trustedGradeRead,
  parseWeekSpan,
  prepareGradeNotifications,
  settleGradeNotifications,
  isNotificationProbe,
  notificationProbeBatch,
  confirmedLessonStamps,
  probeDeviceKey,
  changeVisibleToDevice,
  stampWeeks,
  unseenChanges,
  normalizeSchoolBase,
  parseKontoauszug,
  parseKontoSaldo,
  parseRawSnapshot,
  parseStartMessages,
  redactSecrets,
  schulnetzCallAllowed,
  stripPhpSession,
  zurichToday,
} from './schulnetz-logic.mjs'
import { establishWebSession, scrapeWithSession } from './schulnetz-web.mjs'
import {
  connectionRouteKey,
  FCM_ACCOUNT_FILE,
  exchangeServiceAccount,
  fcmDataMessage,
  fcmPriorityForChanges,
  pushKeyBytes,
  sealPushChanges,
  fcmDropToken,
  isValidFcmToken,
  readServiceAccount,
} from './fcm.mjs'

const API_PREFIX = '/api/v1/schulnetz'
const MAX_BODY = 64 * 1024
const SCHOOL_FILES = ['link.json', 'snapshot.json', 'notified-grades.json', 'changes.jsonl', 'notification-baseline.json', 'reveals.json', 'monitor.json']
const GUEST_LIMIT = 30
const USER_AGENT = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'
const REFERER = 'https://schulnetz.web.app/'
const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  grades: true,
  gradeNew: true,
  gradeChanged: true,
  timetable: true,
  lessonCancelled: true,
  lessonChanged: true,
  exams: true,
  examNew: true,
  examMoved: true,
  examCancelled: true,
  examRoom: true,
  absences: true,
  events: true,
  appointmentNew: true,
  messageNew: true,
  deadlines: true,
  guessGrades: false,
})
const COOKIE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000
const SSO_HOSTS = new Set(['login.microsoftonline.com', 'login.microsoft.com', 'login.live.com', 'login.windows.net'])
const SSO_COOKIE_NAMES = new Set(['ESTSAUTH', 'ESTSAUTHPERSISTENT', 'ESTSAUTHLIGHT', 'SignInStateCookie', 'x-ms-RefreshTokenCredential'])
const LINK_LIMIT = 5
const WEB_PAIR_LIMIT = 30
const SNAPSHOT_LIMIT = 60
const PUSH_TEST_LIMIT = 5
const LIMIT_WINDOW_MS = 60 * 60 * 1000

const readKeyMaterial = () => {
  const inline = process.env.FANOTES_SCHULNETZ_TOKEN_KEY
  if (inline && inline.trim()) return decodeKey(inline.trim())
  return null
}

const decodeKey = (text) => {
  if (/^[a-f0-9]{64}$/iu.test(text)) return Buffer.from(text, 'hex')
  const decoded = Buffer.from(text, 'base64')
  if (decoded.length === 32) return decoded
  return null
}

const loadKeyFile = async (file) => {
  try {
    const text = (await fs.readFile(file, 'utf8')).trim()
    return decodeKey(text)
  } catch {
    return null
  }
}

export const sealToken = (key, plain) => {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
  return { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }
}

export const openToken = (key, sealed) => {
  if (!sealed || sealed.v !== 1 || !key) return ''
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]).toString('utf8')
}

/** The absence fields of a snapshot, for copying a kept statement. */
const absenceFields = (snapshot) => ({
  absences: snapshot?.absences || [],
  absenceQuota: snapshot?.absenceQuota ?? null,
  absenceRemaining: snapshot?.absenceRemaining ?? null,
  absenceParser: Number(snapshot?.absenceParser) || 0,
})

const fail = (status, message) => {
  const error = new Error('schulnetz')
  error.status = status
  error.publicMessage = message
  throw error
}

const keptSsoHeader = (value) => String(value || '')
  .split(';')
  .map((part) => part.trim())
  .filter((part) => SSO_COOKIE_NAMES.has(part.slice(0, part.indexOf('='))))
  .join('; ')

export const createSchulnetzRuntime = (options = {}) => {
  const root = resolve(options.root || process.env.FANOTES_SCHULNETZ_DIR || '/var/lib/fanotes-schulnetz')
  // Kanti+ im Browser (kanti-web-api.mjs): pairing codes and browser sessions. Optional.
  const web = options.web || null
  // Class and room timetables from the school's PDF (class-timetables.mjs). Optional.
  const timetables = options.timetables || null
  const fetchImpl = options.fetch || globalThis.fetch
  const now = options.now || (() => new Date())
  const log = options.log || ((level, message) => {
    console.log(`${now().toISOString()} schulnetz ${level} ${redactSecrets(message)}`)
  })
  let keyPromise = null
  const key = async () => {
    if (options.key) return options.key
    if (!keyPromise) {
      keyPromise = (async () => {
        const inline = readKeyMaterial()
        if (inline) return inline
        const file = options.keyFile || process.env.FANOTES_SCHULNETZ_TOKEN_KEY_FILE || credentialOr('schulnetz-token', '/etc/fanotes/schulnetz-token.key')
        return loadKeyFile(file)
      })()
    }
    return keyPromise
  }

  const accountDir = (accountId) => {
    if (!/^[a-f0-9]{32}$/u.test(accountId)) fail(400, 'Ungültiges Konto.')
    const dir = resolve(root, 'accounts', accountId)
    if (dir !== resolve(root, 'accounts', accountId) || !dir.startsWith(`${resolve(root, 'accounts')}${sep}`)) fail(400, 'Ungültiges Konto.')
    return dir
  }

  const readJson = async (file) => {
    try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch { return null }
  }

  const writeJson = async (file, value) => {
    await fs.mkdir(resolve(file, '..'), { recursive: true, mode: 0o700 })
    const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`
    await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600 })
    await fs.rename(temporary, file)
  }

  const stripLegacyPush = (link) => {
    if (!link || typeof link !== 'object') return link
    delete link.topic
    delete link.pushEndpoints
    return link
  }

  const readLink = async (accountId) => {
    const file = resolve(accountDir(accountId), 'link.json')
    const link = await readJson(file)
    if (!link) return null
    if (link.topic != null || link.pushEndpoints != null) {
      stripLegacyPush(link)
      await writeJson(file, link)
    }
    return link
  }
  const saveLink = async (accountId, link) => writeJson(resolve(accountDir(accountId), 'link.json'), stripLegacyPush(link))

  const publicStatus = (link) => {
    if (!link) return { linked: false, settings: DEFAULT_SETTINGS }
    return {
      linked: true,
      baseUrl: link.baseUrl,
      displayName: link.displayName || '',
      needsReauth: link.needsReauth === true,
      lastPollAt: link.lastPollAt || '',
      lastError: link.lastError || '',
      revision: link.revision || 0,
      settings: { ...DEFAULT_SETTINGS, ...(link.settings || {}) },
      settingsUpdatedAt: link.settingsUpdatedAt || '',
      mode: link.mode || 'rest',
      provider: link.provider || 'schulnetz',
      push: { endpoints: (link.fcmTokens || []).length },
    }
  }

  const requireKey = async () => {
    const material = await key()
    if (!material) fail(503, 'Der Schulnetz-Schlüssel ist auf dem Server noch nicht eingerichtet.')
    return material
  }

  const linkAccount = async (accountId, body) => {
    if (body?.mode === 'device') return linkDeviceAccount(accountId, body)
    const material = await requireKey()
    const baseUrl = normalizeSchoolBase(body?.baseUrl)
    if (!baseUrl) fail(400, 'Die Schulnetz-Adresse ist nicht erlaubt.')
    const deviceId = String(body?.deviceId || '')
    if (!/^[a-f0-9]{24}$/u.test(deviceId)) fail(400, 'Die Gerätekennung fehlt.')
    if (body?.mode === 'web') return linkWebAccount(accountId, body, material, baseUrl, deviceId)
    const refreshToken = String(body?.refreshToken || '')
    const accessToken = String(body?.accessToken || '')
    if (refreshToken.length < 20 || refreshToken.length > 4000) fail(400, 'Das Schulnetz-Token ist ungültig.')
    if (accessToken && accessToken.length > 8000) fail(400, 'Das Schulnetz-Token ist ungültig.')
    const existing = await readLink(accountId)
    const expiresIn = Number(body?.expiresIn) || 600
    const record = {
      baseUrl,
      deviceId,
      displayName: String(body?.displayName || existing?.displayName || '').slice(0, 80),
      refresh: sealToken(material, refreshToken),
      access: accessToken ? sealToken(material, accessToken) : null,
      accessExpiresAt: new Date(now().getTime() + Math.max(60, expiresIn - 60) * 1000).toISOString(),
      needsReauth: false,
      lastError: '',
      lastPollAt: existing?.lastPollAt || '',
      fcmTokens: storedFcmTokens(existing),
      settings: { ...DEFAULT_SETTINGS, ...(existing?.settings || {}) },
      revision: existing?.revision || 0,
    }
    await saveLink(accountId, record)
    return publicStatus(record)
  }

  const linkWebAccount = async (accountId, body, material, baseUrl, deviceId) => {
    const cookies = body?.ssoCookies
    if (!cookies || typeof cookies !== 'object' || Array.isArray(cookies)) fail(400, 'Die Microsoft-Cookies fehlen.')
    const sealedSource = {}
    let bytes = 0
    for (const [host, value] of Object.entries(cookies)) {
      const hostName = String(host || '').toLowerCase()
      if (!SSO_HOSTS.has(hostName) || typeof value !== 'string') continue
      const cleaned = keptSsoHeader(stripPhpSession(value))
      if (!cleaned) continue
      bytes += cleaned.length
      if (bytes > 16_000) fail(413, 'Die Cookie-Daten sind zu gross.')
      sealedSource[hostName] = cleaned
    }
    if (!Object.keys(sealedSource).length) fail(400, 'Die Microsoft-Cookies fehlen.')
    const existing = await readLink(accountId)
    const record = {
      mode: 'web',
      baseUrl,
      deviceId,
      displayName: String(body?.displayName || existing?.displayName || '').slice(0, 80),
      userAgent: String(body?.userAgent || '').slice(0, 240),
      sso: sealToken(material, JSON.stringify(sealedSource)),
      cookiesSavedAt: now().toISOString(),
      needsReauth: false,
      lastError: '',
      lastPollAt: existing?.lastPollAt || '',
      fcmTokens: storedFcmTokens(existing),
      settings: { ...DEFAULT_SETTINGS, ...(existing?.settings || {}) },
      revision: existing?.revision || 0,
    }
    await saveLink(accountId, record)
    return publicStatus(record)
  }

  /**
   * A connection the phone reads itself (TAM). The server holds no school secret, never polls it and
   * only keeps what the app uploads with PUT /snapshot, so a paired browser can show it.
   */
  const linkDeviceAccount = async (accountId, body) => {
    if (body?.provider !== 'tam') fail(400, 'Diese Verbindung wird nicht unterstützt.')
    const baseUrl = tamSchoolRoot(body?.baseUrl)
    if (!baseUrl) fail(400, 'Die Schuladresse ist nicht erlaubt.')
    const deviceId = String(body?.deviceId || '')
    if (!/^[a-f0-9]{24}$/u.test(deviceId)) fail(400, 'Die Gerätekennung fehlt.')
    const existing = await readLink(accountId)
    // A Schulnetz link carries sealed sign-in cookies; a device link must never replace it.
    if (existing && existing.mode !== 'device') fail(409, 'Diese Verbindung ist bereits mit Schulnetz verknüpft.')
    const record = {
      mode: 'device',
      provider: 'tam',
      baseUrl,
      deviceId,
      displayName: String(body?.displayName || existing?.displayName || '').slice(0, 80),
      needsReauth: false,
      lastError: '',
      lastPollAt: existing?.lastPollAt || '',
      fcmTokens: storedFcmTokens(existing),
      settings: { ...DEFAULT_SETTINGS, ...(existing?.settings || {}) },
      settingsUpdatedAt: existing?.settingsUpdatedAt || '',
      revision: existing?.revision || 0,
    }
    await saveLink(accountId, record)
    return publicStatus(record)
  }

  const storedFcmTokens = (existing) => (
    Array.isArray(existing?.fcmTokens) ? existing.fcmTokens.filter(isValidFcmToken).slice(-8) : []
  )

  const acceptSnapshot = async (accountId, body) => {
    const link = await readLink(accountId)
    if (!link) fail(404, 'Schulnetz ist noch nicht verbunden.')
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'Der Schnappschuss ist ungültig.')
    const previous = await readJson(resolve(accountDir(accountId), 'snapshot.json'))
    const snapshot = { ...keepServerLessons(previous, body), revision: (link.revision || 0) + 1, fetchedAt: body.fetchedAt || now().toISOString() }
    snapshot.grades = keepLoadedGrades(previous?.grades, snapshot.grades, trustedGradeRead(snapshot))
    // The app reads every grade row; an upload whose grades were kept is stored as a complete list.
    snapshot.gradeParser = snapshot.grades === previous?.grades ? (Number(previous?.gradeParser) || 0) : GRADE_PARSER_VERSION
    // The phone's own read errors describe its read, not what the server holds: when the server reads
    // Schulnetz itself, its own errors stay, and the phone's are kept apart (the browser showed them as
    // if every section had failed).
    if (link.mode === 'web' || (link.mode !== 'device' && link.refresh)) {
      snapshot.deviceReadErrors = Array.isArray(body.readErrors) ? body.readErrors.filter((item) => typeof item === 'string').slice(0, 20) : []
      snapshot.deviceReadAt = snapshot.fetchedAt
      snapshot.readErrors = Array.isArray(previous?.readErrors) ? previous.readErrors : []
    }
    // An app before the points parser uploads other ids; the server's own statement read stays.
    Object.assign(snapshot, absenceFields(keepAbsenceRead(previous || {}, snapshot)))
    // A device link's changes were already announced on the phone that read them: feed only, no push.
    const changes = await publishChanges(accountId, link, await agendaDiff(accountId, uploadDiffBase(gradeDiffBase(previous, snapshot), snapshot), snapshot, link.settings || DEFAULT_SETTINGS), snapshot.revision, gradePool(previous, snapshot), { push: link.mode !== 'device' })
    link.revision = snapshot.revision
    link.lastPollAt = snapshot.fetchedAt
    link.needsReauth = false
    link.loginPushSent = false
    link.lastError = ''
    await writeJson(resolve(accountDir(accountId), 'snapshot.json'), snapshot)
    await saveLink(accountId, link)
    return { revision: snapshot.revision, changes: changes.length }
  }

  const updateSettings = async (accountId, body) => {
    const link = await readLink(accountId)
    if (!link) fail(404, 'Schulnetz ist noch nicht verbunden.')
    const settings = { ...DEFAULT_SETTINGS, ...(link.settings || {}) }
    for (const name of Object.keys(DEFAULT_SETTINGS)) {
      if (typeof body?.[name] === 'boolean') settings[name] = body[name]
    }
    link.settings = settings
    // The app adopts settings changed elsewhere (the browser) when this stamp is newer than its own.
    link.settingsUpdatedAt = now().toISOString()
    await saveLink(accountId, link)
    return publicStatus(link)
  }

  const revealsPath = (accountId) => resolve(accountDir(accountId), 'reveals.json')
  const readReveals = async (accountId) => mergeRevealLedger(await readJson(revealsPath(accountId)))
  const mergeReveals = async (accountId, incoming) => withAccount(accountId, async () => {
    const merged = mergeRevealLedger(await readJson(revealsPath(accountId)), incoming || {})
    await writeJson(revealsPath(accountId), merged)
    return merged
  })
  const addHiddenGrades = async (accountId, ids) => {
    if (!ids.length) return
    const merged = mergeRevealLedger(await readJson(revealsPath(accountId)), { hidden: ids })
    await writeJson(revealsPath(accountId), merged)
  }

  const tokenKey = (token) => createHash('sha256').update(`kanti-push:${token}`).digest('hex').slice(0, 24)

  /**
   * [pushKey]: 32 random bytes the app made for this device. Pushes to this token then carry their
   * notices sealed with it, so the app shows them at once and Google never reads them. Sealed at rest.
   */
  const addFcmToken = async (accountId, token, pushKey = '') => {
    if (!isValidFcmToken(token)) fail(400, 'Das Push-Token ist ungültig.')
    const link = await readLink(accountId)
    if (!link) fail(404, 'Schulnetz ist noch nicht verbunden.')
    link.fcmTokens = [...(link.fcmTokens || []).filter((item) => item !== token), token].slice(-8)
    const kept = new Set(link.fcmTokens.map(tokenKey))
    const keys = Object.fromEntries(Object.entries(link.pushKeys || {}).filter(([name]) => kept.has(name)))
    const material = pushKeyBytes(pushKey) ? await key() : null
    if (material) keys[tokenKey(token)] = sealToken(material, pushKey)
    link.pushKeys = keys
    await saveLink(accountId, link)
    return publicStatus(link)
  }

  const unlink = async (accountId) => {
    const guest = await readGuestRecord(accountId)
    if (guest) {
      for (const name of SCHOOL_FILES) await fs.rm(resolve(accountDir(accountId), name), { force: true })
      return
    }
    await fs.rm(accountDir(accountId), { recursive: true, force: true })
  }

  const guestHits = new Map()
  const guestAllowed = (address) => {
    const key = String(address || 'unknown').slice(0, 80)
    const nowMs = now().getTime()
    const recent = (guestHits.get(key) || []).filter((at) => nowMs - at < 60_000)
    if (guestHits.size > 1000) {
      for (const [stored, stamps] of guestHits) {
        if (stamps.every((at) => nowMs - at >= 60_000)) guestHits.delete(stored)
      }
    }
    if (recent.length >= GUEST_LIMIT) {
      guestHits.set(key, recent)
      return false
    }
    recent.push(nowMs)
    guestHits.set(key, recent)
    return true
  }

  const hashGuestToken = (token) => createHash('sha256').update(String(token)).digest('hex')
  const guestTokenOk = (token) => typeof token === 'string' && /^[A-Za-z0-9_-]{40,80}$/u.test(token)
  const hashesEqual = (left, right) => {
    const a = Buffer.from(String(left))
    const b = Buffer.from(String(right))
    return a.length === b.length && timingSafeEqual(a, b)
  }

  const readGuestRecord = async (accountId) => {
    if (!/^[a-f0-9]{32}$/u.test(String(accountId || ''))) return null
    const parsed = await readJson(resolve(accountDir(accountId), 'guest.json'))
    if (!parsed || parsed.v !== 1 || typeof parsed.tokenHash !== 'string') return null
    return parsed
  }

  const assertGuest = async (accountId, token) => {
    if (!guestTokenOk(token)) fail(401, 'Bitte erneut anmelden.')
    const guest = await readGuestRecord(accountId)
    if (!guest || !hashesEqual(guest.tokenHash, hashGuestToken(token))) fail(401, 'Bitte erneut anmelden.')
    return accountId
  }

  const createGuest = async (address) => {
    if (!guestAllowed(address)) fail(429, 'Zu viele Anfragen. Bitte kurz warten.')
    const accountId = randomBytes(16).toString('hex')
    const token = randomBytes(32).toString('base64url')
    await writeJson(resolve(accountDir(accountId), 'guest.json'), {
      v: 1,
      tokenHash: hashGuestToken(token),
      createdAt: now().toISOString(),
    })
    return { accountId, token }
  }

  const copySchoolFiles = async (fromId, toId) => {
    const from = accountDir(fromId)
    const to = accountDir(toId)
    await fs.mkdir(to, { recursive: true, mode: 0o700 })
    for (const name of SCHOOL_FILES) {
      try {
        const dest = resolve(to, name)
        await fs.copyFile(resolve(from, name), dest)
        await fs.chmod(dest, 0o600)
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
  }

  const unionLedger = async (targetId, sourceId) => {
    const target = await readGradeLedger(targetId)
    const source = await readGradeLedger(sourceId)
    if (target == null && source == null) return
    await writeGradeLedger(targetId, [...(target || []), ...(source || [])])
  }

  const unionFcmTokens = (targetLink, sourceLink) => {
    const merged = []
    for (const token of [...storedFcmTokens(targetLink), ...storedFcmTokens(sourceLink)]) {
      if (!merged.includes(token)) merged.push(token)
    }
    return merged.slice(-8)
  }

  /** Move a guest's school files onto a FaNotes account. Never publishes. */
  const adoptGuest = async (faAccountId, body) => {
    const guestId = String(body?.guestAccountId || '')
    const guestToken = String(body?.guestToken || '')
    await assertGuest(guestId, guestToken)
    if (guestId === faAccountId) return { adopted: false, revision: 0 }
    const targetLink = await readLink(faAccountId)
    const guestLink = await readLink(guestId)
    if (!targetLink && guestLink) await copySchoolFiles(guestId, faAccountId)
    else if (targetLink && guestLink) {
      await unionLedger(faAccountId, guestId)
      targetLink.fcmTokens = unionFcmTokens(targetLink, guestLink)
      await saveLink(faAccountId, targetLink)
    }
    await fs.rm(accountDir(guestId), { recursive: true, force: true })
    const revision = (await readLink(faAccountId))?.revision || 0
    return { adopted: true, revision }
  }

  /**
   * Copy the FaNotes school link onto this device's guest so sign-out keeps
   * school updates. This device's push token moves. Other devices stay.
   * Never publishes.
   */
  const detachGuest = async (faAccountId, body) => {
    const guestId = String(body?.guestAccountId || '')
    const guestToken = String(body?.guestToken || '')
    const fcmToken = body?.fcmToken
    await assertGuest(guestId, guestToken)
    if (guestId === faAccountId) fail(400, 'Ungültiges Konto.')
    const faLink = await readLink(faAccountId)
    if (faLink) {
      await copySchoolFiles(faAccountId, guestId)
      const guestLink = await readLink(guestId)
      if (guestLink) {
        guestLink.fcmTokens = isValidFcmToken(fcmToken) ? [fcmToken] : []
        guestLink.loginPushSent = false
        if (guestLink.mode === 'web') {
          // Microsoft cookies can open a fresh PHP session. Sharing the
          // FaNotes PHPSESSID would let one poll invalidate the other.
          guestLink.serverSession = null
        } else {
          // A REST refresh token rotates on use. Drop the copy so this
          // device cannot sign the FaNotes link out of Schulnetz.
          guestLink.refresh = null
          guestLink.access = null
          guestLink.accessExpiresAt = null
          guestLink.needsReauth = true
        }
        await saveLink(guestId, guestLink)
      }
      if (isValidFcmToken(fcmToken)) {
        faLink.fcmTokens = storedFcmTokens(faLink).filter((item) => item !== fcmToken)
        await saveLink(faAccountId, faLink)
      }
    }
    const revision = (await readLink(guestId))?.revision || 0
    return { detached: true, revision }
  }

  const deleteGuestAccount = async (accountId) => {
    const guest = await readGuestRecord(accountId)
    if (!guest) fail(404, 'Dieses Kanti+-Konto gibt es nicht.')
    await fs.rm(accountDir(accountId), { recursive: true, force: true })
    // Browsers that read this identity lose it now, not on their next request.
    if (web?.forgetAccount) await web.forgetAccount(accountId).catch(() => undefined)
    return { deleted: true }
  }

  const bearerToken = (request) => {
    const header = request.headers?.authorization
    return typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  }

  const clientAddress = (request) => {
    const forwarded = request.headers?.['x-forwarded-for']
    const raw = typeof forwarded === 'string' && forwarded.trim() ? forwarded : request.socket?.remoteAddress || ''
    return String(raw).split(',')[0].trim()
  }

  const tails = new Map()
  const withAccount = (accountId, task) => {
    const previous = tails.get(accountId) || Promise.resolve()
    const run = previous.then(task, task)
    tails.set(accountId, run.then(() => undefined, () => undefined))
    return run
  }

  const schoolFetch = async (url, method, headers, body) => {
    if (!schulnetzCallAllowed(method, url, body || '')) fail(400, 'Diese Schulnetz-Anfrage ist nicht erlaubt.')
    const response = await fetchImpl(url, { method, headers, body, redirect: 'manual' })
    const responseBody = await response.text()
    return { status: response.status, body: responseBody }
  }

  const refreshTokens = async (baseUrl, refreshToken, deviceId) => {
    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: 'ppyybShnMerHdtBQ',
      device_id: deviceId,
    }).toString()
    const response = await schoolFetch(`${baseUrl}/token.php`, 'POST', {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: REFERER,
      'User-Agent': USER_AGENT,
    }, form)
    let json = {}
    try { json = JSON.parse(response.body) } catch { json = {} }
    return {
      accessToken: typeof json.access_token === 'string' ? json.access_token : '',
      refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : '',
      expiresIn: Number(json.expires_in) || 0,
      error: typeof json.error === 'string' ? json.error : (response.status === 200 ? '' : `http-${response.status}`),
    }
  }

  const readCollection = async (baseUrl, access, path) => {
    const response = await schoolFetch(`${baseUrl}${path}`, 'GET', {
      Accept: path.includes('index.php') ? 'text/html' : 'application/json',
      Authorization: `Bearer ${access}`,
      Referer: REFERER,
      'User-Agent': USER_AGENT,
    })
    if (response.status === 401) return { unauthorized: true, body: '' }
    if (response.status >= 400) return { unauthorized: false, body: '' }
    return { unauthorized: false, body: response.body }
  }

  let fcmCache = null
  const sendFcm = async (token, event, priority = 'HIGH', extra = {}) => {
    const message = fcmDataMessage(token, event, { priority, ...extra })
    if (typeof options.fcmSend === 'function') return options.fcmSend(message)
    const nowMs = now().getTime()
    if (!fcmCache || fcmCache.exp - 60 <= Math.floor(nowMs / 1000)) {
      const account = options.fcmAccount || await readServiceAccount(options.fcmAccountFile || process.env.FANOTES_FCM_SERVICE_ACCOUNT || FCM_ACCOUNT_FILE)
      if (!account) return { skipped: true }
      fcmCache = await exchangeServiceAccount(account, fetchImpl, nowMs)
    }
    const response = await fetchImpl(`https://fcm.googleapis.com/v1/projects/${fcmCache.projectId}/messages:send`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${fcmCache.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(message),
    })
    const body = await response.text()
    if (response.status === 401) fcmCache = null
    return { status: response.status, drop: fcmDropToken(response.status, body) }
  }

  const ping = async (accountId, link, event, priority = 'HIGH', changes = []) => {
    if (event !== 'sync' && event !== 'reauth' && event !== 'test') return
    const tokens = (link.fcmTokens || []).filter(isValidFcmToken)
    if (!tokens.length) return
    let dropped = false
    const material = event === 'sync' && changes.length ? await key() : null
    for (const token of tokens) {
      try {
        let sealed = null
        if (material && link.pushKeys?.[tokenKey(token)]) {
          let pushKey = ''
          try { pushKey = openToken(material, link.pushKeys[tokenKey(token)]) } catch { pushKey = '' }
          const bytes = pushKeyBytes(pushKey)
          if (bytes) sealed = sealPushChanges(bytes, changes)
        }
        const result = await sendFcm(token, event, priority, { route: connectionRouteKey(accountId), ...(sealed?.sealed ? { sealed: sealed.sealed, more: sealed.more } : {}) })
        if (result?.drop) {
          link.fcmTokens = (link.fcmTokens || []).filter((item) => item !== token)
          dropped = true
        }
      } catch (error) {
        log('warn', `FCM fehlgeschlagen (${error?.name || 'error'})`)
      }
    }
    if (dropped) await saveLink(accountId, link)
  }

  const pingDevice = async (accountId, link, token, event, priority = 'HIGH', extra = {}) => {
    if (event !== 'sync' && event !== 'reauth' && event !== 'test') return { rejected: true }
    if (!isValidFcmToken(token) || !(link.fcmTokens || []).includes(token)) return { rejected: true }
    try {
      const result = await sendFcm(token, event, priority, { route: connectionRouteKey(accountId), ...extra })
      if (result?.drop) {
        link.fcmTokens = (link.fcmTokens || []).filter((item) => item !== token)
        await saveLink(accountId, link)
      }
      return result || { skipped: true }
    } catch (error) {
      log('warn', `FCM fehlgeschlagen (${error?.name || 'error'})`)
      return { failed: true }
    }
  }

  const rollbackProbe = async (accountId, link, revision) => {
    const file = resolve(accountDir(accountId), 'changes.jsonl')
    const text = await fs.readFile(file, 'utf8').catch(() => '')
    const kept = text.split('\n').filter((line) => {
      if (!line) return false
      try {
        const row = JSON.parse(line)
        return !(row.revision === revision && isNotificationProbe(row.id))
      } catch {
        return true
      }
    })
    if (kept.length) await fs.writeFile(file, `${kept.join('\n')}\n`, { mode: 0o600 })
    else await fs.rm(file, { force: true })
    if (link.revision === revision) {
      link.revision = revision - 1
      await saveLink(accountId, link)
    }
  }

  /** Drops this device's probe rows only. Revision, snapshot, ledger and baseline stay. */
  const clearProbeChanges = async (accountId, deviceHash) => {
    if (!/^[a-f0-9]{32}$/u.test(String(deviceHash || ''))) return { removed: 0, failed: true }
    const file = resolve(accountDir(accountId), 'changes.jsonl')
    let text = ''
    try {
      text = await fs.readFile(file, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return { removed: 0, failed: false }
      return { removed: 0, failed: true }
    }
    const kept = []
    let removed = 0
    for (const line of text.split('\n')) {
      if (!line) continue
      try {
        const row = JSON.parse(line)
        if (isNotificationProbe(row?.id) && row?.device === deviceHash) {
          removed += 1
          continue
        }
      } catch {
        /* unreadable lines are not probe rows */
      }
      kept.push(line)
    }
    try {
      if (kept.length) await fs.writeFile(file, `${kept.join('\n')}\n`, { mode: 0o600 })
      else await fs.rm(file, { force: true })
    } catch {
      return { removed: 0, failed: true }
    }
    return { removed, failed: false }
  }

  const appendChanges = async (accountId, changes, revision) => {
    if (!changes.length) return
    const file = resolve(accountDir(accountId), 'changes.jsonl')
    const lines = changes.map((change) => JSON.stringify({ ...change, revision, at: now().toISOString() }))
    await fs.appendFile(file, `${lines.join('\n')}\n`, { mode: 0o600 })
    const text = await fs.readFile(file, 'utf8')
    const kept = text.trim().split('\n').slice(-200)
    await fs.writeFile(file, `${kept.join('\n')}\n`, { mode: 0o600 })
  }

  const knownChangeIds = async (accountId) => {
    try {
      const text = await fs.readFile(resolve(accountDir(accountId), 'changes.jsonl'), 'utf8')
      return text.trim().split('\n').map((line) => {
        try { return JSON.parse(line).id } catch { return '' }
      }).filter(Boolean)
    } catch {
      return []
    }
  }

  const gradePool = (previous, snapshot) => [...(previous?.grades || []), ...(snapshot?.grades || [])]

  /** Missing file means "not migrated yet". A present file is the durable ledger. */
  const readGradeLedger = async (accountId) => {
    const parsed = await readJson(resolve(accountDir(accountId), 'notified-grades.json'))
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.keys)) return null
    return parsed.keys.filter((key) => typeof key === 'string' && key)
  }

  const writeGradeLedger = async (accountId, keys) => {
    const unique = [...new Set(keys)].sort()
    await writeJson(resolve(accountDir(accountId), 'notified-grades.json'), { version: 1, keys: unique })
  }

  const publishChanges = async (accountId, link, changes, revision, grades = [], { push = true, detectedAt = 0 } = {}) => {
    // No allowed school alert means no row and no push. Callers still save the snapshot.
    const ledger = await readGradeLedger(accountId)
    const settled = settleGradeNotifications(changes, grades, ledger)
    await writeGradeLedger(accountId, settled.keys)
    const unseen = unseenChanges(settled.changes, await knownChangeIds(accountId))
    await appendChanges(accountId, unseen, revision)
    // Hidden grades: a grade that arrives while they are on stays hidden in every browser until revealed.
    if (link.settings?.guessGrades === true) {
      try { await addHiddenGrades(accountId, newGradeTargetIds(unseen)) } catch (error) { log('warn', `Verdeckte Noten nicht gespeichert (${error?.name || 'error'})`) }
    }
    const fresh = prepareGradeNotifications(unseen, link.settings?.guessGrades === true)
    const priority = fcmPriorityForChanges(fresh, now())
    if (priority && push) {
      await ping(accountId, link, 'sync', priority, fresh)
      // Detection (the school page that showed the change was read) to push sent.
      if (detectedAt > 0) await recordPush(accountId, now().getTime() - detectedAt, fresh.filter((change) => change.category === 'grade').length)
    }
    return fresh
  }

  const agendaDiff = async (accountId, previous, snapshot, settings) => {
    const path = resolve(accountDir(accountId), 'notification-baseline.json')
    const stored = await readJson(path)
    const read = prepareAgendaRead(stored?.version === 1 ? stored.weeks || {} : {}, snapshot)
    // Durable before any diff/push; a crash cannot turn an imported week into a second first read.
    await writeJson(path, { version: 1, weeks: read.weeks })
    return diffSnapshots(previous ? { ...previous, events: read.before.events.filter(isLesson).concat((previous.events || []).filter((event) => !isLesson(event) && !isExamLike(event))), exams: read.before.exams } : null, snapshot, resolvedAlertSettings(settings))
  }

  const accountStillExists = options.syncAccountExists || syncAccountExists

  const ownerStillExists = async (accountId) => {
    if (await readGuestRecord(accountId)) return true
    return accountStillExists(accountId)
  }

  const alertReauthOnce = async (accountId, link) => {
    if (link.loginPushSent === true) return
    await ping(accountId, link, 'reauth')
    link.loginPushSent = true
    await saveLink(accountId, link)
  }

  // The grade promise (a new grade on the phone within 10 minutes): when each account's grades page
  // was last read, and how long each push took from detection. Counts and times only.
  const monitorPath = (accountId) => resolve(accountDir(accountId), 'monitor.json')
  const readMonitor = async (accountId) => (await readJson(monitorPath(accountId))) || {}
  const recordGradeCheck = async (accountId, ok, ms, kind) => {
    const monitor = await readMonitor(accountId)
    const at = now().toISOString()
    monitor.gradeCheckAt = at
    monitor.gradeCheckMs = Math.max(0, Math.round(ms))
    if (ok) monitor.gradeCheckOkAt = at
    await writeJson(monitorPath(accountId), monitor)
    log('info', `Noten geprüft ${accountId.slice(0, 8)} ${kind} ${ok ? 'ok' : 'fehlgeschlagen'} ${Math.round(ms)} ms`)
  }
  const recordPush = async (accountId, latencyMs, grades) => {
    const monitor = await readMonitor(accountId)
    monitor.pushes = [...(monitor.pushes || []), { at: now().toISOString(), latencyMs: Math.max(0, Math.round(latencyMs)), grades }].slice(-100)
    await writeJson(monitorPath(accountId), monitor)
    log('info', `Push gesendet ${accountId.slice(0, 8)} ${Math.round(latencyMs)} ms nach Erkennung${grades ? ` (${grades} Noten)` : ''}`)
  }

  /** The grade promise across accounts. No account ids: counts, ages and latencies only. */
  const health = async () => {
    const nowMs = now().getTime()
    let accounts = 0
    let overdue = 0
    let needsReauth = 0
    let maxAge = 0
    const latencies = []
    for (const accountId of await listAccounts()) {
      const link = await readLink(accountId)
      // A device link (TAM) is read on the phone; the server has nothing to check.
      if (!link || link.mode === 'device') continue
      if (link.needsReauth) { needsReauth += 1; continue }
      accounts += 1
      const monitor = await readMonitor(accountId)
      const okAt = Date.parse(monitor.gradeCheckOkAt || '')
      const age = Number.isFinite(okAt) ? Math.max(0, nowMs - okAt) : Number.POSITIVE_INFINITY
      maxAge = Math.max(maxAge, age)
      if (age > GRADE_SLA_MS) overdue += 1
      for (const push of monitor.pushes || []) if (nowMs - Date.parse(push.at) <= 86_400_000) latencies.push(push.latencyMs)
    }
    latencies.sort((a, b) => a - b)
    return {
      status: overdue ? 'degraded' : 'ok',
      slaSeconds: GRADE_SLA_MS / 1000,
      gradeChecks: { accounts, maxAgeSeconds: Number.isFinite(maxAge) ? Math.round(maxAge / 1000) : null, overdue, needsReauth },
      pushes24h: { count: latencies.length, maxLatencyMs: latencies.at(-1) ?? null, medianLatencyMs: latencies.length ? latencies[Math.floor(latencies.length / 2)] : null },
    }
  }

  let slaWarnedAt = 0
  const runtimeStarted = now().getTime()
  /**
   * Logs a warning (at most every 10 minutes) while any account's grades were not read within the
   * promise. Not in the first 10 minutes after a start: the first round is still reading.
   */
  const watchGradePromise = async () => {
    const state = await health()
    if (now().getTime() - runtimeStarted < GRADE_SLA_MS) return state
    if (state.status === 'ok' || now().getTime() - slaWarnedAt < GRADE_SLA_MS) return state
    slaWarnedAt = now().getTime()
    log('warn', `Notenprüfung überfällig: ${state.gradeChecks.overdue} von ${state.gradeChecks.accounts} Konten seit über ${GRADE_SLA_MS / 60_000} Minuten nicht geprüft (älteste ${state.gradeChecks.maxAgeSeconds ?? '–'} s)`)
    return state
  }

  const pollAccount = async (accountId, { gradesOnly = false } = {}) => withAccount(accountId, async () => {
    const pollStarted = now().getTime()
    if (options.pruneOrphans === true && !(await ownerStillExists(accountId))) {
      await unlink(accountId)
      return { skipped: true }
    }
    const material = await key()
    const link = await readLink(accountId)
    if (!material || !link || link.needsReauth) return { skipped: true }
    // The phone reads a device link itself; there is nothing on the server to sign in with.
    if (link.mode === 'device') return { skipped: true }
    if (link.mode === 'web') {
      const savedAt = Date.parse(link.cookiesSavedAt || '')
      if (!Number.isFinite(savedAt) || now().getTime() - savedAt > COOKIE_MAX_AGE_MS) {
        link.sso = null
        link.cookiesSavedAt = ''
        link.serverSession = null
        link.needsReauth = true
        link.lastError = 'cookie-expired'
        await saveLink(accountId, link)
        // The grade promise cannot hold without a sign-in: tell the user once instead of going quiet.
        await alertReauthOnce(accountId, link)
        return { needsReauth: true }
      }
      return pollWeb(accountId, link, material, { gradesOnly })
    }
    const baseUrl = normalizeSchoolBase(link.baseUrl)
    if (!baseUrl) return { skipped: true }
    let refreshToken = ''
    try { refreshToken = openToken(material, link.refresh) } catch { refreshToken = '' }
    if (!refreshToken) {
      link.needsReauth = true
      link.lastError = 'token'
      await saveLink(accountId, link)
      await alertReauthOnce(accountId, link)
      return { skipped: true }
    }
    let access = ''
    const expiry = Date.parse(link.accessExpiresAt || '')
    if (link.access && Number.isFinite(expiry) && expiry > now().getTime() + 30_000) {
      try { access = openToken(material, link.access) } catch { access = '' }
    }
    const storeRefresh = async (tokens) => {
      if (tokens.refreshToken && tokens.refreshToken !== refreshToken) {
        link.refresh = sealToken(material, tokens.refreshToken)
        refreshToken = tokens.refreshToken
      }
      if (tokens.accessToken) {
        link.access = sealToken(material, tokens.accessToken)
        const seconds = tokens.expiresIn > 0 ? tokens.expiresIn : 600
        link.accessExpiresAt = new Date(now().getTime() + Math.max(60, seconds - 60) * 1000).toISOString()
        access = tokens.accessToken
      }
      await saveLink(accountId, link)
    }
    if (!access) {
      const tokens = await refreshTokens(baseUrl, refreshToken, link.deviceId)
      if (!tokens.accessToken) {
        link.needsReauth = true
        link.lastError = tokens.error === 'biometric_required' ? 'biometric_required' : 'reauth'
        await saveLink(accountId, link)
        await ping(accountId, link, 'reauth')
        return { needsReauth: true }
      }
      await storeRefresh(tokens)
    }
    const previous = await readJson(resolve(accountDir(accountId), 'snapshot.json'))
    const span = { start: String(previous?.weekSpanStart || ''), end: String(previous?.weekSpanEnd || '') }
    const needPlan = !(span.start && span.end) && !hasFetchedWeeks(previous?.weekFetched)
    const raw = {}
    let eventMin = ''
    let eventMax = ''
    const paths = [
      ['me', () => '/rest/v1/me'],
      ['grades', () => '/rest/v1/me/grades'],
      ['planHtml', () => (needPlan ? '/index.php?pageid=22202' : '')],
      ['events', () => {
        const window = eventQueryWindow({
          spanStart: span.start,
          spanEnd: span.end,
          weekFetched: previous?.weekFetched || {},
          icalFetchedAt: previous?.icalFetchedAt || '',
          today: zurichToday(now()),
          now: now().toISOString(),
        })
        eventMin = window.min
        eventMax = window.max
        return eventsPath(window.min, window.max)
      }],
      ['exams', () => '/rest/v1/me/exams'],
      ['absences', () => '/rest/v1/me/absences'],
      ['homework', () => '/rest/v1/me/notes/homework'],
      ['messages', () => '/rest/v1/me/notifications/push'],
      ['vacations', () => '/rest/v1/me/vacations'],
      ['lateness', () => '/rest/v1/me/lateness'],
      ['kontoHtml', () => '/index.php?pageid=21411'],
      ['startHtml', () => '/index.php?pageid=1'],
    ]
    for (const [name, pathOf] of paths) {
      const path = pathOf()
      if (!path) continue
      const response = await readCollection(baseUrl, access, path)
      if (response.unauthorized) {
        const tokens = await refreshTokens(baseUrl, refreshToken, link.deviceId)
        if (!tokens.accessToken) {
          link.needsReauth = true
          link.lastError = 'reauth'
          await saveLink(accountId, link)
          await alertReauthOnce(accountId, link)
          return { needsReauth: true }
        }
        await storeRefresh(tokens)
        const retry = await readCollection(baseUrl, access, path)
        raw[name] = retry.body
      } else {
        raw[name] = response.body
      }
      if (name === 'planHtml') {
        const found = parseWeekSpan(String(raw.planHtml || ''))
        if (found) {
          span.start = found.start
          span.end = found.end
        }
      }
    }
    const snapshot = parseRawSnapshot(raw, now().toISOString())
    snapshot.grades = keepLoadedGrades(previous?.grades, snapshot.grades, trustedGradeRead(snapshot))
    const eventsOk = typeof raw.events === 'string' && raw.events.trim() !== ''
    const seededRead = Object.keys(previous?.weekRead || {}).length
      ? { ...(previous.weekRead) }
      : confirmedLessonStamps(previous?.events || [], previous?.weekFetched || {}, {})
    if (eventsOk && eventMin && eventMax) {
      snapshot.events = applyEventWindow(previous?.events || [], snapshot.events, eventMin, eventMax)
      snapshot.weekFetched = stampWeeks(previous?.weekFetched || {}, eventMin, eventMax, snapshot.fetchedAt)
      snapshot.weekRead = stampWeeks(seededRead, eventMin, eventMax, snapshot.fetchedAt)
    } else {
      snapshot.events = previous?.events || []
      snapshot.weekFetched = previous?.weekFetched || {}
      snapshot.weekRead = seededRead
    }
    snapshot.examWeekFetched = previous?.examWeekFetched || {}
    if (typeof raw.exams === 'string' && (snapshot.exams.length || raw.exams.trim() === '[]')) {
      const keys = new Set([...Object.keys(snapshot.weekFetched || {}), ...(previous?.exams || []).concat(snapshot.exams).map((event) => weekMondayKey(event.start)).filter(Boolean)])
      snapshot.examWeekFetched = { ...snapshot.examWeekFetched }
      for (const week of keys) if (snapshot.exams.some((event) => weekMondayKey(event.start) === week) ||
        !(previous?.exams || []).some((event) => weekMondayKey(event.start) === week)) snapshot.examWeekFetched[week] = snapshot.fetchedAt
    }
    snapshot.weekSpanStart = span.start || ''
    snapshot.weekSpanEnd = span.end || ''
    snapshot.icalFetchedAt = previous?.icalFetchedAt || ''
    snapshot.gradeParser = GRADE_PARSER_VERSION
    snapshot.revision = (link.revision || 0) + 1
    const changes = await publishChanges(accountId, link, await agendaDiff(accountId, gradeDiffBase(previous, snapshot), snapshot, link.settings || DEFAULT_SETTINGS), snapshot.revision, gradePool(previous, snapshot), { detectedAt: now().getTime() })
    link.revision = snapshot.revision
    link.lastPollAt = snapshot.fetchedAt
    link.lastError = ''
    link.needsReauth = false
    await writeJson(resolve(accountDir(accountId), 'snapshot.json'), snapshot)
    await saveLink(accountId, link)
    // The app's REST API reads every list in one go; a successful read is also a grade check.
    await recordGradeCheck(accountId, true, now().getTime() - pollStarted, 'rest')
    return { revision: snapshot.revision, changes: changes.length, gradesOk: true }
  })

  const pollWeb = async (accountId, link, material, { gradesOnly = false } = {}) => {
    const started = now().getTime()
    const kind = gradesOnly ? 'kurz' : 'voll'
    let cookies = {}
    try { cookies = JSON.parse(openToken(material, link.sso)) } catch { cookies = {} }
    const userAgent = link.userAgent || USER_AGENT
    let serverSession = null
    try { serverSession = JSON.parse(openToken(material, link.serverSession)) } catch { serverSession = null }
    const baseUrl = link.baseUrl
    const scrape = async (session) => {
      const stored = await readJson(resolve(accountDir(accountId), 'snapshot.json'))
      return scrapeWithSession(baseUrl, { ...session, userAgent }, fetchImpl, {
        gradesOnly,
        previousEvents: stored?.events || [],
        previousExams: stored?.exams || [],
        vacations: stored?.vacations || [],
        weekFetched: stored?.weekFetched || {},
        weekRead: stored?.weekRead || {},
        examWeekFetched: stored?.examWeekFetched || {},
        weekSpanStart: stored?.weekSpanStart || '',
        weekSpanEnd: stored?.weekSpanEnd || '',
        icalFetchedAt: stored?.icalFetchedAt || '',
        today: zurichToday(now()),
        now: now().toISOString(),
      })
    }
    let scraped = serverSession ? await scrape(serverSession) : { problem: 'login' }
    if (scraped.problem) {
      const established = await establishWebSession(baseUrl, cookies, fetchImpl, userAgent)
      if (established.needsInteraction) {
        link.needsReauth = true
        link.lastError = established.error || 'reauth'
        link.serverSession = null
        await saveLink(accountId, link)
        if (link.loginPushSent !== true) {
          await ping(accountId, link, 'reauth')
          link.loginPushSent = true
          await saveLink(accountId, link)
        }
        await recordGradeCheck(accountId, false, now().getTime() - started, kind)
        return { needsReauth: true }
      }
      link.serverSession = sealToken(material, JSON.stringify({ php: established.php, id: established.id, transid: established.transid }))
      await saveLink(accountId, link)
      scraped = await scrape({ php: established.php, id: established.id, transid: established.transid, userAgent })
      if (scraped.problem === 'microsoft') {
        link.needsReauth = true
        link.lastError = 'microsoft'
        link.serverSession = null
        if (link.loginPushSent !== true) {
          await ping(accountId, link, 'reauth')
          link.loginPushSent = true
        }
        await saveLink(accountId, link)
        await recordGradeCheck(accountId, false, now().getTime() - started, kind)
        return { needsReauth: true }
      }
    }
    const previous = await readJson(resolve(accountDir(accountId), 'snapshot.json'))
    const failed = Boolean(scraped.problem)
    // The Absenzen page with points, quota and open reports. An unread page keeps the stored statement.
    const statement = failed ? null : readAbsenceStatement(scraped.absencesHtml || '')
    const absencePart = statement?.read
      ? { absences: statement.absences, absenceQuota: statement.quota, absenceRemaining: statement.remaining, absenceParser: ABSENCE_PARSER_VERSION }
      : absenceFields(keepAbsenceRead(previous || {}, { absences: [] }))
    const parsedNotes = parseStartMessages(scraped.startHtml || '').map((body, index) => ({ id: `start-${index}`, title: 'Mitteilung', body, at: '' }))
    const keepMessages = failed || parsedNotes.length === 0
    const snapshot = {
      revision: (link.revision || 0) + 1,
      // A grade check reads the grades page only; the full read time stays what it was.
      fetchedAt: gradesOnly ? (previous?.fetchedAt || now().toISOString()) : now().toISOString(),
      // A grade check that also read this and next week's lessons (lessonCheckWeeks).
      lessonsFetchedAt: gradesOnly ? (scraped.lessonsRead && !failed ? now().toISOString() : (previous?.lessonsFetchedAt || '')) : now().toISOString(),
      gradesFetchedAt: scraped.gradesRead && !failed ? now().toISOString() : (previous?.gradesFetchedAt || ''),
      grades: keepLoadedGrades(previous?.grades, scraped.grades || [], !failed),
      gradesReadComplete: !failed,
      gradeParser: failed ? (Number(previous?.gradeParser) || 0) : (scraped.gradeParser || 0),
      events: failed ? (previous?.events || []) : (scraped.events || []),
      exams: failed ? (previous?.exams || []) : (scraped.exams || previous?.exams || []),
      ...absencePart,
      homework: previous?.homework || [],
      messages: keepMessages ? (previous?.messages || []) : parsedNotes,
      vacations: previous?.vacations || [],
      konto: gradesOnly ? (previous?.konto || []) : parseKontoauszug(scraped.kontoHtml || ''),
      kontoSaldo: gradesOnly ? (previous?.kontoSaldo || '') : parseKontoSaldo(scraped.kontoHtml || ''),
      startMessages: keepMessages ? (previous?.startMessages || []) : parseStartMessages(scraped.startHtml || ''),
      readErrors: scraped.problem ? [`Schulnetz: ${scraped.problem}`] : [],
      weekFetched: failed ? (previous?.weekFetched || {}) : (scraped.weekFetched || {}),
      weekRead: failed ? (previous?.weekRead || {}) : (scraped.weekRead || {}),
      examWeekFetched: failed ? (previous?.examWeekFetched || {}) : (scraped.examWeekFetched || {}),
      weekSpanStart: scraped.weekSpanStart || previous?.weekSpanStart || '',
      weekSpanEnd: scraped.weekSpanEnd || previous?.weekSpanEnd || '',
      icalFetchedAt: scraped.icalFetchedAt || previous?.icalFetchedAt || '',
    }
    const detectedAt = now().getTime()
    const changes = await publishChanges(accountId, link, await agendaDiff(accountId, gradeDiffBase(previous, snapshot), snapshot, link.settings || DEFAULT_SETTINGS), snapshot.revision, gradePool(previous, snapshot), { detectedAt })
    link.revision = snapshot.revision
    link.lastPollAt = snapshot.fetchedAt
    link.lastError = ''
    link.needsReauth = false
    await writeJson(resolve(accountDir(accountId), 'snapshot.json'), snapshot)
    await saveLink(accountId, link)
    // A failed school read (sign-in wall, read error) counts for the poller's backoff.
    const gradesOk = Boolean(scraped.gradesRead) && !failed
    await recordGradeCheck(accountId, gradesOk, now().getTime() - started, kind)
    return { revision: snapshot.revision, changes: changes.length, failed, gradesOk }
  }

  const listAccounts = async () => {
    try {
      const entries = await fs.readdir(resolve(root, 'accounts'))
      return entries.filter((name) => /^[a-f0-9]{32}$/u.test(name))
    } catch {
      return []
    }
  }

  let started = false
  let lockHandle = null
  /** Due-time poller: every account on its own schedule (pollDelayMs), checked every [tickMs]. */
  const scheduler = createPollScheduler({
    listAccounts: () => listAccounts(),
    pollAccount: (accountId, mode) => pollAccount(accountId, mode),
    readSnapshot: (accountId) => readJson(resolve(accountDir(accountId), 'snapshot.json')),
    now,
    baseMs: Number(process.env.FANOTES_SCHULNETZ_POLL_MS || options.intervalMs || POLL_SCHOOL_DEFAULT_MS),
    spacingMs: options.spacingMs ?? POLL_SPACING_MS,
    log,
  })

  const start = () => {
    if (options.autostart === false || process.env.FANOTES_SCHULNETZ_POLL === '0' || started) return
    started = true
    const tickMs = Number(options.tickMs || 15_000)
    const loop = async () => {
      const acquired = await acquireLock()
      if (!acquired) {
        log('info', 'Poller übersprungen, eine andere Instanz hält die Sperre.')
        return
      }
      for (;;) {
        try { await scheduler.tick() } catch (error) {
          log('warn', `Poller-Durchlauf fehlgeschlagen (${error?.name || 'error'})`)
        }
        try { await watchGradePromise() } catch { /* the next round checks again */ }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, tickMs))
      }
    }
    loop().catch((error) => log('warn', `Poller gestoppt (${error?.name || 'error'})`))
  }

  const acquireLock = async () => {
    await fs.mkdir(root, { recursive: true, mode: 0o700 })
    const lockPath = resolve(root, 'poller.lock')
    try {
      lockHandle = await fs.open(lockPath, 'wx', 0o600)
      await lockHandle.writeFile(String(process.pid))
      return true
    } catch (error) {
      if (error?.code !== 'EEXIST') return false
      const pid = Number(await fs.readFile(lockPath, 'utf8').catch(() => '0'))
      if (pid && alive(pid)) return false
      await fs.rm(lockPath, { force: true })
      return acquireLock()
    }
  }

  const changesSince = async (accountId, since, deviceHash = '') => {
    const file = resolve(accountDir(accountId), 'changes.jsonl')
    const text = await fs.readFile(file, 'utf8').catch(() => '')
    const changes = text.split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line) } catch { return null }
    }).filter((change) => change && Number(change.revision) > since && changeVisibleToDevice(change, deviceHash))
    return { changes }
  }

  const rateRemaining = (accountId, bucket, maximum) => {
    const current = rateHits.get(`${accountId}:${bucket}`)
    const nowMs = now().getTime()
    if (!current || current.until <= nowMs) return maximum
    return Math.max(0, maximum - current.count)
  }

  // A snapshot upload carries a semester of lessons: it may be up to SNAPSHOT_BODY_LIMIT raw and gzip.
  // Every other request stays small and plain.
  const readBody = async (request, { limit = MAX_BODY, inflate = false } = {}) => {
    const chunks = []
    let size = 0
    for await (const chunk of request) {
      size += chunk.length
      if (size > limit) fail(413, 'Die Anfrage ist zu gross.')
      chunks.push(chunk)
    }
    if (!chunks.length) return {}
    const raw = Buffer.concat(chunks)
    if (!inflate) {
      try { return JSON.parse(raw.toString('utf8')) } catch { fail(400, 'Ungültiges JSON.') }
    }
    try {
      return decodeRequestJson(raw, request.headers?.['content-encoding'] || '')
    } catch (error) {
      fail(error?.status || 400, error?.message || 'Ungültiges JSON.')
    }
  }

  const rateHits = new Map()
  const accountRate = (accountId, bucket, maximum) => {
    const keyName = `${accountId}:${bucket}`
    const nowMs = now().getTime()
    if (rateHits.size > 50_000) {
      for (const [candidate, window] of rateHits) if (window.until <= nowMs) rateHits.delete(candidate)
    }
    const current = rateHits.get(keyName)
    if (!current || current.until <= nowMs) {
      rateHits.set(keyName, { count: 1, until: nowMs + LIMIT_WINDOW_MS })
      return
    }
    if (current.count >= maximum) fail(429, 'Zu viele Anfragen. Bitte später erneut versuchen.')
    current.count += 1
  }

  const send = (response, status, value) => {
    const language = response.schulnetzLanguage || 'de'
    const payload = JSON.stringify(localizeSchulnetzPayload(value, language))
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    response.end(payload)
  }

  const handle = async (request, response, url) => {
    if (url.pathname !== API_PREFIX && !url.pathname.startsWith(`${API_PREFIX}/`)) return false
    const route = url.pathname.slice(API_PREFIX.length).replace(/\/+$/u, '') || '/'
    const method = request.method || 'GET'
    response.schulnetzLanguage = schulnetzLanguage(request)
    try {
      if (method === 'OPTIONS') {
        response.writeHead(204, { 'Cache-Control': 'no-store' })
        response.end()
        return true
      }
      // Public: whether every linked account's grades were read within the 10-minute promise (counts only).
      if (route === '/health' && method === 'GET') {
        const state = await health()
        send(response, state.status === 'ok' ? 200 : 503, state)
        return true
      }
      if (route === '/guest' && method === 'POST') {
        await readBody(request)
        send(response, 200, await createGuest(clientAddress(request)))
        return true
      }
      const guestHeader = request.headers?.['x-kanti-guest']
      let accountId
      let guestAuth = false
      if (guestHeader) {
        const headerId = String(Array.isArray(guestHeader) ? guestHeader[0] : guestHeader).trim()
        accountId = await assertGuest(headerId, bearerToken(request))
        guestAuth = true
      } else {
        const auth = await authenticateSyncRequest(request)
        accountId = auth.account.id
      }
      if (route === '/adopt' && method === 'POST') {
        if (guestAuth) fail(403, 'Diese Anfrage braucht ein FaNotes-Konto.')
        send(response, 200, await adoptGuest(accountId, await readBody(request)))
        return true
      }
      if (route === '/detach' && method === 'POST') {
        if (guestAuth) fail(403, 'Diese Anfrage braucht ein FaNotes-Konto.')
        send(response, 200, await detachGuest(accountId, await readBody(request)))
        return true
      }
      if (route === '/guest' && method === 'DELETE') {
        if (!guestAuth) fail(403, 'Diese Anfrage braucht ein Kanti+-Konto.')
        send(response, 200, await deleteGuestAccount(accountId))
        return true
      }
      if (route === '/status' && method === 'GET') {
        const status = publicStatus(await readLink(accountId))
        send(response, 200, web ? { ...status, webSessions: await web.countFor(accountId) } : status)
        return true
      }
      // Kanti+ im Browser: this identity shares itself with a browser that shows a pairing code.
      if (web && route === '/web-pair' && method === 'GET') {
        accountRate(accountId, 'web-pair', WEB_PAIR_LIMIT)
        send(response, 200, await web.lookupPairing(accountId, url.searchParams.get('code'), clientAddress(request)))
        return true
      }
      // The app shows a code the user types into the browser; its connections then join with POST /web-pair.
      if (web && route === '/web-pair/offer' && method === 'POST') {
        accountRate(accountId, 'web-pair', WEB_PAIR_LIMIT)
        await readBody(request)
        send(response, 200, await web.createOffer())
        return true
      }
      if (web && route === '/web-pair' && method === 'POST') {
        accountRate(accountId, 'web-pair', WEB_PAIR_LIMIT)
        const body = await readBody(request)
        const link = await readLink(accountId)
        const joined = await web.joinPairing(accountId, body, clientAddress(request), {
          provider: link?.provider || (body?.provider === 'tam' ? 'tam' : 'schulnetz'),
          baseUrl: link?.baseUrl || '',
        })
        // Grades the app still hides stay hidden in the browser too.
        if (Array.isArray(body?.unrevealed) && body.unrevealed.length) await mergeReveals(accountId, { hidden: body.unrevealed.slice(0, 2000) })
        send(response, 200, joined)
        return true
      }
      if (web && route === '/web-sessions' && method === 'GET') { send(response, 200, { sessions: await web.sessionsFor(accountId) }); return true }
      const webSession = /^\/web-sessions\/([a-f0-9]{16})$/u.exec(route)
      if (web && webSession && method === 'DELETE') { send(response, 200, { removed: await web.revoke(accountId, webSession[1]) }); return true }
      // Other classes' and rooms' timetables: only for identities linked to the Alte Kanti (/aksa).
      const timetableMatch = /^\/timetables(?:\/(class|room)\/([^/]+))?$/u.exec(route)
      if (timetableMatch && method === 'GET') {
        const link = await readLink(accountId)
        const [, kind, rawName] = timetableMatch
        // Asking whether there is anything is an answer, not an error; files stay 404 for everyone else.
        if ((!timetables || !isAksaBase(link?.baseUrl)) && !kind) { send(response, 200, { available: false }); return true }
        if (!timetables || !isAksaBase(link?.baseUrl)) fail(404, 'Diesen Endpunkt gibt es nicht.')
        if (!kind) { send(response, 200, await timetables.summary()); return true }
        let name = ''
        try { name = decodeURIComponent(rawName) } catch { fail(404, 'Diesen Stundenplan gibt es nicht.') }
        if (kind === 'class') {
          if (!name.endsWith('.pdf')) {
            // No extension: the week as JSON, rendered natively by the app.
            const week = CLASS_CODE.test(name) ? await timetables.classWeek(name) : null
            if (!week) fail(404, 'Diesen Stundenplan gibt es nicht.')
            send(response, 200, week)
            return true
          }
          const code = name.slice(0, -4)
          const pdf = CLASS_CODE.test(code) ? await timetables.classPdf(code) : null
          if (!pdf) fail(404, 'Diesen Stundenplan gibt es nicht.')
          response.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': pdf.length, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' })
          response.end(pdf)
          return true
        }
        const found = await timetables.room(name)
        if (!found) fail(404, 'Diesen Raum gibt es nicht.')
        send(response, 200, found)
        return true
      }
      if (route === '/reveals' && method === 'GET') { send(response, 200, await readReveals(accountId)); return true }
      if (route === '/reveals' && method === 'PUT') { send(response, 200, await mergeReveals(accountId, await readBody(request))); return true }
      if (route === '/link' && method === 'PUT') {
        accountRate(accountId, 'link', LINK_LIMIT)
        send(response, 200, await linkAccount(accountId, await readBody(request)))
        return true
      }
      if (route === '/link' && method === 'DELETE') { await unlink(accountId); send(response, 200, { linked: false }); return true }
      if (route === '/snapshot' && method === 'PUT') {
        accountRate(accountId, 'snapshot', SNAPSHOT_LIMIT)
        const body = await readBody(request, { limit: SNAPSHOT_BODY_LIMIT, inflate: true })
        send(response, 200, await withAccount(accountId, () => acceptSnapshot(accountId, body)))
        return true
      }
      if (route === '/snapshot' && method === 'GET') {
        const stored = await readJson(resolve(accountDir(accountId), 'snapshot.json'))
        // Apps that handle every timetable week say so; older ones get this week only.
        const weeks = String(request.headers?.[TIMETABLE_WEEKS_HEADER] || '') === 'weeks' ? stored : legacySnapshotView(stored, zurichToday(now()))
        // Apps before the points parser get the absences their own reader produces, so their diff stays quiet.
        const snapshot = String(request.headers?.[ABSENCES_HEADER] || '') === String(ABSENCE_PARSER_VERSION) ? weeks : legacyAbsenceView(weeks)
        send(response, 200, snapshot || { revision: 0, grades: [], events: [], exams: [], absences: [], homework: [], messages: [], vacations: [], konto: [], kontoSaldo: '', startMessages: [] })
        return true
      }
      if (route === '/changes' && method === 'GET') {
        const since = Number(url.searchParams.get('since') || 0)
        const device = String(url.searchParams.get('device') || '')
        send(response, 200, await changesSince(accountId, Number.isFinite(since) ? since : 0, device))
        return true
      }
      if (route === '/settings' && method === 'PUT') { send(response, 200, await updateSettings(accountId, await readBody(request))); return true }
      if (route === '/push-token' && method === 'PUT') {
        const body = await readBody(request)
        send(response, 200, await addFcmToken(accountId, body?.token, body?.key))
        return true
      }
      if (route === '/push/test' && method === 'POST') {
        accountRate(accountId, 'push-test', PUSH_TEST_LIMIT)
        const link = await readLink(accountId)
        if (!link) fail(404, 'Schulnetz ist noch nicht verbunden.')
        await ping(accountId, link, 'test')
        send(response, 200, { ok: true })
        return true
      }
      if (route === '/push/probe' && method === 'POST') {
        accountRate(accountId, 'push-probe', PUSH_TEST_LIMIT)
        const link = await readLink(accountId)
        if (!link) fail(404, 'Schulnetz ist noch nicht verbunden.')
        const body = await readBody(request)
        const token = typeof body?.token === 'string' ? body.token.trim() : ''
        if (!isValidFcmToken(token) || !(link.fcmTokens || []).includes(token)) {
          fail(400, 'Dieses Gerät ist für Push nicht registriert.')
        }
        const serverAt = now().toISOString()
        const scenario = typeof body?.scenario === 'string' ? body.scenario : 'standard'
        const batch = notificationProbeBatch({ serverAt, day: zurichToday(now()), scenario })
        if (!batch) fail(400, 'Dieses Testszenario gibt es nicht.')
        const device = probeDeviceKey(token)
        const changes = batch.map((change) => ({ ...change, device }))
        const correlation = changes[0]?.correlation || ''
        const revision = (Number(link.revision) || 0) + 1
        await appendChanges(accountId, changes, revision)
        link.revision = revision
        await saveLink(accountId, link)
        const result = await pingDevice(accountId, link, token, 'sync', 'HIGH', { probe: true, serverAt, correlation })
        const accepted = result?.status === 200 && !result.drop && !result.skipped && !result.failed && !result.rejected
        if (!accepted) {
          await rollbackProbe(accountId, link, revision)
          if (result?.skipped) fail(503, 'Firebase ist auf dem Server nicht eingerichtet.')
          if (result?.drop) fail(409, 'Dieses Gerät ist bei Firebase nicht mehr registriert.')
          fail(502, 'Firebase hat die Testmeldung nicht angenommen.')
        }
        send(response, 200, {
          ok: true,
          serverAt,
          count: changes.length,
          correlation,
          scenario: String(scenario || 'standard').trim().toLowerCase() || 'standard',
          probeRemaining: rateRemaining(accountId, 'push-probe', PUSH_TEST_LIMIT),
          clearRemaining: rateRemaining(accountId, 'push-probe-clear', PUSH_TEST_LIMIT),
        })
        return true
      }
      if (route === '/push/probe/clear' && method === 'POST') {
        accountRate(accountId, 'push-probe-clear', PUSH_TEST_LIMIT)
        const link = await readLink(accountId)
        if (!link) fail(404, 'Schulnetz ist noch nicht verbunden.')
        const body = await readBody(request)
        const token = typeof body?.token === 'string' ? body.token.trim() : ''
        if (!isValidFcmToken(token) || !(link.fcmTokens || []).includes(token)) {
          fail(400, 'Dieses Gerät ist für Push nicht registriert.')
        }
        const cleared = await clearProbeChanges(accountId, probeDeviceKey(token))
        send(response, 200, {
          ok: !cleared.failed,
          ...cleared,
          probeRemaining: rateRemaining(accountId, 'push-probe', PUSH_TEST_LIMIT),
          clearRemaining: rateRemaining(accountId, 'push-probe-clear', PUSH_TEST_LIMIT),
        })
        return true
      }
      send(response, 404, { error: 'Diesen Schulnetz-Endpunkt gibt es nicht.' })
    } catch (error) {
      const status = Number(error?.status) || 500
      if (status >= 500) log('warn', `Anfrage fehlgeschlagen (${error?.name || 'error'})`)
      send(response, status, { error: error?.publicMessage || 'Der Schulnetz-Dienst ist vorübergehend nicht erreichbar.' })
    }
    return true
  }

  /** What the browser API may read and change for a connection a session holds. */
  const webAccess = {
    ownerExists: async (accountId) => {
      try { return await ownerStillExists(accountId) } catch { return false }
    },
    readStatus: async (accountId) => publicStatus(await readLink(accountId)),
    readSnapshot: async (accountId) => readJson(resolve(accountDir(accountId), 'snapshot.json')),
    updateSettings: (accountId, body) => updateSettings(accountId, body),
    changesSince: (accountId, since) => changesSince(accountId, since, ''),
    readReveals,
    mergeReveals,
    timetablesFor: async (accountId) => {
      const link = await readLink(accountId)
      return timetables && isAksaBase(link?.baseUrl) ? timetables : null
    },
  }

  return {
    handle,
    start,
    webAccess,
    pollAccount,
    scheduler,
    health,
    watchGradePromise,
    linkAccount,
    addFcmToken,
    createGuest,
    adoptGuest,
    detachGuest,
    deleteGuestAccount,
    unlink,
    publicStatusOf: async (accountId) => publicStatus(await readLink(accountId)),
    root,
  }
}

const eventsPath = (min, max) => `/rest/v1/me/events?min_date=${min}&max_date=${max}`

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
