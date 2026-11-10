// Kanti+ im Browser: the browser API against the real sync API and Schulnetz runtime, over HTTP.
// Synthetic accounts and grades only.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import test from 'node:test'

const syncDir = await mkdtemp(join(tmpdir(), 'kanti-web-sync-'))
process.env.FANOTES_SYNC_DIR = syncDir

const { handleSyncRequest } = await import('./sync-api.mjs')
const { createSchulnetzRuntime } = await import('./schulnetz-api.mjs')
const {
  browserLabel,
  createKantiWebApi,
  createKantiWebAppRoutes,
  createKantiWebStore,
  formatPairingCode,
  normalizePairingCode,
  parseCookies,
  PAIR_TTL_MS,
  SESSION_IDLE_MS,
} = await import('./kanti-web-api.mjs')
const { mergeRevealLedger, newGradeTargetIds, tamSchoolRoot, unrevealedGradeIds, webGradeView, gradeTargetId } = await import('./schulnetz-logic.mjs')

const WEB = 'schulnetz.fasrv.ch'
const ORIGIN = `https://${WEB}`
const DEVICE = '0123456789abcdef01234567'

const grade = (id, title, mark, date = '2026-10-01') => ({ id, course: 'Mathematik', courseId: 'M-2a', subject: 'Mathematik', title, date, mark, weight: 1, comment: '', confirmed: true, courseGrade: 4.75 })
const snapshotWith = (grades, extra = {}) => ({
  fetchedAt: '2026-11-10T08:00:00.000Z',
  gradesReadComplete: true,
  grades,
  events: [{ id: 'l1', eventType: 'lesson', start: '2026-11-10T07:40:00', end: '2026-11-10T08:25:00', text: 'Mathematik', courseName: 'Mathematik', room: 'B101', teachers: ['Xa'], status: '' }],
  exams: [],
  absences: [],
  homework: [],
  messages: [],
  vacations: [],
  konto: [],
  startMessages: [],
  ...extra,
})

const start = async ({ clock } = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'kanti-web-'))
  const now = clock || (() => new Date())
  const pushes = []
  const store = createKantiWebStore({ root, now })
  const schulnetz = createSchulnetzRuntime({
    root,
    key: randomBytes(32),
    autostart: false,
    now,
    log: () => {},
    fetch: async () => { throw new Error('no network in tests') },
    fcmSend: async (message) => { pushes.push(message); return { status: 200 } },
    web: createKantiWebAppRoutes(store, { now }),
  })
  const web = createKantiWebApi({ store, access: schulnetz.webAccess, now, hosts: [WEB], log: () => {} })
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    if (await handleSyncRequest(request, response, url)) return
    if (await schulnetz.handle(request, response, url)) return
    if (await web.handle(request, response, url)) return
    response.writeHead(404, { 'Content-Type': 'application/json' })
    response.end('{"error":"fallthrough"}')
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const base = `http://127.0.0.1:${server.address().port}`
  const close = async () => {
    await new Promise((done) => server.close(done))
    await rm(root, { recursive: true, force: true })
  }
  return { base, root, store, schulnetz, pushes, close }
}

/** A browser: keeps its cookies like a real one would for this origin. */
const browser = (base, userAgent = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0') => {
  const jar = {}
  let csrf = ''
  const call = async (method, path, body, extra = {}) => {
    const headers = { 'X-Forwarded-Host': WEB, 'User-Agent': userAgent, ...extra }
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
      const [name, value] = [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]
      assert.ok(attributes.includes('HttpOnly') && attributes.includes('Secure') && attributes.includes('SameSite=Strict') && attributes.includes('Path=/'), line)
      assert.ok(name.startsWith('__Host-'), name)
      if (attributes.includes('Max-Age=0')) delete jar[name]
      else jar[name] = value
    }
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : null }
  }
  return {
    jar,
    call,
    async session() {
      const result = await call('GET', '/session')
      // Signed out is an answer (200, signedIn false); the tests read it as 401 like every other route.
      if (result.status === 200 && result.body?.signedIn === false) return { status: 401, body: result.body }
      if (result.status === 200) csrf = result.body.csrf
      return result
    },
    setCsrf(value) { csrf = value },
  }
}

/** An app identity (anonymous guest), as the Kanti+ app has one per connection. */
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

