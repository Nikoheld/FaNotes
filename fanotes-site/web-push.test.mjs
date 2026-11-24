import assert from 'node:assert/strict'
import { createPublicKey, createVerify, createECDH } from 'node:crypto'
import { test } from 'node:test'
import {
  cleanTopic, createWebPush, deliverWebPush, encryptWebPush, isAllowedPushEndpoint, parsePushSubscription,
  parseVapidKeys, vapidAuthorization,
} from './web-push.mjs'

const b64 = (text) => Buffer.from(text, 'base64url')

// RFC 8291 appendix A.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
}

test('RFC 8291 appendix A vector encrypts to the published body', () => {
  const body = encryptWebPush(RFC.plaintext, { p256dh: RFC.uaPublic, auth: RFC.auth }, { ephemeral: { privateKey: b64(RFC.asPrivate) }, salt: b64(RFC.salt) })
  assert.equal(body.toString('base64url'), RFC.body)
})

const newBrowser = () => {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  return { ecdh, sub: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 7).toString('base64url') } } }
}

test('a fresh encryption has the aes128gcm header and a unique salt and key', () => {
  const { sub } = newBrowser()
  const one = encryptWebPush('hi', { p256dh: sub.keys.p256dh, auth: sub.keys.auth })
  const two = encryptWebPush('hi', { p256dh: sub.keys.p256dh, auth: sub.keys.auth })
  assert.equal(one.readUInt32BE(16), 4096)
  assert.equal(one[20], 65)
  assert.notDeepEqual(one.subarray(0, 16), two.subarray(0, 16))
  assert.throws(() => encryptWebPush(Buffer.alloc(5000), { p256dh: sub.keys.p256dh, auth: sub.keys.auth }))
})

const vapid = () => {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  return { publicKey: ecdh.getPublicKey().toString('base64url'), privateKey: ecdh.getPrivateKey().toString('base64url') }
}

test('VAPID JWT is ES256, names the push service origin and verifies', () => {
  const keys = vapid()
  assert.ok(parseVapidKeys(JSON.stringify(keys)))
  const header = vapidAuthorization(keys, 'https://fcm.googleapis.com/fcm/send/xyz', { nowMs: 1_700_000_000_000, subject: 'https://example.test/' })
  const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/u.exec(header)
  assert.ok(match)
  assert.equal(match[4], keys.publicKey)
  assert.deepEqual(JSON.parse(b64(match[1])), { typ: 'JWT', alg: 'ES256' })
  const claims = JSON.parse(b64(match[2]))
  assert.equal(claims.aud, 'https://fcm.googleapis.com')
  assert.equal(claims.exp, 1_700_000_000 + 12 * 3600)
  assert.equal(claims.sub, 'https://example.test/')
  const pub = b64(keys.publicKey)
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' })
  const verify = createVerify('SHA256').update(`${match[1]}.${match[2]}`)
  assert.equal(verify.verify({ key, dsaEncoding: 'ieee-p1363' }, b64(match[3])), true)
  assert.equal(b64(match[3]).length, 64)
})

test('vapid key files must be consistent', () => {
  const keys = vapid()
  assert.equal(parseVapidKeys(JSON.stringify({ ...keys, privateKey: vapid().privateKey })), null)
  assert.equal(parseVapidKeys('nope'), null)
  assert.equal(parseVapidKeys('{}'), null)
})

test('endpoint allow-list: major push services, https, default port', () => {
  for (const ok of ['https://fcm.googleapis.com/fcm/send/a', 'https://updates.push.services.mozilla.com/wpush/v2/a', 'https://web.push.apple.com/Qx', 'https://wns2-par02p.notify.windows.com/w/?token=a', 'https://notify.windows.com/x'.replace('//notify', '//a.notify')]) assert.equal(isAllowedPushEndpoint(ok), true, ok)
  for (const bad of ['http://fcm.googleapis.com/x', 'https://evil.example/x', 'https://fcm.googleapis.com.evil.example/x', 'https://fcm.googleapis.com:8443/x', 'https://u:p@fcm.googleapis.com/x', 'https://notify.windows.com.evil.example/', 'https://evilnotify.windows.com/', 'https://127.0.0.1/', '', null, 5]) assert.equal(isAllowedPushEndpoint(bad), false, String(bad))
})

test('subscription parsing checks keys', () => {
  const { sub } = newBrowser()
  assert.deepEqual(parsePushSubscription(sub), { endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth })
  assert.equal(parsePushSubscription({ ...sub, keys: { ...sub.keys, auth: 'AAAA' } }), null)
  assert.equal(parsePushSubscription({ ...sub, keys: { ...sub.keys, p256dh: Buffer.alloc(65, 4).toString('base64url') } }), null)
  assert.equal(parsePushSubscription({ ...sub, endpoint: 'https://evil.example/x' }), null)
  assert.equal(parsePushSubscription(null), null)
})

test('delivery sends the push headers, drops on 410 and retries 503', async () => {
  const keys = vapid()
  const { sub } = newBrowser()
  const subscription = { endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth }
  const calls = []
  const answers = [503, 201]
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { status: answers.shift() ?? 201 } }
  const quiet = { requestId: () => 'r', info() {}, warn() {} }
  const ok = await deliverWebPush({ fetchImpl, subscription, keys, payload: '{"a":1}', urgency: 'high', ttl: 21600, topic: 'abcdef0123456789', sleep: async () => {}, jsonLog: quiet })
  assert.equal(ok.status, 201)
  assert.equal(ok.attempts, 2)
  const { headers, body, method } = calls[0].init
  assert.equal(method, 'POST')
  assert.equal(headers.Urgency, 'high')
  assert.equal(headers.TTL, '21600')
  assert.equal(headers.Topic, 'abcdef0123456789')
  assert.equal(headers['Content-Encoding'], 'aes128gcm')
  assert.match(headers.Authorization, /^vapid t=/u)
  assert.ok(Buffer.isBuffer(body))
  answers.push(410)
  const gone = await deliverWebPush({ fetchImpl, subscription, keys, payload: 'x', sleep: async () => {}, jsonLog: quiet })
  assert.deepEqual([gone.status, gone.drop, gone.attempts], [410, true, 1])
  const refused = await deliverWebPush({ fetchImpl, subscription: { ...subscription, endpoint: 'https://evil.example/x' }, keys, payload: 'x', jsonLog: quiet })
  assert.equal(refused.rejected, true)
  const failing = await deliverWebPush({ fetchImpl: async () => { throw new TypeError('down') }, subscription, keys, payload: 'x', sleep: async () => {}, jsonLog: quiet, attempts: 2 })
  assert.deepEqual([failing.status, failing.attempts], [0, 2])
})

test('topic must be url-safe and short', () => {
  assert.equal(cleanTopic('abc_DEF-123'), 'abc_DEF-123')
  assert.equal(cleanTopic('a'.repeat(33)), '')
  assert.equal(cleanTopic('a b'), '')
})

test('without a key file web push is off; with keys it is on and never fetches in tests', async () => {
  const off = createWebPush({ file: '/nonexistent/vapid.json', fetch: async () => { throw new Error('network') } })
  assert.equal(await off.enabled(), false)
  assert.deepEqual(await off.send({ subscription: {}, payload: 'x' }), { skipped: true })
  const keys = vapid()
  const on = createWebPush({ keys, send: async () => ({ status: 201 }) })
  assert.equal(await on.enabled(), true)
  assert.equal(await on.publicKey(), keys.publicKey)
  assert.deepEqual(await on.send({ subscription: {}, payload: 'x' }), { status: 201 })
})
