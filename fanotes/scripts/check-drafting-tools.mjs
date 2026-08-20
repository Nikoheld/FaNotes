import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const {
  RULER_HEIGHT_MM,
  RULER_LENGTH_MM,
  SET_SQUARE_LEG_MM,
  SET_SQUARE_PROTRACTOR_DEGREES,
  SOURCE_A4_PX,
  defaultRulerPose,
  defaultSetSquarePose,
  draftingLocalToNorm,
  formatDegrees,
  millimetresAlongEdge,
  rulerDrawingEdges,
  setSquareDrawingEdges,
  snapToDraftingTools,
} = await server.ssrLoadModule('/src/lib/draftingTools.ts')

const W = SOURCE_A4_PX
const H = 1273

const snapNear = (kind, pose, localX, localY) => {
  const point = draftingLocalToNorm(localX, localY, pose, W, H)
  return snapToDraftingTools(point.x, point.y, [{ kind, pose }], W, H)
}

try {
  const ruler = defaultRulerPose()
  const rulerEdges = rulerDrawingEdges(ruler, W, H)
  assert.equal(rulerEdges.length, 2, 'ruler has two long drawing edges')

  const topSnap = snapNear('ruler', ruler, 0, -RULER_HEIGHT_MM / 2 - 1)
  assert.ok(topSnap, 'live sample next to the top edge must snap')
  assert.equal(topSnap.kind, 'ruler')
  assert.equal(topSnap.edgeIndex, 0, 'top sample must land on the top edge, not the opposite one')

  const bottomSnap = snapNear('ruler', ruler, 0, RULER_HEIGHT_MM / 2 + 1)
  assert.ok(bottomSnap, 'live sample next to the bottom edge must snap')
  assert.equal(bottomSnap.edgeIndex, 1, 'bottom sample must land on the bottom edge, not the opposite one')

  const midStart = snapNear('ruler', ruler, 0, -RULER_HEIGHT_MM / 2)
  assert.ok(midStart, 'grow/snap check starts from a live mid-edge point')
  const tenMm = snapNear('ruler', ruler, -RULER_LENGTH_MM / 2 + 10, -RULER_HEIGHT_MM / 2)
  assert.ok(tenMm)
  assert.ok(Math.abs(tenMm.millimetres - 10) <= 0.5, `10 mm along the ruler must stay near 10, got ${tenMm.millimetres}`)
  assert.ok(Math.abs(millimetresAlongEdge(rulerEdges[0], 10 / RULER_LENGTH_MM, W, H) - 10) <= 0.5)

  const square = defaultSetSquarePose()
  const squareEdges = setSquareDrawingEdges(square, W, H)
  assert.equal(squareEdges.length, 3, 'set square has three drawing edges')

  const alongBase = snapNear('setSquare', square, SET_SQUARE_LEG_MM / 2, 1)
  assert.ok(alongBase)
  assert.equal(alongBase.edgeIndex, 0, 'sample next to the base must snap to the base')

  const alongHeight = snapNear('setSquare', square, -1, -SET_SQUARE_LEG_MM / 2)
  assert.ok(alongHeight)
  assert.equal(alongHeight.edgeIndex, 1, 'sample next to the height must snap to the height')

  const alongHyp = snapNear('setSquare', square, SET_SQUARE_LEG_MM / 2 + 1.2, -SET_SQUARE_LEG_MM / 2 - 1.2)
  assert.ok(alongHyp)
  assert.equal(alongHyp.edgeIndex, 2, 'sample next to the hypotenuse must snap to the hypotenuse')

  const tenOnHeight = snapNear('setSquare', square, 0, -10)
  assert.ok(tenOnHeight)
  assert.ok(
    Math.abs(tenOnHeight.millimetres - 10) <= 0.5,
    `10 mm along the set-square height must stay near 10, got ${tenOnHeight.millimetres}`,
  )

  assert.ok(SET_SQUARE_PROTRACTOR_DEGREES.includes(0))
  assert.ok(SET_SQUARE_PROTRACTOR_DEGREES.includes(90))
  assert.ok(SET_SQUARE_PROTRACTOR_DEGREES.includes(180), 'protractor must reach 180°, not stop at 90°')
  assert.ok(SET_SQUARE_PROTRACTOR_DEGREES.some((degree) => degree > 90))
  assert.equal(formatDegrees(Math.PI / 2), '90°')
  assert.equal(formatDegrees(Math.PI), '180°')

  console.log(JSON.stringify({
    rulerEdges: rulerEdges.length,
    topEdge: topSnap.edgeIndex,
    bottomEdge: bottomSnap.edgeIndex,
    tenMm: tenMm.millimetres,
    squareEdges: squareEdges.length,
    heightMm: tenOnHeight.millimetres,
    protractor: SET_SQUARE_PROTRACTOR_DEGREES,
    rotation: formatDegrees(square.rotation),
  }))
  console.log('drafting-tools ok')
} finally {
  await server.close()
}
