import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { claimPushKeys, deliverFcm, exchangeServiceAccount, FCM_ATTEMPTS, FCM_AUTH_ATTEMPTS, FCM_BODY_MAX, FCM_TIMEOUT_MS, fcmDropToken, pushDedupKey } from './fcm.mjs'
import { createServiceLog } from './service-log.mjs'
import { createSchulnetzRuntime, SCHOOL_BODY_MAX, updateChangeLog } from './schulnetz-api.mjs'

const grade = (id, mark = '5.5') => ({ id, category: 'grade', title: 'Neue Note', body: `Mathematik · Probe · ${mark}`, targetId: 'course-1', date: '2026-11-10' })
const cancelled = (id, targetId = 'lesson-1') => ({ id, category: 'timetable', title: 'Lektion fällt aus', body: 'Deutsch · 08:15', targetId, date: '2026-11-16' })

test('invalid and unregistered tokens are dropped; a payload error is not', () => {
  assert.equal(fcmDropToken(404, '{}'), true)
  assert.equal(fcmDropToken(400, '{"error":{"details":[{"errorCode":"UNREGISTERED"}]}}'), true)
  assert.equal(fcmDropToken(400, '{"error":{"message":"The registration token is not a valid FCM registration token","status":"INVALID_ARGUMENT"}}'), true)
  assert.equal(fcmDropToken(400, '{"error":{"message":"Android message is too big","status":"INVALID_ARGUMENT"}}'), false)
  assert.equal(fcmDropToken(200, '{}'), false)
  assert.equal(fcmDropToken(503, '{}'), false)
})

test('5xx is retried with backoff; 400 and an unregistered token are not', async () => {
  const waits = []
  const calls = []
  const fetchImpl = async () => {
    calls.push('post')
    const status = calls.length < 3 ? 503 : 200
    return { status, text: async () => (status === 200 ? '{}' : 'unavailable') }
  }
  const lines = []
  const jsonLog = createServiceLog('fcm', (line) => lines.push(line), () => new Date('2026-11-15T11:00:00.000Z'))
  const result = await deliverFcm({
    fetchImpl,
    url: 'https://fcm.googleapis.com/v1/projects/demo/messages:send',
    message: { message: { token: 'phone:APA91b-example-token-value', data: { event: 'sync' } } },
    headers: { Authorization: 'Bearer secret-token' },
    sleep: async (ms) => { waits.push(ms) },
    jsonLog,
  })
  assert.equal(result.status, 200)
  assert.equal(result.drop, false)
  assert.equal(result.attempts, 3)
  assert.deepEqual(waits, [200, 800])
  assert.equal(JSON.stringify(result).includes('secret-token'), false)
  const rows = lines.map((line) => JSON.parse(line))
  assert.deepEqual(rows.map((row) => row.status), [503, 503, 200])
  assert.equal(new Set(rows.map((row) => row.requestId)).size, 1)
  assert.equal(rows[0].service, 'fcm')
  assert.equal(rows[0].route, 'https://fcm.googleapis.com/v1/projects/demo/messages:send')
  assert.equal(rows.every((row) => row.method === 'POST' && row.drop === false), true)
  assert.equal(rows[2].level, 'info')
  const joined = lines.join('\n')
  assert.equal(joined.includes('secret-token'), false)
  assert.equal(joined.includes('APA91b'), false)
  assert.equal(joined.includes('?'), false)

  const once = []
  const rejected = await deliverFcm({
    fetchImpl: async () => { once.push(1); return { status: 400, text: async () => '{"error":{"message":"The registration token is not a valid FCM registration token","status":"INVALID_ARGUMENT"}}' } },
    url: 'https://fcm.googleapis.com/v1/projects/demo/messages:send',
    message: { message: { token: 'gone' } },
    headers: {},
    sleep: async () => { throw new Error('should not retry') },
  })
  assert.equal(once.length, 1)
  assert.equal(rejected.drop, true)
  assert.equal(FCM_ATTEMPTS, 4)
})

