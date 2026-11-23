import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, utimes, writeFile, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'
import test from 'node:test'
import { clientAddress, createDiagnosticsHandler, createDiagnosticsStore, validateDiagnosticsPayload } from './diagnostics-api.mjs'
import { aggregate, readRecords } from './scripts/diagnostics-report.mjs'

const ID = 'a'.repeat(32)
const payload = (extra = {}) => ({ schemaVersion: 1, kind: 'daily', installId: ID, app: { version: '1.0.0', platform: 'linux' }, usage: { counters: { 'tool.pen': 5, 'Bad Name!': 9 }, errors: { 'TypeError|ENOENT|0123456789ab': 2, 'boom at /home/x/y/z.md': 9 }, perf: { startupMs: 1200 }, vault: { notes: 100, sizeMb: 50 } }, ...extra })

const start = async (now = () => Date.now()) => {
  const dir = await mkdtemp(join(tmpdir(), 'fanotes-diag-'))
  const store = createDiagnosticsStore(dir, { now })
  const handler = createDiagnosticsHandler(store)
  const server = createServer(async (req, res) => { if (!(await handler(req, res, new URL(req.url, 'http://x')))) { res.writeHead(404); res.end() } })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { dir, store, base: `http://127.0.0.1:${server.address().port}`, close: async () => { server.close(); await rm(dir, { recursive: true, force: true }) } }
}

test('validation rejects bad ids, schema and empty payloads, and drops bad counters', () => {
  assert.equal(validateDiagnosticsPayload(null).ok, false)
  assert.equal(validateDiagnosticsPayload(payload({ installId: 'x' })).ok, false)
  assert.equal(validateDiagnosticsPayload(payload({ schemaVersion: 2 })).ok, false, 'version 2 is the batch schema only')
  assert.equal(validateDiagnosticsPayload({ schemaVersion: 1, kind: 'daily', installId: ID }).ok, false)
  const ok = validateDiagnosticsPayload(payload())
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.record.usage.counters, { 'tool.pen': 5 })
  assert.deepEqual(ok.record.usage.errors, { 'TypeError|ENOENT|0123456789ab': 2 }, 'free-text error keys are dropped')
})

test('server stores JSONL, enforces size and rate limits, deletes by install id, cleans up', async () => {
  let clock = Date.parse('2026-11-15T10:00:00Z')
  const s = await start(() => clock)
  try {
    let r = await fetch(`${s.base}/api/v1/diagnostics`, { method: 'POST', body: JSON.stringify(payload({ kind: 'report', logs: [{ at: 1, class: 'TypeError', code: '', frames: [{ file: 'index-AbCd1234.js', line: 4 }, { file: '/home/u/secret.js', line: 1 }, { file: 'ch.fasrv.fanotes.vault.NoteStore', line: 9 }, { file: 'okhttp3.internal.Foo', line: 2 }], hash: '0123456789ab', message: 'fail for me@example.com in /home/u/Notes/a.md' }], comment: 'mail me@example.com about /home/u/Notes/a.md and "Scheidung Anwalt"' })) })
    assert.equal(r.status, 202)
    const text = await readFile(join(s.dir, '2026-11-15.jsonl'), 'utf8')
    assert.ok(!/me@example|\/home\/u|Scheidung|secret\.js|fail for/u.test(text), 'free text, paths and quoted titles never reach the disk')
    assert.deepEqual(JSON.parse(text.trim()).logs[0].frames, [{ file: 'index-AbCd1234.js', line: 4 }, { file: 'ch.fasrv.fanotes.vault.NoteStore', line: 9 }])
    r = await fetch(`${s.base}/api/v1/diagnostics`, { method: 'POST', body: 'x'.repeat(70_000) })
    assert.equal(r.status, 413)
    r = await fetch(`${s.base}/api/v1/diagnostics`, { method: 'POST', body: '{nope' })
    assert.equal(r.status, 400)
    // per-install limit: 12 per day, 1 already used
    let last = 0
    for (let i = 0; i < 12; i += 1) last = (await fetch(`${s.base}/api/v1/diagnostics`, { method: 'POST', body: JSON.stringify(payload()) })).status
    assert.equal(last, 429)
    const other = 'b'.repeat(32)
    await fetch(`${s.base}/api/v1/diagnostics`, { method: 'POST', body: JSON.stringify(payload({ installId: other })) })
    r = await fetch(`${s.base}/api/v1/diagnostics/${ID}`, { method: 'DELETE' })
    assert.equal((await r.json()).deleted, 12)
    const left = (await readFile(join(s.dir, '2026-11-15.jsonl'), 'utf8')).trim().split('\n')
    assert.equal(left.length, 1)
    assert.equal(JSON.parse(left[0]).installId, other)
    assert.equal((await fetch(`${s.base}/api/v1/diagnostics/zz`, { method: "DELETE" })).status, 404)
    // retention: a 91-day-old file goes, a 10-day-old file stays
    await writeFile(join(s.dir, '2026-08-01.jsonl'), '{}\n')
    await writeFile(join(s.dir, '2026-11-05.jsonl'), '{}\n')
    assert.equal(await s.store.cleanup(), 1)
    assert.deepEqual((await readdir(s.dir)).sort(), ['2026-11-05.jsonl', '2026-11-15.jsonl'])
  } finally { await s.close() }
})

