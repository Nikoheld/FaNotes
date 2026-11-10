// Firebase Cloud Messaging HTTP v1. A missing service account skips the send.
// Payloads are data messages: an event name, never a grade.

import { createCipheriv, createHash, createSign, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { credentialOr } from './credentials.mjs'

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

export const fcmDropToken = (status, body) => {
  const text = String(body || '')
  if (status === 404) return true
  return text.includes('UNREGISTERED') || text.includes('INVALID_ARGUMENT')
}

export const exchangeServiceAccount = async (account, fetchImpl, nowMs) => {
  const signed = serviceAccountJwt(account, nowMs)
  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: signed.jwt,
    }).toString(),
  })
  const body = await response.text()
  if (!response.ok && response.status !== 200) {
    const error = new Error('fcm-auth')
    error.status = response.status
    throw error
  }
  let parsed = {}
  try { parsed = JSON.parse(body) } catch { parsed = {} }
  if (typeof parsed.access_token !== 'string' || !parsed.access_token) throw new Error('fcm-auth')
  const expiresIn = Number(parsed.expires_in) || 3600
  return { token: parsed.access_token, exp: Math.floor(nowMs / 1000) + expiresIn, projectId: account.project_id }
}
