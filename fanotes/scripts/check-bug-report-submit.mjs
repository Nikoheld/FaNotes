import assert from 'node:assert/strict'
import { createServer } from 'vite'
import {
  acceptBugReportPayload,
  BUG_REPORT_MAX_BODY_BYTES as handlerMaxBody,
  BUG_REPORT_MAX_EVENTS as handlerMaxEvents,
} from '../../fanotes-site/bug-report-api.mjs'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const {
  BUG_REPORT_HOST,
  BUG_REPORT_MAX_BODY_BYTES,
  BUG_REPORT_MAX_EVENTS,
  BUG_REPORT_PEN_SAMPLE_MS,
  BUG_REPORT_WINDOW_MS,
  buildBugReportRequest,
  createBugReportLog,
} = await server.ssrLoadModule('/src/lib/bugReport.ts')

try {
  const now = 20_000_000
  const log = createBugReportLog()
  log.record({
    at: now - 30_000,
    kind: 'pen',
    noteId: 'Physik.md',
    x: 0.33,
    y: 0.48,
    pointerType: 'pen',
    tool: 'pen',
    version: '2026.8.36',
    platform: 'win32',
  }, now)
  const request = buildBugReportRequest({
    description: 'Stift springt nach oben',
    events: log.snapshot(now),
    version: '2026.8.36',
    platform: 'win32',
    now,
    origin: 'https://evil.example',
  })
  assert.equal(request.host, 'fanotes.fasrv.ch')
  assert.equal(new URL(request.url).hostname, BUG_REPORT_HOST)
  assert.equal(new URL(request.url).protocol, 'https:')
  assert.match(request.url, /^https:\/\/fanotes\.fasrv\.ch\/api\/v1\/bug-report$/u)
  assert.equal(request.body.description, 'Stift springt nach oben')
  assert.equal(request.body.events.length, 1)
  assert.equal(request.body.events[0].noteId, 'Physik.md')

  const accepted = acceptBugReportPayload(request.body)
  assert.equal(accepted.ok, true)
  assert.equal(accepted.status, 202)
  assert.equal(accepted.report.description, 'Stift springt nach oben')
  assert.equal(accepted.report.events.length, 1)

  assert.equal(acceptBugReportPayload({ description: '', events: request.body.events }).ok, false)
  assert.equal(acceptBugReportPayload({ description: '   ', events: request.body.events }).ok, false)
  assert.equal(acceptBugReportPayload({ description: 'Stift springt', events: [] }).ok, false)
  assert.equal(acceptBugReportPayload({ description: 'Stift springt' }).ok, false)

  assert.equal(BUG_REPORT_MAX_EVENTS, handlerMaxEvents)
  assert.equal(BUG_REPORT_MAX_BODY_BYTES, handlerMaxBody)
  assert.ok(BUG_REPORT_WINDOW_MS / BUG_REPORT_PEN_SAMPLE_MS <= BUG_REPORT_MAX_EVENTS, '5 minutes of pen samples must fit the event cap')

  const fullLog = createBugReportLog()
  const start = now - BUG_REPORT_WINDOW_MS + 1
  const step = Math.max(1, Math.floor((BUG_REPORT_WINDOW_MS - 2) / BUG_REPORT_MAX_EVENTS))
  for (let index = 0; index < BUG_REPORT_MAX_EVENTS; index += 1) {
    fullLog.record({
      at: start + index * step,
      kind: 'pen',
      noteId: 'Faecher/Mathematik/Uebungen/Lineare-Algebra-Blatt-12.md',
      x: 0.123456789 + (index % 50) / 1000,
      y: 0.554321098 + (index % 40) / 1000,
      pointerType: 'pen',
      tool: 'fineliner',
      version: '2026.8.36',
      platform: 'linux',
    }, now)
  }
  const maxRequest = buildBugReportRequest({
    description: 'x'.repeat(2000),
    events: fullLog.snapshot(now),
    version: '2026.8.36',
    platform: 'linux',
    now,
  })
  const encoded = Buffer.byteLength(JSON.stringify(maxRequest.body), 'utf8')
  assert.equal(maxRequest.body.events.length, BUG_REPORT_MAX_EVENTS, 'max-window payload keeps the full cap')
  assert.ok(encoded < BUG_REPORT_MAX_BODY_BYTES, `max-window payload ${encoded} must stay under ${BUG_REPORT_MAX_BODY_BYTES}`)
  const maxAccepted = acceptBugReportPayload(maxRequest.body)
  assert.equal(maxAccepted.ok, true, 'fasrv handler must accept a full 5-minute window')
  assert.equal(maxAccepted.report.events.length, BUG_REPORT_MAX_EVENTS)

  console.log(JSON.stringify({
    host: request.host,
    url: request.url,
    accepted: accepted.ok,
    events: request.body.events.length,
    maxEvents: maxRequest.body.events.length,
    maxBytes: encoded,
    limit: BUG_REPORT_MAX_BODY_BYTES,
    maxAccepted: maxAccepted.ok,
  }))
  console.log('bug-report-submit ok')
} finally {
  await server.close()
}
