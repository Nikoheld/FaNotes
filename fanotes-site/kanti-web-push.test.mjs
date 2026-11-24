// Web Push subscriptions of Kanti+ im Browser and what the server sends to them.
// Synthetic accounts only; the push service is a stub, nothing leaves the process.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createECDH, randomBytes } from 'node:crypto'
import test from 'node:test'

const syncDir = await mkdtemp(join(tmpdir(), 'kanti-web-push-sync-'))
process.env.FANOTES_SYNC_DIR = syncDir

const { handleSyncRequest } = await import('./sync-api.mjs')
const { createSchulnetzRuntime } = await import('./schulnetz-api.mjs')
const { createKantiWebApi, createKantiWebAppRoutes, createKantiWebStore } = await import('./kanti-web-api.mjs')
const { createWebPush } = await import('./web-push.mjs')

const WEB = 'schulnetz.fasrv.ch'
const ORIGIN = `https://${WEB}`
const DEVICE = '0123456789abcdef01234567'

const vapid = () => {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  return { publicKey: ecdh.getPublicKey().toString('base64url'), privateKey: ecdh.getPrivateKey().toString('base64url') }
}
const newSubscription = (name = 'one') => {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  return { endpoint: `https://fcm.googleapis.com/fcm/send/${name}`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } }
}
const grade = (id, title, mark, date = '2026-10-01') => ({ id, course: 'Mathematik', courseId: 'M-2a', subject: 'Mathematik', title, date, mark, weight: 1, comment: '', confirmed: true, courseGrade: 4.75 })
const snapshotWith = (grades) => ({
  fetchedAt: '2026-11-10T08:00:00.000Z', gradesReadComplete: true, grades, events: [], exams: [], absences: [], homework: [], messages: [], vacations: [], konto: [], startMessages: [],
})

const start = async ({ push = true, answer = () => 201 } = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'kanti-web-push-'))
  const now = () => new Date('2026-11-10T12:00:00.000Z')
  const sent = []
  const store = createKantiWebStore({ root, now })
  const webPush = push ? createWebPush({ keys: vapid(), send: async (message) => { sent.push(message); return { status: answer(message) , drop: [404, 410].includes(answer(message)) } } }) : undefined
  const schulnetz = createSchulnetzRuntime({
    root, key: randomBytes(32), autostart: false, now, log: () => {},
    fetch: async () => { throw new Error('no network in tests') },
    fcmSend: async () => ({ status: 200 }),
    web: createKantiWebAppRoutes(store, { now }),
    webPush,
  })
  const web = createKantiWebApi({ store, access: schulnetz.webAccess, now, hosts: [WEB], log: () => {}, webPush })
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    if (await handleSyncRequest(request, response, url)) return
    if (await schulnetz.handle(request, response, url)) return
    if (await web.handle(request, response, url)) return
    response.writeHead(404).end('{}')
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  return { base: `http://127.0.0.1:${server.address().port}`, root, sent, store, close: async () => { await new Promise((done) => server.close(done)); await rm(root, { recursive: true, force: true }) } }
}

