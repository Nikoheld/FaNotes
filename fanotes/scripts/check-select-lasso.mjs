import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = await createServer({
  root,
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const near = (actual, expected) => Math.abs(actual - expected) < 1e-9
const remember = (strokes) => strokes.map((stroke) => stroke.points.map((point) => ({ x: point.x, y: point.y })))

try {
  const lasso = await server.ssrLoadModule('/src/lib/inkLasso.ts')
  const select = await server.ssrLoadModule('/src/lib/inkSelect.ts')

  const loop = [
    { x: 0.2, y: 0.2 },
    { x: 0.6, y: 0.2 },
    { x: 0.6, y: 0.6 },
    { x: 0.2, y: 0.6 },
  ]
  const inside = { id: 'inside', points: [{ x: 0.35, y: 0.35 }, { x: 0.45, y: 0.5 }] }
  const crossing = { id: 'crossing', points: [{ x: 0.05, y: 0.4 }, { x: 0.9, y: 0.4 }] }
  const partial = {
    id: 'partial',
    points: [
      { x: 0.4, y: 0.4 },
      { x: 0.75, y: 0.4 },
      { x: 0.8, y: 0.42 },
      { x: 0.82, y: 0.44 },
      { x: 0.84, y: 0.46 },
    ],
  }
  const outside = { id: 'outside', points: [{ x: 0.05, y: 0.05 }, { x: 0.1, y: 0.08 }] }
  const strokes = [inside, crossing, partial, outside]

  assert.equal(lasso.pointInPolygon(crossing.points[0], loop), false)
  assert.equal(lasso.pointInPolygon(crossing.points[1], loop), false)
  assert.equal(lasso.strokeMostlyInside(crossing, loop), false)
  assert.equal(lasso.strokeMostlyInside(partial, loop), false, 'a minority of the stroke is inside')
  assert.equal(lasso.strokesInsideLasso(strokes, loop).includes(1), false)
  assert.equal(lasso.strokesInsideLasso(strokes, loop).includes(2), false)

  const indexes = lasso.strokesTouchingLasso(strokes, loop)
  assert.deepEqual(indexes, [0, 1, 2])
  assert.equal(indexes.includes(3), false)

  const rightEdgeCloses = [
    { x: 0.6, y: 0.2 },
    { x: 0.2, y: 0.2 },
    { x: 0.2, y: 0.6 },
    { x: 0.6, y: 0.6 },
  ]
  const touchClose = { id: 'close', points: [{ x: 0.8, y: 0.4 }, { x: 0.6, y: 0.4 }] }
  const missClose = { id: 'miss', points: [{ x: 0.8, y: 0.4 }, { x: 0.7, y: 0.4 }] }
  assert.equal(lasso.pointInPolygon(touchClose.points[0], rightEdgeCloses), false)
  assert.equal(lasso.pointInPolygon(touchClose.points[1], rightEdgeCloses), false)
  assert.deepEqual(lasso.strokesTouchingLasso([touchClose, missClose], rightEdgeCloses), [0])

  const anchor = { x: 0.5, y: 0.4 }
  const factor = 1.1
  const dx = 0.02
  const dy = 0.01

  const beforeMove = remember(strokes)
  const undoMove = select.inkEditUndoSnapshot(strokes)
  const moved = select.moveInkSelection(strokes, indexes, dx, dy)
  assert.equal(moved[3], outside)
  for (const index of indexes) {
    for (let point = 0; point < strokes[index].points.length; point += 1) {
      assert.ok(near(moved[index].points[point].x, strokes[index].points[point].x + dx))
      assert.ok(near(moved[index].points[point].y, strokes[index].points[point].y + dy))
    }
  }
  assert.deepEqual(remember(undoMove), beforeMove)

  const beforeScale = remember(strokes)
  const undoScale = select.inkEditUndoSnapshot(strokes)
  const scaled = select.scaleInkSelection(strokes, indexes, anchor, factor)
  assert.equal(scaled[3], outside)
  for (const index of indexes) {
    for (let point = 0; point < strokes[index].points.length; point += 1) {
      const from = strokes[index].points[point]
      const to = scaled[index].points[point]
      const before = Math.hypot(from.x - anchor.x, from.y - anchor.y)
      const after = Math.hypot(to.x - anchor.x, to.y - anchor.y)
      assert.ok(before > 1e-6)
      assert.ok(near(after, before * factor))
    }
  }
  assert.deepEqual(remember(undoScale), beforeScale)

  const beforeCopy = remember(strokes)
  const undoCopy = select.inkEditUndoSnapshot(strokes)
  const copied = select.copyInkSelection(strokes, indexes, 0.03, 0.03)
  assert.equal(copied.strokes.length, strokes.length + indexes.length)
  assert.equal(copied.indexes.length, indexes.length)
  for (let index = 0; index < strokes.length; index += 1) assert.equal(copied.strokes[index], strokes[index])
  const duplicate = copied.strokes[copied.indexes[0]]
  assert.ok(near(duplicate.points[0].x, inside.points[0].x + 0.03))
  assert.ok(near(duplicate.points[0].y, inside.points[0].y + 0.03))
  assert.deepEqual(remember(undoCopy), beforeCopy)
  assert.equal(undoCopy.length, strokes.length)

  const board = readFileSync(join(root, 'src/components/DrawingBoard.tsx'), 'utf8')
  assert.match(board, /selectionLoopRef\.current = \[\{ x: firstPoint\.x, y: firstPoint\.y \}\]/)
  assert.match(board, /strokesTouchingLasso\(strokesRef\.current, editLoop\)/)
  assert.match(board, /selectionPurpose === 'edit'/)
  assert.match(board, /const selection = selectionBetween\(start, finalPoint/)
  assert.doesNotMatch(board, /takeInkSelection/)
  assert.match(board, /data-handle="scale"/)
  assert.match(board, /copySelectedInk/)
  assert.match(board, /Auswahl duplizieren/)
  const drag = board.slice(board.indexOf('if (!drag.committed &&'), board.indexOf('onPointerUp={() => { inkDragRef.current = null'))
  assert.equal((drag.match(/undoRef\.current\.push/g) ?? []).length, 1)
  assert.match(drag, /inkEditUndoSnapshot\(strokesRef\.current\)/)
  assert.match(drag, /moveInkSelection\(strokesRef\.current, selectedStrokeIndexesRef\.current/)
  assert.match(drag, /scaleInkSelection\(/)
  const copyFn = board.slice(board.indexOf('const copySelectedInk'), board.indexOf('const deleteSelectedInk'))
  assert.equal((copyFn.match(/undoRef\.current\.push/g) ?? []).length, 1)
  assert.match(copyFn, /inkEditUndoSnapshot\(strokesRef\.current\)/)
  assert.match(copyFn, /copyInkSelection\(strokesRef\.current, indexes, 0\.03, 0\.03\)/)

  console.log(JSON.stringify({
    indexes,
    moved: moved[0].points[0],
    scaledDistance: Math.hypot(scaled[0].points[0].x - anchor.x, scaled[0].points[0].y - anchor.y),
    copies: copied.strokes.length,
  }))
  console.log('select-lasso ok')
} finally {
  await server.close()
}
