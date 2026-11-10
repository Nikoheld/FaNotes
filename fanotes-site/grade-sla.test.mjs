// The grade promise: a new grade reaches the phone within 10 minutes of appearing in Schulnetz, 24/7.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createDecipheriv, randomBytes } from 'node:crypto'
import { createSchulnetzRuntime } from './schulnetz-api.mjs'
import { GRADE_CHECK_JITTER, GRADE_CHECK_MS, GRADE_SLA_MS, createPollScheduler, gradeCheckDelayMs } from './schulnetz-logic.mjs'
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