test('a grade and a cancellation are claimed once, and the ledger has no personal data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fcm-dedup-'))
  const file = join(root, 'pushed-notices.json')
  const firstCancel = cancelled('timetable:9:old-key')
  const sameLesson = cancelled('timetable:9:new-key')
  const otherLesson = cancelled('timetable:9:other', 'lesson-2')
  try {
    assert.equal(pushDedupKey({ ...grade('probe:1'), id: 'probe:grade' }), '')
    const first = await claimPushKeys(file, [grade('grade:g1:5.5'), firstCancel, { id: 'event:1', category: 'event', title: 'Neuer Termin', body: 'x' }])
    assert.equal(first.length, 3)
    const second = await claimPushKeys(file, [grade('grade:g1:5.5'), sameLesson, otherLesson, grade('grade:g1:4')])
    assert.deepEqual(second.map((change) => change.id), ['timetable:9:other', 'grade:g1:4'])
    const stored = await readFile(file, 'utf8')
    assert.equal(stored.includes('5.5'), false)
    assert.equal(stored.includes('Mathematik'), false)
    assert.equal(stored.includes('Deutsch'), false)
    assert.equal(stored.includes('lesson-1'), false)
    const [left, right] = await Promise.all([
      claimPushKeys(file, [grade('grade:g9:6')]),
      claimPushKeys(file, [grade('grade:g9:6')]),
    ])
    assert.equal(left.length + right.length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a live grade push is not repeated when the same change is offered again', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fcm-runtime-'))
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const account = {
    client_email: 'push@kanti-test.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    project_id: 'kanti-test',
  }
  let polls = 0
  const posts = []
  const fetch = async (url) => {
    const target = String(url)
    if (target.includes('oauth2.googleapis.com')) return { status: 200, text: async () => JSON.stringify({ access_token: 'ya29.example', expires_in: 3600 }) }
    if (target.includes('fcm.googleapis.com')) {
      posts.push(target)
      const status = posts.length === 1 ? 503 : 200
      return { status, text: async () => (status === 200 ? '{}' : 'unavailable') }
    }
    const json = (value) => ({ status: 200, text: async () => JSON.stringify(value) })
    if (target.endsWith('/token.php')) return json({ access_token: 'access-token-value', refresh_token: 'rotated-refresh-token-value-123456', expires_in: 3600 })
    if (target.includes('/me/grades')) {
      polls += 1
      const grades = [{ id: 'g1', course: 'Mathematik', title: 'Probe', date: '2026-10-20', mark: '5.5', weight: '1' }]
      if (polls > 1) grades.push({ id: 'g2', course: 'Englisch', title: 'Essay', date: '2026-11-01', mark: '4.5', weight: '1' })
      return json(grades)
    }
    return json([])
  }
  const runtime = createSchulnetzRuntime({
    root,
    key: randomBytes(32),
    fetch,
    autostart: false,
    fcmAccount: account,
    fcmSleep: async () => {},
  })
  const accountId = 'a'.repeat(32)
  try {
    await runtime.linkAccount(accountId, {
      baseUrl: 'https://www.schulnetz-ag.ch/aksa',
      deviceId: '0123456789abcdef01234567',
      refreshToken: 'super-secret-refresh-token-value',
    })
    await runtime.addFcmToken(accountId, 'phone:APA91b-example-token-value')
    await runtime.pollAccount(accountId)
    await runtime.pollAccount(accountId)
    assert.equal(posts.length, 2, 'the 503 is retried once and then accepted')
    const ledger = await readFile(join(root, 'accounts', accountId, 'pushed-notices.json'), 'utf8')
    assert.equal(ledger.includes('4.5'), false)
    assert.equal(ledger.includes('APA91b'), false)
    assert.equal(ledger.includes('Englisch'), false)
    const again = await claimPushKeys(join(root, 'accounts', accountId, 'pushed-notices.json'), [
      { id: 'does-not-matter', category: 'grade', title: 'Neue Note', body: 'Englisch · Essay · 4.5' },
    ])
    // A different change id is a different grade. The one FCM already accepted is in the ledger
    // from the poll; offering that same id again must not be a second push.
    const changes = await readFile(join(root, 'accounts', accountId, 'changes.jsonl'), 'utf8')
    const sent = changes.trim().split('\n').map((line) => JSON.parse(line)).find((row) => row.category === 'grade')
    const repeat = await claimPushKeys(join(root, 'accounts', accountId, 'pushed-notices.json'), [sent])
    assert.equal(repeat.length, 0)
    assert.equal(again.length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('FCM sign-in retries a 503 and never logs the signed assertion or the access token', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const account = {
    client_email: 'push@kanti-test.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    project_id: 'kanti-test',
  }
  const lines = []
  const jsonLog = createServiceLog('fcm', (line) => lines.push(line), () => new Date('2026-11-15T11:00:00.000Z'))
  const waits = []
  let calls = 0
  const fetchImpl = async (url, init) => {
    calls += 1
    assert.equal(init.method, 'POST')
    assert.equal(String(url), 'https://oauth2.googleapis.com/token')
    assert.equal(String(init.body).includes('assertion='), true)
    if (calls < 3) return { ok: false, status: 503, text: async () => 'ya29.secret-access-token' }
    return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'ya29.secret-access-token', expires_in: 3600 }) }
  }
  const result = await exchangeServiceAccount(account, fetchImpl, Date.parse('2026-11-15T11:00:00Z'), {
    sleep: async (ms) => { waits.push(ms) },
    jsonLog,
  })
  assert.equal(result.projectId, 'kanti-test')
  assert.equal(result.token, 'ya29.secret-access-token')
  assert.equal(calls, 3)
  assert.equal(FCM_AUTH_ATTEMPTS, 3)
  assert.deepEqual(waits, [200, 800])
  const rows = lines.map((line) => JSON.parse(line))
  assert.deepEqual(rows.map((row) => row.status), [503, 503, 200])
  assert.equal(new Set(rows.map((row) => row.requestId)).size, 1)
  assert.equal(rows[0].route, 'https://oauth2.googleapis.com/token')
  assert.equal(rows[2].level, 'info')
  const joined = lines.join('\n')
  assert.equal(joined.includes('ya29'), false)
  assert.equal(joined.includes('PRIVATE'), false)
  assert.equal(joined.includes('assertion'), false)

  lines.length = 0
  let once = 0
  await assert.rejects(
    () => exchangeServiceAccount(account, async () => {
      once += 1
      return { ok: false, status: 400, text: async () => '{"error":"invalid_grant","assertion":"secret-jwt"}' }
    }, Date.parse('2026-11-15T11:00:00Z'), {
      sleep: async () => { throw new Error('should not retry') },
      jsonLog,
    }),
    (error) => error.message === 'fcm-auth' && error.status === 400 && !String(error.message).includes('secret-jwt'),
  )
  assert.equal(once, 1)
  assert.equal(lines.join('\n').includes('secret-jwt'), false)

  let timeouts = 0
  await assert.rejects(
    () => exchangeServiceAccount(account, async () => {
      timeouts += 1
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    }, Date.parse('2026-11-15T11:00:00Z'), {
      sleep: async () => {},
      jsonLog: createServiceLog('fcm', () => {}, () => new Date('2026-11-15T11:00:00.000Z')),
    }),
    (error) => error.message === 'fcm-auth' && error.name === 'TimeoutError',
  )
  assert.equal(timeouts, FCM_AUTH_ATTEMPTS)
})

