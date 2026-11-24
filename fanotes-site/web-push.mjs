// Web Push for Kanti+ im Browser: VAPID (RFC 8292) and aes128gcm payload encryption (RFC 8291),
// delivery (RFC 8030). Node built-ins only. A missing VAPID key file turns web push off cleanly.
//
// The key pair file (JSON, mode 0600, written by scripts/generate-vapid.mjs):
//   { "publicKey": "<base64url, 65-byte uncompressed P-256 point>", "privateKey": "<base64url, 32 bytes>" }
// Found at the systemd credential `web-push-vapid`, else FANOTES_WEB_PUSH_VAPID, else /etc/fanotes/web-push-vapid.json.
// The VAPID subject (contact) is FANOTES_WEB_PUSH_SUBJECT, default https://schulnetz.fasrv.ch/.

import { createECDH, createHmac, createCipheriv, createPrivateKey, createSign, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { credentialOr } from './credentials.mjs'
import { createServiceLog, routeOf } from './service-log.mjs'

export const WEB_PUSH_VAPID_FILE = process.env.FANOTES_WEB_PUSH_VAPID || credentialOr('web-push-vapid', '/etc/fanotes/web-push-vapid.json')
export const WEB_PUSH_SUBJECT = process.env.FANOTES_WEB_PUSH_SUBJECT || 'https://schulnetz.fasrv.ch/'
/** Plain text per push. The record size is 4096; the services accept 4078 bytes of ciphertext payload. */
export const WEB_PUSH_PLAIN_LIMIT = 3000
export const WEB_PUSH_TIMEOUT_MS = 12_000
export const WEB_PUSH_ATTEMPTS = 3
export const WEB_PUSH_RETRY_MS = [300, 1200]

const b64url = (bytes) => Buffer.from(bytes).toString('base64url')
const fromB64url = (text) => Buffer.from(String(text), 'base64url')
const BASE64URL = /^[A-Za-z0-9_-]+$/u

// ── Subscriptions ─────────────────────────────────────────────────────────

/** Hosts of the major push services. https only, default port, no credentials in the URL. */
export const isAllowedPushEndpoint = (value) => {
  if (typeof value !== 'string' || value.length > 1000) return false
  let url
  try { url = new URL(value) } catch { return false }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return false
  const host = url.hostname.toLowerCase()
  if (host === 'fcm.googleapis.com' || host === 'updates.push.services.mozilla.com' || host === 'web.push.apple.com') return true
  return /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.notify\.windows\.com$/u.test(host)
}

export const pushEndpointHost = (value) => {
  try { return new URL(value).hostname.toLowerCase() } catch { return '' }
}

const validPublicPoint = (bytes) => {
  if (bytes.length !== 65 || bytes[0] !== 4) return false
  try {
    const probe = createECDH('prime256v1')
    probe.generateKeys()
    probe.computeSecret(bytes)
    return true
  } catch {
    return false
  }
}

/** The browser's PushSubscription JSON, checked. Returns { endpoint, p256dh, auth } or null. */
export const parsePushSubscription = (value) => {
  const endpoint = value?.endpoint
  const p256dh = value?.keys?.p256dh
  const auth = value?.keys?.auth
  if (!isAllowedPushEndpoint(endpoint)) return null
  if (typeof p256dh !== 'string' || typeof auth !== 'string' || !BASE64URL.test(p256dh) || !BASE64URL.test(auth)) return null
  if (!validPublicPoint(fromB64url(p256dh)) || fromB64url(auth).length !== 16) return null
  return { endpoint, p256dh, auth }
}

// ── RFC 8291 payload encryption ───────────────────────────────────────────

const hmac = (key, data) => createHmac('sha256', key).update(data).digest()
const hkdfExtract = (salt, ikm) => hmac(salt, ikm)
const hkdfExpand = (prk, info, length) => hmac(prk, Buffer.concat([info, Buffer.from([1])])).subarray(0, length)

/**
 * Encrypt one message for a subscription (aes128gcm, a single record).
 * `ephemeral` ({ privateKey, publicKey } as Buffers) and `salt` are only for the RFC test vectors.
 */
export const encryptWebPush = (plaintext, { p256dh, auth }, { ephemeral, salt = randomBytes(16), recordSize = 4096 } = {}) => {
  const uaPublic = fromB64url(p256dh)
  const authSecret = fromB64url(auth)
  const ecdh = createECDH('prime256v1')
  if (ephemeral) ecdh.setPrivateKey(ephemeral.privateKey)
  else ecdh.generateKeys()
  const asPublic = ecdh.getPublicKey()
  const shared = ecdh.computeSecret(uaPublic)
  const prkKey = hkdfExtract(authSecret, shared)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), uaPublic, asPublic])
  const ikm = hkdfExpand(prkKey, keyInfo, 32)
  const prk = hkdfExtract(salt, ikm)
  const cek = hkdfExpand(prk, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16)
  const nonce = hkdfExpand(prk, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12)
  const data = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8')
  if (data.length > recordSize - 17) throw new Error('web push payload too large')
  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  // A single, last record: the data followed by the 0x02 delimiter.
  const body = Buffer.concat([cipher.update(Buffer.concat([data, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()])
  const header = Buffer.alloc(21)
  salt.copy(header, 0)
  header.writeUInt32BE(recordSize, 16)
  header[20] = asPublic.length
  return Buffer.concat([header, asPublic, body])
}

// ── RFC 8292 VAPID ────────────────────────────────────────────────────────

export const parseVapidKeys = (text) => {
  let parsed
  try { parsed = JSON.parse(text) } catch { return null }
  const publicKey = parsed?.publicKey
  const privateKey = parsed?.privateKey
  if (typeof publicKey !== 'string' || typeof privateKey !== 'string' || !BASE64URL.test(publicKey) || !BASE64URL.test(privateKey)) return null
  const pub = fromB64url(publicKey)
  const priv = fromB64url(privateKey)
  if (priv.length !== 32 || !validPublicPoint(pub)) return null
  try {
    const probe = createECDH('prime256v1')
    probe.setPrivateKey(priv)
    // The private key must belong to the public one.
    if (!probe.getPublicKey().equals(pub)) return null
  } catch {
    return null
  }
  return { publicKey, privateKey }
}

export const readVapidKeys = async (file) => {
  try { return parseVapidKeys(await fs.readFile(file, 'utf8')) } catch { return null }
}

const privateKeyObject = ({ publicKey, privateKey }) => {
  const pub = fromB64url(publicKey)
  return createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: privateKey, x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33, 65)) }, format: 'jwk' })
}

