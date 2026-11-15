import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})
try {
  const { mayWipeLiveInk } = await server.ssrLoadModule('/src/lib/liveInkHandoff.ts')
  assert.equal(mayWipeLiveInk({ committedHasStroke: true, committedPaintRunning: false }), true)
  assert.equal(mayWipeLiveInk({ committedHasStroke: false, committedPaintRunning: false }), false, 'no frame without the stroke')
  assert.equal(mayWipeLiveInk({ committedHasStroke: true, committedPaintRunning: true }), false, 'a refilling heavy page keeps the live stroke')

  // Frame model: the stroke must be visible in the live or the committed layer on every frame.
  const frames = (wipeAtPenUp) => {
    let live = true
    let committed = false
    const seen = []
    if (wipeAtPenUp) live = false
    seen.push(live || committed) // frame after pen-up
    committed = true // microtask redraw paints the committed bitmap
    live = false
    seen.push(live || committed)
    return seen
  }
  assert.deepEqual(frames(false), [true, true])
  assert.deepEqual(frames(true), [false, true], 'the old order drops one frame')

  const board = readFileSync('src/components/DrawingBoard.tsx', 'utf8')
  assert.match(board, /mayWipeLiveInk\(\{ committedHasStroke/, 'pen-up only wipes once the committed layer has the stroke')
  assert.match(board, /if \(inkPaintJobRef\.current && liveCanvasHasInkRef\.current\) return/, 'a running chunked repaint keeps the live stroke')
  // Heavy-page repaint is double-buffered: slices go to an offscreen page and
  // the visible committed canvas is replaced in one copy.
  assert.match(board, /paintInkBudgetSlice\(job\.buffer,/, 'slices paint into the offscreen buffer')
  assert.doesNotMatch(board, /paintInkBudgetSlice\(committedCanvas/, 'no slice paints on the visible canvas')
  const jobStart = board.indexOf('const buffer = inkPaintBufferRef.current')
  const jobEnd = board.indexOf('step(0)', jobStart)
  const jobBody = board.slice(jobStart, jobEnd)
  assert.doesNotMatch(jobBody, /clearRect/, 'the repaint job never clears the visible canvas')
  assert.match(jobBody, /swapInkBuffer\(committedCanvas, job\.buffer\)/, 'the page is swapped in once, when finished')
  const swap = board.slice(board.indexOf('const swapInkBuffer'), board.indexOf('const shiftInkWindowBitmap'))
  assert.match(swap, /globalCompositeOperation = 'copy'/)
  assert.match(jobBody, /committedBitmapRef\.current = null/, 'the stale visible bitmap is unsealed while the job runs')

  // An erase during a running job must not punch into the stale bitmap.
  const { decideCommittedEraseHole } = await server.ssrLoadModule('/src/lib/inkStrokePaint.ts')
  const base = { patchMatchesStrokes: true, held: true, keyMatches: true, topMatches: true, resized: false, activeStroke: false }
  assert.deepEqual(decideCommittedEraseHole({ ...base, budgetCleared: true }), { punch: false, seal: false })
  assert.deepEqual(decideCommittedEraseHole({ ...base, held: false, budgetCleared: false }), { punch: false, seal: false }, 'an unsealed bitmap is never punched')
  assert.equal(decideCommittedEraseHole({ ...base, budgetCleared: false }).punch, true)
  console.log('live-ink-handoff ok')
} finally {
  await server.close()
}
