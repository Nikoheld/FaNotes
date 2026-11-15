// Firebase Cloud Messaging HTTP v1. A missing service account skips the send.
// Payloads are data messages: an event name, never a grade.

import { createCipheriv, createHash, createSign, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { credentialOr } from './credentials.mjs'
import { createServiceLog, routeOf } from './service-log.mjs'

export const FCM_ACCOUNT_FILE = credentialOr('fcm-service-account', '/etc/fanotes/fcm-service-account.json')
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'

export const isValidFcmToken = (token) => (
  typeof token === 'string'
  && token.length >= 20
  && token.length <= 4096
  && /^[A-Za-z0-9:_\-.]+$/u.test(token)
)

export const parseServiceAccount = (text) => {
  let parsed
  try { parsed = JSON.parse(text) } catch { return null }
  if (!parsed || parsed.type !== 'service_account') return null
  if (typeof parsed.client_email !== 'string' || !parsed.client_email.includes('@')) return null
  if (typeof parsed.private_key !== 'string' || !parsed.private_key.includes('PRIVATE KEY')) return null
  if (typeof parsed.project_id !== 'string' || !/^[a-z0-9-]{4,60}$/u.test(parsed.project_id)) return null
  return {
    client_email: parsed.client_email,
    private_key: parsed.private_key,
    project_id: parsed.project_id,
  }
}

export const readServiceAccount = async (file) => {
  try { return parseServiceAccount(await fs.readFile(file, 'utf8')) } catch { return null }
}

const b64url = (value) => Buffer.from(value).toString('base64url')

export const serviceAccountJwt = (account, nowMs) => {
  const iat = Math.floor(nowMs / 1000)
  const exp = iat + 3600
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = b64url(JSON.stringify({
    iss: account.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat,
    exp,
  }))
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${payload}`)
  signer.end()
  const signature = signer.sign(account.private_key).toString('base64url')
  return { jwt: `${header}.${payload}.${signature}`, exp }
}

const COLLAPSE_KEY = {
  reauth: 'kanti-reauth',
  test: 'kanti-test',
  sync: 'kanti-sync',
  // Live commute updates for the widget: their own slot, so they never replace a pending sync push.
  commute: 'kanti-commute',
}

const zurichDay = (now) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
const plusDays = (iso, days) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10)

/**
 * High priority wakes the phone right away. Every school change does, except timetable changes more
 * than a week ahead: those are sent with normal priority and arrive when the phone is awake anyway.
 * No change, no push.
 */
export const fcmPriorityForChanges = (changes, now = new Date()) => {
  const list = (Array.isArray(changes) ? changes : []).filter((change) => typeof change?.category === 'string' && change.category)
  if (!list.length) return null
  if (list.some((change) => change.category !== 'timetable')) return 'HIGH'
  const today = zurichDay(now)
  const soon = plusDays(today, 7)
  const day = (change) => /^\d{4}-\d{2}-\d{2}/u.exec(String(change.date || ''))?.[0] || ''
  // A timetable change without a date counts as soon.
  return list.some((change) => !day(change) || (day(change) >= today && day(change) <= soon)) ? 'HIGH' : 'NORMAL'
}

/**
 * Which school connection a push belongs to. A device can hold several connections, each with its
 * own server identity; the push names it by this key (a hash, so no account id travels through FCM).
 * The app computes the same key: android core `connectionRouteKey`.
 */
export const connectionRouteKey = (accountId) => createHash('sha256').update(`kanti-route:${String(accountId || '')}`).digest('hex').slice(0, 16)

/** The notice text of a push, sealed for one device. Only that device's push key opens it. */
export const PUSH_PAYLOAD_LIMIT = 3000

/** A device push key: 32 random bytes the app generated and sent with its push token (base64). */
export const pushKeyBytes = (text) => {
  if (typeof text !== 'string' || !/^[A-Za-z0-9+/]{43}=$/u.test(text)) return null
  const bytes = Buffer.from(text, 'base64')
  return bytes.length === 32 ? bytes : null
}

/** AES-256-GCM: base64(iv 12 bytes | ciphertext | tag 16 bytes). The app opens it with `openPushPayload`. */
export const sealPushPayload = (key, plain, iv = randomBytes(12)) => {
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(Buffer.from(String(plain), 'utf8')), cipher.final()])
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64')
}

/**
 * The changes a push carries, newest grade first, as many as fit into the FCM data limit once sealed.
 * Returns the sealed text and whether some were left out (the app then also asks the server).
 */
export const sealPushChanges = (key, changes, limit = PUSH_PAYLOAD_LIMIT, iv) => {
  const fields = ['id', 'category', 'title', 'body', 'targetId', 'targetIds', 'date', 'courseId', 'gradeKeys', 'revision']
  const list = (Array.isArray(changes) ? changes : []).map((change) => Object.fromEntries(fields.filter((name) => change?.[name] !== undefined).map((name) => [name, change[name]])))
  const ordered = [...list.filter((change) => change.category === 'grade'), ...list.filter((change) => change.category !== 'grade')]
  for (let count = ordered.length; count > 0; count -= 1) {
    const sealed = sealPushPayload(key, JSON.stringify({ changes: ordered.slice(0, count) }), iv)
    if (sealed.length <= limit) return { sealed, more: count < ordered.length }
  }
  return { sealed: '', more: ordered.length > 0 }
}

export const fcmDataMessage = (token, event, options = {}) => {
  const priority = options.priority === 'NORMAL' ? 'NORMAL' : 'HIGH'
  const data = { event: String(event) }
  const route = typeof options.route === 'string' && /^[a-f0-9]{16}$/u.test(options.route) ? options.route : ''
  if (route) data.route = route
  // The notice itself, end-to-end sealed for this device, so the app can show it without asking first.
  if (typeof options.sealed === 'string' && options.sealed && /^[A-Za-z0-9+/=]+$/u.test(options.sealed)) {
    data.n = options.sealed
    data.v = '1'
    if (options.more === true) data.more = '1'
  }
  if (options.probe === true) data.probe = '1'
  if (typeof options.serverAt === 'string' && options.serverAt) data.serverAt = options.serverAt
  if (typeof options.correlation === 'string' && /^probe:[0-9]{1,20}$/u.test(options.correlation)) data.correlation = options.correlation
  return {
    message: {
      token,
      data,
      android: {
        priority,
        // One collapse slot per connection: two connections' pushes while offline must not replace each other.
        collapse_key: `${options.probe === true ? 'kanti-probe' : (COLLAPSE_KEY[event] || 'kanti-sync')}${route ? `-${route}` : ''}`,
        ttl: priority === 'HIGH' ? '21600s' : '3600s',
      },
    },
  }
}

/**
 * Forget the device token only when FCM says that token is gone or not a registration token.
 * A payload error (INVALID_ARGUMENT, "message is too big") keeps the token.
 */
export const fcmDropToken = (status, body) => {
  const text = String(body || '')
  if (status === 404 || text.includes('UNREGISTERED') || text.includes('NOT_FOUND')) return true
  if (!text.includes('INVALID_ARGUMENT')) return false
  return /registration token|not a valid FCM registration token/iu.test(text)
}

/** HTTP statuses worth sending again. A 4xx other than 408/429 is the message, not the outage. */
export const fcmRetryableStatus = (status) => status === 408 || status === 429 || (status >= 500 && status <= 599)

export const FCM_ATTEMPTS = 4
export const FCM_RETRY_MS = [200, 800, 2000]
/** Error and token JSON are small. Past this, the rest is cancelled and not parsed. */
export const FCM_BODY_MAX = 64 * 1024

const readLimitedText = async (response, max) => {
  const reader = response.body?.getReader?.()
  if (!reader) {
    const body = typeof response.text === 'function' ? await response.text() : ''
    if (body.length > max) throw new Error('page too large')
    return body
  }
  const decoder = new TextDecoder('utf-8')
  let size = 0
  let body = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return body + decoder.decode()
    const bytes = value?.byteLength || 0
    size += bytes
    if (size > max) {
      if (typeof reader.cancel === 'function') await Promise.resolve(reader.cancel()).catch(() => undefined)
      throw new Error('page too large')
    }
    if (bytes) body += decoder.decode(value, { stream: true })
  }
}

const fcmNetworkRetryable = (error) => {
  const name = String(error?.name || '')
  if (name === 'TimeoutError' || name === 'AbortError') return true
  const code = String(error?.code || error?.cause?.code || '')
  if (['ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT'].includes(code)) return true
  return error instanceof TypeError
}

/**
 * POST one FCM message. 5xx, 408, 429 and a dropped connection are retried with backoff.
 * The response body stays here: callers only see the status, whether to drop the token, and how many tries.
 */
export const deliverFcm = async ({ fetchImpl, url, message, headers, sleep = (ms) => new Promise((done) => setTimeout(done, ms)), attempts = FCM_ATTEMPTS, jsonLog, now = () => new Date() } = {}) => {
  // Production emits one JSON line per attempt. Tests pass jsonLog when they want the lines.
  const events = jsonLog || createServiceLog('fcm', (line) => {
    if (process.env.NODE_ENV === 'production') console.log(line)
  }, now)
  const requestId = events.requestId()
  const route = routeOf(url)
  let last = { status: 0, drop: false, attempts: 0 }
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const started = now().getTime()
    const elapsed = () => Math.max(0, now().getTime() - started)
    try {
      const response = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(message) })
      let body = ''
      try {
        body = await readLimitedText(response, FCM_BODY_MAX)
      } catch (error) {
        // A 404 is the token itself. Any other oversized body is not an FCM error we can trust.
        if (error?.message === 'page too large' && response.status === 404) {
          last = { status: 404, drop: true, attempts: attempt }
          events.warn({ requestId, method: 'POST', route, status: 404, attempt, drop: true, ms: elapsed() })
          return last
        }
        throw error
      }
      last = { status: response.status, drop: fcmDropToken(response.status, body), attempts: attempt }
      const fields = { requestId, method: 'POST', route, status: response.status, attempt, drop: last.drop, ms: elapsed() }
      if (last.drop || response.status >= 400) events.warn(fields)
      else events.info(fields)
      if (last.drop || !fcmRetryableStatus(response.status) || attempt === attempts) return last
    } catch (error) {
      events.warn({ requestId, method: 'POST', route, status: 0, attempt, drop: false, error: String(error?.name || 'error'), ms: elapsed() })
      if (!fcmNetworkRetryable(error) || attempt === attempts) throw error
      last = { status: 0, drop: false, attempts: attempt }
    }
    await sleep(FCM_RETRY_MS[attempt - 1] ?? FCM_RETRY_MS.at(-1))
  }
  return last
}

const CANCELLATION_TITLE = /fällt aus|faellt aus|entfällt|entfaellt|abgesagt|entfernt/iu
export const PUSH_DEDUP_LIMIT = 2000
const pushChains = new Map()

/**
 * Key for a grade or a cancellation. Probes are never keyed, so a delivery test can be repeated.
 * A cancellation is the lesson (or exam) on that day, so a changed event key does not push it again.
 * A grade uses its change id, so a later mark on the same row is still news.
 */
const pushDigest = (value) => createHash('sha256').update(value).digest('hex').slice(0, 32)

export const pushDedupKey = (change) => {
  const id = String(change?.id || '')
  if (!id || id.startsWith('probe:')) return ''
  const category = String(change?.category || '')
  if (category === 'grade') return `g:${pushDigest(id)}`
  const title = String(change?.title || '')
  if ((category === 'timetable' || category === 'exam') && CANCELLATION_TITLE.test(title)) {
    const target = String(change?.targetId || id).slice(0, 120)
    const day = String(change?.date || '').slice(0, 10)
    return `c:${pushDigest(`${category}:${title}:${target}:${day}`)}`
  }
  return ''
}

const withPushLock = (file, task) => {
  const previous = pushChains.get(file) || Promise.resolve()
  const run = previous.then(task, task)
  pushChains.set(file, run.then(() => undefined, () => undefined))
  return run
}

/**
 * Drops grades and cancellations this account was already asked to push. Other changes pass through.
 * The ledger stores only those keys, never names, marks or tokens. A failed write still returns the
 * filtered list so a known duplicate is not sent; a brand-new key may be sent once more after a restart.
 */
export const claimPushKeys = (file, changes) => withPushLock(String(file), async () => {
  const list = Array.isArray(changes) ? changes : []
  let stored = []
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'))
    if (parsed?.version === 1 && Array.isArray(parsed.keys)) {
      stored = parsed.keys.filter((key) => typeof key === 'string' && key.length > 0 && key.length <= 200)
    }
  } catch { /* no ledger yet */ }
  const known = new Set(stored)
  const fresh = []
  let added = false
  for (const change of list) {
    const key = pushDedupKey(change)
    if (!key) { fresh.push(change); continue }
    if (known.has(key)) continue
    known.add(key)
    added = true
    fresh.push(change)
  }
  if (!added) return fresh
  const keys = [...known].slice(-PUSH_DEDUP_LIMIT)
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await fs.mkdir(dirname(resolve(file)), { recursive: true })
    await fs.writeFile(temporary, JSON.stringify({ version: 1, keys }), { mode: 0o600 })
    await fs.rename(temporary, file)
  } catch {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
  }
  return fresh
})

export const FCM_AUTH_ATTEMPTS = 3
export const FCM_AUTH_RETRY_MS = [200, 800]

/**
 * Exchange the service-account JWT for an access token.
 * A 408, 429, 5xx or a dropped connection is tried again. The JWT and the access token stay out of errors and logs.
 */
export const exchangeServiceAccount = async (account, fetchImpl, nowMs, options = {}) => {
  const sleep = options.sleep || ((ms) => new Promise((done) => setTimeout(done, ms)))
  const now = options.now || (() => new Date(nowMs))
  const events = options.jsonLog || createServiceLog('fcm', (line) => {
    if (process.env.NODE_ENV === 'production') console.log(line)
  }, now)
  const requestId = events.requestId()
  const route = routeOf(TOKEN_URL)
  let last = null
  for (let attempt = 1; attempt <= FCM_AUTH_ATTEMPTS; attempt += 1) {
    const started = now().getTime()
    const elapsed = () => Math.max(0, now().getTime() - started)
    try {
      const signed = serviceAccountJwt(account, nowMs)
      const response = await fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion: signed.jwt,
        }).toString(),
      })
      let body = ''
      try {
        body = await readLimitedText(response, FCM_BODY_MAX)
      } catch (error) {
        if (error?.message !== 'page too large') throw error
        last = Object.assign(new Error('fcm-auth'), { status: response.status || 0 })
        events.warn({ requestId, method: 'POST', route, status: last.status, attempt, error: 'Error', ms: elapsed() })
        throw last
      }
      if (!response.ok && response.status !== 200) {
        last = Object.assign(new Error('fcm-auth'), { status: response.status })
        events.warn({ requestId, method: 'POST', route, status: response.status, attempt, error: 'Error', ms: elapsed() })
        if (!fcmRetryableStatus(response.status) || attempt === FCM_AUTH_ATTEMPTS) throw last
      } else {
        let parsed = {}
        try { parsed = JSON.parse(body) } catch { parsed = {} }
        if (typeof parsed.access_token !== 'string' || !parsed.access_token) {
          last = Object.assign(new Error('fcm-auth'), { status: response.status || 200 })
          events.warn({ requestId, method: 'POST', route, status: last.status, attempt, error: 'Error', ms: elapsed() })
          throw last
        }
        events.info({ requestId, method: 'POST', route, status: response.status || 200, attempt, ms: elapsed() })
        const expiresIn = Number(parsed.expires_in) || 3600
        return { token: parsed.access_token, exp: Math.floor(nowMs / 1000) + expiresIn, projectId: account.project_id }
      }
    } catch (error) {
      if (error === last) throw error
      last = Object.assign(new Error('fcm-auth'), { status: Number(error?.status) || 0, name: String(error?.name || 'Error') })
      events.warn({ requestId, method: 'POST', route, status: last.status, attempt, error: String(error?.name || 'error'), ms: elapsed() })
      if (!fcmNetworkRetryable(error) || attempt === FCM_AUTH_ATTEMPTS) throw last
    }
    await sleep(FCM_AUTH_RETRY_MS[attempt - 1] ?? FCM_AUTH_RETRY_MS.at(-1))
  }
  throw last
}
