import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, utimes, writeFile, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createDiagnosticsHandler, createDiagnosticsStore, validateDiagnosticsPayload } from './diagnostics-api.mjs'
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
  assert.equal(validateDiagnosticsPayload(payload({ schemaVersion: 2 })).ok, false)
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
    let r = await fetch(`${s.base}/api/v1/diagnostics`, { method: 'POST', body: JSON.stringify(payload({ kind: 'report', logs: [{ at: 1, class: 'TypeError', code: '', frames: [{ file: 'index-AbCd1234.js', line: 4 }, { file: '/home/u/secret.js', line: 1 }], hash: '0123456789ab', message: 'fail for me@example.com in /home/u/Notes/a.md' }], comment: 'mail me@example.com about /home/u/Notes/a.md and "Scheidung Anwalt"' })) })
    assert.equal(r.status, 202)
    const text = await readFile(join(s.dir, '2026-11-15.jsonl'), 'utf8')
    assert.ok(!/me@example|\/home\/u|Scheidung|secret\.js|fail for/u.test(text), 'free text, paths and quoted titles never reach the disk')
    assert.deepEqual(JSON.parse(text.trim()).logs[0].frames, [{ file: 'index-AbCd1234.js', line: 4 }])
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
  const block = conf.slice(conf.indexOf('location ~ ^/api/v1/diagnostics'), conf.indexOf('location ~ ^/api/v1/diagnostics') + 2200)
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
