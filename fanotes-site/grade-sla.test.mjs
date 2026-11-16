// The grade promise: a new grade reaches the phone within 10 minutes of appearing in Schulnetz, 24/7.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createDecipheriv, randomBytes } from 'node:crypto'
import { createSchulnetzRuntime } from './schulnetz-api.mjs'
import { GRADE_CHECK_JITTER, GRADE_CHECK_MS, GRADE_SLA_MS, createPollScheduler, gradeCheckDelayMs, latencyPercentile, sessionProblem } from './schulnetz-logic.mjs'
import { pushKeyBytes, sealPushChanges, sealPushPayload } from './fcm.mjs'

const openSealed = (keyBase64, sealed) => {
  const bytes = Buffer.from(sealed, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(keyBase64, 'base64'), bytes.subarray(0, 12))
  decipher.setAuthTag(bytes.subarray(bytes.length - 16))
  return Buffer.concat([decipher.update(bytes.subarray(12, bytes.length - 16)), decipher.final()]).toString('utf8')
}

test('a grade check is due at most every 4 minutes, with no backoff', () => {
  assert.equal(gradeCheckDelayMs(() => 0), Math.round(GRADE_CHECK_MS * (1 - GRADE_CHECK_JITTER)))
  assert.equal(gradeCheckDelayMs(() => 1), Math.round(GRADE_CHECK_MS * (1 + GRADE_CHECK_JITTER)))
  assert.ok(gradeCheckDelayMs(() => 1) <= 240_000)
})

test('every account’s grades are read at least every 5 minutes through nights, weekends and failures', async () => {
  // Saturday 14 November 2026, 00:00 Zurich, for 48 hours; ticks every 15 s; reads take 4–9 s.
  let clock = Date.parse('2026-11-13T23:00:00Z')
  const end = clock + 48 * 3600_000
  const accounts = Array.from({ length: 6 }, (_, index) => String(index).repeat(32))
  const reads = new Map(accounts.map((id) => [id, []]))
  let seed = 11
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
  const scheduler = createPollScheduler({
    listAccounts: async () => accounts,
    pollAccount: async (id, mode) => {
      clock += mode?.gradesOnly ? 4_000 : 9_000
      // Account 0 fails every read for 6 hours: grade checks must keep their pace.
      if (id === accounts[0] && clock < Date.parse('2026-11-14T05:00:00Z')) throw new Error('down')
      reads.get(id).push(clock)
      return { revision: 1 }
    },
    readSnapshot: async () => ({ events: [], weekRead: {} }),
    now: () => new Date(clock),
    baseMs: 150_000,
    random,
    sleep: async (ms) => { clock += ms },
  })
  const attempts = new Map(accounts.map((id) => [id, []]))
  const wrapped = scheduler.tick
  while (clock < end) {
    const before = new Map([...scheduler.gradeDue.entries()])
    await wrapped()
    for (const id of accounts) if (scheduler.gradeDue.get(id) !== before.get(id)) attempts.get(id).push(clock)
    clock += 15_000
  }
  for (const id of accounts) {
    const times = id === accounts[0] ? attempts.get(id) : reads.get(id)
    const gaps = times.slice(1).map((at, index) => at - times[index])
    assert.ok(Math.max(...gaps) < 5 * 60_000, `${id.slice(0, 2)} max gap ${Math.max(...gaps)} ms`)
  }
})