test('overlapping change-log updates keep both new lines', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fcm-changes-'))
  const file = join(root, 'changes.jsonl')
  await writeFile(file, '{"id":"one"}\n', { mode: 0o600 })
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let entered = 0
  try {
    const first = updateChangeLog(file, async (lines) => {
      entered += 1
      await gate
      return [...lines, '{"id":"two"}']
    })
    for (let i = 0; i < 20 && entered < 1; i += 1) await new Promise((resolve) => setImmediate(resolve))
    const second = updateChangeLog(file, async (lines) => [...lines, '{"id":"three"}'])
    release()
    await Promise.all([first, second])
    assert.equal(await readFile(file, 'utf8'), '{"id":"one"}\n{"id":"two"}\n{"id":"three"}\n')
    assert.equal((await stat(file)).mode & 0o777, 0o600)
    assert.equal((await readdir(root)).some((name) => name.endsWith('.tmp')), false)
    await updateChangeLog(file, () => [])
    await assert.rejects(stat(file))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a failed change log does not mark the new grade as already announced', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fcm-ledger-'))
  let polls = 0
  const fetch = async (url) => {
    const target = String(url)
    const json = (value) => ({ status: 200, text: async () => JSON.stringify(value) })
    if (target.endsWith('/token.php')) return json({ access_token: 'access-token-value', refresh_token: 'rotated-refresh-token-value-123456', expires_in: 3600 })
    if (target.includes('/me/grades')) {
      polls += 1
      const grades = [{ id: 'g1', course: 'Mathematik', title: 'Probe', date: '2026-10-20', mark: '5.5', weight: '1' }]
      if (polls > 1) grades.push({ id: 'g2', course: 'Englisch', title: 'Essay', date: '2026-11-01', mark: '4.5', weight: '1' })
      return json(grades)
    }
    return json([])
  }
  const runtime = createSchulnetzRuntime({
    root,
    key: randomBytes(32),
    fetch,
    autostart: false,
    fcmSend: async () => ({ status: 200 }),
  })
  const accountId = 'b'.repeat(32)
  const ledgerFile = join(root, 'accounts', accountId, 'notified-grades.json')
  const changeFile = join(root, 'accounts', accountId, 'changes.jsonl')
  const snapshotFile = join(root, 'accounts', accountId, 'snapshot.json')
  try {
    await runtime.linkAccount(accountId, {
      baseUrl: 'https://www.schulnetz-ag.ch/aksa',
      deviceId: '0123456789abcdef01234567',
      refreshToken: 'super-secret-refresh-token-value',
    })
    await runtime.pollAccount(accountId)
    const before = await readFile(ledgerFile, 'utf8')
    await rm(changeFile, { force: true })
    await mkdir(changeFile)
    await assert.rejects(() => runtime.pollAccount(accountId))
    assert.equal(await readFile(ledgerFile, 'utf8'), before)
    assert.equal((await readFile(snapshotFile, 'utf8')).includes('Englisch'), false)
    await rm(changeFile, { recursive: true, force: true })
    await runtime.pollAccount(accountId)
    const lines = (await readFile(changeFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(lines.some((row) => row.category === 'grade' && String(row.body).includes('Englisch')), true)
    assert.equal((await readFile(snapshotFile, 'utf8')).includes('Englisch'), true)
    assert.notEqual(await readFile(ledgerFile, 'utf8'), before)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

const byteStream = (status, chunks, counters) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => { counters.text += 1; return '' },
  body: {
    getReader: () => ({
      read: async () => {
        if (!chunks.length) return { done: true }
        counters.reads += 1
        return { done: false, value: chunks.shift() }
      },
      cancel: async () => { counters.cancelled += 1 },
    }),
  },
})

test('an oversized FCM body is cancelled and is not retried', async () => {
  const phrase = Buffer.from('{"error":{"message":"The registration token is not a valid FCM registration token","status":"INVALID_ARGUMENT"}}')
  const mid = Math.floor(phrase.length / 2)
  const streamed = { text: 0, reads: 0, cancelled: 0 }
  const dropped = await deliverFcm({
    fetchImpl: async () => byteStream(400, [phrase.subarray(0, mid), phrase.subarray(mid)], streamed),
    url: 'https://fcm.googleapis.com/v1/projects/demo/messages:send',
    message: { message: { token: 'device-token' } },
    headers: {},
    sleep: async () => { throw new Error('should not retry') },
  })
  assert.equal(dropped.drop, true)
  assert.equal(dropped.attempts, 1)
  assert.equal(streamed.text, 0)
  assert.equal(streamed.reads, 2)
  assert.equal(streamed.cancelled, 0)

  const lines = []
  const jsonLog = createServiceLog('fcm', (line) => lines.push(line), () => new Date('2026-11-15T11:00:00.000Z'))
  const huge = { text: 0, reads: 0, cancelled: 0 }
  let posts = 0
  await assert.rejects(
    () => deliverFcm({
      fetchImpl: async () => {
        posts += 1
        return byteStream(400, [new Uint8Array(FCM_BODY_MAX + 1)], huge)
      },
      url: 'https://fcm.googleapis.com/v1/projects/demo/messages:send',
      message: { message: { token: 'device-token' } },
      headers: { Authorization: 'Bearer secret-token' },
      sleep: async () => { throw new Error('should not retry') },
      jsonLog,
    }),
    (error) => error.message === 'page too large',
  )
  assert.equal(posts, 1)
  assert.equal(huge.text, 0)
  assert.equal(huge.reads, 1)
  assert.equal(huge.cancelled, 1)
  assert.equal(lines.join('\n').includes('page too large'), false)
  assert.equal(lines.join('\n').includes('secret-token'), false)
  assert.equal(lines.join('\n').includes('device-token'), false)

  const gone = { text: 0, reads: 0, cancelled: 0 }
  const missing = await deliverFcm({
    fetchImpl: async () => byteStream(404, [new Uint8Array(FCM_BODY_MAX + 1)], gone),
    url: 'https://fcm.googleapis.com/v1/projects/demo/messages:send',
    message: { message: { token: 'device-token' } },
    headers: {},
    sleep: async () => { throw new Error('should not retry') },
  })
  assert.equal(missing.status, 404)
  assert.equal(missing.drop, true)
  assert.equal(gone.cancelled, 1)

  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const account = {
    client_email: 'push@kanti-test.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    project_id: 'kanti-test',
  }
  const authLines = []
  const authLog = createServiceLog('fcm', (line) => authLines.push(line), () => new Date('2026-11-15T11:00:00.000Z'))
  const authHuge = { text: 0, reads: 0, cancelled: 0 }
  let authCalls = 0
  await assert.rejects(
    () => exchangeServiceAccount(account, async () => {
      authCalls += 1
      return byteStream(200, [new Uint8Array(FCM_BODY_MAX + 1)], authHuge)
    }, Date.parse('2026-11-15T11:00:00Z'), {
      sleep: async () => { throw new Error('should not retry') },
      jsonLog: authLog,
    }),
    (error) => error.message === 'fcm-auth' && error.status === 200,
  )
  assert.equal(authCalls, 1)
  assert.equal(authHuge.text, 0)
  assert.equal(authHuge.cancelled, 1)
  assert.equal(authLines.join('\n').includes('page too large'), false)
  assert.equal(authLines.join('\n').includes('PRIVATE'), false)
})

test('a failed account write removes its temporary file and keeps the link', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fcm-write-'))
  const runtime = createSchulnetzRuntime({
    root,
    key: randomBytes(32),
    fetch: async () => { throw new Error('no network') },
    autostart: false,
    fcmSend: async () => ({ status: 200 }),
  })
  const accountId = 'c'.repeat(32)
  const dir = join(root, 'accounts', accountId)
  try {
    await runtime.linkAccount(accountId, {
      baseUrl: 'https://www.schulnetz-ag.ch/aksa',
      deviceId: '0123456789abcdef01234567',
      refreshToken: 'super-secret-refresh-token-value',
    })
    const linkFile = join(dir, 'link.json')
    const before = await readFile(linkFile, 'utf8')
    await chmod(dir, 0o500)
    await assert.rejects(() => runtime.webAccess.updateSettings(accountId, { gradePush: false }), { code: 'EACCES' })
    await chmod(dir, 0o700)
    assert.equal(await readFile(linkFile, 'utf8'), before)
    assert.equal((await readdir(dir)).some((name) => name.endsWith('.tmp')), false)
    assert.equal(before.includes('super-secret-refresh-token-value'), false)
  } finally {
    await chmod(dir, 0o700).catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})

test('an oversized Schulnetz request is refused and the connection is closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fcm-large-'))
  const runtime = createSchulnetzRuntime({ root, key: randomBytes(32), autostart: false, log: () => {} })
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (await runtime.handle(request, response, url)) return
    response.writeHead(404).end()
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  try {
    const result = await new Promise((resolve) => {
      let settled = false
      const done = (value) => { if (!settled) { settled = true; resolve(value) } }
      const req = httpRequest({
        hostname: '127.0.0.1',
        port: server.address().port,
        path: '/api/v1/schulnetz/guest',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': String(1024 * 1024) },
      }, (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => setTimeout(() => done({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), destroyed: req.destroyed }), 50))
      })
      req.on('error', () => done({ status: 0, body: '', destroyed: req.destroyed }))
      req.write('{}')
      setTimeout(() => done({ status: 0, body: '', destroyed: req.destroyed }), 2000)
    })
    assert.equal(result.status, 413)
    assert.equal(JSON.parse(result.body).error, 'Die Anfrage ist zu gross.')
    assert.equal(result.destroyed, true)
    assert.deepEqual(await readdir(join(root, 'accounts')).catch(() => []), [])
  } finally {
    await new Promise((done) => server.close(done))
    await rm(root, { recursive: true, force: true })
  }
})

