import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const {
  BUG_REPORT_WINDOW_MS,
  createBugReportLog,
} = await server.ssrLoadModule('/src/lib/bugReport.ts')

try {
  const now = 10_000_000
  const log = createBugReportLog()
  log.record({
    at: now - BUG_REPORT_WINDOW_MS - 60_000,
    kind: 'pen',
    noteId: 'alt.md',
    x: 0.1,
    y: 0.1,
    pointerType: 'pen',
    tool: 'pen',
    version: '2026.8.35',
    platform: 'linux',
  }, now)
  const mid = log.record({
    at: now - 90_000,
    kind: 'pen',
    noteId: 'Mathe.md',
    x: 0.42,
    y: 0.55,
    pointerType: 'pen',
    tool: 'pen',
    version: '2026.8.35',
    platform: 'linux',
  }, now)
  assert.equal(mid.length, 1, 'the live mid-window sample must remain after prune')
  assert.equal(mid[0].noteId, 'Mathe.md')
  assert.equal(mid[0].x, 0.42)
  assert.equal(mid[0].y, 0.55)
  assert.ok(!mid.some((event) => event.noteId === 'alt.md'), 'a sample older than 5 minutes must be gone')
  const snapshot = log.snapshot(now)
  assert.equal(snapshot.length, 1)
  assert.equal(snapshot[0].pointerType, 'pen')
  console.log(JSON.stringify({ kept: snapshot.length, noteId: snapshot[0].noteId, y: snapshot[0].y, windowMs: BUG_REPORT_WINDOW_MS }))
  console.log('bug-report-window ok')
} finally {
  await server.close()
}
