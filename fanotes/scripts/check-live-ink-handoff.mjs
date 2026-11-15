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
  console.log('live-ink-handoff ok')
} finally {
  await server.close()
}
