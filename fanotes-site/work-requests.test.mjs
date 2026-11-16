import assert from 'node:assert/strict'
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createWorkRequestsHandler, createWorkRequestsStore, REQUESTS_CREATE_PER_HOUR, REQUESTS_SSE_PER_ACCOUNT } from './work-requests-api.mjs'

const OWNER = 'a'.repeat(32)
const OTHER = 'b'.repeat(32)
const AGENT = 'agent-token-'.padEnd(40, 'x')
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)])

// Session tokens in the tests are "s-<accountId>"; the fake authenticator mirrors the sync one.
const authenticate = async (request) => {
  const match = /^Bearer s-([0-9a-f]{32})$/u.exec(request.headers.authorization ?? '')
  if (!match) throw Object.assign(new Error('Bitte erneut anmelden.'), { status: 401 })
  return { account: { id: match[1] } }
}

const start = async (env = { FANOTES_REQUEST_OWNERS: OWNER, FANOTES_AGENT_TOKEN: AGENT }, options = {}) => {
  const dir = await mkdtemp(join(tmpdir(), 'fanotes-req-'))
  const store = createWorkRequestsStore(dir)
  const handler = createWorkRequestsHandler(store, { env, authenticate, heartbeatMs: 40, ...options })
  const server = createServer(async (req, res) => { if (!(await handler(req, res, new URL(req.url, 'http://x')))) { res.writeHead(404); res.end() } })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}/api/v1`
  const call = async (method, path, { token = `s-${OWNER}`, body, headers = {} } = {}) => {
    const response = await fetch(`${base}${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : {} }
  }
  const worker = (method, path, body) => call(method, `/worker${path}`, { token: AGENT, body })
  return { dir, base, call, worker, close: async () => { server.closeAllConnections(); server.close(); await rm(dir, { recursive: true, force: true }) } }
}
const draft = (extra = {}) => ({ type: 'bug', title: 'Radierer hängt', description: 'Der Radierer reagiert nicht.', ...extra })
const create = async (s, extra) => (await s.call('POST', '/requests', { body: draft(extra) })).body.request

test('owner vs non-owner and feature switch', async () => {
  const s = await start()
  try {
    assert.deepEqual((await s.call('GET', '/requests/capabilities')).body.enabled, true)
    assert.deepEqual((await s.call('GET', '/requests/capabilities', { token: `s-${OTHER}` })).body, { enabled: false })
    assert.equal((await s.call('GET', '/requests/capabilities', { token: null })).status, 401)
    assert.equal((await s.call('POST', '/requests', { token: `s-${OTHER}`, body: draft() })).status, 403)
    assert.equal((await s.call('GET', '/requests', { token: `s-${OTHER}` })).status, 403)
    const made = await create(s)
    assert.equal(made.status, 'queued')
    assert.equal(made.accountId, undefined)
    assert.equal((await s.call('GET', `/requests/${made.id}`, { token: `s-${OTHER}` })).status, 403)
    assert.equal((await s.call('GET', '/requests')).body.requests.length, 1)
    assert.equal((await s.call('GET', '/requests/rdeadbeefdeadbeef')).status, 404)
  } finally { await s.close() }
  const off = await start({ FANOTES_REQUEST_OWNERS: '', FANOTES_AGENT_TOKEN: AGENT })
  try {
    assert.deepEqual((await off.call('GET', '/requests/capabilities')).body, { enabled: false })
    assert.equal((await off.call('POST', '/requests', { body: draft() })).status, 403)
  } finally { await off.close() }
})

test('worker endpoints need the agent token', async () => {
  const s = await start()
  try {
    assert.equal((await s.call('POST', '/worker/claim', { token: null })).status, 401)
    assert.equal((await s.call('POST', '/worker/claim', { token: `s-${OWNER}` })).status, 401)
    assert.equal((await s.call('POST', '/worker/claim', { token: AGENT.slice(0, -1) })).status, 401)
    assert.equal((await s.worker('POST', '/claim')).status, 200)
  } finally { await s.close() }
  const unset = await start({ FANOTES_REQUEST_OWNERS: OWNER })
  try { assert.equal((await unset.worker('POST', '/claim')).status, 503) } finally { await unset.close() }
})

