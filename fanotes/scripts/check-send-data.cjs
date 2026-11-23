'use strict'
// "Daten senden": stack scrubbing, one-time migration, the off switch, batching/gzip/idle/online rules and
// main-process wiring. Plain Node: synthetic data in a temp dir, no Electron, no network.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const zlib = require('node:zlib')
const d = require('../electron/diagnostics.cjs')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fanotes-senddata-'))
const ON = { diagnosticsEnabled: true, diagnosticsCrashes: true, diagnosticsLogs: true, diagnosticsPerf: true, diagnosticsUsage: true, diagnosticsSettingsVersion: 1 }
const OFF = { ...ON, diagnosticsEnabled: false }
const HASH = '0123456789ab'
const FORBIDDEN = /anna|M\u00fcller|Notizen|Scheidung|Krankheit|hunter2|secret-vault|\/home\/|C:\\|Users/u

const makeService = (settings, extra = {}) => {
  const dir = tmp()
  const calls = []
  const timers = []
  let clock = 1_700_000_000_000
  const state = { online: true, idle: true, status: 200 }
  const service = d.createDiagnosticsService({
    dir,
    getSettings: () => settings,
    appInfo: () => ({ version: '2026.11.3', platform: 'linux', arch: 'x64', language: 'de' }),
    appRoots: ['/opt/FaNotes/resources/app.asar', '/home/anna/src/fanotes'],
    now: () => clock,
    isOnline: () => state.online,
    isIdle: () => state.idle,
    memory: () => ({ processes: 5, totalMb: 800, mainRssMb: 150, byType: { main: 150, renderer: 400, gpu: 200, utility: 50, other: 0 } }),
    setTimer: (fn, ms) => { const handle = { fn, ms, cleared: false, unref() {} }; timers.push(handle); return handle },
    clearTimer: (handle) => { handle.cleared = true },
    post: async (url, body, headers, signal) => { calls.push({ url, body, headers, signal }); return { status: state.status } },
    ...extra,
  })
  return { dir, service, calls, timers, state, advance: (ms) => { clock += ms }, tick: () => { const live = timers.filter((t) => !t.cleared); return live } }
}
const decode = (call) => JSON.parse(zlib.gunzipSync(call.body).toString('utf8'))

