import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const {
  commitInkPointerSequence,
  isInkCorridorLeap,
} = await server.ssrLoadModule('/src/lib/inkSampleMap.ts')

const SOURCE_WIDTH = 900
const SOURCE_HEIGHT = 1273
const surface = { left: 80, top: 60, width: 700, height: 990, offsetWidth: 900, offsetHeight: 1273 }

const clientAt = (nx, ny, extras = {}) => ({
  type: extras.type ?? 'pointermove',
  clientX: surface.left + nx * surface.width,
  clientY: surface.top + ny * surface.height,
  timeStamp: extras.timeStamp ?? 16,
  pressure: extras.pressure ?? 0.5,
  pointerType: 'pen',
  ...extras,
})

const hasLineToTop = (points) => points.some((point, index) => (
  index > 0
  && (
    (point.y < 0.05 && points[index - 1].y > 0.15)
    || (points[index - 1].y < 0.05 && point.y > 0.15)
  )
))

try {
  const firstX = 0.62
  const firstY = 0.31
  const points = commitInkPointerSequence(
    [
      clientAt(firstX, firstY, { type: 'pointerdown', timeStamp: 1 }),
      clientAt(0.63, 0.01, { timeStamp: 8 }),
      clientAt(0.64, 0.32, { timeStamp: 16 }),
      clientAt(0.66, 0.33, { timeStamp: 24 }),
    ],
    surface,
    SOURCE_WIDTH,
    SOURCE_HEIGHT,
  )
  assert.ok(points.length >= 2, 'right-half writing must keep the in-band stroke')
  assert.ok(points[0].x >= 0.5, 'first contact must stay on the right half')
  assert.ok(points[0].y > 0.15, 'first contact must stay in the written band')
  assert.equal(points.some((point) => point.y < 0.05), false, 'no committed point at y≈0')
  assert.equal(hasLineToTop(points), false, 'must not keep a segment to the top')
  assert.equal(isInkCorridorLeap({ x: 0.62, y: 0.31 }, { x: 0.63, y: 0.01 }), true)

  const short = commitInkPointerSequence(
    [
      clientAt(0.71, 0.28, { type: 'pointerdown', timeStamp: 1 }),
      clientAt(0.72, 0.29, { timeStamp: 10 }),
    ],
    surface,
    SOURCE_WIDTH,
    SOURCE_HEIGHT,
  )
  assert.equal(hasLineToTop(short), false)
  assert.ok(short.every((point) => point.x >= 0.5 && point.y > 0.2))

  console.log(JSON.stringify({
    first: { x: Number(points[0].x.toFixed(3)), y: Number(points[0].y.toFixed(3)) },
    count: points.length,
    ys: points.map((point) => Number(point.y.toFixed(3))),
  }))
  console.log('bug-right-line-up ok')
} finally {
  await server.close()
}
