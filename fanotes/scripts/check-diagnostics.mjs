// Opt-in diagnostics: scrubbing, payload schema, server compatibility and "nothing is sent while off".
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createServer } from 'vite'
import { validateDiagnosticsPayload } from '../../fanotes-site/diagnostics-api.mjs'

const server = await createServer({ appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true } })
try {
  const lib = await server.ssrLoadModule('/src/lib/diagnostics.mjs')
  const { scrubText, buildDiagnosticsPayload, dailySendDue, newInstallId, describeError, errorGroupKey, identityFromPath, hashText } = lib
  const context = identityFromPath('/home/anna/Notizen')
  assert.deepEqual(context, { vaultPath: '/home/anna/Notizen', homeDir: '/home/anna', userName: 'anna' })
  assert.equal(identityFromPath('C:\\Users\\Anna Müller\\Vault').userName, 'Anna Müller')

  // Scrubbing regression corpus: each line lists words that must never survive.
  const corpus = [
    ['Notiz „Scheidung Anwalt Müller“ konnte nicht gespeichert werden', ['Scheidung', 'Anwalt', 'Müller']],
    ['Titel "Scheidung" fehlt', ['Scheidung']],
    ["Titel 'Gehalt 2026' fehlt", ['Gehalt']],
    ['Titel «Chemo» fehlt', ['Chemo']],
    ['Titel ‚Chemo‘ fehlt', ['Chemo']],
    ['Titel “Chemo” fehlt', ['Chemo']],
    ['Privat/Krankheit/Befund.md', ['Privat', 'Krankheit', 'Befund']],
    ['Ordner Privat/Krankheit', ['Privat', 'Krankheit']],
    ['Ordner Privat\\Krankheit', ['Privat', 'Krankheit']],
    ['open C:\\Users\\Anna Müller\\Documents\\Befund Krebs.pdf failed', ['Anna', 'Müller', 'Befund', 'Krebs', 'Documents']],
    ['load %2Fhome%2Fanna%2FNotizen%2FKrankheit.md now', ['anna', 'Krankheit', 'Notizen']],
    ['load %252Fhome%252Fanna%252FKrankheit.md now', ['anna', 'Krankheit']],
    ['ENOENT: open /home/anna/Notizen/Mathe/Klausur Analysis.md', ['anna', 'Notizen', 'Mathe', 'Klausur', 'Analysis']],
    ['failed C:\\Users\\Bob\\Docs\\Geheim.pdf for anna@example.com', ['Bob', 'Geheim', 'example.com', 'anna']],
    ['GET https://user:pw@nas.privat.example.org/vault/abc?token=abc123 failed', ['user', 'pw', 'nas', 'privat', 'abc123', 'example.org']],
    ['connect 192.168.1.20:8080 refused', ['192.168', '8080']],
    ['connect [2001:db8::1]:443 refused', ['2001', 'db8']],
    ['peer fe80::1 gone and 2001:0db8:85a3:0000:0000:8a2e:0370:7334', ['fe80', '8a2e']],
    ['aws AKIAIOSFODNN7EXAMPLE used', ['AKIAIOSFODNN7EXAMPLE']],
    ['key sk-abc123def456ghi789 used', ['sk-abc123']],
    ['jwt eyJhbGciOi.eyJzdWIiOiIx.sig used', ['eyJhbGciOi', 'eyJzdWIiOiIx']],
    ['pairing code 483-921-770 shown', ['483-921-770']],
    ['password: hunter2 and more words\nnext line ok', ['hunter2', 'more words']],
    ['token = abcdef ghi', ['abcdef']],
    ['mail anna@localhost bounced', ['anna', 'localhost']],
    ['Authorization: Bearer abcdefghijklmnop1234567890', ['abcdefghijklmnop']],
    ['id 0123456789abcdef0123456789abcdef01234567', ['0123456789abcdef']],
    ['Mathe Notizen.md konnte nicht gespeichert werden', ['Mathe Notizen', '.md']],
    ['anna hat Anna gesehen', ['anna', 'Anna']],
  ]
  for (const [line, words] of corpus) {
    const clean = scrubText(line, context)
    for (const word of words) assert.ok(!clean.toLowerCase().includes(word.toLowerCase()), `"${word}" leaked from "${line}" -> "${clean}"`)
  }
  assert.ok(scrubText('x'.repeat(2000)).length <= 300)
  assert.equal(scrubText('wort '.repeat(300), {}, 1000).length, 1000 > 'wort '.repeat(300).trim().length ? 'wort '.repeat(300).trim().length : 1000, 'a custom limit applies')

  // The server scrubber is the same code (defence in depth).
  const grab = (file) => { const text = fs.readFileSync(new URL(file, import.meta.url), 'utf8'); return text.slice(text.indexOf('// scrub:begin'), text.indexOf('// scrub:end')) }
  assert.equal(grab('../src/lib/diagnostics.mjs'), grab('../../fanotes-site/diagnostics-api.mjs'), 'client and server scrub blocks are identical')

  // Errors never leave as text: class, code, bundle frames and a hash.
  const thrown = Object.assign(new TypeError('Fehler beim Öffnen von Mein Tagebuch „Scheidung“ in /home/anna/Notizen/Privat/Krankheit.md'), { code: 'ENOENT' })
  thrown.stack = 'TypeError: Fehler beim Öffnen von Mein Tagebuch\n    at open (https://app/assets/index-AbCd1234.js:10:5)\n    at file:///home/anna/Notizen/Scheidung.js:3:1\n    at run (app://x/assets/vendor-Zz99Yy88.js:200:9)'
  const described = describeError(thrown)
  assert.deepEqual({ class: described.class, code: described.code, frames: described.frames }, { class: 'TypeError', code: 'ENOENT', frames: [{ file: 'index-AbCd1234.js', line: 10 }, { file: 'vendor-Zz99Yy88.js', line: 200 }] })
  assert.match(described.hash, /^[0-9a-f]{12}$/u)
  assert.equal(describeError(new Error('x 12 "a"')).hash, describeError(new Error('x 99 "b"')).hash, 'digits and quoted parts do not split a group')
  assert.notEqual(hashText('a'), hashText('b'))
  assert.equal(describeError(Object.assign(new Error('x'), { name: 'AnwaltMuellerError' })).class, 'Error', 'unknown error names collapse to Error')

  // Payload schema.
  const installId = newInstallId()
  assert.match(installId, /^[0-9a-f]{32}$/u)
  assert.notEqual(installId, newInstallId(), 'ids are random')
  const usage = { counters: { 'tool.pen': 7, 'My Secret Note': 3, 'view.statistics': 1 }, errors: { [errorGroupKey(described)]: 2, 'Boom in /home/anna/x/y.md for anna@example.com': 5 }, perf: { startupMs: 1234 }, vault: { notes: 137, bytes: 83 * 1024 * 1024 } }
  const logs = [{ ...described, at: 1_700_000_123_456, message: 'Fehler beim Öffnen von Mein Tagebuch', level: 'error' }]
  const app = { version: '1.2.3', platform: 'linux', arch: 'x64', language: 'de' }
  const payload = buildDiagnosticsPayload({ consent: { usage: true, logs: true }, installId, app, usage, logs, context })
  assert.equal(payload.schemaVersion, 1)
  assert.deepEqual(payload.usage.counters, { 'tool.pen': 7, 'view.statistics': 1 }, 'free-form counter names are dropped')
  assert.deepEqual(Object.keys(payload.usage.errors), [errorGroupKey(described)], 'free-text error keys are dropped')
  assert.equal(payload.usage.vault.notes, 100, 'vault size is bucketed')
  assert.equal(payload.usage.vault.sizeMb, 50)
  assert.equal(payload.usage.perf.startupMs, 1200)
  assert.deepEqual(Object.keys(payload.logs[0]).sort(), ['at', 'class', 'code', 'frames', 'hash'], 'a log entry has no message field')
  const text = JSON.stringify(payload)
  for (const word of ['anna', 'Notizen', 'example.com', 'Tagebuch', 'Scheidung', 'Krankheit', 'Secret', 'Fehler beim']) assert.ok(!text.includes(word), `payload leaks ${word}`)
  assert.deepEqual(Object.keys(payload).sort(), ['app', 'installId', 'kind', 'logs', 'schemaVersion', 'sentAt', 'usage'])
  assert.equal(validateDiagnosticsPayload(JSON.parse(text)).ok, true, 'the server accepts what the client builds')

  // Consent: usage only, logs only, manual.
  const usageOnly = buildDiagnosticsPayload({ consent: { usage: true }, installId, app, usage, logs, context })
  assert.ok(usageOnly.usage && !usageOnly.logs)
  const logsOnly = buildDiagnosticsPayload({ consent: { logs: true }, installId, app, usage, logs, context })
  assert.ok(logsOnly.logs && !logsOnly.usage)
  const manual = buildDiagnosticsPayload({ consent: {}, manual: true, installId, app, logs, comment: 'Crash when mail me@x.org opens /home/anna/a.md in "Gehalt 2026" at Privat/Krankheit', context })
  assert.equal(manual.kind, 'report')
  assert.ok(!manual.usage && !/me@x\.org|anna|Gehalt|Krankheit/u.test(JSON.stringify(manual)))
  const longComment = buildDiagnosticsPayload({ consent: {}, manual: true, installId, app, logs: [], comment: `Beschreibung ${'wort '.repeat(180)}`, context })
  assert.ok(longComment.comment.length > 800, 'the comment keeps up to 1000 characters')
  assert.deepEqual(longComment.logs, [])
  assert.equal(validateDiagnosticsPayload(JSON.parse(JSON.stringify(manual))).ok, true)

  // Off means nothing: no payload, no scheduled send.
  assert.equal(buildDiagnosticsPayload({ consent: { usage: false, logs: false }, installId, app, usage, logs, context }), null)
  assert.equal(buildDiagnosticsPayload({ consent: {}, installId, app, usage, logs, context }), null)
  assert.equal(dailySendDue({ usage: false, logs: false }, 0), false)
  assert.equal(dailySendDue(undefined, 0), false)
  assert.equal(dailySendDue({ usage: true }, 0), true)
  assert.equal(dailySendDue({ usage: true }, Date.now() - 3_600_000), false, 'at most once a day')
  assert.equal(dailySendDue({ logs: true }, Date.now() - 25 * 3_600_000), true)

  // Client glue: while both toggles are off no fetch happens and nothing is counted.
  const store = new Map()
  globalThis.window = { localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) }, addEventListener() {}, setTimeout, clearTimeout, fanotes: { platform: 'linux' } }
  globalThis.document = { documentElement: { lang: 'de' } }
  let fetches = 0
  globalThis.fetch = async () => { fetches += 1; return { ok: true } }
  const client = await server.ssrLoadModule('/src/lib/diagnosticsClient.ts')
  client.configureDiagnostics({ usage: false, logs: false })
  client.recordFeature('tool.pen')
  assert.equal(await client.sendDailyIfDue(), false)
  assert.equal(fetches, 0, 'nothing is sent while off')
  assert.equal(client.previewDiagnostics(), null)
  assert.equal(store.has('fanotes.diagnostics.counters'), false)
  client.configureDiagnostics({ usage: true, logs: false })
  client.recordFeature('tool.pen'); client.recordFeature('not a valid name!')
  assert.deepEqual(client.previewDiagnostics().usage.counters, { 'tool.pen': 1 })
  // Tool switches and error toasts reach the counters through the shared diagnostic log.
  const { diagnosticLog } = await server.ssrLoadModule('/src/lib/bugReport.ts')
  diagnosticLog.record({ at: Date.now(), kind: 'tool', tool: 'Eraser' })
  diagnosticLog.record({ at: Date.now(), kind: 'error', message: 'Die Notiz "Bio" konnte nicht gespeichert werden.' })
  const counted = client.previewDiagnostics().usage
  assert.equal(counted.counters["tool.eraser"], 1, 'a tool switch is counted')
  assert.equal(Object.values(counted.errors).reduce((sum, n) => sum + n, 0), 1, 'an error toast is counted')
  assert.ok(!JSON.stringify(counted).includes('konnte') && !JSON.stringify(counted).includes('Bio'), 'the error text never leaves the device')
  assert.equal(await client.sendDailyIfDue(), true)
  assert.equal(fetches, 1)
  assert.equal(await client.sendDailyIfDue(), false, 'second call within a day does not send')
  assert.equal(fetches, 1)
  client.configureDiagnostics({ usage: false, logs: false })
  assert.equal(await client.sendLogsNow('hi'), true, 'an explicit click sends even while off')
  assert.equal(fetches, 2)
  console.log('Diagnose-Prüfung bestanden: Bereinigung, Schema, Server-Kompatibilität, Einwilligung und "aus heisst nichts senden".')
} finally {
  await server.close()
}
