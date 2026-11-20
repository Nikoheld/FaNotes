// Eraser modes: the stroke eraser drops whole strokes, the area eraser splits
// them into ordinary strokes; both give the original back when undone.
// Also checks the paper step of PDF side pages.
import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})
try {
  const { applyStrokeErase, applyToolErase, readEraserMode } = await server.ssrLoadModule('/src/lib/toolErase.ts')
  const { sidePagePaperStepPercent } = await server.ssrLoadModule('/src/lib/paperStyles.ts')
  const { defaultToolMemory } = await server.ssrLoadModule('/src/lib/toolMemory.ts')

  const W = 900
  const H = 1273
  const pt = (x, y) => ({ x: x / W, y: y / H, t: 0, pressure: 0.5, tiltX: 0, tiltY: 0, pointerType: 'pen' })
  const line = (y) => ({ points: [100, 200, 300, 400, 500].map((x) => pt(x, y)), baseWidth: 4, color: '#000' })
  const strokes = [line(100), line(300)]
  const swipe = [{ x: 300 / W, y: 80 / H }, { x: 300 / W, y: 120 / H }]

  // Stroke mode: first stroke gone whole, second keeps its identity.
  const wholeGone = applyStrokeErase(strokes, swipe, 10, W, H)
  assert.equal(wholeGone.length, 1)
  assert.equal(wholeGone[0], strokes[1])

  // Area mode: the touched stroke is split into two normal strokes with the gap cut out.
  const split = applyToolErase(strokes, swipe, 10, W, H)
  assert.equal(split.length, 3)
  assert.equal(split[2], strokes[1])
  for (const piece of split.slice(0, 2)) {
    assert.ok(piece.points.length >= 1)
    assert.equal(piece.baseWidth, 4)
    assert.ok(Array.isArray(piece.points))
  }
  const xs = split.slice(0, 2).map((piece) => piece.points.map((p) => p.x * W))
  assert.ok(Math.max(...xs[0]) < 300 && Math.min(...xs[1]) > 300, 'gap around the eraser')

  // A miss changes nothing in either mode.
  const miss = [{ x: 300 / W, y: 700 / H }]
  assert.equal(applyStrokeErase(strokes, miss, 10, W, H), strokes)
  assert.equal(applyToolErase(strokes, miss, 10, W, H), strokes)

  // Fast swipe across a stroke between two far-apart samples still hits.
  const jump = [{ x: 300 / W, y: 20 / H }, { x: 300 / W, y: 190 / H }]
  assert.equal(applyStrokeErase(strokes, jump, 6, W, H).length, 1)

  // Undo: the erase never mutates its input, so the snapshot is the undo state.
  assert.equal(strokes.length, 2)
  assert.equal(strokes[0].points.length, 5)

  assert.equal(readEraserMode('stroke'), 'stroke')
  assert.equal(readEraserMode('x'), 'area')
  assert.equal(defaultToolMemory().eraserMode, 'area')

  // Side page paper: blank has no ruling, others scale with the page width.
  assert.equal(sidePagePaperStepPercent('blank'), null)
  for (const style of ['dots', 'squares', 'grid', 'lines', 'millimeter']) {
    const step = sidePagePaperStepPercent(style)
    assert.ok(step > 0 && step < 20, style)
  }
  assert.ok(sidePagePaperStepPercent('squares', 10) > sidePagePaperStepPercent('squares', 5))
  console.log('eraser modes and side page paper OK')
} finally {
  await server.close()
}
