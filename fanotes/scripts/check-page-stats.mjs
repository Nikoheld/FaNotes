import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const {
  closePageStats,
  emptyPageStats,
  formatPageDwell,
  openPageStats,
  parsePageStats,
  tickPageStats,
} = await server.ssrLoadModule('/src/lib/pageStats.ts')
const {
  readPageStatsFromNote,
  writePageStatsIntoNote,
} = await server.ssrLoadModule('/src/lib/famd.ts')

const runOnce = () => {
  const t0 = Date.parse('2026-09-06T12:00:00.000Z')
  const empty = emptyPageStats(t0)
  assert.equal(Number.isFinite(Date.parse(empty.createdAt)), true)
  assert.equal(Number.isFinite(Date.parse(empty.modifiedAt)), true)
  assert.equal(empty.dwellMs, 0)

  const opened = openPageStats(empty, t0)
  assert.equal(opened.openCount, 1)
  assert.equal(opened.active, true)
  const ticked = tickPageStats(opened, t0 + 5_000, true)
  assert.equal(ticked.dwellMs, 5_000)
  const idle = tickPageStats(ticked, t0 + 8_000, false)
  assert.equal(idle.dwellMs, 8_000)
  assert.equal(idle.active, false)
  const stillIdle = tickPageStats(idle, t0 + 20_000, false)
  assert.equal(stillIdle.dwellMs, 8_000, 'dwell must not grow while the page is inactive')
  const closed = closePageStats(stillIdle, t0 + 21_000)
  assert.equal(closed.dwellMs, 8_000)
  assert.equal(Number.isFinite(Date.parse(closed.createdAt)), true)
  assert.equal(Number.isFinite(Date.parse(closed.modifiedAt)), true)

  const persisted = writePageStatsIntoNote('# Hello\n', closed)
  const reloaded = readPageStatsFromNote(persisted, t0 + 30_000)
  assert.equal(reloaded.dwellMs, 8_000)
  assert.equal(reloaded.createdAt, closed.createdAt)
  assert.equal(reloaded.modifiedAt, closed.modifiedAt)
  assert.equal(reloaded.openCount, 1)
  assert.match(formatPageDwell(8_000), /8 s/)
  assert.equal(parsePageStats({ createdAt: closed.createdAt }).createdAt, closed.createdAt)
  return { createdAt: closed.createdAt, dwellMs: closed.dwellMs, openCount: closed.openCount }
}

try {
  const first = runOnce()
  const second = runOnce()
  assert.deepEqual(first, second)
  console.log(JSON.stringify(first))
  console.log('page-stats ok')
} finally {
  await server.close()
}