test('an oversized Schulnetz page is not stored and an error page is not read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fcm-school-body-'))
  const accountId = 'd'.repeat(32)
  let phase = 'retry'
  let retried = false
  let cancelled = 0
  let reads = 0
  const fetch = async (url) => {
    const target = String(url)
    if (target.endsWith('/token.php')) {
      return { status: 200, text: async () => JSON.stringify({ access_token: 'access-token-value', refresh_token: 'rotated-refresh-token-value-123456', expires_in: 3600 }) }
    }
    if (target.includes('/me/grades')) {
      if (phase === 'retry' && !retried) {
        retried = true
        return {
          status: 503,
          body: {
            getReader: () => ({
              read: async () => { reads += 1; return { done: true, value: undefined } },
              cancel: async () => { cancelled += 1 },
            }),
          },
        }
      }
      if (phase === 'huge') return { status: 200, text: async () => 'x'.repeat(SCHOOL_BODY_MAX + 1) }
    }
    return { status: 200, text: async () => '[]' }
  }
  const runtime = createSchulnetzRuntime({
    root,
    key: randomBytes(32),
    fetch,
    autostart: false,
    fcmSend: async () => ({ status: 200 }),
  })
  const snapshot = join(root, 'accounts', accountId, 'snapshot.json')
  try {
    await runtime.linkAccount(accountId, {
      baseUrl: 'https://www.schulnetz-ag.ch/aksa',
      deviceId: '0123456789abcdef01234567',
      refreshToken: 'synthetic-refresh-token-long-enough',
    })
    await runtime.pollAccount(accountId)
    assert.equal(cancelled, 1)
    assert.equal(reads, 0)
    const before = await readFile(snapshot)
    phase = 'huge'
    await assert.rejects(() => runtime.pollAccount(accountId), (error) => error?.message === 'page too large')
    assert.equal((await readFile(snapshot)).equals(before), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

const untilAbort = (signal) => new Promise((_, reject) => {
  const fail = () => reject(signal.reason)
  if (signal?.aborted) fail()
  else signal.addEventListener('abort', fail, { once: true })
})

test('a hung FCM call is abandoned and tried again', async () => {
  assert.equal(FCM_TIMEOUT_MS, 12_000)
  let posts = 0
  const sent = await deliverFcm({
    fetchImpl: async (_url, init) => {
      posts += 1
      assert.equal(init.redirect, 'error')
      if (posts === 1) await untilAbort(init.signal)
      return { status: 200, text: async () => '{}' }
    },
    url: 'https://fcm.googleapis.com/v1/projects/demo/messages:send',
    message: { message: { token: 'phone:APA91b-example-token-value', data: { event: 'sync' } } },
    headers: { Authorization: 'Bearer secret-token' },
    sleep: async () => {},
    timeoutMs: 30,
    jsonLog: createServiceLog('fcm', () => {}, () => new Date('2026-11-15T11:00:00.000Z')),
  })
  assert.equal(sent.status, 200)
  assert.equal(posts, 2)

  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const account = {
    client_email: 'push@kanti-test.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    project_id: 'kanti-test',
  }
  const lines = []
  let signIns = 0
  const signed = await exchangeServiceAccount(account, async (_url, init) => {
    signIns += 1
    assert.equal(init.redirect, 'error')
    if (signIns === 1) await untilAbort(init.signal)
    return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'ya29.secret-access-token', expires_in: 3600 }) }
  }, Date.parse('2026-11-15T11:00:00Z'), {
    sleep: async () => {},
    timeoutMs: 30,
    jsonLog: createServiceLog('fcm', (line) => lines.push(line), () => new Date('2026-11-15T11:00:00.000Z')),
  })
  assert.equal(signed.projectId, 'kanti-test')
  assert.equal(signIns, 2)
  assert.equal(lines.join('\n').includes('ya29'), false)
  assert.equal(lines.join('\n').includes('PRIVATE'), false)
})

test('an unreadable push ledger is left in place', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fcm-ledger-'))
  const file = join(root, 'pushed-notices.json')
  const kept = grade('grade:keep:5')
  const extra = grade('grade:new:4')
  try {
    assert.equal((await claimPushKeys(file, [kept])).length, 1)
    const before = await readFile(file)
    await chmod(file, 0o000)
    try {
      const during = await claimPushKeys(file, [kept, extra])
      assert.deepEqual(during.map((change) => change.id), ['grade:keep:5', 'grade:new:4'])
    } finally {
      await chmod(file, 0o600)
    }
    assert.deepEqual(await readFile(file), before)
    assert.equal((await claimPushKeys(file, [kept])).length, 0)
    await writeFile(file, '{', { mode: 0o600 })
    assert.equal((await claimPushKeys(file, [extra])).length, 1)
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(parsed.version, 1)
    assert.equal(parsed.keys.length, 1)
    assert.equal(JSON.stringify(parsed).includes('grade:new'), false)
  } finally {
    await chmod(file, 0o600).catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})