const linkSchulnetz = (app) => app.call('PUT', '/link', {
  mode: 'web',
  baseUrl: 'https://www.schulnetz-ag.ch/aksa',
  deviceId: DEVICE,
  userAgent: 'KantiTest',
  ssoCookies: { 'login.microsoftonline.com': 'ESTSAUTHPERSISTENT=synthetic-cookie-value' },
})

const pairBrowser = async (base, apps, client = browser(base)) => {
  const started = await client.call('POST', '/pair')
  assert.equal(started.status, 200)
  assert.match(started.body.code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/u)
  for (const [index, app] of apps.entries()) {
    const joined = await app.call('POST', '/web-pair', { code: started.body.code, connectionId: `c${index}`, label: `Verbindung ${index + 1}`, provider: app.provider || 'schulnetz', finish: index === apps.length - 1 })
    assert.equal(joined.status, 200, JSON.stringify(joined.body))
  }
  const claimed = await client.call('GET', '/pair')
  assert.equal(claimed.body.status, 'approved')
  const session = await client.session()
  assert.equal(session.status, 200)
  return { client, code: started.body.code, session: session.body }
}

test('pairing codes are Crockford base32 and forgive the usual misreadings', () => {
  assert.equal(normalizePairingCode('ab12-cd34'), 'AB12CD34')
  assert.equal(normalizePairingCode(' AB12 CD34 '), 'AB12CD34')
  assert.equal(normalizePairingCode('oIl0-0000'), '0110' + '0000')
  assert.equal(normalizePairingCode('AB12-CD3U'), '')
  assert.equal(normalizePairingCode('AB12-CD3'), '')
  assert.equal(formatPairingCode('AB12CD34'), 'AB12-CD34')
  assert.equal(browserLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36 Edg/141.0'), 'Edge · Windows')
  assert.equal(browserLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'), 'Safari · macOS')
  assert.equal(browserLabel('Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36'), 'Chrome · Android')
  assert.equal(browserLabel(''), 'Browser')
  assert.deepEqual(parseCookies('a=1; __Host-kanti=x.y; b='), { a: '1', '__Host-kanti': 'x.y', b: '' })
})

test('a paired browser reads exactly the shared connections and never a secret', async () => {
  const env = await start()
  try {
    const first = await appIdentity(env.base)
    const second = await appIdentity(env.base)
    const unshared = await appIdentity(env.base)
    for (const app of [first, second, unshared]) assert.equal((await linkSchulnetz(app)).status, 200)
    assert.equal((await first.call('PUT', '/snapshot', snapshotWith([grade('g1', 'Algebra', 5)]))).status, 200)
    assert.equal((await unshared.call('PUT', '/snapshot', snapshotWith([grade('x1', 'Fremd', 3)]))).status, 200)

    const client = browser(env.base)
    const started = await client.call('POST', '/pair')
    // The app sees which browser asks before it approves.
    const looked = await first.call('GET', `/web-pair?code=${encodeURIComponent(started.body.code.toLowerCase())}`)
    assert.equal(looked.status, 200)
    assert.equal(looked.body.browser, 'Firefox · Linux')
    assert.equal((await client.call('GET', '/pair')).body.status, 'waiting')
    assert.equal((await first.call('POST', '/web-pair', { code: started.body.code, label: 'AKSA', finish: false })).status, 200)
    assert.equal((await client.call('GET', '/pair')).body.status, 'waiting')
    assert.equal((await second.call('POST', '/web-pair', { code: started.body.code, label: 'Zweites Konto', finish: true })).status, 200)
    // Finished: nobody can add to it any more, and a second claim finds nothing.
    assert.equal((await unshared.call('POST', '/web-pair', { code: started.body.code, finish: true })).status, 409)
    const claimed = await client.call('GET', '/pair')
    assert.equal(claimed.body.status, 'approved')
    assert.equal(claimed.body.added, 2)
    assert.equal((await client.call('GET', '/pair')).body.status, 'expired')

    const session = await client.session()
    assert.equal(session.status, 200)
    assert.deepEqual(session.body.connections.map((item) => item.label), ['AKSA', 'Zweites Konto'])
    assert.ok(session.body.connections.every((item) => item.linked && item.provider === 'schulnetz' && /^[a-f0-9]{12}$/u.test(item.id)))
    const text = JSON.stringify(session.body)
    for (const secret of [first.accountId, second.accountId, 'synthetic-cookie-value']) assert.equal(text.includes(secret), false)

    const snapshot = await client.call('GET', `/connections/${session.body.connections[0].id}/snapshot`)
    assert.equal(snapshot.status, 200)
    assert.equal(snapshot.body.grades[0].mark, 5)
    assert.equal(snapshot.body.grades[0].targetId, gradeTargetId(grade('g1', 'Algebra', 5)))
    assert.equal(snapshot.body.events.length, 1)
    assert.equal(JSON.stringify(snapshot.body).includes('Fremd'), false)
    // A connection id from another session or a made-up one is not readable.
    assert.equal((await client.call('GET', '/connections/aaaaaaaaaaaa/snapshot')).status, 404)
    // The app lists this browser and can see how many browsers read it.
    const listed = await first.call('GET', '/web-sessions')
    assert.equal(listed.body.sessions.length, 1)
    assert.equal(listed.body.sessions[0].browser, 'Firefox · Linux')
    assert.equal((await first.call('GET', '/status')).body.webSessions, 1)
    assert.equal((await unshared.call('GET', '/status')).body.webSessions, 0)
  } finally {
    await env.close()
  }
})

test('state changes need the origin, JSON and the session CSRF token', async () => {
  const env = await start()
  try {
    const app = await appIdentity(env.base)
    await linkSchulnetz(app)
    const { client, session } = await pairBrowser(env.base, [app])
    const id = session.connections[0].id
    assert.equal((await client.call('PUT', `/connections/${id}/settings`, { grades: false }, { 'X-Kanti-CSRF': '' })).status, 403)
    assert.equal((await client.call('PUT', `/connections/${id}/settings`, { grades: false }, { 'X-Kanti-CSRF': 'wrong' })).status, 403)
    assert.equal((await client.call('PUT', `/connections/${id}/settings`, { grades: false }, { Origin: 'https://evil.example' })).status, 403)
    assert.equal((await client.call('PUT', `/connections/${id}/settings`, { grades: false }, { 'Content-Type': 'text/plain' })).status, 415)
    assert.equal((await client.call('PUT', `/connections/${id}/settings`, { grades: false }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403)
    assert.equal((await client.call('POST', '/pair', {}, { Origin: 'https://evil.example' })).status, 403)
    assert.equal((await app.call('GET', '/status')).body.settings.grades, true)
    // With all three, the change reaches the app's own status, stamped so the app adopts it.
    const changed = await client.call('PUT', `/connections/${id}/settings`, { grades: false, guessGrades: true })
    assert.equal(changed.status, 200)
    const status = (await app.call('GET', '/status')).body
    assert.equal(status.settings.grades, false)
    assert.equal(status.settings.guessGrades, true)
    assert.ok(Date.parse(status.settingsUpdatedAt) > 0)
  } finally {
    await env.close()
  }
})

test('the API only answers on the web host', async () => {
  const env = await start()
  try {
    const response = await fetch(`${env.base}/api/v1/kanti-web/session`, { headers: { 'X-Forwarded-Host': 'fanotes.fasrv.ch' } })
    assert.equal((await response.json()).error, 'fallthrough')
    const health = await fetch(`${env.base}/api/v1/kanti-web/health`, { headers: { 'X-Forwarded-Host': WEB } })
    assert.equal((await health.json()).status, 'ok')
    assert.deepEqual((await browser(env.base).call('GET', '/session')).body, { signedIn: false })
    assert.equal((await browser(env.base).call('GET', '/connections/aaaaaaaaaaaa/snapshot')).status, 401)
  } finally {
    await env.close()
  }
})

test('the app can take a connection back, and a deleted identity disappears', async () => {
  const env = await start()
  try {
    const first = await appIdentity(env.base)
    const second = await appIdentity(env.base)
    await linkSchulnetz(first)
    await linkSchulnetz(second)
    const { client } = await pairBrowser(env.base, [first, second])
    const [listed] = (await first.call('GET', '/web-sessions')).body.sessions
    assert.equal((await first.call('DELETE', `/web-sessions/${listed.id}`)).body.removed, true)
    let session = await client.session()
    assert.deepEqual(session.body.connections.map((item) => item.label), ['Verbindung 2'])
    // Deleting the app identity (removing the connection in the app) ends the browser's access at once.
    assert.equal((await second.call('DELETE', '/guest')).status, 200)
    assert.deepEqual(await readdir(join(env.root, 'web', 'sessions')), [])
    session = await client.session()
    assert.equal(session.status, 401)
    assert.equal('__Host-kanti' in client.jar, false)
    assert.deepEqual(await readdir(join(env.root, 'web', 'sessions')), [])
  } finally {
    await env.close()
  }
})

test('codes expire, are single-use and cannot be walked', async () => {
  let at = Date.parse('2026-11-10T08:00:00Z')
  const env = await start({ clock: () => new Date(at) })
  try {
    const app = await appIdentity(env.base)
    await linkSchulnetz(app)
    const client = browser(env.base)
    const started = await client.call('POST', '/pair')
    at += PAIR_TTL_MS + 1000
    assert.equal((await app.call('GET', `/web-pair?code=${started.body.code}`)).status, 404)
    assert.equal((await client.call('GET', '/pair')).body.status, 'expired')
    // A cancelled pairing is gone for the app too.
    const other = browser(env.base)
    const fresh = await other.call('POST', '/pair')
    assert.equal((await other.call('DELETE', '/pair')).body.status, 'cancelled')
    const identity = await appIdentity(env.base)
    assert.equal((await identity.call('POST', '/web-pair', { code: fresh.body.code, finish: true })).status, 404)
    // Twenty wrong codes from one address, then the address waits, whichever identity asks.
    let last = null
    for (let index = 0; index < 20; index += 1) last = await app.call('GET', `/web-pair?code=ZZZZ-${String(index).padStart(4, '0')}`)
    assert.equal(last.status, 429)
    assert.equal((await identity.call('GET', `/web-pair?code=ZZZZ-9999`)).status, 429)
  } finally {
    await env.close()
  }
})

test('an idle session ends after 30 days; use keeps it alive up to 90', async () => {
  let at = Date.parse('2026-11-10T08:00:00Z')
  const env = await start({ clock: () => new Date(at) })
  try {
    const app = await appIdentity(env.base)
    await linkSchulnetz(app)
    const { client } = await pairBrowser(env.base, [app])
    for (let day = 0; day < 80; day += 20) {
      at += 20 * 24 * 3600 * 1000
      assert.equal((await client.session()).status, 200, `day ${day + 20}`)
    }
    at += 15 * 24 * 3600 * 1000
    assert.equal((await client.session()).status, 401, 'past 90 days')
    const idle = await pairBrowser(env.base, [app])
    at += SESSION_IDLE_MS + 1000
    assert.equal((await idle.client.session()).status, 401)
  } finally {
    await env.close()
  }
})

const registerFaNotes = async (base, email, authKey) => {
  const response = await fetch(`${base}/api/v1/sync/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      authKey,
      kdf: { algorithm: 'pbkdf2-sha256', iterations: 600000, salt: randomBytes(16).toString('base64') },
      vaultKeyWrap: { iv: randomBytes(12).toString('base64'), data: randomBytes(48).toString('base64') },
      device: { name: 'Test', platform: 'android' },
    }),
  })
  assert.equal(response.status, 201)
  return response.json()
}

test('FaNotes sign-in shows the account connection and ends with a password change', async () => {
  const env = await start()
  try {
    const authKey = randomBytes(32).toString('base64')
    const email = `web-${randomBytes(4).toString('hex')}@example.test`
    const account = await registerFaNotes(env.base, email, authKey)
    // The account's school link, as the app stores it for the primary connection.
    await env.schulnetz.linkAccount(account.accountId, {
      mode: 'web', baseUrl: 'https://www.schulnetz-ag.ch/aksa', deviceId: DEVICE, userAgent: 'KantiTest',
      ssoCookies: { 'login.microsoftonline.com': 'ESTSAUTHPERSISTENT=synthetic-cookie-value' },
    })
    const client = browser(env.base)
    const pre = await client.call('POST', '/prelogin', { email })
    assert.equal(pre.status, 200)
    assert.equal(pre.body.kdf.iterations, 600000)
    // An unknown address gets a stable answer of the same shape.
    const unknown = await client.call('POST', '/prelogin', { email: 'nobody@example.test' })
    assert.deepEqual(Object.keys(unknown.body.kdf).sort(), ['algorithm', 'iterations', 'salt'])
    assert.equal((await client.call('POST', '/login', { email, authKey: randomBytes(32).toString('base64') })).status, 401)
    assert.equal((await client.call('POST', '/login', { email: 'nobody@example.test', authKey })).status, 401)
    assert.equal((await client.call('POST', '/login', { email, authKey }, { Origin: 'https://evil.example' })).status, 403)
    const login = await client.call('POST', '/login', { email, authKey })
    assert.equal(login.status, 200)
    const session = await client.session()
    assert.equal(session.body.account, 'fanotes')
    assert.equal(session.body.connections.length, 1)
    assert.equal(session.body.connections[0].source, 'fanotes')
    assert.equal(session.body.connections[0].linked, true)
    assert.equal(JSON.stringify(session.body).includes(email), false)

    // Password change in the app: every other session ends, this one too.
    const password = await fetch(`${env.base}/api/v1/sync/password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${account.token}`, 'X-FaNotes-Account': account.accountId },
      body: JSON.stringify({
        authKey,
        newAuthKey: randomBytes(32).toString('base64'),
        kdf: { algorithm: 'pbkdf2-sha256', iterations: 600000, salt: randomBytes(16).toString('base64') },
        vaultKeyWrap: { iv: randomBytes(12).toString('base64'), data: randomBytes(48).toString('base64') },
      }),
    })
    assert.equal(password.status, 204)
    assert.equal((await client.session()).status, 401)
  } finally {
    await env.close()
  }
})

test('hidden grades: a new mark never reaches the browser until it is revealed', async () => {
  const env = await start()
  try {
    const app = await appIdentity(env.base)
    await linkSchulnetz(app)
    assert.equal((await app.call('PUT', '/settings', { guessGrades: true })).status, 200)
    const first = [grade('g1', 'Algebra', 5), { ...grade('avg', 'Durchschnitt', 4.75), date: '' }]
    assert.equal((await app.call('PUT', '/snapshot', snapshotWith(first))).status, 200)
    const fresh = grade('g2', 'Geometrie', 3.5, '2026-11-09')
    assert.equal((await app.call('PUT', '/snapshot', snapshotWith([...first, fresh]))).body.changes, 1)
    const hiddenId = gradeTargetId(fresh)
    assert.deepEqual(unrevealedGradeIds((await app.call('GET', '/reveals')).body), [hiddenId])

    const { client, session } = await pairBrowser(env.base, [app])
    const id = session.connections[0].id
    let snapshot = (await client.call('GET', `/connections/${id}/snapshot`)).body
    const shown = snapshot.grades.find((item) => item.title === 'Geometrie')
    assert.equal(shown.hidden, true)
    assert.equal(shown.mark, null)
    // Neither the course average nor a summary row of that course gives it away.
    assert.ok(snapshot.grades.every((item) => item.courseGrade == null))
    assert.equal(snapshot.grades.find((item) => item.title === 'Durchschnitt').mark, null)
    assert.equal(JSON.stringify(snapshot).includes('3.5'), false)
    const changes = (await client.call('GET', `/connections/${id}/changes?since=0`)).body.changes
    assert.ok(changes.length >= 1)
    assert.equal(JSON.stringify(changes).includes('3.5'), false)

    const revealed = await client.call('POST', `/connections/${id}/reveal`, { ids: [hiddenId] })
    assert.deepEqual(revealed.body.hidden, [])
    snapshot = (await client.call('GET', `/connections/${id}/snapshot`)).body
    assert.equal(snapshot.grades.find((item) => item.title === 'Geometrie').mark, 3.5)
    // The app learns the reveal from the shared ledger.
    assert.deepEqual((await app.call('GET', '/reveals')).body.revealed, [hiddenId])
  } finally {
    await env.close()
  }
})

test('the app hides grades it still hides when it pairs', async () => {
  const env = await start()
  try {
    const app = await appIdentity(env.base)
    await linkSchulnetz(app)
    await app.call('PUT', '/settings', { guessGrades: true })
    const hiddenGrade = grade('g7', 'Funktionen', 6)
    await app.call('PUT', '/snapshot', snapshotWith([hiddenGrade]))
    const client = browser(env.base)
    const started = await client.call('POST', '/pair')
    await app.call('POST', '/web-pair', { code: started.body.code, finish: true, unrevealed: [gradeTargetId(hiddenGrade)] })
    await client.call('GET', '/pair')
    const session = await client.session()
    const snapshot = (await client.call('GET', `/connections/${session.body.connections[0].id}/snapshot`)).body
    assert.equal(snapshot.grades[0].mark, null)
  } finally {
    await env.close()
  }
})

test('a TAM connection is a device link: never polled, never pushed, shown in the browser', async () => {
  const env = await start()
  try {
    const tam = await appIdentity(env.base)
    tam.provider = 'tam'
    assert.equal((await tam.call('PUT', '/link', { mode: 'device', provider: 'tam', baseUrl: 'https://evil.example/bmz', deviceId: DEVICE })).status, 400)
    const linked = await tam.call('PUT', '/link', { mode: 'device', provider: 'tam', baseUrl: 'intranet.tam.ch/bmz/timetable', deviceId: DEVICE })
    assert.equal(linked.status, 200)
    assert.equal(linked.body.mode, 'device')
    assert.equal(linked.body.provider, 'tam')
    assert.equal(linked.body.baseUrl, 'https://intranet.tam.ch/bmz')
    assert.equal((await tam.call('PUT', '/push-token', { token: 'f'.repeat(40) })).status, 200)
    assert.deepEqual(await env.schulnetz.pollAccount(tam.accountId), { skipped: true })
    await tam.call('PUT', '/snapshot', snapshotWith([grade('t1', 'Aufsatz', 5)]))
    await tam.call('PUT', '/snapshot', snapshotWith([grade('t1', 'Aufsatz', 5), grade('t2', 'Vortrag', 5.5, '2026-11-08')]))
    assert.equal(env.pushes.length, 0)
    const link = JSON.parse(await readFile(join(env.root, 'accounts', tam.accountId, 'link.json'), 'utf8'))
    assert.equal(link.sso, undefined)
    const { client, session } = await pairBrowser(env.base, [tam])
    assert.equal(session.connections[0].provider, 'tam')
    const id = session.connections[0].id
    assert.equal((await client.call('GET', `/connections/${id}/snapshot`)).body.grades.length, 2)
    assert.ok((await client.call('GET', `/connections/${id}/changes?since=0`)).body.changes.some((change) => change.category === 'grade'))

    // A Schulnetz link with sealed cookies is never replaced by a device link.
    const school = await appIdentity(env.base)
    await linkSchulnetz(school)
    assert.equal((await school.call('PUT', '/link', { mode: 'device', provider: 'tam', baseUrl: 'bmz', deviceId: DEVICE })).status, 409)
  } finally {
    await env.close()
  }
})

test('a browser can pair again to add a connection, at most six', async () => {
  const env = await start()
  try {
    const apps = []
    for (let index = 0; index < 7; index += 1) {
      const app = await appIdentity(env.base)
      await linkSchulnetz(app)
      apps.push(app)
    }
    const { client } = await pairBrowser(env.base, apps.slice(0, 2))
    await pairBrowser(env.base, apps.slice(2, 6), client)
    assert.equal((await client.session()).body.connections.length, 6)
    await pairBrowser(env.base, [apps[6]], client)
    assert.equal((await client.session()).body.connections.length, 6)
    // Rename and remove only change this browser.
    const session = (await client.session()).body
    const renamed = await client.call('PATCH', `/connections/${session.connections[0].id}`, { label: '  Mein   Konto  ' })
    assert.equal(renamed.body.label, 'Mein Konto')
    assert.equal((await client.call('DELETE', `/connections/${session.connections[1].id}`)).body.removed, true)
    assert.equal((await client.session()).body.connections.length, 5)
    assert.equal((await apps[1].call('GET', '/status')).body.linked, true)
    assert.equal((await client.call('POST', '/logout')).body.signedOut, true)
    assert.equal((await client.session()).status, 401)
  } finally {
    await env.close()
  }
})

test('shared helpers behave like the app', () => {
  assert.equal(tamSchoolRoot('BMZ'), 'https://intranet.tam.ch/bmz')
  assert.equal(tamSchoolRoot('https://intranet.tam.ch/auth/azure'), null)
  assert.equal(tamSchoolRoot('http://intranet.tam.ch/bmz'), null)
  assert.deepEqual(newGradeTargetIds([
    { id: 'a', category: 'grade', targetIds: ['x', 'y'] },
    { id: 'b', category: 'grade', targetId: 'z' },
    { id: 'probe:1', category: 'grade', targetId: 'p' },
    { id: 'c', category: 'exam', targetId: 'e' },
  ]), ['x', 'y', 'z'])
  const merged = mergeRevealLedger({ hidden: ['a'], revealed: [] }, { hidden: ['b', 'a'], revealed: ['a', '../x'] })
  assert.deepEqual(merged, { version: 1, hidden: ['b', 'a'], revealed: ['a'] })
  assert.deepEqual(unrevealedGradeIds(merged), ['b'])
  const view = webGradeView([grade('g1', 'A', 5), { ...grade('g2', 'B', 4), courseId: 'D-1', course: 'Deutsch' }], [gradeTargetId(grade('g1', 'A', 5))], true)
  assert.equal(view[0].mark, null)
  assert.equal(view[1].mark, 4)
  assert.equal(view[1].courseGrade, 4.75)
  assert.equal(webGradeView([grade('g1', 'A', 5)], [gradeTargetId(grade('g1', 'A', 5))], false)[0].mark, 5)
})

test.after(async () => {
  await rm(syncDir, { recursive: true, force: true })
  await writeFile(join(tmpdir(), '.kanti-web-test-done'), '').catch(() => undefined)
})

test('the other direction: the app shows a code, the browser types it in (also on a phone)', async () => {
  const env = await start()
  try {
    const phone = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'
    const app = await appIdentity(env.base)
    assert.equal((await linkSchulnetz(app)).status, 200)
    const offer = await app.call('POST', '/web-pair/offer', {})
    assert.equal(offer.status, 200)
    assert.match(offer.body.code, /^[0-9A-HJKMNP-TV-Z]{8}$/u)
    const client = browser(env.base, phone)
    // Not approved yet: the browser is told to confirm in the app.
    assert.equal((await client.call('POST', '/pair/claim', { code: offer.body.code })).status, 409)
    // An app cannot look an offer up as if a browser waited for it.
    assert.equal((await app.call('GET', `/web-pair?code=${offer.body.code}`)).status, 404)
    assert.equal((await app.call('POST', '/web-pair', { code: offer.body.code, connectionId: 'c0', label: 'Kanti', provider: 'schulnetz', finish: true })).status, 200)
    // Typed with a dash, lower case and a misread O: still the same code.
    const typed = `${offer.body.code.slice(0, 4)}-${offer.body.code.slice(4)}`.toLowerCase().replace(/0/gu, 'o')
    const claimed = await client.call('POST', '/pair/claim', { code: typed })
    assert.equal(claimed.status, 200, JSON.stringify(claimed.body))
    assert.equal(claimed.body.added, 1)
    const session = await client.session()
    assert.equal(session.status, 200)
    assert.equal(session.body.connections.length, 1)
    // Single use; a foreign origin is refused; wrong codes are counted.
    assert.equal((await client.call('POST', '/pair/claim', { code: offer.body.code })).status, 404)
    assert.equal((await browser(env.base, phone).call('POST', '/pair/claim', { code: offer.body.code }, { Origin: 'https://evil.example' })).status, 403)
    const walker = browser(env.base, phone)
    let last = 0
    for (let index = 0; index < 22; index += 1) last = (await walker.call('POST', '/pair/claim', { code: 'ZZZZZZZZ' })).status
    assert.equal(last, 429)
  } finally {
    await env.close()
  }
})

test('the phone’s own read errors stay with the phone when the server reads the school itself', async () => {
  const env = await start()
  try {
    const app = await appIdentity(env.base)
    assert.equal((await linkSchulnetz(app)).status, 200)
    const upload = await app.call('PUT', '/snapshot', snapshotWith([grade('g1', 'Probe', 5)], { readErrors: Array(10).fill('Laden fehlgeschlagen') }))
    assert.equal(upload.status, 200)
    const { client } = await pairBrowser(env.base, [app])
    const id = (await client.session()).body.connections[0].id
    const snapshot = await client.call('GET', `/connections/${id}/snapshot`)
    assert.equal(snapshot.status, 200)
    assert.deepEqual(snapshot.body.readErrors, [])
    assert.equal(snapshot.body.deviceReadErrors.length, 10)
  } finally {
    await env.close()
  }
})
