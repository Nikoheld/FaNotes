// Logic check for src/lib/workRequests.ts: status mapping, request validation, SSE fallback to polling.
import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({ appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true } })
const wr = await server.ssrLoadModule('/src/lib/workRequests.ts')

try {
  // Status mapping
  assert.equal(wr.normalizeStatus('working'), 'working')
  assert.equal(wr.normalizeStatus('nonsense'), 'queued')
  assert.equal(wr.statusInfo('merged').tone, 'success')
  assert.equal(wr.statusInfo('waiting_for_you').tone, 'attention')
  assert.equal(wr.statusInfo('failed').tone, 'danger')
  for (const s of ['merged', 'rejected', 'failed', 'cancelled']) { assert.ok(wr.isTerminal(s)); assert.ok(!wr.canCancel(s)); assert.ok(!wr.canApprove(s)) }
  assert.ok(wr.canApprove('pr_open') && wr.canApprove('waiting_for_you') && !wr.canApprove('working'))
  assert.ok(wr.canCancel('queued') && wr.canMessage('working'))

  // Parsing
  const parsed = wr.parseWorkRequest({ id: 'a', type: 'feature', title: 'T', status: 'pr_open', percent: 140, pr: { number: 7, url: 'https://github.com/x/y/pull/7', ci: 'success' } })
  assert.equal(parsed.kind, 'feature'); assert.equal(parsed.percent, 100); assert.equal(parsed.pr.number, 7)
  assert.equal(wr.parseWorkRequest({ id: 'b', pr: { number: 7, url: 'javascript:alert(1)' } }).pr, null, 'non-https PR links are dropped')
  const list = wr.parseWorkRequestList({ requests: [{ id: '1', createdAt: '2026-01-01' }, { id: '2', createdAt: '2026-02-01' }, { title: 'no id' }] })
  assert.deepEqual(list.map((r) => r.id), ['2', '1'])
  assert.equal(wr.parseCapabilities({ allowed: true }), true)
  assert.equal(wr.parseCapabilities({ allowed: false }), false)
  assert.equal(wr.parseCapabilities(null), false)

  // Validation
  const ok = { kind: 'bug', title: 'Titel', description: 'Text', priority: 'normal' }
  assert.equal(wr.validateDraft(ok), null)
  assert.equal(wr.validateDraft({ ...ok, title: '  ' }), 'title')
  assert.equal(wr.validateDraft({ ...ok, title: 'x'.repeat(121) }), 'title')
  assert.equal(wr.validateDraft({ ...ok, description: '' }), 'description')
  assert.equal(wr.validateDraft({ ...ok, screenshot: 'http://evil/x.png' }), 'screenshot')
  assert.equal(wr.validateDraft({ ...ok, screenshot: 'data:image/png;base64,' + 'A'.repeat(3 * 1024 * 1024) }), 'screenshot')
  assert.equal(wr.validateDraft({ ...ok, screenshot: 'data:image/jpeg;base64,AAAA' }), null)
  assert.equal(wr.validateDraft({ ...ok, logs: [{ message: 'x'.repeat(300 * 1024) }] }), 'logs')

  // Client: auth headers, create body, capabilities failure
  const session = { accountId: 'acc', deviceId: 'd', token: 'tok', expiresAt: '', email: 'a@b' }
  const calls = []
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  const base = (fetchImpl, getSession = () => session) => new wr.WorkRequestsClient({ getSession, origin: 'https://example.test', fetchImpl })
  const client = base(async (url, init) => { calls.push({ url, init }); return json({ id: 'r1', title: 'T', status: 'queued' }) })
  await client.create({ ...ok, screenshot: 'data:image/png;base64,AAAA', logs: [{ at: 1 }] })
  assert.equal(calls[0].url, 'https://example.test/api/v1/requests')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers.get('Authorization'), 'Bearer tok')
  assert.equal(calls[0].init.headers.get('X-FaNotes-Account'), 'acc')
  const sent = JSON.parse(calls[0].init.body)
  assert.equal(sent.type, 'bug'); assert.equal(sent.logs.length, 1)
  await assert.rejects(() => client.create({ ...ok, title: '' }), (e) => e.status === 400)
  await client.approve('r 1'); assert.equal(calls.at(-1).url, 'https://example.test/api/v1/requests/r%201/approve')
  await client.cancel('r1'); assert.match(calls.at(-1).url, /\/r1\/cancel$/u)
  await client.message('r1', 'hallo'); assert.equal(JSON.parse(calls.at(-1).init.body).message, 'hallo')
  await assert.rejects(() => client.message('r1', '  '), (e) => e.status === 400)
  assert.equal(await base(async () => json({ allowed: true })).capabilities(), true)
  assert.equal(await base(async () => json({ error: 'x' }, 403)).capabilities(), false)
  assert.equal(await base(async () => { throw new TypeError('offline') }).capabilities(), false)
  assert.equal(await base(async () => json({ allowed: true }), () => null).capabilities(), false, 'signed out')

  // Subscribe: stream unavailable -> polls until terminal
  {
    let detailCalls = 0
    const statuses = ['working', 'working', 'merged']
    const c = base(async (url) => {
      if (url.endsWith('/events')) return new Response('nope', { status: 404 })
      const status = statuses[Math.min(detailCalls++, statuses.length - 1)]
      return json({ request: { id: 'r1', status }, events: [] })
    })
    const seen = []
    const stop = c.subscribe('r1', (d) => seen.push(d.request.status), undefined, 10)
    await new Promise((resolve) => setTimeout(resolve, 200))
    stop()
    assert.deepEqual(seen, ['working', 'working', 'merged'])
    const n = detailCalls
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(detailCalls, n, 'polling stops after a terminal status')
  }
  // Subscribe: SSE push triggers a refresh; stream end falls back to polling
  {
    let detailCalls = 0
    const enc = new TextEncoder()
    const c = base(async (url) => {
      if (url.endsWith('/events')) {
        const stream = new ReadableStream({ start(controller) { controller.enqueue(enc.encode('event: progress\ndata: {}\n\n')); setTimeout(() => controller.close(), 30) } })
        return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })
      }
      detailCalls += 1
      return json({ request: { id: 'r1', status: detailCalls > 3 ? 'failed' : 'working', reason: 'x' }, events: [] })
    })
    const seen = []
    const stop = c.subscribe('r1', (d) => seen.push(d.request.status), undefined, 10)
    await new Promise((resolve) => setTimeout(resolve, 250))
    stop()
    assert.equal(seen[0], 'working'); assert.equal(seen.at(-1), 'failed')
    assert.ok(seen.length >= 3, 'initial load, one SSE refresh, then polling')
  }
  // Unsubscribe stops everything
  {
    let n = 0
    const c = base(async () => { n += 1; return json({ request: { id: 'r1', status: 'working' }, events: [] }) })
    const stop = c.subscribe('r1', () => {}, undefined, 10)
    await new Promise((resolve) => setTimeout(resolve, 40)); stop()
    const after = n
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.ok(n - after <= 1)
  }
  console.log('work-requests ok')
} finally {
  await server.close()
}