const main = async () => {
// ---- 0. Helpers killed while the app quits are not crashes (received logs: SIGTERM exit 15 in every batch) ----
{
  let quitting = false
  const s = makeService(ON, { isQuitting: () => quitting })
  s.service.recordProcessGone('child-process-gone', { type: 'GPU', reason: 'killed', exitCode: 15 })
  assert.equal(Object.keys(s.service.preview().crashes).length, 1, 'a kill while running is recorded')
  quitting = true
  s.service.recordProcessGone('render-process-gone', { reason: 'killed', exitCode: 15 })
  s.service.recordProcessGone('child-process-gone', { type: 'Utility', reason: 'killed', exitCode: 15 })
  assert.equal(s.service.preview().crashes.length, 1, 'nothing more is recorded while quitting')
}
// ---- 1. Stack scrubbing: no paths, no user names, nothing outside the app -----------------------------------
{
  const error = Object.assign(new TypeError('Cannot open /home/anna/Notizen/Scheidung.md for "M\u00fcller"'), { code: 'ENOENT' })
  error.stack = [
    'TypeError: Cannot open /home/anna/Notizen/Scheidung.md',
    '    at openVault (/opt/FaNotes/resources/app.asar/electron/main.cjs:1204:11)',
    '    at async Object.readNote (file:///opt/FaNotes/resources/app.asar/electron/note-history.cjs:88:5)',
    '    at C:\\Users\\Anna M\u00fcller\\Documents\\Krankheit\\plugin.js:3:1',
    '    at run (/home/anna/Notizen/addons/secret-vault.js:9:9)',
    '    at weird (/home/anna/src/fanotes/electron/sync.cjs:10:2)',
    '    at node:internal/process/task_queues:95:5',
  ].join('\n')
  const info = d.describeMainError(error, { appRoots: ['/opt/FaNotes/resources/app.asar', '/home/anna/src/fanotes'] })
  assert.equal(info.class, 'TypeError')
  assert.equal(info.code, 'ENOENT')
  assert.deepEqual(info.frames.map((frame) => `${frame.file}:${frame.line}:${frame.fn}`), ['main.cjs:1204:openVault', 'note-history.cjs:88:Object.readNote', 'sync.cjs:10:weird'])
  assert.doesNotMatch(JSON.stringify(info), FORBIDDEN, 'no user name, path or note title survives')
  assert.match(info.hash, /^[0-9a-f]{12}$/u)
  // The hash groups by place, never by message text.
  const other = Object.assign(new TypeError('a completely different message'), { code: 'ENOENT', stack: error.stack })
  assert.equal(d.describeMainError(other, { appRoots: ['/opt/FaNotes/resources/app.asar', '/home/anna/src/fanotes'] }).hash, info.hash)
  // Windows packaged paths: only the base name remains.
  const win = d.scrubStack('    at f (C:\\Users\\Anna\\AppData\\Local\\Programs\\FaNotes\\resources\\app.asar\\electron\\main.cjs:5:1)\n    at g (C:\\Users\\Anna\\Vault\\x.js:1:1)')
  assert.deepEqual(win, [{ file: 'main.cjs', line: 5, fn: 'f' }])
  assert.deepEqual(d.scrubStack(null), [])
  assert.equal(d.describeMainError('just a string with /home/anna/x').frames.length, 0)
}

// ---- 2. Migration: once, never over a later OFF choice ---------------------------------------------------
{
  const fresh = d.migrateDiagnosticsSettings({ theme: 'light', ...d.DIAGNOSTICS_SETTING_DEFAULTS })
  assert.equal(fresh.diagnosticsEnabled, true, 'a new install starts on')
  assert.deepEqual([fresh.diagnosticsCrashes, fresh.diagnosticsLogs, fresh.diagnosticsPerf, fresh.diagnosticsUsage], [true, true, true, true])
  assert.equal(fresh.diagnosticsSettingsVersion, d.SETTINGS_VERSION)
  assert.equal(fresh.diagnosticsNoticeSeen, false, 'the notice is still to be shown')
  // An existing install that had the old per-feature toggles off (version missing) is switched on once.
  const legacy = d.migrateDiagnosticsSettings({ theme: 'dark', diagnosticsUsage: false, diagnosticsLogs: false })
  assert.equal(legacy.diagnosticsEnabled, true)
  assert.equal(legacy.theme, 'dark', 'other settings are untouched')
  // After that the user turns it off. Every later load and every migration pass leaves it off.
  const choice = { ...legacy, diagnosticsEnabled: false, diagnosticsNoticeSeen: true }
  assert.equal(d.migrateDiagnosticsSettings(choice), choice, 'migration returns the same object: nothing to do')
  assert.equal(d.migrateDiagnosticsSettings(d.migrateDiagnosticsSettings(choice)).diagnosticsEnabled, false)
  const categoryOff = { ...legacy, diagnosticsPerf: false }
  assert.equal(d.migrateDiagnosticsSettings(categoryOff).diagnosticsPerf, false, 'a single category choice stays too')
  // A stale renderer save with version 0 cannot re-arm the migration.
  const stale = d.keepDiagnosticsVersion({ ...choice, diagnosticsSettingsVersion: 0 }, choice)
  assert.equal(stale.diagnosticsSettingsVersion, 1)
  assert.equal(d.migrateDiagnosticsSettings(stale).diagnosticsEnabled, false, 'existing OFF stays OFF after the first migration')
  // Through the real settings sanitizer too (what is stored and loaded).
  const { sanitizeSettings } = require('../electron/settings-sanitize.cjs')
  const base = { theme: 'light', ...d.DIAGNOSTICS_SETTING_DEFAULTS }
  const loaded = sanitizeSettings({ diagnosticsEnabled: false, diagnosticsSettingsVersion: 1, diagnosticsPerf: true, diagnosticsNoticeSeen: true }, base, base)
  assert.equal(loaded.diagnosticsEnabled, false)
  assert.equal(loaded.diagnosticsSettingsVersion, 1)
  assert.equal(d.migrateDiagnosticsSettings(loaded).diagnosticsEnabled, false)
}

// ---- 3. Master switch gates every category ---------------------------------------------------------------
{
  assert.equal(d.policyFromSettings(OFF).any, false)
  assert.equal(d.policyFromSettings({ ...ON, diagnosticsCrashes: false }).crashes, false)
  assert.equal(d.policyFromSettings({ ...ON, diagnosticsCrashes: false }).perf, true)
  assert.equal(d.policyFromSettings({ ...ON, diagnosticsCrashes: false, diagnosticsLogs: false, diagnosticsPerf: false, diagnosticsUsage: false }).any, false)
  assert.equal(d.policyFromSettings(undefined).any, false)
}

// ---- 3b. Stall statistics: counts and durations with fixed phase words, nothing else ---------------------
{
  const s = makeService({ ...ON })
  s.service.applySettings(ON)
  for (const [ms, phase] of [[620, 'sync'], [900, 'sync'], [2104, 'save'], [800, 'open'], [700, 'secret note.md'], [80, 'sync']]) s.service.recordRenderer({ k: 'stall', ms, phase })
  const stalls = JSON.parse(JSON.stringify(s.service.preview())).perf?.stalls
  assert.ok(stalls, 'stall statistics are part of the batch')
  assert.equal(stalls.count, 4, 'an unknown phase word and a stall under 100 ms are dropped')
  assert.equal(stalls.maxMs, 2100)
  assert.deepEqual(stalls.byPhase, { sync: 2, save: 1, index: 0, open: 1, other: 0 })
  assert.deepEqual(Object.keys(stalls).sort(), ['byPhase', 'count', 'mainLag', 'maxMs', 'p95Ms'], 'exactly the documented fields')
  assert.doesNotMatch(JSON.stringify(stalls), /secret|\.md/u)
  s.service.applySettings({ ...ON, diagnosticsPerf: false })
  s.service.recordRenderer({ k: 'stall', ms: 900, phase: 'sync' })
  assert.equal(s.service.preview()?.perf?.stalls, undefined, 'with the performance switch off nothing is kept')
  fs.rmSync(s.dir, { recursive: true, force: true })
}

// ---- 4. The off switch stops everything at once and deletes the queue --------------------------------------
{
  const s = makeService({ ...ON })
  s.service.applySettings(ON)
  s.service.recordMainException('uncaughtException', new Error('x'))
  s.service.recordProcessGone('render-process-gone', { reason: 'oom', exitCode: 9 })
  s.service.recordRenderer({ k: 'feature', name: 'tool.pen' })
  s.service.recordRenderer({ k: 'error', class: 'TypeError', code: '', hash: HASH, frames: [] })
  s.service.recordRenderer({ k: 'pen', samples: Array.from({ length: 50 }, (_, i) => 5 + i / 10) })
  s.service.recordStartup(1900)
  s.service.flush()
  assert.ok(fs.existsSync(s.service.paths.queuePath), 'queued data is on disk while on')
  assert.ok(JSON.parse(fs.readFileSync(s.service.paths.queuePath, 'utf8')).counters['tool.pen'])
  // Turn off: file gone, nothing queued, pending timers cleared.
  s.service.applySettings(OFF)
  assert.equal(fs.existsSync(s.service.paths.queuePath), false, 'the queue file is deleted')
  assert.equal(s.service.preview(), null, 'nothing is left in memory')
  assert.equal(s.tick().length, 0, 'no timer stays armed')
  // Everything recorded afterwards is dropped and nothing is sent or written.
  s.service.recordMainException('uncaughtException', new Error('later'))
  s.service.recordRenderer({ k: 'feature', name: 'tool.pen' })
  s.service.recordStartup(2000)
  s.service.flush()
  assert.equal(fs.existsSync(s.service.paths.queuePath), false)
  assert.deepEqual(await s.service.send({ ignoreIdle: true }), { sent: false, reason: 'off' })
  assert.equal(s.calls.length, 0, 'no request while off')
  assert.equal(s.tick().length, 0, 'no timers while off')
  // Back on starts from an empty queue.
  s.service.applySettings(ON)
  assert.equal(s.service.preview(), null)
  fs.rmSync(s.dir, { recursive: true, force: true })

  // A single category off removes just that category's data.
  const t = makeService({ ...ON })
  t.service.applySettings(ON)
  t.service.recordMainException('uncaughtException', new Error('x'))
  t.service.recordRenderer({ k: 'feature', name: 'tool.pen' })
  t.service.applySettings({ ...ON, diagnosticsCrashes: false })
  const preview = t.service.preview()
  assert.equal(preview.crashes, undefined)
  assert.ok(preview.usage.counters['tool.pen'])
  t.service.recordMainException('uncaughtException', new Error('again'))
  assert.equal(t.service.preview().crashes, undefined, 'a switched-off category records nothing')
  fs.rmSync(t.dir, { recursive: true, force: true })

  // A request in flight is aborted when the switch goes off, and its data is not put back.
  const settings = { ...ON }
  let release
  const hold = new Promise((resolve) => { release = resolve })
  const u = makeService(settings, { post: async (_url, _body, _headers, signal) => { await hold; assert.equal(signal.aborted, true, 'the request was aborted'); throw new Error('aborted') } })
  u.service.applySettings(settings)
  u.service.recordMainException('uncaughtException', new Error('x'))
  const pending = u.service.send({ ignoreIdle: true })
  u.service.applySettings(OFF)
  release()
  assert.deepEqual(await pending, { sent: false, reason: 'off' })
  assert.equal(fs.existsSync(u.service.paths.queuePath), false)
  assert.equal(u.service.preview(), null)
  fs.rmSync(u.dir, { recursive: true, force: true })
}

// ---- 5. Batched, gzipped, once a day, idle and online ----------------------------------------------------------
{
  const s = makeService({ ...ON })
  s.service.applySettings(ON)
  assert.equal(s.tick().length, 0, 'no timer at all while there is nothing to send (idle costs nothing)')
  s.service.recordRenderer({ k: 'feature', name: 'tool.pen' })
  s.service.recordRenderer({ k: 'feature', name: 'tool.pen' })
  s.service.recordRenderer({ k: 'vault', notes: 137, bytes: 80 * 1024 * 1024 })
  s.service.recordRenderer({ k: 'pen', samples: Array.from({ length: 100 }, (_, i) => 4 + i / 5) })
  s.service.recordStartup(2310)
  s.service.recordMainException('uncaughtException', Object.assign(new RangeError('Invalid array length for /home/anna/Notizen/x.md'), { stack: 'RangeError: x\n    at buildTree (/opt/FaNotes/resources/app.asar/electron/main.cjs:77:3)' }))
  s.service.recordProcessGone('child-process-gone', { type: 'GPU', reason: 'crashed', exitCode: 139, name: '/home/anna/secret' })
  s.service.recordProcessGone('render-process-gone', { reason: 'clean-exit' })
  const armed = s.tick()
  assert.ok(armed.length >= 1 && armed.every((timer) => timer.ms <= 60_000), 'one short timer, armed by an event')

  s.state.online = false
  assert.equal((await s.service.send()).reason, 'offline', 'not while offline')
  s.state.online = true
  s.state.idle = false
  assert.equal((await s.service.send()).reason, 'busy-user', 'not while the user is working')
  s.state.idle = true
  const first = await s.service.send()
  assert.deepEqual(first, { sent: true })
  assert.equal(s.calls.length, 1)
  const call = s.calls[0]
  assert.equal(call.url, d.ENDPOINT)
  assert.equal(call.headers['Content-Encoding'], 'gzip')
  assert.ok(call.body.length < 4096, 'small gzip body')
  const payload = decode(call)
  assert.equal(payload.schemaVersion, 2)
  assert.equal(payload.kind, 'batch')
  assert.match(payload.installId, /^[0-9a-f]{32}$/u)
  assert.equal(payload.crashes.length, 2, 'the clean exit was not reported')
  assert.equal(payload.usage.counters['tool.pen'], 2)
  assert.deepEqual(payload.usage.vault, { notes: 100, sizeMb: 50 }, 'vault size is bucketed')
  assert.equal(payload.perf.penLatency.samples, 100)
  assert.ok(payload.perf.penLatency.p50 <= payload.perf.penLatency.p90 && payload.perf.penLatency.p90 <= payload.perf.penLatency.p99)
  assert.deepEqual(payload.perf.startup, { sessions: 1, medianMs: 2300, maxMs: 2300 })
  assert.equal(payload.perf.memory.totalMb, 800)
  assert.doesNotMatch(JSON.stringify(payload), FORBIDDEN)
  // It really is what the server accepts.
  const { validateDiagnosticsPayload } = await import('../../fanotes-site/diagnostics-api.mjs')
  const accepted = validateDiagnosticsPayload(payload)
  assert.equal(accepted.ok, true, accepted.error)
  assert.equal(accepted.record.crashes.length, 2)
  assert.ok(accepted.record.perf.penLatency)
  assert.deepEqual(accepted.record.perf.memory.byType, { main: 150, renderer: 400, gpu: 200, utility: 50, other: 0 }, 'memory per process kind reaches the record')
  // Sent data is gone from the queue; at most once a day.
  assert.equal(s.service.preview(), null)
  s.service.recordRenderer({ k: 'feature', name: 'tool.eraser' })
  s.advance(30 * 60_000)
  assert.equal((await s.service.send()).reason, 'not-due')
  s.advance(24 * 3_600_000)
  assert.deepEqual(await s.service.send(), { sent: true })
  assert.equal(decode(s.calls[1]).usage.counters['tool.eraser'], 1)
  // A crash alone may go out earlier (hourly) but carries no perf or usage data.
  s.service.recordRenderer({ k: 'feature', name: 'tool.pen' })
  s.service.recordMainException('unhandledRejection', new Error('x'))
  s.advance(2 * 3_600_000)
  assert.deepEqual(await s.service.send(), { sent: true })
  const early = decode(s.calls[2])
  assert.ok(early.crashes && !early.usage && !early.perf, 'only the crash left early')
  assert.ok(s.service.preview().usage.counters['tool.pen'], 'routine data waits for its day')
  fs.rmSync(s.dir, { recursive: true, force: true })
}

// ---- 6. Failure handling ------------------------------------------------------------------------------------
{
  const s = makeService({ ...ON })
  s.service.applySettings(ON)
  s.service.recordRenderer({ k: 'feature', name: 'tool.pen' })
  s.service.recordMainException('uncaughtException', new Error('x'))
  s.state.status = 503
  assert.equal((await s.service.send()).reason, 'failed')
  const kept = s.service.preview()
  assert.ok(kept.usage.counters['tool.pen'] === 1 && kept.crashes.length === 1, 'a server error keeps the data for later')
  assert.equal((await s.service.send()).reason, 'cooldown', 'no hammering')
  s.advance(31 * 60_000)
  s.state.status = 400
  assert.equal((await s.service.send()).reason, 'rejected-400')
  assert.equal(s.service.preview(), null, 'a payload the server refuses is dropped')
  fs.rmSync(s.dir, { recursive: true, force: true })
}

// ---- 7. Renderer input is not trusted -------------------------------------------------------------------------
{
  const s = makeService({ ...ON })
  s.service.applySettings(ON)
  for (const event of [
    { k: 'feature', name: '/home/anna/Notizen' },
    { k: 'feature', name: 'x'.repeat(80) },
    { k: 'error', class: 'Scheidung', code: '', hash: HASH },
    { k: 'error', class: 'Error', code: '', hash: 'zz' },
    { k: 'crash', type: 'made-up', class: 'Error', hash: HASH },
    { k: 'pen', samples: ['a', -5, 1e9, NaN] },
    null, 'string', { k: 'unknown' },
  ]) s.service.recordRenderer(event)
  assert.equal(s.service.preview(), null, 'every malformed event is dropped')
  s.service.recordRenderer({ k: 'crash', type: 'renderer-error', class: 'TypeError', code: 'ENOENT', hash: HASH, frames: [{ file: 'index-AbCd1234.js', line: 10 }, { file: '/home/anna/x.js', line: 1 }, { file: 'Scheidung.md', line: 2 }] })
  const crash = s.service.preview().crashes[0]
  assert.deepEqual(crash.frames, [{ file: 'index-AbCd1234.js', line: 10 }])
  fs.rmSync(s.dir, { recursive: true, force: true })
}

// ---- 8. Install id: random, resettable, not an account -----------------------------------------------------------
{
  const s = makeService({ ...ON })
  const first = s.service.status().installId
  assert.match(first, /^[0-9a-f]{32}$/u)
  assert.equal(s.service.status().installId, first, 'stable')
  const second = s.service.resetInstallId()
  assert.notEqual(second, first)
  assert.equal(s.service.status().installId, second)
  const s2 = makeService({ ...ON })
  assert.notEqual(s2.service.status().installId, first, 'random per install')
  // Deleting remote data wipes the queue and rotates the id.
  s.service.applySettings(ON)
  s.service.recordRenderer({ k: 'feature', name: 'tool.pen' })
  const removed = []
  assert.equal(await s.service.deleteRemote(async (url) => { removed.push(url); return { status: 200 } }), true)
  assert.match(removed[0], new RegExp(`/api/v1/diagnostics/${second}$`, 'u'))
  assert.equal(s.service.preview(), null)
  assert.notEqual(s.service.status().installId, second)
  fs.rmSync(s.dir, { recursive: true, force: true })
  fs.rmSync(s2.dir, { recursive: true, force: true })
}

// ---- 9. main.cjs wiring --------------------------------------------------------------------------------------------
{
  const mainSource = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8')
  for (const needle of [
    "recordMainException('unhandledRejection'",
    "recordMainException('uncaughtException'",
    "recordProcessGone('render-process-gone'",
    "recordProcessGone('child-process-gone'",
    'diagnostics.migrateDiagnosticsSettings(applyExperimentalHandwritingGate(sanitized))',
    'diagnostics.keepDiagnosticsVersion(',
    'diagnosticsService()?.applySettings(currentSettings)',
    'diagnosticsServiceInstance?.flush()',
  ]) assert.ok(mainSource.includes(needle), `main.cjs wires ${needle}`)
  assert.match(mainSource, /reportAnonymousDesktopAppOpen\(\) \{[^}]*policyFromSettings\(currentSettings\)\.usage/su, 'the launch counter follows the usage switch')
  const preload = fs.readFileSync(path.join(__dirname, '../electron/preload.cjs'), 'utf8')
  assert.ok(preload.includes('diagnostics: Object.freeze({'), 'the renderer bridge exists')
}

console.log('Daten-senden-Prüfung bestanden: Bereinigung, Migration, Aus-Schalter, Batch/Gzip/Leerlauf, Server-Kompatibilität.')
}
main().catch((error) => { console.error(error); process.exit(1) })
