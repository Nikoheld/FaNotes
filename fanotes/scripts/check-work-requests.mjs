// Logic check for src/lib/workRequests.ts, including a run of the client against the real server module
// (fanotes-site/work-requests-api.mjs) in-process with a temp FANOTES_REQUESTS_DIR and a fake sync authenticator.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'vite'
import { createWorkRequestsHandler, createWorkRequestsStore } from '../../fanotes-site/work-requests-api.mjs'

const server = await createServer({ appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true } })
const wr = await server.ssrLoadModule('/src/lib/workRequests.ts')
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return; await wait(10) } assert.fail('condition not reached') }

const OWNER = 'a'.repeat(32)
const OTHER = 'b'.repeat(32)
const AGENT = 'agent-token-'.padEnd(40, 'x')
const PNG_B64 = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]).toString('base64')

const dir = await mkdtemp(join(tmpdir(), 'fanotes-wr-check-'))
let http
try {
  // ---- pure logic
  assert.equal(wr.normalizeStatus('working'), 'working')
  assert.equal(wr.normalizeStatus('nonsense'), 'queued')
  assert.equal(wr.statusInfo('merged').tone, 'success')
  assert.equal(wr.statusInfo('waiting_for_you').tone, 'attention')
  assert.equal(wr.statusInfo('rejected', true).label, 'Abgebrochen')
  assert.equal(wr.statusInfo('rejected').label, 'Abgelehnt')
  for (const s of ['merged', 'rejected', 'failed']) { assert.ok(wr.isTerminal(s)); assert.ok(!wr.canCancel(s)); assert.ok(!wr.canApprove(s)) }
  assert.ok(wr.canApprove('waiting_for_you') && !wr.canApprove('waiting_for_you', true) && !wr.canApprove('pr_open') && !wr.canApprove('working'))
  assert.equal(wr.ciLabel('success'), 'bestanden'); assert.equal(wr.ciLabel('failure'), 'fehlgeschlagen'); assert.equal(wr.ciLabel('pending'), 'läuft'); assert.equal(wr.ciLabel('weird'), 'ausstehend'); assert.equal(wr.ciLabel(null), null)
  // progress bar follows the latest event percent, not the request snapshot
  const snap = wr.parseWorkRequest({ id: 'r1', status: 'working', percent: 40 })
  const ev = (seq, percent) => wr.parseWorkRequestEvent({ seq, type: 'progress', text: 'x', percent })
  assert.equal(wr.progressPercent(snap, [ev(1, 10), ev(2, 70)]), 70)
  assert.equal(wr.progressPercent(snap, []), 40)
  assert.equal(wr.progressPercent(wr.parseWorkRequest({ id: 'r', status: 'merged' }), [ev(1, 70)]), null)
  assert.equal(wr.parseWorkRequest({ id: 'b', pr: { number: 7, url: 'javascript:alert(1)' } }).pr, null)
  assert.equal(wr.parseCapabilities({ enabled: true }), true)
  assert.equal(wr.parseCapabilities({ enabled: false }), false)
  const ok = { kind: 'bug', title: 'Titel', description: 'Text', priority: 'normal' }
  assert.equal(wr.validateDraft(ok), null)
  assert.equal(wr.validateDraft({ ...ok, title: '  ' }), 'title')
  assert.equal(wr.validateDraft({ ...ok, title: 'x'.repeat(121) }), 'title')
  assert.equal(wr.validateDraft({ ...ok, description: '' }), 'description')
  assert.equal(wr.validateDraft({ ...ok, screenshot: 'http://evil/x.png' }), 'screenshot')
  assert.equal(wr.validateDraft({ ...ok, screenshot: 'data:image/png;base64,' + 'A'.repeat(3 * 1024 * 1024) }), 'screenshot')
  assert.equal(wr.validateDraft({ ...ok, logs: [{ message: 'x'.repeat(300 * 1024) }] }), 'logs')

  // ---- client against the real server module
  const store = createWorkRequestsStore(dir)
  const authenticate = async (request) => {
    const m = /^Bearer s-([0-9a-f]{32})$/u.exec(request.headers.authorization ?? '')
    if (!m || request.headers['x-fanotes-account'] !== m[1]) throw Object.assign(new Error('Bitte erneut anmelden.'), { status: 401 })
    return { account: { id: m[1] } }
  }
  const handler = createWorkRequestsHandler(store, { env: { FANOTES_REQUEST_OWNERS: OWNER, FANOTES_AGENT_TOKEN: AGENT }, authenticate, heartbeatMs: 50 })
  http = createHttpServer(async (req, res) => { if (!(await handler(req, res, new URL(req.url, 'http://x')))) { res.writeHead(404); res.end() } })
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${http.address().port}`
  const session = (id) => ({ accountId: id, deviceId: 'd', token: `s-${id}`, expiresAt: '', email: 'x@y' })
  const clientFor = (id) => new wr.WorkRequestsClient({ origin, getSession: () => id ? session(id) : null })
  const owner = clientFor(OWNER)
  const worker = async (path, body, method = 'POST') => (await fetch(`${origin}/api/v1/worker${path}`, { method, headers: { Authorization: `Bearer ${AGENT}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })).json()

  assert.equal(await owner.capabilities(), true)
  assert.equal(await clientFor(OTHER).capabilities(), false)
  assert.equal(await clientFor(null).capabilities(), false)

  await assert.rejects(() => owner.create({ ...ok, title: '' }), (e) => e.status === 400)
  const created = await owner.create({ kind: 'feature', title: 'Dunkles Thema', description: 'Bitte.', priority: 'high', screenshot: `data:image/png;base64,${PNG_B64}`, logs: [{ at: 1, kind: 'app', message: 'hi' }, { at: 2, kind: 'tool' }] })
  assert.equal(created.status, 'queued'); assert.equal(created.kind, 'feature'); assert.equal(created.priority, 'high')
  assert.equal((await owner.list()).length, 1)
  assert.equal((await clientFor(OTHER).list().catch((e) => e.status)), 403)
  assert.equal((await owner.detail(created.id)).title, 'Dunkles Thema')

  // Live updates through the real SSE endpoint: replay, then pushes, ends after a terminal status.
  const seen = []
  const stop = owner.subscribe(created.id, (d) => seen.push(d), undefined, 50)
  await until(() => seen.some((d) => d.events.some((e) => e.status === 'queued')))
  const claim = await worker('/claim', {})
  assert.equal(claim.request.id, created.id)
  await worker(`/requests/${created.id}/status`, { status: 'working' })
  await worker(`/requests/${created.id}/events`, { text: 'Tests laufen', percent: 70 })
  await until(() => seen.at(-1).request.percent === 70 && seen.at(-1).request.status === 'working')
  const latest = seen.at(-1)
  assert.equal(wr.progressPercent(latest.request, latest.events), 70)
  assert.ok(latest.events.map(wr.describeEvent).includes('Tests laufen'))
  await worker(`/requests/${created.id}/status`, { status: 'pr_open', prNumber: 42, prUrl: 'https://github.com/x/y/pull/42', ci: 'pending' })
  await worker(`/requests/${created.id}/status`, { status: 'waiting_for_you', ci: 'success' })
  await until(() => seen.at(-1).request.status === 'waiting_for_you')
  assert.equal(seen.at(-1).request.pr.number, 42); assert.equal(wr.ciLabel(seen.at(-1).request.pr.ci), 'bestanden')
  assert.ok(wr.canApprove(seen.at(-1).request.status, seen.at(-1).request.approved))

  await owner.message(created.id, 'Bitte auch Hellmodus.')
  assert.deepEqual((await worker(`/requests/${created.id}/messages?after=0`, undefined, 'GET')).messages.map((m) => m.text), ['Bitte auch Hellmodus.'])
  await owner.approve(created.id)
  await until(() => seen.at(-1).request.approved)
  assert.ok(!wr.canApprove(seen.at(-1).request.status, true))
  await worker(`/requests/${created.id}/status`, { status: 'merged' })
  await until(() => seen.at(-1).request.status === 'merged')
  stop()
  const lastSeqs = seen.at(-1).events.map((e) => e.seq)
  assert.deepEqual(lastSeqs, [...new Set(lastSeqs)].sort((a, b) => a - b), 'events are unique and ordered')

  // Cancel maps to rejected + cancelled
  const second = await owner.create(ok)
  await owner.cancel(second.id)
  const cancelled = await owner.detail(second.id)
  assert.equal(cancelled.status, 'rejected'); assert.equal(cancelled.cancelled, true)
  assert.equal(wr.statusInfo(cancelled.status, cancelled.cancelled).label, 'Abgebrochen')

  // Subscribing to a finished request resolves from the detail alone
  const done = []
  const stop2 = owner.subscribe(second.id, (d) => done.push(d), undefined, 50)
  await until(() => done.length > 0); stop2()

  // Fallback to polling when the stream cannot be opened
  const third = await owner.create(ok)
  const mock = new wr.WorkRequestsClient({
    origin, getSession: () => session(OWNER),
    fetchImpl: (url, init) => String(url).endsWith('/events') ? Promise.resolve(new Response('no', { status: 502 })) : fetch(url, init),
  })
  const polled = []
  const stop3 = mock.subscribe(third.id, (d) => polled.push(d.request.status), undefined, 30)
  await wait(50)
  await worker('/claim', {})
  await worker(`/requests/${third.id}/status`, { status: 'failed', reason: 'kaputt' })
  await until(() => polled.at(-1) === 'failed')
  stop3()
  const count = polled.length
  await wait(120)
  assert.equal(polled.length, count, 'polling stops after a terminal status')
  console.log('work-requests ok')
} finally {
  http?.closeAllConnections(); http?.close()
  await rm(dir, { recursive: true, force: true })
  await server.close()
}