test('report script aggregates versions, errors, features and percentiles', async () => {
  const s = await start()
  try {
    for (let i = 0; i < 4; i += 1) {
      await s.store.accept(payload({ installId: String(i).repeat(32), usage: { counters: { 'tool.pen': i + 1 }, errors: { 'Error||0123456789ab': 1 }, perf: { startupMs: 1000 + i * 100 }, vault: { notes: 10 * (i + 1), sizeMb: 1 } } }), `ip${i}`)
    }
    const report = aggregate(await readRecords(s.dir))
    assert.equal(report.installs, 4)
    assert.deepEqual(report.features[0], ['tool.pen', 10])
    assert.deepEqual(report.topErrors[0], ['Error||0123456789ab', 4])
    assert.equal(report.startupMs.p50, 1100)
    assert.equal(report.startupMs.p90, 1300)
  } finally { await s.close() }
})

test('preflight allows DELETE and the nginx location mirrors it', async () => {
  const s = await start()
  try {
    const response = await fetch(`${s.base}/api/v1/diagnostics/${ID}`, { method: 'OPTIONS' })
    assert.equal(response.status, 204)
    assert.match(response.headers.get('access-control-allow-methods'), /DELETE/u)
  } finally { await s.close() }
  const conf = await readFile(new URL('./deploy/fanotes-fasrv.conf', import.meta.url), 'utf8')
  const block = conf.slice(conf.indexOf('location ~ "^/api/v1/diagnostics'), conf.indexOf('location ~ "^/api/v1/diagnostics') + 2200)
  assert.match(block, /Access-Control-Allow-Methods "POST, DELETE, OPTIONS"/u)
  assert.match(block, /limit_req zone=fanotes_diagnostics/u)
  assert.match(conf, /geo \$fanotes_from_cf/u, 'CF-Connecting-IP is only trusted from Cloudflare ranges')
  assert.match(conf, /"~\^1:\(\?<cfip>\.\+\)\$" \$cfip/u)
})