test('claim is atomic, oldest first and one at a time', async () => {
  const s = await start()
  try {
    const first = await create(s, { title: 'Erste' })
    await create(s, { title: 'Zweite' })
    const results = await Promise.all([s.worker('POST', '/claim'), s.worker('POST', '/claim')])
    const claimed = results.filter((r) => r.body.request)
    assert.equal(claimed.length, 1, 'exactly one worker wins')
    assert.equal(claimed[0].body.request.id, first.id)
    assert.equal(claimed[0].body.request.status, 'picked')
    assert.equal(results.find((r) => !r.body.request).body.busy, true)
    assert.equal((await s.worker('POST', '/claim')).body.busy, true)
  } finally { await s.close() }
})

test('status machine follows the design and rejects invalid transitions', async () => {
  const s = await start()
  try {
    const made = await create(s)
    const id = made.id
    assert.equal((await s.worker('POST', `/requests/${id}/status`, { status: 'working' })).status, 409, 'queued cannot skip the claim')
    assert.equal((await s.worker('POST', `/requests/${id}/events`, { text: 'x' })).status, 409)
    await s.worker('POST', '/claim')
    assert.equal((await s.worker('POST', `/requests/${id}/status`, { status: 'pr_open', prNumber: 5 })).status, 409, 'picked -> pr_open is illegal')
    assert.equal((await s.worker('POST', `/requests/${id}/status`, { status: 'bogus' })).status, 400)
    assert.equal((await s.worker('POST', `/requests/${id}/status`, { status: 'working' })).status, 200)
    assert.equal((await s.worker('POST', `/requests/${id}/events`, { text: 'Tests laufen', percent: 40 })).status, 201)
    assert.equal((await s.worker('POST', `/requests/${id}/events`, { text: 'x', percent: 140 })).status, 400)
    assert.equal((await s.worker('POST', `/requests/${id}/status`, { status: 'pr_open' })).status, 400, 'PR number required')
    assert.equal((await s.worker('POST', `/requests/${id}/status`, { status: 'pr_open', prNumber: 7, prUrl: 'https://github.com/x/y/pull/7', ci: 'pending' })).status, 200)
    assert.equal((await s.call('POST', `/requests/${id}/approve`)).status, 409, 'cannot approve before waiting_for_you')
    assert.equal((await s.worker('POST', `/requests/${id}/status`, { status: 'waiting_for_you', ci: 'success' })).status, 200)
    assert.equal((await s.worker('POST', `/requests/${id}/status`, { status: 'merged' })).status, 409, 'merge needs the owner approval')
    assert.equal((await s.call('POST', `/requests/${id}/approve`, { token: `s-${OTHER}` })).status, 403)
    assert.equal((await s.call('POST', `/requests/${id}/approve`)).body.request.approved, true)
    const merged = await s.worker('POST', `/requests/${id}/status`, { status: 'merged' })
    assert.equal(merged.status, 200)
    const detail = (await s.call('GET', `/requests/${id}`)).body.request
    assert.equal(detail.status, 'merged')
    assert.equal(detail.percent, 100)
    assert.deepEqual(detail.pr, { number: 7, url: 'https://github.com/x/y/pull/7', ci: 'success' })
    assert.equal((await s.worker('POST', `/requests/${id}/status`, { status: 'working' })).status, 409, 'terminal states are final')
    assert.equal((await s.call('POST', `/requests/${id}/cancel`)).status, 409)
    assert.equal((await s.call('POST', `/requests/${id}/messages`, { body: { text: 'hi' } })).status, 409)
  } finally { await s.close() }
})