const browser = (base) => {
  const jar = {}
  let csrf = ''
  const call = async (method, path, body, extra = {}) => {
    const headers = { 'X-Forwarded-Host': WEB, ...extra }
    const cookie = Object.entries(jar).map(([name, value]) => `${name}=${value}`).join('; ')
    if (cookie) headers.Cookie = cookie
    if (method !== 'GET') {
      headers.Origin ??= ORIGIN
      headers['Content-Type'] ??= 'application/json'
      if (csrf && !('X-Kanti-CSRF' in extra)) headers['X-Kanti-CSRF'] = csrf
    }
    const response = await fetch(`${base}/api/v1/kanti-web${path}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body || {}) })
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(';').map((part) => part.trim())
      const name = pair.slice(0, pair.indexOf('='))
      if (attributes.includes('Max-Age=0')) delete jar[name]
      else jar[name] = pair.slice(pair.indexOf('=') + 1)
    }
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : null }
  }
  return {
    call,
    async session() {
      const result = await call('GET', '/session')
      if (result.status === 200 && result.body?.signedIn === false) return { status: 401, body: result.body }
      if (result.status === 200) csrf = result.body.csrf
      return result
    },
  }
}

const appIdentity = async (base) => {
  const response = await fetch(`${base}/api/v1/schulnetz/guest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  const { accountId, token } = await response.json()
  const call = async (method, path, body) => {
    const result = await fetch(`${base}/api/v1/schulnetz${path}`, {
      method,
      headers: { 'X-Kanti-Guest': accountId, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await result.text()
    return { status: result.status, body: text ? JSON.parse(text) : null }
  }
  return { accountId, call }
}
const link = (app) => app.call('PUT', '/link', { mode: 'web', baseUrl: 'https://www.schulnetz-ag.ch/aksa', deviceId: DEVICE, userAgent: 'KantiTest', ssoCookies: { 'login.microsoftonline.com': 'ESTSAUTHPERSISTENT=synthetic-cookie-value' } })

const pair = async (base, apps) => {
  const client = browser(base)
  const started = await client.call('POST', '/pair')
  for (const [index, app] of apps.entries()) {
    const joined = await app.call('POST', '/web-pair', { code: started.body.code, connectionId: `c${index}`, label: `Verbindung ${index + 1}`, provider: 'schulnetz', finish: index === apps.length - 1 })
    assert.equal(joined.status, 200)
  }
  await client.call('GET', '/pair')
  const session = await client.session()
  assert.equal(session.status, 200)
  return { client, session: session.body }
}

test('without a key file the feature is off and says so', async () => {
  const env = await start({ push: false })
  try {
    const app = await appIdentity(env.base)
    await link(app)
    const { client, session } = await pair(env.base, [app])
    assert.equal(session.webPush, false)
    assert.deepEqual((await client.call('GET', '/push/key')).body, { enabled: false, publicKey: '' })
    const id = session.connections[0].id
    assert.equal((await client.call('POST', '/push/subscribe', { subscription: newSubscription(), connectionId: id })).status, 404)
  } finally { await env.close() }
})

test('subscribe, status and unsubscribe need the origin and CSRF and an allowed endpoint', async () => {
  const env = await start()
  try {
    const first = await appIdentity(env.base)
    const second = await appIdentity(env.base)
    await link(first)
    await link(second)
    const { client, session } = await pair(env.base, [first, second])
    assert.equal(session.webPush, true)
    const key = (await client.call('GET', '/push/key')).body
    assert.equal(key.enabled, true)
    assert.match(key.publicKey, /^[A-Za-z0-9_-]{87}$/u)
    const [one, two] = session.connections.map((connection) => connection.id)
    const sub = newSubscription()
    assert.equal((await client.call('POST', '/push/subscribe', { subscription: sub, connectionId: one }, { 'X-Kanti-CSRF': 'wrong' })).status, 403)
    assert.equal((await client.call('POST', '/push/subscribe', { subscription: sub, connectionId: one }, { Origin: 'https://evil.example' })).status, 403)
    assert.equal((await client.call('POST', '/push/subscribe', { subscription: { ...sub, endpoint: 'https://evil.example/x' }, connectionId: one })).status, 400)
    assert.equal((await client.call('POST', '/push/subscribe', { subscription: sub, connectionId: 'ffffffffffff' })).status, 404)
    assert.deepEqual((await client.call('GET', '/push/status')).body, { enabled: true, subscribed: false, connections: [], host: '' })
    const on = await client.call('POST', '/push/subscribe', { subscription: sub, connectionId: one, lang: 'en' })
    assert.deepEqual(on.body, { enabled: true, subscribed: true, connections: [one], host: 'fcm.googleapis.com' })
    assert.equal(JSON.stringify(on.body).includes('fcm/send'), false)
    const both = await client.call('POST', '/push/subscribe', { subscription: sub, connectionId: two })
    assert.deepEqual([...both.body.connections].sort(), [one, two].sort())
    // A new endpoint replaces the old subscription: one per session.
    const replaced = await client.call('POST', '/push/subscribe', { subscription: newSubscription('two'), connectionId: two })
    assert.deepEqual(replaced.body.connections, [two])
    const off = await client.call('POST', '/push/unsubscribe', { connectionId: two })
    assert.equal(off.body.subscribed, false)
    await client.call('POST', '/push/subscribe', { subscription: sub, connectionId: one })
    assert.equal((await client.call('POST', '/push/unsubscribe', {})).body.subscribed, false)
    const sessions = await readdir(join(env.root, 'web', 'sessions'))
    assert.equal((await readFile(join(env.root, 'web', 'sessions', sessions[0]), 'utf8')).includes('"push"'), false)
  } finally { await env.close() }
})

test('the subscription goes with the connection, the app identity, the account and the session', async () => {
  const env = await start()
  try {
    const first = await appIdentity(env.base)
    const second = await appIdentity(env.base)
    await link(first)
    await link(second)
    const { client, session } = await pair(env.base, [first, second])
    const [one, two] = session.connections.map((connection) => connection.id)
    const sub = newSubscription()
    const stored = async () => {
      const [name] = await readdir(join(env.root, 'web', 'sessions'))
      return JSON.parse(await readFile(join(env.root, 'web', 'sessions', name), 'utf8')).push
    }
    await client.call('POST', '/push/subscribe', { subscription: sub, connectionId: one })
    await client.call('POST', '/push/subscribe', { subscription: sub, connectionId: two })
    assert.deepEqual((await stored()).connections.sort(), [one, two].sort())
    // Removing a connection in the browser.
    assert.equal((await client.call('DELETE', `/connections/${one}`)).status, 200)
    assert.deepEqual((await stored()).connections, [two])
    assert.deepEqual((await env.store.pushTargets(second.accountId)).map((target) => target.connectionId), [two])
    assert.deepEqual(await env.store.pushTargets(first.accountId), [])
    // The app deletes that identity: the session (and its subscription) is gone.
    assert.equal((await second.call('DELETE', '/guest')).status, 200)
    assert.deepEqual(await readdir(join(env.root, 'web', 'sessions')), [])
  } finally { await env.close() }
})

test('the app taking a browser back and a logout drop the subscription', async () => {
  const env = await start()
  try {
    const app = await appIdentity(env.base)
    const other = await appIdentity(env.base)
    await link(app)
    await link(other)
    const { client, session } = await pair(env.base, [app, other])
    const [one, two] = session.connections.map((connection) => connection.id)
    await client.call('POST', '/push/subscribe', { subscription: newSubscription(), connectionId: one })
    await client.call('POST', '/push/subscribe', { subscription: newSubscription(), connectionId: one })
    const [listed] = (await app.call('GET', '/web-sessions')).body.sessions
    assert.equal((await app.call('DELETE', `/web-sessions/${listed.id}`)).body.removed, true)
    assert.deepEqual(await env.store.pushTargets(app.accountId), [])
    assert.equal((await client.call('GET', '/push/status')).body.subscribed, false)
    await client.call('POST', '/push/subscribe', { subscription: newSubscription(), connectionId: two })
    assert.equal((await env.store.pushTargets(other.accountId)).length, 1)
    assert.equal((await client.call('POST', '/logout')).status, 200)
    assert.deepEqual(await env.store.pushTargets(other.accountId), [])
    assert.deepEqual(await readdir(join(env.root, 'web', 'sessions')), [])
  } finally { await env.close() }
})

test('a grade push reaches the subscribed browser: same text, high urgency, one topic per connection', async () => {
  const env = await start()
  try {
    const app = await appIdentity(env.base)
    await link(app)
    const { client, session } = await pair(env.base, [app])
    const id = session.connections[0].id
    await client.call('POST', '/push/subscribe', { subscription: newSubscription(), connectionId: id })
    assert.equal((await app.call('PUT', '/snapshot', snapshotWith([grade('g1', 'Algebra', 5)]))).status, 200)
    env.sent.length = 0
    assert.equal((await app.call('PUT', '/snapshot', snapshotWith([grade('g1', 'Algebra', 5), grade('g2', 'Geometrie', 4.5, '2026-11-09')]))).body.changes, 1)
    assert.equal(env.sent.length, 1)
    const [message] = env.sent
    assert.equal(message.urgency, 'high')
    assert.equal(message.ttl, 21600)
    assert.match(message.topic, /^s[a-f0-9]{16}$/u)
    assert.equal(message.subscription.endpoint, 'https://fcm.googleapis.com/fcm/send/one')
    const payload = JSON.parse(message.payload)
    assert.equal(payload.c, id)
    assert.equal(payload.l, undefined)
    assert.equal(payload.n[0].p, '/noten')
    assert.match(payload.n[0].b, /4\.5/u)
    assert.ok(Buffer.byteLength(message.payload) <= 3000)
  } finally { await env.close() }
})

test('hidden grades: the browser push never carries the mark', async () => {
  const env = await start()
  try {
    const app = await appIdentity(env.base)
    await link(app)
    assert.equal((await app.call('PUT', '/settings', { guessGrades: true })).status, 200)
    const { client, session } = await pair(env.base, [app])
    await client.call('POST', '/push/subscribe', { subscription: newSubscription(), connectionId: session.connections[0].id })
    await app.call('PUT', '/snapshot', snapshotWith([grade('g1', 'Algebra', 5)]))
    env.sent.length = 0
    await app.call('PUT', '/snapshot', snapshotWith([grade('g1', 'Algebra', 5), grade('g2', 'Geometrie', 3.5, '2026-11-09')]))
    assert.equal(env.sent.length, 1)
    assert.equal(env.sent[0].payload.includes('3.5'), false)
    assert.equal(env.sent[0].payload.includes('Geometrie'), true)
  } finally { await env.close() }
})

test('an alert kind that is switched off sends nothing, and a gone subscription is removed', async () => {
  let status = 201
  const env = await start({ answer: () => status })
  try {
    const app = await appIdentity(env.base)
    await link(app)
    const { client, session } = await pair(env.base, [app])
    await client.call('POST', '/push/subscribe', { subscription: newSubscription(), connectionId: session.connections[0].id })
    await app.call('PUT', '/snapshot', snapshotWith([grade('g1', 'Algebra', 5)]))
    env.sent.length = 0
    assert.equal((await app.call('PUT', '/settings', { gradeNew: false })).status, 200)
    await app.call('PUT', '/snapshot', snapshotWith([grade('g1', 'Algebra', 5), grade('g2', 'Geometrie', 4.5, '2026-11-09')]))
    assert.equal(env.sent.length, 0)
    assert.equal((await app.call('PUT', '/settings', { gradeNew: true })).status, 200)
    status = 410
    await app.call('PUT', '/snapshot', snapshotWith([grade('g1', 'Algebra', 5), grade('g2', 'Geometrie', 4.5, '2026-11-09'), grade('g3', 'Trigonometrie', 5.5, '2026-11-09')]))
    assert.equal(env.sent.length, 1)
    assert.equal((await client.call('GET', '/push/status')).body.subscribed, false)
    env.sent.length = 0
    await app.call('PUT', '/snapshot', snapshotWith([grade('g1', 'Algebra', 5), grade('g4', 'Analysis', 5.5, '2026-11-10')]))
    assert.equal(env.sent.length, 0)
  } finally { await env.close() }
})
