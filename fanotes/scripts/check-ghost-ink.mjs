import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const {
  acceptCommittedInkSample,
  appendAcceptedInkPoint,
  mapClientToPaperPoint,
} = await server.ssrLoadModule('/src/lib/inkSampleMap.ts')
const { resolveInkFinishSample } = await server.ssrLoadModule('/src/lib/inkPointerSession.ts')

const SOURCE_WIDTH = 900
const SOURCE_HEIGHT = 1273
const surface = { left: 120, top: 80, width: 600, height: 800, offsetWidth: 900, offsetHeight: 1273 }

const clientAt = (nx, ny, extras = {}) => ({
  type: 'pointermove',
  clientX: surface.left + nx * surface.width,
  clientY: surface.top + ny * surface.height,
  timeStamp: extras.timeStamp ?? 16,
  pressure: 0.5,
  pointerType: 'pen',
  ...extras,
})

try {
  const points = []
  const corridor = [
    clientAt(0.2, 0.25, { timeStamp: 16 }),
    clientAt(0.22, 0.27, { timeStamp: 32 }),
    clientAt(0.24, 0.29, { timeStamp: 48 }),
    clientAt(0.26, 0.31, { timeStamp: 64 }),
  ]
  corridor.forEach((event) => appendAcceptedInkPoint(points, event, surface, SOURCE_WIDTH, SOURCE_HEIGHT))
  assert.equal(points.length, 4, 'valid corridor samples must commit')

  appendAcceptedInkPoint(points, { ...clientAt(0.28, 0.33), predicted: true }, surface, SOURCE_WIDTH, SOURCE_HEIGHT)
  assert.equal(points.length, 4, 'predicted-only samples must stay preview-only')

  appendAcceptedInkPoint(points, { type: 'pointermove', clientX: 0, clientY: 0, pressure: 0.4, pointerType: 'pen' }, surface, SOURCE_WIDTH, SOURCE_HEIGHT)
  assert.equal(points.length, 4, '0,0 far from the surface must not commit a corner jump')

  const pannedSurface = {
    left: -80,
    top: -220,
    width: 600,
    height: 800,
    offsetWidth: 900,
    offsetHeight: 1273,
  }
  const pannedClientAt = (nx, ny, extras = {}) => ({
    type: 'pointermove',
    clientX: pannedSurface.left + nx * pannedSurface.width,
    clientY: pannedSurface.top + ny * pannedSurface.height,
    timeStamp: extras.timeStamp ?? 80,
    pressure: 0.5,
    pointerType: 'pen',
    ...extras,
  })
  const pannedPoints = []
  appendAcceptedInkPoint(pannedPoints, pannedClientAt(0.18, 0.22, { timeStamp: 80 }), pannedSurface, SOURCE_WIDTH, SOURCE_HEIGHT)
  appendAcceptedInkPoint(pannedPoints, pannedClientAt(0.20, 0.24, { timeStamp: 96 }), pannedSurface, SOURCE_WIDTH, SOURCE_HEIGHT)
  assert.equal(pannedPoints.length, 2, 'valid samples on a panned sheet must still commit')
  const beforePannedGhost = pannedPoints.length
  appendAcceptedInkPoint(
    pannedPoints,
    { type: 'pointermove', clientX: 0, clientY: 0, pressure: 0.4, pointerType: 'pen', timeStamp: 112 },
    pannedSurface,
    SOURCE_WIDTH,
    SOURCE_HEIGHT,
  )
  assert.equal(pannedPoints.length, beforePannedGhost, '0,0 on a panned sheet that only overlaps the origin must not commit a mid-page ghost')
  assert.equal(
    acceptCommittedInkSample(
      { type: 'pointermove', clientX: 0, clientY: 0, pressure: 0.4, pointerType: 'pen' },
      pannedSurface,
      pannedPoints.at(-1),
      SOURCE_WIDTH,
      SOURCE_HEIGHT,
    ),
    null,
  )
  const originSurface = { left: 0, top: 0, width: 600, height: 800, offsetWidth: 900, offsetHeight: 1273 }
  const originContact = acceptCommittedInkSample(
    { type: 'pointerdown', clientX: 0, clientY: 0, pressure: 0.4, pointerType: 'pen' },
    originSurface,
    null,
    SOURCE_WIDTH,
    SOURCE_HEIGHT,
  )
  assert.ok(originContact && originContact.x <= 0.02 && originContact.y <= 0.02, 'real 0,0 contact at the paper corner must still map')

  appendAcceptedInkPoint(points, { type: 'pointermove', clientX: Number.NaN, clientY: 200, pressure: 0.4, pointerType: 'pen' }, surface, SOURCE_WIDTH, SOURCE_HEIGHT)
  assert.equal(points.length, 4, 'NaN client coords must not commit')

  appendAcceptedInkPoint(points, { type: 'pointercancel', clientX: surface.left + 200, clientY: surface.top + 200 }, surface, SOURCE_WIDTH, SOURCE_HEIGHT)
  assert.equal(points.length, 4, 'pointercancel must not append')

  appendAcceptedInkPoint(points, clientAt(0.3, 0.34), null, SOURCE_WIDTH, SOURCE_HEIGHT)
  assert.equal(points.length, 4, 'missing surface must not fall back to the page center')
  assert.equal(mapClientToPaperPoint(clientAt(0.3, 0.34), null), null)
  assert.equal(
    acceptCommittedInkSample({ type: 'pointermove', clientX: 400, clientY: 400 }, null, points.at(-1), SOURCE_WIDTH, SOURCE_HEIGHT),
    null,
  )

  const last = points.at(-1)
  appendAcceptedInkPoint(points, clientAt(0.95, 0.95), surface, SOURCE_WIDTH, SOURCE_HEIGHT)
  assert.equal(points.length, 4, 'a random leap off the corridor must not commit')
  assert.ok(last && last.x < 0.4 && last.y < 0.4, 'last committed point must stay in the corridor')

  for (const point of points) {
    assert.ok(point.x >= 0.18 && point.x <= 0.32, `x ${point.x} left the corridor`)
    assert.ok(point.y >= 0.23 && point.y <= 0.35, `y ${point.y} left the corridor`)
    assert.notEqual(point.x, 0.5)
    assert.notEqual(point.y, 0.5)
    assert.notEqual(point.x, 0)
    assert.notEqual(point.y, 0)
  }

  assert.equal(resolveInkFinishSample({ type: 'pointercancel', clientX: 420, clientY: 480 }), null)
  assert.equal(resolveInkFinishSample({ type: 'lostpointercapture', clientX: 420, clientY: 480 }), null)

  console.log(JSON.stringify({ committed: points.length, last, cancelNull: true }))
  console.log('ghost-ink ok')
} finally {
  await server.close()
}