test('cancel, failure reason and messages for the worker', async () => {
  const s = await start()
  try {
    const a = await create(s)
    const cancelled = (await s.call('POST', `/requests/${a.id}/cancel`)).body.request
    assert.equal(cancelled.status, 'rejected')
    assert.equal(cancelled.cancelled, true)
    assert.equal((await s.worker('POST', '/claim')).body.request, null, 'cancelled requests are not claimed')
    const b = await create(s)
    await s.worker('POST', '/claim')
    assert.equal((await s.call('POST', `/requests/${b.id}/messages`, { body: { text: '  Bitte kleiner  ' } })).status, 201)
    assert.equal((await s.call('POST', `/requests/${b.id}/messages`, { body: { text: '' } })).status, 400)
    const messages = (await s.worker('GET', `/requests/${b.id}/messages`)).body
    assert.equal(messages.messages.length, 1)
    assert.equal(messages.messages[0].text, 'Bitte kleiner')
    assert.equal((await s.worker('GET', `/requests/${b.id}/messages?after=${messages.messages[0].seq}`)).body.messages.length, 0)
    assert.equal((await s.worker('POST', `/requests/${b.id}/status`, { status: 'failed' })).status, 400, 'a reason is required')
    assert.equal((await s.worker('POST', `/requests/${b.id}/status`, { status: 'failed', reason: 'Tests rot' })).status, 200)
    assert.equal((await s.call('GET', `/requests/${b.id}`)).body.request.reason, 'Tests rot')
  } finally { await s.close() }
})

test('attachments are validated, scrubbed and stored with private modes', async () => {
  const s = await start()
  try {
    assert.equal((await s.call('POST', '/requests', { body: draft({ screenshot: Buffer.from('not an image').toString('base64') }) })).status, 400)
    assert.equal((await s.call('POST', '/requests', { body: draft({ screenshot: Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]).toString('base64') }) })).status, 413)
    assert.equal((await s.call('POST', '/requests', { body: draft({ logs: 'x'.repeat(256 * 1024 + 1) }) })).status, 413)
    assert.equal((await s.call('POST', '/requests', { body: draft({ title: '' }) })).status, 400)
    assert.equal((await s.call('POST', '/requests', { body: draft({ type: 'other' }) })).status, 400)
    const ok = await s.call('POST', '/requests', { body: draft({ screenshot: PNG.toString('base64'), logs: 'error for me@example.com in /home/u/Notes/a.md\nsecond line' }) })
    assert.equal(ok.status, 201)
    const id = ok.body.request.id
    const shot = await fetch(`${s.base}/requests/${id}/attachments/screenshot`, { headers: { Authorization: `Bearer s-${OWNER}` } })
    assert.equal(shot.headers.get('content-type'), 'image/png')
    assert.deepEqual(Buffer.from(await shot.arrayBuffer()), PNG)
    const logs = await (await fetch(`${s.base}/worker/requests/${id}/attachments/logs`, { headers: { Authorization: `Bearer ${AGENT}` } })).text()
    assert.ok(!/me@example|\/home\/u/u.test(logs) && logs.includes('second line'))
    assert.equal((await fetch(`${s.base}/requests/${id}/attachments/screenshot`, { headers: { Authorization: `Bearer s-${OTHER}` } })).status, 403)
    assert.equal((await stat(join(s.dir, 'requests'))).mode & 0o777, 0o700)
    assert.equal((await stat(join(s.dir, 'requests', `${id}.json`))).mode & 0o777, 0o600)
    assert.equal((await stat(join(s.dir, 'attachments', id, 'screenshot'))).mode & 0o777, 0o600)
    assert.ok((await readFile(join(s.dir, 'events', `${id}.jsonl`), 'utf8')).includes('"queued"'))
  } finally { await s.close() }
})

test('rate limit on create and open request cap', async () => {
  const s = await start()
  try {
    for (let i = 0; i < REQUESTS_CREATE_PER_HOUR; i += 1) assert.equal((await s.call('POST', '/requests', { body: draft() })).status, i < 10 ? 201 : 429)
    assert.equal((await s.call('POST', '/requests', { body: draft() })).status, 429)
  } finally { await s.close() }
})