/** The Authorization header value for one push service origin. */
export const vapidAuthorization = (keys, endpoint, { nowMs = Date.now(), subject = WEB_PUSH_SUBJECT, ttlSeconds = 12 * 3600, keyObject } = {}) => {
  const audience = new URL(endpoint).origin
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))
  const claims = b64url(JSON.stringify({ aud: audience, exp: Math.floor(nowMs / 1000) + ttlSeconds, sub: subject }))
  const signer = createSign('SHA256')
  signer.update(`${header}.${claims}`)
  signer.end()
  // JOSE wants the raw r||s form, not DER.
  const signature = signer.sign({ key: keyObject || privateKeyObject(keys), dsaEncoding: 'ieee-p1363' })
  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${keys.publicKey}`
}

// ── Delivery (RFC 8030) ───────────────────────────────────────────────────

/** 404 and 410: the subscription is gone for good. */
export const webPushDropStatus = (status) => status === 404 || status === 410
const retryable = (status) => status === 408 || status === 429 || (status >= 500 && status <= 599)

/** Topic: up to 32 URL-safe characters. A newer push with the same topic replaces a waiting one. */
export const cleanTopic = (value) => {
  const text = String(value || '')
  return /^[A-Za-z0-9_-]{1,32}$/u.test(text) ? text : ''
}

/**
 * Send one encrypted message. Returns { status, drop, attempts }; never throws for an HTTP answer.
 * Only the status leaves this function: no endpoint, no body, no key.
 */
export const deliverWebPush = async ({
  fetchImpl, subscription, keys, payload, urgency = 'normal', ttl = 3600, topic = '',
  nowMs = Date.now(), sleep = (ms) => new Promise((done) => setTimeout(done, ms)), attempts = WEB_PUSH_ATTEMPTS,
  timeoutMs = WEB_PUSH_TIMEOUT_MS, keyObject, subject, jsonLog, now = () => new Date(),
}) => {
  if (!isAllowedPushEndpoint(subscription.endpoint)) return { status: 0, drop: false, attempts: 0, rejected: true }
  const events = jsonLog || createServiceLog('web-push', (line) => {
    if (process.env.NODE_ENV === 'production') console.log(line)
  }, now)
  const requestId = events.requestId()
  const route = routeOf(subscription.endpoint)
  const body = encryptWebPush(payload, subscription)
  let last = { status: 0, drop: false, attempts: 0 }
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const started = now().getTime()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(Object.assign(new Error('timed out'), { name: 'TimeoutError' })), timeoutMs)
    try {
      const headers = {
        Authorization: vapidAuthorization(keys, subscription.endpoint, { nowMs, keyObject, subject }),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(Math.max(0, Math.floor(ttl))),
        Urgency: urgency,
      }
      const cleanedTopic = cleanTopic(topic)
      if (cleanedTopic) headers.Topic = cleanedTopic
      const response = await fetchImpl(subscription.endpoint, { method: 'POST', headers, body, redirect: 'error', signal: controller.signal })
      // The answer body is never read: it can echo nothing we need, and stays out of logs.
      try { await response.body?.cancel?.() } catch { /* nothing to free */ }
      last = { status: response.status, drop: webPushDropStatus(response.status), attempts: attempt }
      const fields = { requestId, method: 'POST', route, status: response.status, attempt, drop: last.drop, ms: Math.max(0, now().getTime() - started) }
      if (response.status >= 400) events.warn(fields)
      else events.info(fields)
      if (last.drop || !retryable(response.status) || attempt === attempts) return last
    } catch (error) {
      events.warn({ requestId, method: 'POST', route, status: 0, attempt, drop: false, error: String(error?.name || 'error'), ms: Math.max(0, now().getTime() - started) })
      last = { status: 0, drop: false, attempts: attempt }
      if (attempt === attempts) return last
    } finally {
      clearTimeout(timer)
    }
    await sleep(WEB_PUSH_RETRY_MS[attempt - 1] ?? WEB_PUSH_RETRY_MS.at(-1))
  }
  return last
}

/**
 * The sender the runtime uses. `enabled()` is false until a valid key file exists (read once, then
 * re-read at most every minute while it is missing, so a key written at deploy needs no restart).
 */
export const createWebPush = (options = {}) => {
  const file = options.file || WEB_PUSH_VAPID_FILE
  const fetchImpl = options.fetch || globalThis.fetch
  const now = options.now || (() => new Date())
  let loaded = options.keys ? parseVapidKeys(JSON.stringify(options.keys)) : null
  let keyObject = loaded ? privateKeyObject(loaded) : null
  let checkedAt = loaded ? Number.POSITIVE_INFINITY : -Infinity
  const load = async () => {
    if (loaded) return loaded
    const at = now().getTime()
    if (at - checkedAt < 60_000) return null
    checkedAt = at
    loaded = await readVapidKeys(file)
    keyObject = loaded ? privateKeyObject(loaded) : null
    return loaded
  }
  return {
    /** True when a key pair is present. */
    enabled: async () => Boolean(await load()),
    publicKey: async () => (await load())?.publicKey || '',
    send: async ({ subscription, payload, urgency, ttl, topic }) => {
      const keys = await load()
      if (!keys) return { skipped: true }
      if (typeof options.send === 'function') return options.send({ subscription, payload, urgency, ttl, topic })
      return deliverWebPush({
        fetchImpl, subscription, keys, keyObject, payload, urgency, ttl, topic,
        nowMs: now().getTime(), sleep: options.sleep, subject: options.subject, now,
      })
    },
  }
}
