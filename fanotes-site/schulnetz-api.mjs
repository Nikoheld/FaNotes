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
import { localizeSchulnetzPayload, schulnetzLanguage } from './i18n.mjs'
import { GRADE_PARSER_VERSION, SNAPSHOT_BODY_LIMIT, decodeRequestJson, gradeDiffBase, keepServerLessons, uploadDiffBase, legacySnapshotView, TIMETABLE_WEEKS_HEADER } from './schulnetz-logic.mjs'
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
  parseRawSnapshot,
  parseStartMessages,
  redactSecrets,
  schulnetzCallAllowed,
  stripPhpSession,
  zurichToday,
} from './schulnetz-logic.mjs'
import { establishWebSession, scrapeWithSession } from './schulnetz-web.mjs'
import {
  FCM_ACCOUNT_FILE,
  exchangeServiceAccount,
  fcmDataMessage,
  fcmPriorityForChanges,
  fcmDropToken,
  isValidFcmToken,
  readServiceAccount,
} from './fcm.mjs'

const API_PREFIX = '/api/v1/schulnetz'
const MAX_BODY = 64 * 1024
const SCHOOL_FILES = ['link.json', 'snapshot.json', 'notified-grades.json', 'changes.jsonl', 'notification-baseline.json']
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
      mode: link.mode || 'rest',
      push: { endpoints: (link.fcmTokens || []).length },
    }
  }

  const requireKey = async () => {
    const material = await key()
    if (!material) fail(503, 'Der Schulnetz-Schlüssel ist auf dem Server noch nicht eingerichtet.')
    return material
  }

  const linkAccount = async (accountId, body) => {
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
    const changes = await publishChanges(accountId, link, await agendaDiff(accountId, uploadDiffBase(gradeDiffBase(previous, snapshot), snapshot), snapshot, link.settings || DEFAULT_SETTINGS), snapshot.revision, gradePool(previous, snapshot))
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
    await saveLink(accountId, link)
    return publicStatus(link)
  }

  const addFcmToken = async (accountId, token) => {
    if (!isValidFcmToken(token)) fail(400, 'Das Push-Token ist ungültig.')
    const link = await readLink(accountId)
    if (!link) fail(404, 'Schulnetz ist noch nicht verbunden.')
    link.fcmTokens = [...(link.fcmTokens || []).filter((item) => item !== token), token].slice(-8)
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

  const ping = async (accountId, link, event, priority = 'HIGH') => {
    if (event !== 'sync' && event !== 'reauth' && event !== 'test') return
    const tokens = (link.fcmTokens || []).filter(isValidFcmToken)
    if (!tokens.length) return
    let dropped = false
    for (const token of tokens) {
      try {
        const result = await sendFcm(token, event, priority)
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
      const result = await sendFcm(token, event, priority, extra)
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

  const publishChanges = async (accountId, link, changes, revision, grades = []) => {
    // No allowed school alert means no row and no push. Callers still save the snapshot.
    const ledger = await readGradeLedger(accountId)
    const settled = settleGradeNotifications(changes, grades, ledger)
    await writeGradeLedger(accountId, settled.keys)
    const unseen = unseenChanges(settled.changes, await knownChangeIds(accountId))
    await appendChanges(accountId, unseen, revision)
    const fresh = prepareGradeNotifications(unseen, link.settings?.guessGrades === true)
    const priority = fcmPriorityForChanges(fresh)
    if (priority) await ping(accountId, link, 'sync', priority)
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

  const pollAccount = async (accountId) => withAccount(accountId, async () => {
    if (options.pruneOrphans === true && !(await ownerStillExists(accountId))) {
      await unlink(accountId)
      return { skipped: true }
    }
    const material = await key()
    const link = await readLink(accountId)
    if (!material || !link || link.needsReauth) return { skipped: true }
    if (link.mode === 'web') {
      const savedAt = Date.parse(link.cookiesSavedAt || '')
      if (!Number.isFinite(savedAt) || now().getTime() - savedAt > COOKIE_MAX_AGE_MS) {
        link.sso = null
        link.cookiesSavedAt = ''
        link.serverSession = null
        link.needsReauth = true
        link.lastError = 'cookie-expired'
        await saveLink(accountId, link)
        return { needsReauth: true }
      }
      return pollWeb(accountId, link, material)
    }
    const baseUrl = normalizeSchoolBase(link.baseUrl)
    if (!baseUrl) return { skipped: true }
    let refreshToken = ''
    try { refreshToken = openToken(material, link.refresh) } catch { refreshToken = '' }
    if (!refreshToken) {
      link.needsReauth = true
      link.lastError = 'token'
      await saveLink(accountId, link)
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
    const changes = await publishChanges(accountId, link, await agendaDiff(accountId, gradeDiffBase(previous, snapshot), snapshot, link.settings || DEFAULT_SETTINGS), snapshot.revision, gradePool(previous, snapshot))
    link.revision = snapshot.revision
    link.lastPollAt = snapshot.fetchedAt
    link.lastError = ''
    link.needsReauth = false
    await writeJson(resolve(accountDir(accountId), 'snapshot.json'), snapshot)
    await saveLink(accountId, link)
    return { revision: snapshot.revision, changes: changes.length }
  })

  const pollWeb = async (accountId, link, material) => {
    let cookies = {}
    try { cookies = JSON.parse(openToken(material, link.sso)) } catch { cookies = {} }
    const userAgent = link.userAgent || USER_AGENT
    let serverSession = null
    try { serverSession = JSON.parse(openToken(material, link.serverSession)) } catch { serverSession = null }
    const baseUrl = link.baseUrl
    const scrape = async (session) => {
      const stored = await readJson(resolve(accountDir(accountId), 'snapshot.json'))
      return scrapeWithSession(baseUrl, { ...session, userAgent }, fetchImpl, {
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
        return { needsReauth: true }
      }
    }
    const previous = await readJson(resolve(accountDir(accountId), 'snapshot.json'))
    const failed = Boolean(scraped.problem)
    const parsedNotes = parseStartMessages(scraped.startHtml || '').map((body, index) => ({ id: `start-${index}`, title: 'Mitteilung', body, at: '' }))
    const keepMessages = failed || parsedNotes.length === 0
    const snapshot = {
      revision: (link.revision || 0) + 1,
      fetchedAt: now().toISOString(),
      grades: keepLoadedGrades(previous?.grades, scraped.grades || [], !failed),
      gradesReadComplete: !failed,
      gradeParser: failed ? (Number(previous?.gradeParser) || 0) : (scraped.gradeParser || 0),
      events: failed ? (previous?.events || []) : (scraped.events || []),
      exams: failed ? (previous?.exams || []) : (scraped.exams || previous?.exams || []),
      absences: previous?.absences || [],
      homework: previous?.homework || [],
      messages: keepMessages ? (previous?.messages || []) : parsedNotes,
      vacations: previous?.vacations || [],
      konto: parseKontoauszug(scraped.kontoHtml || ''),
      startMessages: keepMessages ? (previous?.startMessages || []) : parseStartMessages(scraped.startHtml || ''),
      readErrors: scraped.problem ? [`Schulnetz: ${scraped.problem}`] : [],
      weekFetched: failed ? (previous?.weekFetched || {}) : (scraped.weekFetched || {}),
      weekRead: failed ? (previous?.weekRead || {}) : (scraped.weekRead || {}),
      examWeekFetched: failed ? (previous?.examWeekFetched || {}) : (scraped.examWeekFetched || {}),
      weekSpanStart: scraped.weekSpanStart || previous?.weekSpanStart || '',
      weekSpanEnd: scraped.weekSpanEnd || previous?.weekSpanEnd || '',
      icalFetchedAt: scraped.icalFetchedAt || previous?.icalFetchedAt || '',
    }
    const changes = await publishChanges(accountId, link, await agendaDiff(accountId, gradeDiffBase(previous, snapshot), snapshot, link.settings || DEFAULT_SETTINGS), snapshot.revision, gradePool(previous, snapshot))
    link.revision = snapshot.revision
    link.lastPollAt = snapshot.fetchedAt
    link.lastError = ''
    link.needsReauth = false
    await writeJson(resolve(accountDir(accountId), 'snapshot.json'), snapshot)
    await saveLink(accountId, link)
    return { revision: snapshot.revision, changes: changes.length }
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
  const start = () => {
    if (options.autostart === false || process.env.FANOTES_SCHULNETZ_POLL === '0' || started) return
    started = true
    const interval = Number(process.env.FANOTES_SCHULNETZ_POLL_MS || options.intervalMs || 60_000)
    const loop = async () => {
      const acquired = await acquireLock()
      if (!acquired) {
        log('info', 'Poller übersprungen, eine andere Instanz hält die Sperre.')
        return
      }
      for (;;) {
        try {
          for (const accountId of await listAccounts()) {
            try { await pollAccount(accountId) } catch (error) {
              log('warn', `Konto ${accountId.slice(0, 8)} nicht aktualisiert (${error?.status || error?.name || 'error'})`)
            }
          }
        } catch (error) {
          log('warn', `Poller-Durchlauf fehlgeschlagen (${error?.name || 'error'})`)
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, interval))
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
      if (route === '/status' && method === 'GET') { send(response, 200, publicStatus(await readLink(accountId))); return true }
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
        const snapshot = String(request.headers?.[TIMETABLE_WEEKS_HEADER] || '') === 'weeks' ? stored : legacySnapshotView(stored, zurichToday(now()))
        send(response, 200, snapshot || { revision: 0, grades: [], events: [], exams: [], absences: [], homework: [], messages: [], vacations: [], konto: [], startMessages: [] })
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
        send(response, 200, await addFcmToken(accountId, body?.token))
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

  return {
    handle,
    start,
    pollAccount,
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