// Reads SSE frames until `until` returns true, then aborts.
const readSse = async (url, token, until, headers = {}) => {
  const controller = new AbortController()
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, ...headers }, signal: controller.signal })
  if (response.status !== 200) return { status: response.status, frames: [], text: '' }
  const decoder = new TextDecoder()
  let text = ''
  try {
    for await (const chunk of response.body) {
      text += decoder.decode(chunk, { stream: true })
      if (until(text)) break
    }
  } finally { controller.abort() }
  const frames = text.split('\n\n').filter((f) => f.includes('data: ')).map((f) => ({ id: Number(/^id: (\d+)$/mu.exec(f)?.[1]), data: JSON.parse(/^data: (.*)$/mu.exec(f)[1]) }))
  return { status: 200, frames, text }
}

test('SSE replays, streams live events, resumes with Last-Event-ID and heartbeats', async () => {
  const s = await start()
  try {
    const made = await create(s)
    await s.worker('POST', '/claim')
    const url = `${s.base}/requests/${made.id}/events`
    const live = readSse(url, `s-${OWNER}`, (t) => t.includes('Schritt zwei') && t.includes(': heartbeat'))
    await new Promise((r) => setTimeout(r, 120))
    await s.worker('POST', `/requests/${made.id}/status`, { status: 'working' })
    await s.worker('POST', `/requests/${made.id}/events`, { text: 'Schritt zwei', percent: 20 })
    const first = await live
    assert.deepEqual(first.frames.map((f) => f.id), [1, 2, 3, 4], 'replay (queued, picked) then live (working, progress)')
    assert.equal(first.frames[3].data.text, 'Schritt zwei')
    assert.ok(first.text.includes(': heartbeat'))
    const resumed = await readSse(url, `s-${OWNER}`, (t) => t.includes('id: 4'), { 'Last-Event-ID': '2' })
    assert.deepEqual(resumed.frames.map((f) => f.id), [3, 4])
    assert.equal((await readSse(url, `s-${OTHER}`, () => true)).status, 403)
    // The stream ends by itself after a terminal status.
    const done = readSse(url, `s-${OWNER}`, () => false)
    await new Promise((r) => setTimeout(r, 100))
    await s.worker('POST', `/requests/${made.id}/status`, { status: 'failed', reason: 'kaputt' })
    const all = await done
    assert.equal(all.frames.at(-1).data.status, 'failed')
  } finally { await s.close() }
})

test('SSE connections are capped per account', async () => {
  const s = await start()
  try {
    const made = await create(s)
    const controllers = []
    for (let i = 0; i < REQUESTS_SSE_PER_ACCOUNT; i += 1) {
      const controller = new AbortController()
      controllers.push(controller)
      const response = await fetch(`${s.base}/requests/${made.id}/events`, { headers: { Authorization: `Bearer s-${OWNER}` }, signal: controller.signal })
      assert.equal(response.status, 200)
    }
    const over = await fetch(`${s.base}/requests/${made.id}/events`, { headers: { Authorization: `Bearer s-${OWNER}` } })
    assert.equal(over.status, 429)
    await over.text()
    for (const controller of controllers) controller.abort()
  } finally { await s.close() }
})

test('auto-approve marks a request approved when it reaches waiting_for_you', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fanotes-req-'))
  try {
    for (const autoApprove of [false, true]) {
      const store = createWorkRequestsStore(join(dir, String(autoApprove)), { autoApprove })
      const created = await store.create(OWNER, { type: 'bug', title: 'T', description: 'D', priority: 'normal' })
      await store.claim()
      await store.workerStatus(created.id, { status: 'working' })
      await store.workerStatus(created.id, { status: 'pr_open', pr: { number: 1 } })
      const { request } = await store.workerStatus(created.id, { status: 'waiting_for_you' })
      assert.equal(request.approved, autoApprove)
      const events = await store.readEvents(created.id)
      assert.equal(events.some((event) => event.type === 'approved' && event.by === 'auto'), autoApprove)
      if (autoApprove) assert.equal((await store.workerStatus(created.id, { status: 'merged' })).request.status, 'merged')
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
})