test('concurrent appends and a delete never lose another install\'s lines', async () => {
  const s = await start()
  try {
    const id = (n) => n.toString(16).padStart(32, '0')
    const writes = []
    for (let i = 1; i <= 40; i += 1) writes.push(s.store.accept(payload({ installId: i % 2 ? ID : id(i) }), `ip${i}`))
    writes.push(s.store.deleteInstall(ID))
    for (let i = 41; i <= 60; i += 1) writes.push(s.store.accept(payload({ installId: id(i) }), `ip${i}`))
    await Promise.all(writes)
    const lines = (await readFile(join(s.dir, `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(lines.filter((line) => line.installId !== ID).length, 40, 'every other install survived (20 even ids + 20 later)')
  } finally { await s.close() }
})

test('data directory size cap rejects with 507', async () => {
  const s = await start()
  try {
    const small = createDiagnosticsStore(s.dir, { maxBytes: 600 })
    assert.equal((await small.accept(payload(), 'a')).status, 202)
    assert.equal((await small.accept(payload({ installId: 'd'.repeat(32) }), 'b')).status, 507)
  } finally { await s.close() }
})

test('comment keeps up to 1000 characters after scrubbing', () => {
  const comment = `Beschreibung ${'wort '.repeat(180)}`
  const ok = validateDiagnosticsPayload(payload({ comment }))
  assert.ok(ok.record.comment.length > 800 && ok.record.comment.length <= 1000)
})

// -- who a request is limited as ---------------------------------------------------------------
const peerRequest = (peer, realIp) => ({ headers: realIp === undefined ? {} : { 'x-real-ip': realIp }, socket: { remoteAddress: peer } })

test('X-Real-IP is only honoured from the local nginx peer and only when it is one plain address', () => {
  // The proxy peer: the header is the real client (Cloudflare-aware, written by nginx).
  assert.equal(clientAddress(peerRequest('127.0.0.1', '203.0.113.7')), '203.0.113.7')
  assert.equal(clientAddress(peerRequest('::1', '203.0.113.7')), '203.0.113.7')
  assert.equal(clientAddress(peerRequest('::ffff:127.0.0.1', ' 203.0.113.7 ')), '203.0.113.7')
  assert.equal(clientAddress(peerRequest('127.0.0.1', '::ffff:198.51.100.9')), '198.51.100.9', 'IPv4-mapped IPv6 is the IPv4 client')
  assert.equal(clientAddress(peerRequest('127.0.0.1')), '127.0.0.1', 'no header: the peer itself')
  // Anyone else is limited by where they connect from, whatever they send.
  assert.equal(clientAddress(peerRequest('198.51.100.20', '203.0.113.7')), '198.51.100.20')
  assert.equal(clientAddress(peerRequest('::ffff:198.51.100.20', '203.0.113.7')), '198.51.100.20')
  assert.equal(clientAddress(peerRequest('10.0.0.5', '127.0.0.1')), '10.0.0.5', 'a forged loopback header does not make a peer local')
  assert.equal(clientAddress(peerRequest(undefined, '203.0.113.7')), 'unknown')
  // Junk from the proxy peer is ignored rather than becoming a bucket name.
  for (const junk of ['not-an-ip', '1.2.3.4, 5.6.7.8', '1.2.3.4:80', 'a'.repeat(100), '', '999.1.1.1']) {
    assert.equal(clientAddress(peerRequest('127.0.0.1', junk)), '127.0.0.1', `ignored: ${junk.slice(0, 12)}`)
  }
})

test('IPv6 clients share one budget per /64 so rotating addresses inside a prefix does not help', () => {
  const key = (address) => clientAddress(peerRequest('127.0.0.1', address))
  assert.equal(key('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), '2001:db8:1:2::/64')
  assert.equal(key('2001:DB8:1:2:0:0:0:1'), '2001:db8:1:2::/64')
  assert.equal(key('2001:db8:1:2::9'), '2001:db8:1:2::/64')
  assert.equal(key('2001:db8::5'), '2001:db8:0:0::/64')
  assert.equal(key('::1'), '0:0:0:0::/64')
  assert.notEqual(key('2001:db8:1:3::1'), key('2001:db8:1:2::1'))
  assert.equal(clientAddress(peerRequest('2001:db8:5:6:1:2:3:4', '203.0.113.7')), '2001:db8:5:6::/64')
})

test('a direct peer cannot rotate X-Real-IP to escape the per-IP limit, the proxy peer gets one budget per client', async () => {
  const s = await start()
  try {
    const handler = createDiagnosticsHandler(s.store)
    const post = async (peer, realIp, n) => {
      const body = Buffer.from(JSON.stringify(payload({ installId: n.toString(16).padStart(32, '0') })))
      const request = Object.assign(Readable.from([body]), peerRequest(peer, realIp), { method: 'POST' })
      const result = { status: 0 }
      await handler(request, { writeHead: (status) => { result.status = status }, end: () => {} }, new URL('http://x/api/v1/diagnostics'))
      return result.status
    }
    const direct = []
    for (let i = 1; i <= 61; i += 1) direct.push(await post('198.51.100.20', `203.0.113.${i}`, i))
    assert.equal(direct.filter((status) => status === 202).length, 60, 'the per-IP budget is spent by the real peer')
    assert.equal(direct[60], 429, 'the 61st request is refused although every header named a new address')
    // Through the proxy each real client has its own budget.
    assert.equal(await post('127.0.0.1', '203.0.113.200', 1000), 202)
    const proxied = []
    for (let i = 1; i <= 61; i += 1) proxied.push(await post('127.0.0.1', '203.0.113.201', 2000 + i))
    assert.equal(proxied.filter((status) => status === 202).length, 60, 'one client behind the proxy is limited on its own')
    assert.equal(proxied[60], 429)
    assert.equal(await post('127.0.0.1', '203.0.113.202', 3000), 202, 'another client is unaffected')
  } finally { await s.close() }
})

test('the nginx location overwrites X-Real-IP with the Cloudflare-aware client address', async () => {
  // The process trusts the header from its local proxy because nginx always replaces whatever the client sent.
  const conf = await readFile(new URL('./deploy/fanotes-fasrv.conf', import.meta.url), 'utf8')
  const from = conf.indexOf('location ~ "^/api/v1/diagnostics')
  assert.ok(from > 0)
  const block = conf.slice(from, conf.indexOf('proxy_pass', from))
  assert.match(block, /proxy_set_header X-Real-IP \$fanotes_client_ip;/u)
  assert.doesNotMatch(block, /proxy_set_header X-Real-IP \$http_/u)
  assert.match(conf, /proxy_pass http:\/\/127\.0\.0\.1:18185;/u, 'the site process stays loopback-only behind nginx')
})

// -- schema 2 batches from the desktop app ------------------------------------------------------
const batch = (extra = {}) => ({
  schemaVersion: 2,
  kind: 'batch',
  installId: ID,
  app: { version: '2026.11.3', platform: 'linux', arch: 'x64', language: 'de' },
  crashes: [
    { type: 'uncaughtException', process: 'main', class: 'TypeError', code: '', reason: '', exitCode: 0, frames: [{ file: 'main.cjs', line: 120, fn: 'openVault' }, { file: '/home/anna/Notizen/x.js', line: 1 }, { file: 'evil name.js', line: 2 }], hash: '0123456789ab', count: 2, lastAt: 1_700_000_000_000 },
    { type: 'child-process-gone', process: 'GPU', class: 'Error', code: '', reason: 'crashed', exitCode: 139, frames: [], hash: 'abcdefabcdef', count: 1, lastAt: 1_700_000_000_000 },
    { type: 'made-up', process: 'main', class: 'Error', hash: '0123456789ab' },
    { type: 'uncaughtException', process: 'main', class: 'Error', hash: 'not-a-hash' },
  ],
  perf: { startup: { sessions: 3, medianMs: 1800, maxMs: 2600 }, penLatency: { samples: 400, p50: 6.5, p90: 11, p99: 20.4, max: 33 }, memory: { processes: 6, totalMb: 900, mainRssMb: 150 }, stalls: { count: 4, maxMs: 2100, p95Ms: 1900, byPhase: { sync: 3, save: 1, 'secret note.md': 9, other: -2 }, mainLag: { maxMs: 800, p95Ms: 120, path: '/home/anna/x' }, note: 'ignored' }, note: 'ignored' },
  ...extra,
})

test('a batch keeps crashes and perf, and only keeps frames of the app itself', () => {
  const result = validateDiagnosticsPayload(batch())
  assert.equal(result.ok, true)
  assert.equal(result.record.crashes.length, 2, 'unknown types and bad hashes are dropped')
  assert.deepEqual(result.record.crashes[0].frames, [{ file: 'main.cjs', line: 120, fn: 'openVault' }], 'paths and odd names never pass')
  assert.equal(result.record.crashes[1].reason, 'crashed')
  assert.deepEqual(result.record.perf.penLatency, { samples: 400, p50: 6.5, p90: 11, p99: 20.4, max: 33 })
  assert.equal('note' in result.record.perf, false)
  assert.deepEqual(result.record.perf.stalls, { count: 4, maxMs: 2100, p95Ms: 1900, byPhase: { sync: 3, save: 1, index: 0, open: 0, other: 0 }, mainLag: { maxMs: 800, p95Ms: 120 } }, 'only the fixed stall fields pass, bounded')
  const huge = validateDiagnosticsPayload(batch({ perf: { stalls: { count: 1e12, maxMs: 1e12, p95Ms: 'x', byPhase: { sync: 1e12 }, mainLag: null } } }))
  assert.deepEqual(huge.record.perf.stalls, { count: 100000, maxMs: 600000, p95Ms: 0, byPhase: { sync: 100000, save: 0, index: 0, open: 0, other: 0 }, mainLag: { maxMs: 0, p95Ms: 0 } })
  assert.equal(validateDiagnosticsPayload(batch({ kind: 'daily' })).ok, false)
  assert.equal(validateDiagnosticsPayload(batch({ crashes: 'x' })).ok, false)
  assert.equal(validateDiagnosticsPayload({ schemaVersion: 2, kind: 'batch', installId: ID, app: {} }).ok, false, 'empty batch')
  assert.doesNotMatch(JSON.stringify(result.record), /anna|Notizen|evil/u)
})

test('a gzipped batch is accepted, an inflation bomb and an unknown encoding are refused, and no address is stored', async () => {
  const s = await start()
  try {
    const send = (body, headers = {}) => fetch(`${s.base}/api/v1/diagnostics`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body })
    const ok = await send(gzipSync(JSON.stringify(batch())), { 'Content-Encoding': 'gzip' })
    assert.equal(ok.status, 202)
    assert.equal((await send(gzipSync(Buffer.alloc(5_000_000, 32)), { 'Content-Encoding': 'gzip' })).status, 413, 'inflates past the cap')
    assert.equal((await send(Buffer.alloc(70_000, 97))).status, 413, 'oversized body')
    assert.equal((await send('{}', { 'Content-Encoding': 'br' })).status, 415)
    assert.equal((await send(Buffer.from('not gzip'), { 'Content-Encoding': 'gzip' })).status, 400)
    const [file] = await readdir(s.dir)
    const stored = await readFile(join(s.dir, file), 'utf8')
    assert.equal(stored.split('\n').filter(Boolean).length, 1, 'only the valid batch was stored')
    assert.doesNotMatch(stored, /127\.0\.0\.1|::1|"ip"|user-agent/iu, 'no request metadata in the data')
    assert.match(stored, /"crashes"/u)
  } finally { await s.close() }
})
