import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const { applyToolErase, strokeTouchesEraser } = await server.ssrLoadModule('/src/lib/toolErase.ts')

const SOURCE_WIDTH = 900
const SOURCE_HEIGHT = 1273
const RADIUS = 16

const point = (x, y) => ({ x, y, t: 0, pressure: 0.5, tiltX: 0, tiltY: 0, pointerType: 'pen' })
const polyline = (coords, extras = {}) => ({
  points: coords.map(([x, y]) => point(x, y)),
  baseWidth: 4,
  pressureEnabled: true,
  color: '#191c24',
  purpose: 'handwriting',
  ...extras,
})

try {
  const handwriting = polyline([[0.2, 0.25], [0.28, 0.25], [0.36, 0.25]], { id: 'handwriting' })
  const neighbor = polyline([[0.72, 0.25], [0.8, 0.25], [0.88, 0.25]], { id: 'neighbor' })
  const symbol = polyline([[0.25, 0.62]], { id: 'symbol', baseWidth: 36, purpose: 'art', symbolId: 'star' })
  const start = [handwriting, neighbor, symbol]

  assert.equal(start.length, 3, 'the check starts from the mixed list, not a pre-filtered one')
  assert.equal(
    strokeTouchesEraser(handwriting, 0.28 * SOURCE_WIDTH, 0.25 * SOURCE_HEIGHT, RADIUS, SOURCE_WIDTH, SOURCE_HEIGHT),
    true,
    'eraser on the handwriting path must hit that stroke',
  )
  assert.equal(
    strokeTouchesEraser(neighbor, 0.28 * SOURCE_WIDTH, 0.25 * SOURCE_HEIGHT, RADIUS, SOURCE_WIDTH, SOURCE_HEIGHT),
    false,
    'the nearby polyline must not intersect the handwriting hit',
  )
  assert.equal(
    strokeTouchesEraser(symbol, 0.25 * SOURCE_WIDTH, 0.62 * SOURCE_HEIGHT, RADIUS, SOURCE_WIDTH, SOURCE_HEIGHT),
    true,
    'eraser on a one-point pictogram must hit the symbol disk',
  )

  const afterHits = applyToolErase(
    start,
    [{ x: 0.28, y: 0.25 }, { x: 0.25, y: 0.62 }],
    RADIUS,
    SOURCE_WIDTH,
    SOURCE_HEIGHT,
  )
  assert.deepEqual(afterHits.map((stroke) => stroke.id), ['neighbor'], 'only intersecting ink (polyline + symbol) is removed')
  assert.equal(afterHits.length, 1)
  assert.equal(afterHits[0], neighbor, 'the nearby stroke is the same object, not a rebuilt copy')

  const afterMiss = applyToolErase(start, [{ x: 0.5, y: 0.82 }], RADIUS, SOURCE_WIDTH, SOURCE_HEIGHT)
  assert.equal(afterMiss, start, 'a miss on empty paper leaves the original list unchanged')
  assert.equal(afterMiss.length, 3)
  assert.deepEqual(afterMiss.map((stroke) => stroke.id), ['handwriting', 'neighbor', 'symbol'])

  const afterEmpty = applyToolErase(start, [], RADIUS, SOURCE_WIDTH, SOURCE_HEIGHT)
  assert.equal(afterEmpty, start, 'no samples must not filter the list')

  console.log(JSON.stringify({
    start: start.map((stroke) => stroke.id),
    afterHits: afterHits.map((stroke) => stroke.id),
    missUnchanged: afterMiss.length,
  }))
  console.log('tool-erase ok')
} finally {
  await server.close()
}