test('a new grade appearing at 03:00 on a Saturday is pushed, sealed for the phone, within 10 minutes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'schulnetz-grade-sla-'))
  let clock = Date.parse('2026-11-14T01:00:00Z') // Saturday 02:00 Zurich
  let marks = [['20.10.2026', 'Probe', '5.5']]
  const sent = []
  const grades = () => `<html><body><a href="index.php?pageid=21311&amp;id=abc123&amp;transid=a1b2c3">Noten</a><table><tr><td><b>MA-4a-He</b></td><td>5.5</td></tr><tr><td><table>${marks.map(([date, title, mark]) => `<tr><td>${date}</td><td>${title}</td><td>${mark}</td><td>1</td></tr>`).join('')}</table></td></tr></table></body></html>`
  const fetch = async (url, options = {}) => {
    const target = String(url)
    const cookie = options.headers?.Cookie || ''
    if ((options.method || 'GET') !== 'GET') throw new Error(`not read-only: ${options.method}`)
    const response = (status, body, { location = '', cookies = [] } = {}) => ({ status, headers: { get: (name) => (name.toLowerCase() === 'location' ? location : null) }, setCookies: cookies, text: async () => body })
    if (target.endsWith('/index.php?pageid=1') && !cookie.includes('PHPSESSID=server-session')) return response(302, '', { location: 'https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize?redirect_uri=https%3A%2F%2Fwww.schulnetz-ag.ch%2Faksa%2F' })
    if (target.includes('login.microsoftonline.com')) return response(302, '', { location: 'https://www.schulnetz-ag.ch/aksa/?code=abc' })
    if (target.includes('/aksa/?code=')) return response(200, '<a href="index.php?pageid=21311&id=abc123&transid=a1b2c3">Noten</a>', { cookies: ['PHPSESSID=server-session; Path=/; HttpOnly'] })
    if (target.includes('scheduler_processor')) return response(200, "<?xml version='1.0' encoding='utf-8' ?><data></data>")
    if (target.includes('pageid=21311')) return response(200, grades())
    return response(200, '<html><body><a href="index.php?pageid=21311&amp;id=abc123&amp;transid=a1b2c3">Noten</a></body></html>')
  }
  const logs = []
  const runtime = createSchulnetzRuntime({
    root, key: randomBytes(32), fetch, autostart: false, spacingMs: 0,
    now: () => new Date(clock),
    log: (level, message) => logs.push(`${level} ${message}`),
    fcmSend: async (message) => { sent.push({ at: clock, message: message.message }); return { status: 200 } },
  })
  try {
    const guest = await runtime.createGuest('203.0.113.70')
    await runtime.linkAccount(guest.accountId, { mode: 'web', baseUrl: 'https://www.schulnetz-ag.ch/aksa', deviceId: '0123456789abcdef01234567', userAgent: 'KantiTest', ssoCookies: { 'login.microsoftonline.com': 'ESTSAUTHPERSISTENT=synthetic' } })
    // The app registers its push token with its device key.
    const pushKey = randomBytes(32).toString('base64')
    const token = `${'f'.repeat(40)}:APA91b${'x'.repeat(120)}`
    const request = Readable.from([Buffer.from(JSON.stringify({ token, key: pushKey }))])
    request.method = 'PUT'
    request.headers = { authorization: `Bearer ${guest.token}`, 'x-kanti-guest': guest.accountId, 'content-type': 'application/json' }
    request.socket = { remoteAddress: '198.51.100.10' }
    let status = 0
    await runtime.handle(request, { writeHead(code) { status = code }, end() {} }, new URL('http://127.0.0.1/api/v1/schulnetz/push-token'))
    assert.equal(status, 200)
    const stored = await readFile(join(root, 'accounts', guest.accountId, 'link.json'), 'utf8')
    assert.equal(stored.includes(pushKey), false, 'the push key is sealed at rest')
    // Run the poller for an hour of quiet: the first read is the silent baseline.
    const runFor = async (ms) => { const stop = clock + ms; while (clock < stop) { await runtime.scheduler.tick(); clock += 15_000 } }
    await runFor(60 * 60_000)
    assert.equal(sent.filter((item) => item.message.data.event === 'sync').length, 0)
    // 03:00 Zurich: a new grade appears in Schulnetz.
    clock = Math.max(clock, Date.parse('2026-11-14T02:00:00Z'))
    const appeared = clock
    marks = [...marks, ['13.11.2026', 'Funktionen', '5']]
    while (!sent.some((item) => item.message.data.event === 'sync') && clock < appeared + 30 * 60_000) { await runtime.scheduler.tick(); clock += 15_000 }
    const push = sent.find((item) => item.message.data.event === 'sync')
    assert.ok(push, 'a push was sent')
    assert.ok(push.at - appeared <= GRADE_SLA_MS, `pushed ${Math.round((push.at - appeared) / 1000)} s after the grade appeared`)
    assert.ok(push.at - appeared <= 5 * 60_000, 'well inside the promise')
    // High priority, and the notice itself sealed for this device: the app shows it without asking first.
    assert.equal(push.message.android.priority, 'HIGH')
    assert.equal(push.message.data.v, '1')
    const notices = JSON.parse(openSealed(pushKey, push.message.data.n)).changes
    assert.equal(notices[0].category, 'grade')
    assert.match(`${notices[0].title} ${notices[0].body}`, /Funktionen|5/u)
    assert.ok(!JSON.stringify(push.message.data).includes('Funktionen'), 'Google sees no school content')
    // Monitoring: the last grade check is fresh, the detection-to-push latency is recorded.
    const health = await runtime.health()
    assert.equal(health.status, 'ok')
    assert.ok(health.gradeChecks.maxAgeSeconds < GRADE_SLA_MS / 1000)
    assert.equal(health.pushes24h.count, 1)
    assert.ok(health.pushes24h.maxLatencyMs >= 0 && health.pushes24h.maxLatencyMs < 60_000)
    assert.equal(health.pushes24h.p50LatencyMs, health.pushes24h.maxLatencyMs)
    assert.equal(health.pushes24h.p95LatencyMs, health.pushes24h.maxLatencyMs)
    assert.equal(health.pushes24h.overdue, 0)
    assert.ok(logs.some((line) => /^info Noten geprüft [a-f0-9]{8} kurz ok/u.test(line)), 'grade checks are logged')
    // Without reads for 11 minutes the promise is broken: health says so and the poller warns once.
    clock += 11 * 60_000
    const broken = await runtime.health()
    assert.equal(broken.status, 'degraded')
    assert.equal(broken.gradeChecks.overdue, 1)
    await runtime.watchGradePromise()
    await runtime.watchGradePromise()
    assert.equal(logs.filter((line) => line.startsWith('warn Notenprüfung überfällig')).length, 1)
    let healthStatus = 0
    const healthRequest = Readable.from([])
    healthRequest.method = 'GET'
    healthRequest.headers = {}
    healthRequest.socket = { remoteAddress: '198.51.100.10' }
    let body = ''
    await runtime.handle(healthRequest, { writeHead(code) { healthStatus = code }, end(value) { body = value || '' } }, new URL('http://127.0.0.1/api/v1/schulnetz/health'))
    assert.equal(healthStatus, 503)
    assert.ok(!body.includes(guest.accountId), 'no account ids in the public health')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an expired sign-in is announced once, not silently dropped', async () => {
  const root = await mkdtemp(join(tmpdir(), 'schulnetz-reauth-once-'))
  let clock = Date.parse('2026-11-14T08:00:00Z')
  const sent = []
  const runtime = createSchulnetzRuntime({ root, key: randomBytes(32), autostart: false, spacingMs: 0, now: () => new Date(clock), fetch: async () => ({ status: 500, headers: { get: () => null }, text: async () => '' }), fcmSend: async (message) => { sent.push(message.message.data.event); return { status: 200 } } })
  try {
    const guest = await runtime.createGuest('203.0.113.71')
    await runtime.linkAccount(guest.accountId, { mode: 'web', baseUrl: 'https://www.schulnetz-ag.ch/aksa', deviceId: '0123456789abcdef01234567', userAgent: 'KantiTest', ssoCookies: { 'login.microsoftonline.com': 'ESTSAUTHPERSISTENT=synthetic' } })
    const linkPath = join(root, 'accounts', guest.accountId, 'link.json')
    const link = JSON.parse(await readFile(linkPath, 'utf8'))
    link.fcmTokens = [`${'e'.repeat(40)}:APA91b${'y'.repeat(120)}`]
    link.cookiesSavedAt = '2025-01-01T00:00:00Z' // the Microsoft sign-in is older than the server keeps it
    await (await import('node:fs/promises')).writeFile(linkPath, JSON.stringify(link))
    await runtime.pollAccount(guest.accountId)
    await runtime.pollAccount(guest.accountId)
    assert.deepEqual(sent, ['reauth'])
    const health = await runtime.health()
    assert.equal(health.gradeChecks.needsReauth, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('percentiles use nearest rank', () => {
  assert.equal(latencyPercentile([], 0.95), null)
  assert.equal(latencyPercentile([10, 20, 30, 40], 0.5), 20)
  assert.equal(latencyPercentile([10, 20, 30, 40], 0.95), 40)
})

test('a grade whose FCM response arrives after 10 minutes is overdue and logged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'schulnetz-push-sla-'))
  let clock = Date.parse('2026-11-14T08:00:00Z')
  let gradePolls = 0
  const lines = []
  const fetch = async (url) => {
    const target = String(url)
    const json = (value) => ({ status: 200, text: async () => JSON.stringify(value) })
    if (target.endsWith('/token.php')) return json({ access_token: 'access-token-value', refresh_token: 'rotated-refresh-token-value-123456', expires_in: 3600 })
    if (target.includes('/me/grades')) {
      gradePolls += 1
      const grades = [{ id: 'g1', course: 'Mathematik', courseId: 'math', title: 'Probe', date: '2026-11-14', mark: '5.5', weight: '1' }]
      if (gradePolls > 1) grades.push({ id: 'g2', course: 'Englisch', courseId: 'en', title: 'Essay', date: '2026-11-14', mark: '4.5', weight: '1' })
      return json(grades)
    }
    return json([])
  }
  const runtime = createSchulnetzRuntime({
    root,
    key: randomBytes(32),
    autostart: false,
    now: () => new Date(clock),
    log: (level, message) => lines.push(`${level} ${message}`),
    fetch,
    fcmSend: async () => { clock += 11 * 60_000; return { status: 200 } },
  })
  try {
    const accountId = 'a'.repeat(32)
    await runtime.linkAccount(accountId, { baseUrl: 'https://www.schulnetz-ag.ch/aksa', deviceId: '0123456789abcdef01234567', refreshToken: 'synthetic-refresh-token-long-enough' })
    await runtime.addFcmToken(accountId, 'phone:APA91b-sla-device-token')
    await runtime.pollAccount(accountId)
    await runtime.pollAccount(accountId)
    const health = await runtime.health()
    assert.equal(health.pushes24h.count, 1)
    assert.ok(health.pushes24h.maxLatencyMs > GRADE_SLA_MS)
    assert.equal(health.pushes24h.p50LatencyMs, health.pushes24h.maxLatencyMs)
    assert.equal(health.pushes24h.p95LatencyMs, health.pushes24h.maxLatencyMs)
    assert.equal(health.pushes24h.overdue, 1)
    const warn = lines.find((line) => line.startsWith('warn Noten-Push über 10 Minuten'))
    assert.ok(warn, lines.join('\n'))
    assert.match(warn, /FCM 200/)
    assert.equal(warn.includes('APA91b'), false)
    assert.equal(warn.includes('synthetic'), false)
    const stored = await readFile(join(root, 'accounts', accountId, 'monitor.json'), 'utf8')
    assert.equal(stored.includes('APA91b'), false)
    const row = JSON.parse(stored).pushes[0]
    assert.equal(row.fcm[0], '200')
    assert.ok(row.respondedAt > row.at)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('sealed notices fit the FCM data limit and open with the device key', () => {
  const key = pushKeyBytes(randomBytes(32).toString('base64'))
  assert.ok(key)
  assert.equal(pushKeyBytes('short'), null)
  const many = Array.from({ length: 40 }, (_, index) => ({ id: `grade:${index}`, category: index % 2 ? 'exam' : 'grade', title: 'Neue Note', body: `Mathematik · Prüfung ${index} · 5.5` }))
  const { sealed, more } = sealPushChanges(key, many)
  assert.ok(sealed.length <= 3000)
  assert.equal(more, true)
  const opened = JSON.parse(openSealed(key.toString('base64'), sealed)).changes
  assert.ok(opened.length > 0 && opened.every((change, index, list) => index === 0 || change.category !== 'grade' || list[index - 1].category === 'grade'))
  // A fixed vector shared with the app's PushPayloadTest.kt.
  const vectorKey = Buffer.alloc(32, 7)
  const vectorIv = Buffer.alloc(12, 9)
  assert.equal(sealPushPayload(vectorKey, '{"changes":[{"id":"grade:1","category":"grade","title":"Neue Note","body":"Mathematik · 5.5"}]}', vectorIv),
    'CQkJCQkJCQkJCQkJXKfn/N+epgTTQPFjncjKu/aKQZRGj5OlVZ9kivcXYA62goixm3AQMhjBxHIhFs/2CD3q+He2lGwrCnTydlgV+gldpCzrSYja+trrOd6d7JBwiL9/wCcGCl2KeLN9+lAf4R8XRSRky5q4XgYZpTt+Ug==')
})

test('health counts a DNS failure as network and does not repeat the host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'schulnetz-poll-error-'))
  const lines = []
  const runtime = createSchulnetzRuntime({
    root,
    key: randomBytes(32),
    autostart: false,
    spacingMs: 0,
    log: (level, message) => lines.push(`${level} ${message}`),
    fetch: async () => {
      const error = new TypeError('fetch failed')
      error.cause = Object.assign(new Error('getaddrinfo ENOTFOUND www.schulnetz-ag.ch'), { code: 'ENOTFOUND' })
      throw error
    },
  })
  try {
    const guest = await runtime.createGuest('203.0.113.71')
    await runtime.linkAccount(guest.accountId, {
      mode: 'web',
      baseUrl: 'https://www.schulnetz-ag.ch/aksa',
      deviceId: '0123456789abcdef01234567',
      userAgent: 'KantiTest',
      ssoCookies: { 'login.microsoftonline.com': 'ESTSAUTHPERSISTENT=synthetic' },
    })
    await runtime.scheduler.tick()
    const health = await runtime.health()
    assert.equal(health.pollErrors.network, 1)
    assert.equal(health.pollErrors.code, 0)
    assert.equal(health.pollErrors.codes.ENOTFOUND, 1)
    assert.equal(JSON.stringify(health).includes(guest.accountId), false)
    assert.equal(JSON.stringify(health).includes('schulnetz'), false)
    const warn = lines.find((line) => line.includes('nicht aktualisiert'))
    assert.match(warn, /network ENOTFOUND stage=fetch/)
    assert.equal(warn.includes('schulnetz-ag'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a transient grade read is retried, a maintenance page keeps the book, and polls do not overlap or leave temp files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'schulnetz-robust-'))
  let gradeHits = 0
  let inFlight = 0
  let maxInFlight = 0
  const grade = [{ id: 'g1', course: 'Mathematik', courseId: 'math', title: 'Probe', date: '2026-11-14', mark: '5.5', weight: '1' }]
  const fetch = async (url, init) => {
    assert.ok(init?.signal, 'every outbound call has a timeout')
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise((resolve) => setTimeout(resolve, 20))
    inFlight -= 1
    const target = String(url)
    const json = (value, status = 200) => ({ status, headers: { get: () => null }, text: async () => (typeof value === 'string' ? value : JSON.stringify(value)) })
    if (target.endsWith('/token.php')) return json({ access_token: 'access-token-value', refresh_token: 'rotated-refresh-token-value-123456', expires_in: 3600 })
    if (target.includes('/me/grades')) {
      gradeHits += 1
      if (gradeHits < 3) return json('temporarily unavailable', 503)
      return json(grade)
    }
    if (target.includes('pageid=')) return json('<html><body>Wartungsarbeiten</body></html>')
    return json([])
  }
  const runtime = createSchulnetzRuntime({ root, key: randomBytes(32), autostart: false, spacingMs: 0, fetch, fcmSend: async () => ({ status: 200 }) })
  try {
    assert.equal(sessionProblem('https://www.schulnetz-ag.ch/aksa/', '<html><body>Wartungsarbeiten</body></html>'), 'maintenance')
    assert.equal(sessionProblem('https://www.schulnetz-ag.ch/aksa/index.php?pageid=21311', '<html><body><a href="index.php?pageid=21311">Noten</a> wegen Wartung verschoben</body></html>'), '')
    const accountId = 'b'.repeat(32)
    await runtime.linkAccount(accountId, { baseUrl: 'https://www.schulnetz-ag.ch/aksa', deviceId: '0123456789abcdef01234567', refreshToken: 'synthetic-refresh-token-long-enough' })
    await runtime.pollAccount(accountId)
    const first = JSON.parse(await readFile(join(root, 'accounts', accountId, 'snapshot.json'), 'utf8'))
    assert.equal(first.grades[0].mark, 5.5)
    assert.equal(gradeHits, 3)
    const again = Promise.all([runtime.pollAccount(accountId), runtime.pollAccount(accountId)])
    await again
    assert.equal(maxInFlight, 1)
    const names = await readdir(join(root, 'accounts', accountId))
    assert.equal(names.some((name) => name.endsWith('.tmp') || name.includes('.tmp')), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an unreadable account file is left in place', async () => {
  const root = await mkdtemp(join(tmpdir(), 'schulnetz-read-'))
  const accountId = 'e'.repeat(32)
  const calls = []
  const runtime = createSchulnetzRuntime({
    root,
    key: randomBytes(32),
    autostart: false,
    pruneOrphans: true,
    now: () => new Date('2026-11-15T12:00:00.000Z'),
    fetch: async (url) => {
      const target = String(url)
      calls.push(target.endsWith('/token.php') ? 'token' : 'school')
      if (target.endsWith('/token.php')) {
        return { status: 200, text: async () => JSON.stringify({ access_token: 'access-token-value', refresh_token: 'rotated-refresh-token-value-123456', expires_in: 3600 }) }
      }
      throw new Error('school read')
    },
    syncAccountExists: async () => true,
    fcmSend: async () => ({ status: 200 }),
  })
  const snapshot = join(root, 'accounts', accountId, 'snapshot.json')
  const linkFile = join(root, 'accounts', accountId, 'link.json')
  let guestFile
  try {
    await runtime.linkAccount(accountId, {
      baseUrl: 'https://www.schulnetz-ag.ch/aksa',
      deviceId: '0123456789abcdef01234567',
      refreshToken: 'synthetic-refresh-token-long-enough',
    })
    const stored = JSON.stringify({ revision: 3, grades: [{ id: 'kept-grade' }], fetchedAt: '2026-11-15T08:00:00.000Z' })
    await writeFile(snapshot, stored, { mode: 0o600 })
    await chmod(snapshot, 0o000)
    await assert.rejects(() => runtime.pollAccount(accountId), { code: 'EACCES' })
    assert.deepEqual(calls, ['token'])
    await chmod(snapshot, 0o600)
    assert.equal(await readFile(snapshot, 'utf8'), stored)
    const linkBefore = await readFile(linkFile)
    await chmod(linkFile, 0o000)
    const health = await runtime.health()
    assert.equal(typeof health.status, 'string')
    assert.equal(typeof health.gradeChecks.overdue, 'number')
    await assert.rejects(() => runtime.pollAccount(accountId), { code: 'EACCES' })
    await chmod(linkFile, 0o600)
    assert.deepEqual(await readFile(linkFile), linkBefore)

    const guest = await runtime.createGuest('203.0.113.72')
    guestFile = join(root, 'accounts', guest.accountId, 'guest.json')
    const guestBefore = await readFile(guestFile)
    await chmod(guestFile, 0o000)
    await assert.rejects(() => runtime.pollAccount(guest.accountId), { code: 'EACCES' })
    await chmod(guestFile, 0o600)
    assert.deepEqual(await readFile(guestFile), guestBefore)
    assert.equal((await readdir(join(root, 'accounts'))).includes(guest.accountId), true)
  } finally {
    await chmod(snapshot, 0o600).catch(() => undefined)
    await chmod(linkFile, 0o600).catch(() => undefined)
    if (guestFile) await chmod(guestFile, 0o600).catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})

test('a broken guest file does not remove the account', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grade-guest-'))
  const runtime = createSchulnetzRuntime({
    root,
    key: randomBytes(32),
    fetch: async () => { throw new Error('school') },
    autostart: false,
    pruneOrphans: true,
    syncAccountExists: async () => false,
  })
  try {
    const guest = await runtime.createGuest('203.0.113.80')
    const dir = join(root, 'accounts', guest.accountId)
    const guestFile = join(dir, 'guest.json')
    const snapshot = join(dir, 'snapshot.json')
    const marker = '{"keep":true}\n'
    await writeFile(snapshot, marker, { mode: 0o600 })
    await writeFile(guestFile, '{', { mode: 0o600 })
    await assert.rejects(() => runtime.pollAccount(guest.accountId), (error) => error?.code === 'EBADMSG')
    await assert.rejects(() => runtime.unlink(guest.accountId), (error) => error?.code === 'EBADMSG')
    assert.equal(await readFile(guestFile, 'utf8'), '{')
    assert.equal(await readFile(snapshot, 'utf8'), marker)
    const accountId = 'a'.repeat(32)
    await mkdir(join(root, 'accounts', accountId), { recursive: true, mode: 0o700 })
    await writeFile(join(root, 'accounts', accountId, 'link.json'), '{"mode":"rest"}\n', { mode: 0o600 })
    const removed = await runtime.pollAccount(accountId)
    assert.equal(removed.skipped, true)
    assert.equal((await readdir(join(root, 'accounts'))).includes(accountId), false)
    assert.equal((await readdir(join(root, 'accounts'))).includes(guest.accountId), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an unreadable poller lock and change log are left in place', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grade-lock-'))
  const runtime = createSchulnetzRuntime({
    root,
    key: randomBytes(32),
    fetch: async () => { throw new Error('school') },
    autostart: false,
  })
  const lock = join(root, 'poller.lock')
  const marker = '2147483646\n'
  const accountId = 'b'.repeat(32)
  const logFile = join(root, 'accounts', accountId, 'changes.jsonl')
  const row = '{"id":"keep","revision":2,"category":"grade"}\n'
  try {
    await writeFile(lock, marker, { mode: 0o600 })
    await chmod(lock, 0o000)
    assert.equal(await runtime.claimPoller(), false)
    await chmod(lock, 0o600)
    assert.equal(await readFile(lock, 'utf8'), marker)
    await writeFile(lock, marker, { mode: 0o600 })
    assert.equal(await runtime.claimPoller(), true)
    assert.equal(await readFile(lock, 'utf8'), String(process.pid))
    await mkdir(join(root, 'accounts', accountId), { recursive: true, mode: 0o700 })
    await writeFile(logFile, row, { mode: 0o600 })
    const seen = await runtime.webAccess.changesSince(accountId, 0)
    assert.equal(seen.changes.length, 1)
    assert.equal(seen.changes[0].id, 'keep')
    await chmod(logFile, 0o000)
    await assert.rejects(() => runtime.webAccess.changesSince(accountId, 0), (error) => error?.code === 'EACCES')
    await chmod(logFile, 0o600)
    assert.equal(await readFile(logFile, 'utf8'), row)
    assert.deepEqual((await runtime.webAccess.changesSince('c'.repeat(32), 0)).changes, [])
  } finally {
    await chmod(lock, 0o600).catch(() => undefined)
    await chmod(logFile, 0o600).catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})

test('a grade ledger key that is not text is left in place', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grade-ledger-key-'))
  const runtime = createSchulnetzRuntime({
    root,
    key: randomBytes(32),
    fetch: async () => { throw new Error('school') },
    autostart: false,
  })
  try {
    const guest = await runtime.createGuest('203.0.113.89')
    await runtime.linkAccount(guest.accountId, {
      baseUrl: 'https://www.schulnetz-ag.ch/aksa',
      deviceId: '0123456789abcdef01234567',
      refreshToken: 'synthetic-refresh-token-long-enough',
    })
    const file = join(root, 'accounts', guest.accountId, 'notified-grades.json')
    const call = async () => {
      const request = {
        method: 'PUT',
        headers: { 'x-kanti-guest': guest.accountId, authorization: `Bearer ${guest.token}` },
        socket: { remoteAddress: '203.0.113.89' },
        async *[Symbol.asyncIterator]() { yield Buffer.from('{"grades":[]}') },
      }
      let status = 0
      await runtime.handle(request, { writeHead(code) { status = code }, end() {} }, new URL('http://127.0.0.1/api/v1/schulnetz/snapshot'))
      return status
    }
    const keep = async (keys) => {
      const stored = `${JSON.stringify({ version: 1, keys })}\n`
      await writeFile(file, stored, { mode: 0o600 })
      assert.equal(await call(), 500)
      assert.equal(await readFile(file, 'utf8'), stored)
    }
    await keep(['c:keep', { kept: true }])
    await keep(['c:keep', ''])
    await keep(['c:keep', 1])
    await writeFile(file, `${JSON.stringify({ version: 1, keys: ['c:keep'] })}\n`, { mode: 0o600 })
    assert.equal(await call(), 200)
    assert.equal(JSON.parse(await readFile(file, 'utf8')).keys.includes('c:keep'), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a grade ledger that is not the known shape is left in place', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grade-ledger-'))
  const runtime = createSchulnetzRuntime({
    root,
    key: randomBytes(32),
    fetch: async () => { throw new Error('school') },
    autostart: false,
    syncAccountExists: async () => true,
  })
  const fa = 'd'.repeat(32)
  const ledger = '{"version":2,"keys":["c:keep"]}\n'
  try {
    await runtime.linkAccount(fa, {
      baseUrl: 'https://www.schulnetz-ag.ch/aksa',
      deviceId: '0123456789abcdef01234567',
      refreshToken: 'synthetic-refresh-token-long-enough',
    })
    const guest = await runtime.createGuest('203.0.113.81')
    await runtime.linkAccount(guest.accountId, {
      baseUrl: 'https://www.schulnetz-ag.ch/aksa',
      deviceId: '0123456789abcdef01234567',
      refreshToken: 'synthetic-refresh-token-long-enough',
    })
    const file = join(root, 'accounts', fa, 'notified-grades.json')
    const guestLedger = join(root, 'accounts', guest.accountId, 'notified-grades.json')
    await writeFile(file, ledger, { mode: 0o600 })
    await writeFile(guestLedger, '{"version":1,"keys":["c:other"]}\n', { mode: 0o600 })
    await assert.rejects(
      () => runtime.adoptGuest(fa, { guestAccountId: guest.accountId, guestToken: guest.token }),
      (error) => error?.code === 'EBADMSG',
    )
    assert.equal(await readFile(file, 'utf8'), ledger)
    assert.equal(await readFile(guestLedger, 'utf8'), '{"version":1,"keys":["c:other"]}\n')
    assert.equal((await readdir(join(root, 'accounts'))).includes(guest.accountId), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an agenda week that is not a week is left in place', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grade-agenda-week-'))
  const runtime = createSchulnetzRuntime({
    root,
    key: randomBytes(32),
    fetch: async () => { throw new Error('school') },
    autostart: false,
  })
  try {
    const guest = await runtime.createGuest('203.0.113.90')
    await runtime.linkAccount(guest.accountId, {
      baseUrl: 'https://www.schulnetz-ag.ch/aksa',
      deviceId: '0123456789abcdef01234567',
      refreshToken: 'synthetic-refresh-token-long-enough',
    })
    const dir = join(root, 'accounts', guest.accountId)
    const file = join(dir, 'notification-baseline.json')
    const call = async () => {
      const request = {
        method: 'PUT',
        headers: { 'x-kanti-guest': guest.accountId, authorization: `Bearer ${guest.token}` },
        socket: { remoteAddress: '203.0.113.90' },
        async *[Symbol.asyncIterator]() { yield Buffer.from('{"grades":[]}') },
      }
      let status = 0
      await runtime.handle(request, { writeHead(code) { status = code }, end() {} }, new URL('http://127.0.0.1/api/v1/schulnetz/snapshot'))
      return status
    }
    const keep = async (week) => {
      const stored = `${JSON.stringify({ version: 1, weeks: { '2026-11-16': week } })}\n`
      await writeFile(file, stored, { mode: 0o600 })
      assert.equal(await call(), 500)
      assert.equal(await readFile(file, 'utf8'), stored)
    }
    await keep('kept')
    await keep({ events: 'kept', exams: [], weekFetched: {}, examWeekFetched: {} })
    await keep({ events: [], exams: 'kept', weekFetched: {}, examWeekFetched: {} })
    await keep({ events: [], exams: [], weekFetched: ['kept'], examWeekFetched: {} })
    const good = { keep: true, events: [], exams: [], weekFetched: {}, examWeekFetched: {}, fetchedAt: '2026-11-16T08:00:00.000Z' }
    await writeFile(file, JSON.stringify({ version: 1, weeks: { '2026-11-16': good } }), { mode: 0o600 })
    assert.equal(await call(), 200)
    assert.equal(JSON.parse(await readFile(file, 'utf8')).weeks['2026-11-16'].keep, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an agenda baseline that is not the known shape is left in place', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grade-agenda-'))
  const runtime = createSchulnetzRuntime({
    root,
    key: randomBytes(32),
    fetch: async () => { throw new Error('school') },
    autostart: false,
  })
  const baseline = '{"version":2,"weeks":{"2026-11-16":{"keep":true}}}\n'
  try {
    const guest = await runtime.createGuest('203.0.113.82')
    await runtime.linkAccount(guest.accountId, {
      baseUrl: 'https://www.schulnetz-ag.ch/aksa',
      deviceId: '0123456789abcdef01234567',
      refreshToken: 'synthetic-refresh-token-long-enough',
    })
    const dir = join(root, 'accounts', guest.accountId)
    const file = join(dir, 'notification-baseline.json')
    const linkFile = join(dir, 'link.json')
    await writeFile(file, baseline, { mode: 0o600 })
    const linkBefore = await readFile(linkFile)
    const request = {
      method: 'PUT',
      headers: { 'x-kanti-guest': guest.accountId, authorization: `Bearer ${guest.token}` },
      socket: { remoteAddress: '203.0.113.82' },
      async *[Symbol.asyncIterator]() { yield Buffer.from('{"grades":[]}') },
    }
    let status = 0
    await runtime.handle(request, { writeHead(code) { status = code }, end() {} }, new URL('http://127.0.0.1/api/v1/schulnetz/snapshot'))
    assert.equal(status, 500)
    assert.equal(await readFile(file, 'utf8'), baseline)
    assert.deepEqual(await readFile(linkFile), linkBefore)
    await assert.rejects(readFile(join(dir, 'snapshot.json')), (error) => error?.code === 'ENOENT')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a reveal ledger that is not the known shape is left in place', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grade-reveal-'))
  const runtime = createSchulnetzRuntime({
    root,
    key: randomBytes(32),
    fetch: async () => { throw new Error('school') },
    autostart: false,
  })
  const ledger = '{"version":2,"hidden":["c-keep"],"revealed":["c-old"]}\n'
  try {
    const guest = await runtime.createGuest('203.0.113.83')
    await runtime.linkAccount(guest.accountId, {
      baseUrl: 'https://www.schulnetz-ag.ch/aksa',
      deviceId: '0123456789abcdef01234567',
      refreshToken: 'synthetic-refresh-token-long-enough',
    })
    const dir = join(root, 'accounts', guest.accountId)
    const file = join(dir, 'reveals.json')
    await writeFile(file, ledger, { mode: 0o600 })
    const request = {
      method: 'PUT',
      headers: { 'x-kanti-guest': guest.accountId, authorization: `Bearer ${guest.token}` },
      socket: { remoteAddress: '203.0.113.83' },
      async *[Symbol.asyncIterator]() { yield Buffer.from('{"hidden":["c-new"]}') },
    }
    let status = 0
    await runtime.handle(request, { writeHead(code) { status = code }, end() {} }, new URL('http://127.0.0.1/api/v1/schulnetz/reveals'))
    assert.equal(status, 500)
    assert.equal(await readFile(file, 'utf8'), ledger)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a reveal ledger id that is not a token is left in place', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grade-reveal-id-'))
  const runtime = createSchulnetzRuntime({
    root,
    key: randomBytes(32),
    fetch: async () => { throw new Error('school') },
    autostart: false,
  })
  try {
    const guest = await runtime.createGuest('203.0.113.90')
    await runtime.linkAccount(guest.accountId, {
      baseUrl: 'https://www.schulnetz-ag.ch/aksa',
      deviceId: '0123456789abcdef01234567',
      refreshToken: 'synthetic-refresh-token-long-enough',
    })
    const file = join(root, 'accounts', guest.accountId, 'reveals.json')
    const call = async () => {
      const request = {
        method: 'PUT',
        headers: { 'x-kanti-guest': guest.accountId, authorization: `Bearer ${guest.token}` },
        socket: { remoteAddress: '203.0.113.90' },
        async *[Symbol.asyncIterator]() { yield Buffer.from('{"hidden":["c-new"]}') },
      }
      let status = 0
      await runtime.handle(request, { writeHead(code) { status = code }, end() {} }, new URL('http://127.0.0.1/api/v1/schulnetz/reveals'))
      return status
    }
    const keep = async (ledger) => {
      const stored = `${JSON.stringify(ledger)}\n`
      await writeFile(file, stored, { mode: 0o600 })
      assert.equal(await call(), 500)
      assert.equal(await readFile(file, 'utf8'), stored)
    }
    await keep({ version: 1, hidden: ['c-keep', { kept: true }], revealed: ['c-old'] })
    await keep({ version: 1, hidden: ['c-keep', ''], revealed: ['c-old'] })
    await keep({ version: 1, hidden: ['c-keep', 1], revealed: ['c-old'] })
    await keep({ version: 1, hidden: ['c-keep'], revealed: ['c-old', 'has space'] })
    await keep({ version: 1, hidden: [' c-keep'], revealed: ['c-old'] })
    await keep({ version: 1, hidden: ['c-keep', 'x'.repeat(65)], revealed: ['c-old'] })
    const longId = 'a'.repeat(64)
    await writeFile(file, `${JSON.stringify({ version: 1, hidden: ['c-keep', longId], revealed: ['c-old'] })}\n`, { mode: 0o600 })
    assert.equal(await call(), 200)
    const saved = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(saved.hidden.includes('c-keep'), true)
    assert.equal(saved.hidden.includes(longId), true)
    assert.equal(saved.hidden.includes('c-new'), true)
    assert.equal(saved.revealed.includes('c-old'), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a grade monitor that is not the known shape is left in place', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grade-monitor-'))
  const runtime = createSchulnetzRuntime({
    root,
    key: randomBytes(32),
    autostart: false,
    now: () => new Date('2026-11-16T08:00:00.000Z'),
    fetch: async (url) => {
      const target = String(url)
      const body = target.endsWith('/token.php')
        ? { access_token: 'access-token-value', refresh_token: 'rotated-refresh-token-value-123456', expires_in: 3600 }
        : []
      return { status: 200, text: async () => JSON.stringify(body) }
    },
    fcmSend: async () => ({ status: 200 }),
  })
  const accountId = 'f'.repeat(32)
  const file = join(root, 'accounts', accountId, 'monitor.json')
  try {
    await runtime.linkAccount(accountId, {
      baseUrl: 'https://www.schulnetz-ag.ch/aksa',
      deviceId: '0123456789abcdef01234567',
      refreshToken: 'synthetic-refresh-token-long-enough',
    })
    await runtime.pollAccount(accountId)
    const list = '["keep-this-check"]\n'
    await writeFile(file, list, { mode: 0o600 })
    await assert.rejects(() => runtime.pollAccount(accountId), (error) => error?.code === 'EBADMSG')
    assert.equal(await readFile(file, 'utf8'), list)
    const pushes = '{"pushes":"keep-this"}\n'
    await writeFile(file, pushes, { mode: 0o600 })
    await assert.rejects(() => runtime.pollAccount(accountId), (error) => error?.code === 'EBADMSG')
    assert.equal(await readFile(file, 'utf8'), pushes)
    await rm(file)
    await runtime.pollAccount(accountId)
    const fresh = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(typeof fresh.gradeCheckAt, 'string')
    assert.equal(Array.isArray(fresh.pushes) || fresh.pushes == null, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a snapshot whose grades are not a list is left in place', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grade-snapshot-'))
  const runtime = createSchulnetzRuntime({
    root,
    key: randomBytes(32),
    fetch: async () => { throw new Error('school') },
    autostart: false,
  })
  const stored = '{"fetchedAt":"2026-11-16T08:00:00.000Z","grades":{"kept":true},"events":[]}\n'
  try {
    const guest = await runtime.createGuest('203.0.113.84')
    await runtime.linkAccount(guest.accountId, {
      baseUrl: 'https://www.schulnetz-ag.ch/aksa',
      deviceId: '0123456789abcdef01234567',
      refreshToken: 'synthetic-refresh-token-long-enough',
    })
    const dir = join(root, 'accounts', guest.accountId)
    const file = join(dir, 'snapshot.json')
    await writeFile(file, stored, { mode: 0o600 })
    const call = async (method, body) => {
      const request = {
        method,
        headers: { 'x-kanti-guest': guest.accountId, authorization: `Bearer ${guest.token}` },
        socket: { remoteAddress: '203.0.113.84' },
        async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(body) },
      }
      let status = 0
      const chunks = []
      await runtime.handle(request, {
        writeHead(code) { status = code },
        end(payload) { if (payload) chunks.push(Buffer.from(payload)) },
      }, new URL('http://127.0.0.1/api/v1/schulnetz/snapshot'))
      return status
    }
    assert.equal(await call('GET'), 500)
    assert.equal(await call('PUT', '{"grades":[]}'), 500)
    assert.equal(await readFile(file, 'utf8'), stored)
    const kept = '{"fetchedAt":"2026-11-16T08:00:00.000Z","grades":[{"id":"g-keep"}],"events":[]}\n'
    await writeFile(file, kept, { mode: 0o600 })
    assert.equal(await call('PUT', '{"grades":[]}'), 200)
    const saved = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(saved.grades.some((grade) => grade.id === 'g-keep'), true)
    await rm(file)
    assert.equal(await call('PUT', '{"grades":[],"fetchedAt":"2026-11-16T09:00:00.000Z"}'), 200)
    assert.equal(Array.isArray(JSON.parse(await readFile(file, 'utf8')).grades), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a snapshot row that is not a record is left in place', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grade-snapshot-row-'))
  const runtime = createSchulnetzRuntime({
    root,
    key: randomBytes(32),
    fetch: async () => { throw new Error('school') },
    autostart: false,
  })
  try {
    const guest = await runtime.createGuest('203.0.113.91')
    await runtime.linkAccount(guest.accountId, {
      baseUrl: 'https://www.schulnetz-ag.ch/aksa',
      deviceId: '0123456789abcdef01234567',
      refreshToken: 'synthetic-refresh-token-long-enough',
    })
    const file = join(root, 'accounts', guest.accountId, 'snapshot.json')
    const call = async () => {
      const request = {
        method: 'PUT',
        headers: { 'x-kanti-guest': guest.accountId, authorization: `Bearer ${guest.token}` },
        socket: { remoteAddress: '203.0.113.91' },
        async *[Symbol.asyncIterator]() { yield Buffer.from('{"grades":[]}') },
      }
      let status = 0
      await runtime.handle(request, { writeHead(code) { status = code }, end() {} }, new URL('http://127.0.0.1/api/v1/schulnetz/snapshot'))
      return status
    }
    const keep = async (snapshot) => {
      const stored = `${JSON.stringify({ fetchedAt: '2026-11-16T08:00:00.000Z', ...snapshot })}\n`
      await writeFile(file, stored, { mode: 0o600 })
      assert.equal(await call(), 500)
      assert.equal(await readFile(file, 'utf8'), stored)
    }
    await keep({ events: ['kept'] })
    await keep({ events: [1] })
    await keep({ events: [null] })
    await keep({ grades: ['kept'] })
    await keep({ exams: [[]] })
    await keep({ absences: ['kept'] })
    const lesson = { id: 'e-keep', start: '2026-11-16T08:00:00', eventType: 'lesson' }
    await writeFile(file, `${JSON.stringify({ fetchedAt: '2026-11-16T08:00:00.000Z', grades: [{ id: 'g-keep' }], events: [lesson], startMessages: ['Willkommen'] })}\n`, { mode: 0o600 })
    assert.equal(await call(), 200)
    const saved = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(saved.grades.some((grade) => grade.id === 'g-keep'), true)
    assert.equal(saved.events.some((event) => event.id === 'e-keep'), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a snapshot lesson with no week is left in place', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grade-snapshot-week-'))
  const runtime = createSchulnetzRuntime({
    root,
    key: randomBytes(32),
    fetch: async () => { throw new Error('school') },
    autostart: false,
  })
  try {
    const guest = await runtime.createGuest('203.0.113.92')
    await runtime.linkAccount(guest.accountId, {
      baseUrl: 'https://www.schulnetz-ag.ch/aksa',
      deviceId: '0123456789abcdef01234567',
      refreshToken: 'synthetic-refresh-token-long-enough',
    })
    const file = join(root, 'accounts', guest.accountId, 'snapshot.json')
    const call = async () => {
      const request = {
        method: 'PUT',
        headers: { 'x-kanti-guest': guest.accountId, authorization: `Bearer ${guest.token}` },
        socket: { remoteAddress: '203.0.113.92' },
        async *[Symbol.asyncIterator]() { yield Buffer.from('{"grades":[]}') },
      }
      let status = 0
      await runtime.handle(request, { writeHead(code) { status = code }, end() {} }, new URL('http://127.0.0.1/api/v1/schulnetz/snapshot'))
      return status
    }
    const keep = async (snapshot) => {
      const stored = `${JSON.stringify({ fetchedAt: '2026-11-16T08:00:00.000Z', ...snapshot })}\n`
      await writeFile(file, stored, { mode: 0o600 })
      assert.equal(await call(), 500)
      assert.equal(await readFile(file, 'utf8'), stored)
    }
    const dated = { id: 'e-keep', start: '2026-11-16T08:00:00', eventType: 'lesson' }
    await keep({ events: [{ id: 'e-lost' }] })
    await keep({ events: [{ id: 'e-lost', eventType: 'lesson', start: '' }] })
    await keep({ events: [{ id: 'e-lost', eventType: '0_stp', start: 'not-a-day' }] })
    await keep({ events: [dated, { id: 'e-lost' }] })
    await writeFile(file, `${JSON.stringify({ fetchedAt: '2026-11-16T08:00:00.000Z', grades: [{ id: 'g-keep' }], events: [dated, { id: 'a-keep', eventType: 'appointment', start: '' }] })}\n`, { mode: 0o600 })
    assert.equal(await call(), 200)
    const saved = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(saved.grades.some((grade) => grade.id === 'g-keep'), true)
    assert.equal(saved.events.some((event) => event.id === 'e-keep'), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a snapshot whose exams are not a list is left in place', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grade-exams-'))
  const runtime = createSchulnetzRuntime({
    root,
    key: randomBytes(32),
    fetch: async () => { throw new Error('school') },
    autostart: false,
  })
  const stored = '{"fetchedAt":"2026-11-16T08:00:00.000Z","grades":[{"id":"g-keep"}],"events":[],"exams":{"kept":true}}\n'
  try {
    const guest = await runtime.createGuest('203.0.113.85')
    await runtime.linkAccount(guest.accountId, {
      baseUrl: 'https://www.schulnetz-ag.ch/aksa',
      deviceId: '0123456789abcdef01234567',
      refreshToken: 'synthetic-refresh-token-long-enough',
    })
    const file = join(root, 'accounts', guest.accountId, 'snapshot.json')
    await writeFile(file, stored, { mode: 0o600 })
    const request = {
      method: 'PUT',
      headers: { 'x-kanti-guest': guest.accountId, authorization: `Bearer ${guest.token}` },
      socket: { remoteAddress: '203.0.113.85' },
      async *[Symbol.asyncIterator]() { yield Buffer.from('{"grades":[]}') },
    }
    let status = 0
    await runtime.handle(request, { writeHead(code) { status = code }, end() {} }, new URL('http://127.0.0.1/api/v1/schulnetz/snapshot'))
    assert.equal(status, 500)
    assert.equal(await readFile(file, 'utf8'), stored)
    await writeFile(file, '{"fetchedAt":"2026-11-16T08:00:00.000Z","grades":[{"id":"g-keep"}],"events":[],"exams":[]}\n', { mode: 0o600 })
    const again = {
      method: 'PUT',
      headers: { 'x-kanti-guest': guest.accountId, authorization: `Bearer ${guest.token}` },
      socket: { remoteAddress: '203.0.113.85' },
      async *[Symbol.asyncIterator]() { yield Buffer.from('{"grades":[]}') },
    }
    status = 0
    await runtime.handle(again, { writeHead(code) { status = code }, end() {} }, new URL('http://127.0.0.1/api/v1/schulnetz/snapshot'))
    assert.equal(status, 200)
    assert.equal(JSON.parse(await readFile(file, 'utf8')).grades.some((grade) => grade.id === 'g-keep'), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a snapshot whose week map is not an object is left in place', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grade-weeks-'))
  const runtime = createSchulnetzRuntime({
    root,
    key: randomBytes(32),
    fetch: async () => { throw new Error('school') },
    autostart: false,
  })
  const stored = '{"fetchedAt":"2026-11-16T08:00:00.000Z","grades":[{"id":"g-keep"}],"events":[],"weekFetched":["2026-11-09"]}\n'
  try {
    const guest = await runtime.createGuest('203.0.113.86')
    await runtime.linkAccount(guest.accountId, {
      baseUrl: 'https://www.schulnetz-ag.ch/aksa',
      deviceId: '0123456789abcdef01234567',
      refreshToken: 'synthetic-refresh-token-long-enough',
    })
    const file = join(root, 'accounts', guest.accountId, 'snapshot.json')
    await writeFile(file, stored, { mode: 0o600 })
    const call = async (body) => {
      const request = {
        method: 'PUT',
        headers: { 'x-kanti-guest': guest.accountId, authorization: `Bearer ${guest.token}` },
        socket: { remoteAddress: '203.0.113.86' },
        async *[Symbol.asyncIterator]() { yield Buffer.from(body) },
      }
      let status = 0
      await runtime.handle(request, { writeHead(code) { status = code }, end() {} }, new URL('http://127.0.0.1/api/v1/schulnetz/snapshot'))
      return status
    }
    assert.equal(await call('{"grades":[]}'), 500)
    assert.equal(await readFile(file, 'utf8'), stored)
    await writeFile(file, '{"fetchedAt":"2026-11-16T08:00:00.000Z","grades":[{"id":"g-keep"}],"events":[],"weekFetched":{}}\n', { mode: 0o600 })
    assert.equal(await call('{"grades":[]}'), 200)
    assert.equal(JSON.parse(await readFile(file, 'utf8')).grades.some((grade) => grade.id === 'g-keep'), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a push token that is not a token is left in place', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grade-token-'))
  const runtime = createSchulnetzRuntime({
    root,
    key: randomBytes(32),
    fetch: async () => { throw new Error('school') },
    autostart: false,
  })
  try {
    const guest = await runtime.createGuest('203.0.113.88')
    await runtime.linkAccount(guest.accountId, {
      baseUrl: 'https://www.schulnetz-ag.ch/aksa',
      deviceId: '0123456789abcdef01234567',
      refreshToken: 'synthetic-refresh-token-long-enough',
    })
    const dir = join(root, 'accounts', guest.accountId)
    const linkFile = join(dir, 'link.json')
    const snapshot = join(dir, 'snapshot.json')
    const keptSnapshot = '{"grades":[{"id":"g-keep"}]}\n'
    await writeFile(snapshot, keptSnapshot, { mode: 0o600 })
    const token = `${'a'.repeat(20)}:APA91b${'b'.repeat(20)}`
    const call = async (method, path, body) => {
      const request = {
        method,
        headers: { 'x-kanti-guest': guest.accountId, authorization: `Bearer ${guest.token}` },
        socket: { remoteAddress: '203.0.113.88' },
        async *[Symbol.asyncIterator]() { if (body != null) yield Buffer.from(body) },
      }
      let status = 0
      await runtime.handle(request, { writeHead(code) { status = code }, end() {} }, new URL(`http://127.0.0.1/api/v1/schulnetz${path}`))
      return status
    }
    const keep = async (tokens) => {
      const parsed = JSON.parse(await readFile(linkFile, 'utf8'))
      parsed.fcmTokens = tokens
      const stored = `${JSON.stringify(parsed)}\n`
      await writeFile(linkFile, stored, { mode: 0o600 })
      assert.equal(await call('GET', '/status'), 500)
      assert.equal(await call('PUT', '/snapshot', '{"grades":[]}'), 500)
      await assert.rejects(() => runtime.pollAccount(guest.accountId), (error) => error?.code === 'EBADMSG')
      await assert.rejects(() => runtime.linkAccount(guest.accountId, {
        baseUrl: 'https://www.schulnetz-ag.ch/aksa',
        deviceId: '0123456789abcdef01234567',
        refreshToken: 'synthetic-refresh-token-long-enough',
      }), (error) => error?.code === 'EBADMSG')
      assert.equal(await readFile(linkFile, 'utf8'), stored)
      assert.equal(await readFile(snapshot, 'utf8'), keptSnapshot)
    }
    await keep(['kept'])
    await keep([{ kept: true }])
    await keep([token, ''])
    const parsed = JSON.parse(await readFile(linkFile, 'utf8'))
    parsed.fcmTokens = [token]
    await writeFile(linkFile, JSON.stringify(parsed), { mode: 0o600 })
    assert.equal(await call('GET', '/status'), 200)
    await runtime.linkAccount(guest.accountId, {
      baseUrl: 'https://www.schulnetz-ag.ch/aksa',
      deviceId: '0123456789abcdef01234567',
      refreshToken: 'synthetic-refresh-token-long-enough',
    })
    assert.deepEqual(JSON.parse(await readFile(linkFile, 'utf8')).fcmTokens, [token])
    assert.equal(await readFile(snapshot, 'utf8'), keptSnapshot)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a link that is not the known shape is left in place', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grade-link-'))
  const runtime = createSchulnetzRuntime({
    root,
    key: randomBytes(32),
    fetch: async () => { throw new Error('school') },
    autostart: false,
  })
  try {
    const guest = await runtime.createGuest('203.0.113.87')
    await runtime.linkAccount(guest.accountId, {
      baseUrl: 'https://www.schulnetz-ag.ch/aksa',
      deviceId: '0123456789abcdef01234567',
      refreshToken: 'synthetic-refresh-token-long-enough',
    })
    const dir = join(root, 'accounts', guest.accountId)
    const linkFile = join(dir, 'link.json')
    const snapshot = join(dir, 'snapshot.json')
    const baseline = join(dir, 'notification-baseline.json')
    const ledger = join(dir, 'notified-grades.json')
    const keptSnapshot = '{"grades":[{"id":"g-keep"}]}\n'
    const keptBaseline = '{"version":1,"weeks":{"2026-11-16":{"keep":true}}}\n'
    const keptLedger = '{"version":1,"keys":["g:keep"]}\n'
    await writeFile(snapshot, keptSnapshot, { mode: 0o600 })
    await writeFile(baseline, keptBaseline, { mode: 0o600 })
    await writeFile(ledger, keptLedger, { mode: 0o600 })
    const call = async (method, path, body) => {
      const request = {
        method,
        headers: { 'x-kanti-guest': guest.accountId, authorization: `Bearer ${guest.token}` },
        socket: { remoteAddress: '203.0.113.87' },
        async *[Symbol.asyncIterator]() { if (body != null) yield Buffer.from(body) },
      }
      let status = 0
      await runtime.handle(request, { writeHead(code) { status = code }, end() {} }, new URL(`http://127.0.0.1/api/v1/schulnetz${path}`))
      return status
    }
    const live = JSON.parse(await readFile(linkFile, 'utf8'))
    live.fcmTokens = [`${'a'.repeat(20)}:APA91b${'b'.repeat(80)}`]
    live.pushKeys = { abcdef0123456789abcdef01: { sealed: true } }
    live.settings = { grades: true }
    live.topic = 'old-topic'
    live.pushEndpoints = ['old-endpoint']
    await writeFile(linkFile, JSON.stringify(live), { mode: 0o600 })
    assert.equal(await call('GET', '/status'), 200)
    const stripped = JSON.parse(await readFile(linkFile, 'utf8'))
    assert.equal(Object.hasOwn(stripped, 'topic'), false)
    assert.equal(Object.hasOwn(stripped, 'pushEndpoints'), false)
    assert.equal(stripped.pushKeys.abcdef0123456789abcdef01.sealed, true)
    const unchanged = async (stored) => {
      assert.equal(await readFile(linkFile, 'utf8'), stored)
      assert.equal(await readFile(snapshot, 'utf8'), keptSnapshot)
      assert.equal(await readFile(baseline, 'utf8'), keptBaseline)
      assert.equal(await readFile(ledger, 'utf8'), keptLedger)
    }
    for (const bad of ['["keep-link"]\n', '"keep-link"\n', 'true\n', '{"mode":"rest","fcmTokens":"keep-tokens"}\n', '{"mode":"rest","pushKeys":["keep-keys"]}\n', '{"mode":"web","settings":["keep-settings"]}\n']) {
      await writeFile(linkFile, bad, { mode: 0o600 })
      assert.equal(await call('GET', '/status'), 500)
      assert.equal(await call('PUT', '/snapshot', '{"grades":[]}'), 500)
      await assert.rejects(() => runtime.pollAccount(guest.accountId), (error) => error?.code === 'EBADMSG')
      await assert.rejects(() => runtime.linkAccount(guest.accountId, {
        baseUrl: 'https://www.schulnetz-ag.ch/aksa',
        deviceId: '0123456789abcdef01234567',
        refreshToken: 'synthetic-refresh-token-long-enough',
      }), (error) => error?.code === 'EBADMSG')
      await unchanged(bad)
    }
    await writeFile(linkFile, 'null\n', { mode: 0o600 })
    assert.equal(await call('PUT', '/snapshot', '{"grades":[]}'), 404)
    await runtime.linkAccount(guest.accountId, {
      baseUrl: 'https://www.schulnetz-ag.ch/aksa',
      deviceId: '0123456789abcdef01234567',
      refreshToken: 'synthetic-refresh-token-long-enough',
    })
    assert.equal(JSON.parse(await readFile(linkFile, 'utf8')).baseUrl, 'https://www.schulnetz-ag.ch/aksa')
    assert.equal(await readFile(snapshot, 'utf8'), keptSnapshot)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
