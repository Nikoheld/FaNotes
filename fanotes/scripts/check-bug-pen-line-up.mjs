import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const {
  acceptUsableInkClient,
  appendAcceptedInkPoint,
  collectPreviewInkPoints,
  commitInkPointerSequence,
  mapClientToPaperPoint,
  resolveInkPointerDown,
} = await server.ssrLoadModule('/src/lib/inkSampleMap.ts')

const SOURCE_WIDTH = 900
const SOURCE_HEIGHT = 1273
const surface = { left: 120, top: 80, width: 600, height: 800, offsetWidth: 900, offsetHeight: 1273 }

const clientAt = (nx, ny, extras = {}) => ({
  type: extras.type ?? 'pointermove',
  clientX: surface.left + nx * surface.width,
  clientY: surface.top + ny * surface.height,
  timeStamp: extras.timeStamp ?? 16,
  pressure: extras.pressure ?? 0.5,
  pointerType: 'pen',
  ...extras,
})

const inReportBand = (point) => point.y >= 0.27 && point.y <= 0.34 && point.x >= 0.30 && point.x <= 0.79
const hasLineToTop = (points) => points.some((point, index) => (
  index > 0
  && (
    (point.y < 0.05 && points[index - 1].y > 0.2)
    || (points[index - 1].y < 0.05 && point.y > 0.2)
  )
))

try {
  const first = clientAt(0.33, 0.33, { type: 'pointerdown', timeStamp: 1 })
  const ghostZero = { type: 'pointermove', clientX: 0, clientY: 0, pressure: 0.4, pointerType: 'pen', timeStamp: 8 }
  const missingSurface = clientAt(0.34, 0.32, { timeStamp: 12 })
  const leapTop = clientAt(0.33, 0, { timeStamp: 16 })
  const nextReal = clientAt(0.36, 0.31, { timeStamp: 24 })

  const points = commitInkPointerSequence(
    [first, ghostZero, leapTop, nextReal],
    surface,
    SOURCE_WIDTH,
    SOURCE_HEIGHT,
  )
  assert.ok(points.length >= 1, 'real samples must still start the stroke')
  assert.equal(points.some((point) => point.y < 0.05), false, 'no committed point at y≈0')
  assert.equal(hasLineToTop(points), false, 'must not keep a segment to the top')
  for (const point of points) assert.ok(inReportBand(point) || (point.y >= 0.27 && point.y <= 0.34), `point y=${point.y} left the report band`)

  const afterGhost = commitInkPointerSequence(
    [ghostZero, clientAt(0.33, 0.33, { type: 'pointerdown', timeStamp: 40 })],
    surface,
    SOURCE_WIDTH,
    SOURCE_HEIGHT,
  )
  assert.equal(afterGhost.length, 1, 'a real sample after a rejected 0,0 down must still start')
  assert.ok(afterGhost[0].y > 0.2)
  assert.equal(afterGhost[0].y < 0.05, false)

  const midMissing = commitInkPointerSequence([first], surface, SOURCE_WIDTH, SOURCE_HEIGHT)
  appendAcceptedInkPoint(midMissing, missingSurface, null, SOURCE_WIDTH, SOURCE_HEIGHT)
  assert.equal(midMissing.length, 1, 'missing surface mid-stroke must not add a point')
  assert.equal(hasLineToTop(midMissing), false)

  const originSurface = { left: 0, top: 0, width: 600, height: 800, offsetWidth: 900, offsetHeight: 1273 }
  const originGhostThenReal = commitInkPointerSequence(
    [
      { type: 'pointerdown', clientX: 0, clientY: 0, pressure: 0.4, pointerType: 'pen', timeStamp: 1 },
      {
        type: 'pointermove',
        clientX: originSurface.left + 0.33 * originSurface.width,
        clientY: originSurface.top + 0.33 * originSurface.height,
        pressure: 0.5,
        pointerType: 'pen',
        timeStamp: 16,
      },
    ],
    originSurface,
    SOURCE_WIDTH,
    SOURCE_HEIGHT,
  )
  assert.equal(originGhostThenReal.some((point) => point.y < 0.05), false, 'restart must drop the top ghost')
  assert.equal(hasLineToTop(originGhostThenReal), false)
  assert.ok(originGhostThenReal.length >= 1 && originGhostThenReal[0].y > 0.2)

  assert.equal(acceptUsableInkClient(ghostZero, surface), null, 'first gate rejects 0,0 without leap-filter')
  assert.ok(acceptUsableInkClient(first, surface), 'first gate keeps an in-band sample')

  const downGhost = resolveInkPointerDown(ghostZero, surface)
  assert.equal(downGhost.commitFirst, false)
  assert.equal(downGhost.openStroke, true)

  const preview = collectPreviewInkPoints(
    [{ x: 0.33, y: 0.33 }],
    [
      mapClientToPaperPoint(ghostZero, surface),
      mapClientToPaperPoint(leapTop, surface),
      mapClientToPaperPoint(nextReal, surface),
    ],
  )
  assert.equal(preview.some((point) => point.y < 0.05), false, 'predicted leap to y≈0 must not paint a line')
  assert.ok(preview.length >= 1, 'in-band predicted samples may still preview')
  assert.ok(preview.every((point) => point.y > 0.2))

  const zeroPressure = mapClientToPaperPoint(
    { type: 'pointerdown', clientX: 0, clientY: 0, pressure: 0, pointerType: 'pen' },
    originSurface,
  )
  assert.equal(zeroPressure, null, '0,0 with no pressure is not a first ink point')

  console.log(JSON.stringify({
    committed: points.length,
    ys: points.map((point) => Number(point.y.toFixed(3))),
    preview: preview.length,
    afterGhostY: afterGhost[0].y,
  }))
  console.log('bug-pen-line-up ok')
} finally {
  await server.close()
}
