import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const {
  inkStrokeAllowsShapeSnap,
  shapeSnapAllowsLiveSample,
  snapStrokeToShape,
} = await server.ssrLoadModule('/src/lib/shapeSnap.ts')

const WIDTH = 1000
const HEIGHT = 800

const point = (x, y, index) => ({
  x, y, t: index, pressure: 0.5, tiltX: 0, tiltY: 0, pointerType: 'pen',
})

const lineStroke = (extra) => {
  const points = []
  for (let index = 0; index < 18; index += 1) {
    const t = index / 17
    points.push(point(0.12 + t * 0.62, 0.42, index))
  }
  if (extra) points.push(extra)
  return {
    points,
    baseWidth: 2.2,
    pressureEnabled: true,
    color: '#202333',
    purpose: 'handwriting',
    brush: 'fineliner',
  }
}

/**
 * Same rule as the board: a snapped figure drops every later sample, including
 * the lift. Freehand still takes the sample. A move never clears the snap.
 */
const applyLiveSample = (stroke, sample) => {
  if (!shapeSnapAllowsLiveSample(stroke.snapped)) return stroke
  return { snapped: false, points: [...stroke.points, sample] }
}

const runOnce = () => {
  assert.equal(shapeSnapAllowsLiveSample(false), true)
  assert.equal(shapeSnapAllowsLiveSample(true), false)
  assert.equal(inkStrokeAllowsShapeSnap({ purpose: 'art', brush: 'marker' }), false)
  assert.equal(inkStrokeAllowsShapeSnap({ purpose: 'handwriting', brush: 'fineliner' }), true)

  const clean = snapStrokeToShape(lineStroke(), WIDTH, HEIGHT, 50)
  assert.equal(clean?.kind, 'line')
  const cleanEnd = clean.stroke.points.at(-1)
  const held = { snapped: true, points: clean.stroke.points.map((sample) => ({ ...sample })) }

  // 4px along the line and 3px off it. The old reset resumed freehand past 1.8px.
  const lift = point(cleanEnd.x + 4 / WIDTH, cleanEnd.y + 3 / HEIGHT, 99)
  const afterLift = applyLiveSample(held, lift)
  assert.equal(afterLift.snapped, true)
  assert.equal(afterLift.points.length, clean.stroke.points.length)
  assert.deepEqual(afterLift.points.at(-1), cleanEnd)

  const drag = point(cleanEnd.x + 24 / WIDTH, cleanEnd.y + 18 / HEIGHT, 100)
  const afterDrag = applyLiveSample(afterLift, drag)
  assert.equal(afterDrag.snapped, true, 'pen still down must not resume freehand')
  assert.equal(afterDrag.points.length, clean.stroke.points.length)
  assert.deepEqual(afterDrag.points.at(-1), cleanEnd)

  const freehand = { snapped: false, points: lineStroke().points }
  const freeCommitted = applyLiveSample(freehand, lift)
  assert.equal(freeCommitted.snapped, false)
  assert.equal(freeCommitted.points.length, freehand.points.length + 1)
  assert.equal(freeCommitted.points.at(-1), lift)

  // Appending the lift before the snap pulls the straight end onto that jitter.
  const hooked = snapStrokeToShape(
    lineStroke(point(0.12 + 0.62 + 6 / WIDTH, 0.42 + 5 / HEIGHT, 18)),
    WIDTH,
    HEIGHT,
    50,
  )
  assert.equal(hooked?.kind, 'line')
  const hookedEnd = hooked.stroke.points.at(-1)
  const endShift = Math.hypot((hookedEnd.x - cleanEnd.x) * WIDTH, (hookedEnd.y - cleanEnd.y) * HEIGHT)
  assert.ok(endShift > 2, `a lift sample before snap moved the line end by ${endShift.toFixed(2)}px`)

  const board = readFileSync(join(root, 'src/components/DrawingBoard.tsx'), 'utf8')
  assert.equal(board.includes('SHAPE_MOVE_RESET_PX'), false, 'a small move must not clear a snapped figure')
  const appendAt = board.indexOf('const appendPointerEvent = useCallback')
  const appendEnd = board.indexOf('const commitPendingSolverTap', appendAt)
  const appendBody = board.slice(appendAt, appendEnd)
  const guardAt = appendBody.indexOf('if (!shapeSnapAllowsLiveSample(shapeSnappedRef.current)) return')
  const pushAt = appendBody.indexOf('stroke.points.push(point)')
  assert.ok(guardAt >= 0 && pushAt > guardAt, 'append must drop samples before it pushes a point')
  assert.equal(appendBody.includes('shapeSnappedRef.current = false'), false)

  const finishAt = board.indexOf('const heldLongEnough = performance.now() - shapeLastMoveAtRef.current')
  const finishSlice = board.slice(finishAt, finishAt + 1200)
  const snapAt = finishSlice.indexOf('trySnapActiveShape()')
  const captureAt = finishSlice.indexOf('const activeStroke = activeStrokeRef.current')
  const finishAppendAt = finishSlice.indexOf('appendPointerEvent(native, true)')
  assert.ok(snapAt >= 0 && captureAt > snapAt && finishAppendAt > captureAt, 'pen-up snaps, then commits that figure, then maybe takes a freehand lift')
  assert.ok(finishSlice.includes('shapeSnapAllowsLiveSample(shapeSnappedRef.current) && resolveInkFinishSample(native)'))
  assert.ok(board.includes('const livePredicted = shapeSnapAllowsLiveSample(shapeSnappedRef.current) ? predicted : []'))

  const downAt = board.indexOf('shapeSnappedRef.current = false\n    shapeLastMoveAtRef.current = performance.now()')
  const downAppend = board.indexOf('appendPointerEvent(event.nativeEvent)', downAt)
  assert.ok(downAt > 0 && downAppend > downAt, 'the next pen-down clears the hold before its first sample')

  return {
    points: clean.stroke.points.length,
    endShift: Math.round(endShift * 1000) / 1000,
  }
}

try {
  const first = runOnce()
  const second = runOnce()
  assert.deepEqual(first, second)
  console.log(JSON.stringify(first))
  console.log('shape snap hold ok')
} finally {
  await server.close()
}
