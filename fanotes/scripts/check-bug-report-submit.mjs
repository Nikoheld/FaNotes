import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { acceptBugReportPayload } from '../../fanotes-site/bug-report-api.mjs'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const {
  BUG_REPORT_HOST,
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

  console.log(JSON.stringify({ host: request.host, url: request.url, accepted: accepted.ok, events: request.body.events.length }))
  console.log('bug-report-submit ok')
} finally {
  await server.close()
}
