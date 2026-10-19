import assert from 'node:assert/strict'
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

const { createInkReadbackContext, createMarkerCoverage, drawInkStroke } = await server.ssrLoadModule('/src/lib/inkStrokePaint.ts')
const { inkStrokeAllowsShapeSnap } = await server.ssrLoadModule('/src/lib/shapeSnap.ts')

const alphaAt = (image, x, y) => {
  const px = Math.round(x)
  const py = Math.round(y)
  return image.data[(py * image.width + px) * 4 + 3]
}

const marker = (points) => ({
  points,
  baseWidth: 9,
  pressureEnabled: false,
  color: '#202333',
  purpose: 'art',
  brush: 'marker',
  colorEffect: 'solid',
  opacity: 1,
})

const paint = (points, smoothing) => {
  const surface = createInkReadbackContext(400, 400)
  drawInkStroke(surface.context, marker(points), 400, 400, smoothing, 1, 400, 400)
  return surface.getImageData()
}

const covered = (image, x, y) => alphaAt(image, x, y) >= 24
const clear = (image, x, y) => alphaAt(image, x, y) < 24

const runOnce = () => {
  assert.equal(inkStrokeAllowsShapeSnap({ purpose: 'art', brush: 'marker' }), false)
  assert.equal(inkStrokeAllowsShapeSnap({ purpose: 'art', brush: 'highlighter' }), false)
  assert.equal(inkStrokeAllowsShapeSnap({ purpose: 'handwriting', brush: 'fineliner' }), true)
  assert.equal(inkStrokeAllowsShapeSnap({ purpose: 'art', symbolId: 'star' }), false)
  assert.equal(inkStrokeAllowsShapeSnap(null), false)

  // 90° turn. The old last segment extrapolated past the corner (~x=216).
  const turn = paint([
    { x: 0.2, y: 0.5 },
    { x: 0.5, y: 0.5 },
    { x: 0.5, y: 0.8 },
  ], 0.68)
  assert.ok(covered(turn, 200, 200), 'marker must cover the corner the pen reached')
  assert.ok(covered(turn, 120, 200), 'marker must cover the incoming leg')
  assert.ok(covered(turn, 200, 280), 'marker must cover the outgoing leg')
  assert.ok(clear(turn, 216, 220), 'a direction change must not hook past the nib')
  assert.ok(clear(turn, 214, 200), 'the incoming direction must stop at the corner')

  // Same turn with more of the new direction already drawn (interior corner).
  const interior = paint([
    { x: 0.2, y: 0.5 },
    { x: 0.5, y: 0.5 },
    { x: 0.5, y: 0.65 },
    { x: 0.5, y: 0.8 },
  ], 0.68)
  assert.ok(covered(interior, 200, 200), 'an interior corner stays covered')
  assert.ok(clear(interior, 216, 210), 'an interior corner must not balloon outward')

  // Reversal. The stroke comes back on itself and must not loop past the tip.
  const reverse = paint([
    { x: 0.2, y: 0.45 },
    { x: 0.55, y: 0.45 },
    { x: 0.2, y: 0.45 },
  ], 0.68)
  assert.ok(covered(reverse, 220, 180), 'a reversal still covers the turn point')
  assert.ok(clear(reverse, 248, 180), 'a reversal must not loop past the turn')

  // Smoothing off is the polyline. Round caps may reach half a nib past the corner, not a hook.
  const hard = paint([
    { x: 0.2, y: 0.3 },
    { x: 0.5, y: 0.3 },
    { x: 0.5, y: 0.55 },
  ], 0)
  assert.ok(covered(hard, 200, 120), 'unsmoothed marker still covers the corner')
  assert.ok(clear(hard, 216, 120), 'unsmoothed marker does not shoot past the corner')

  // A straight marker stays on its line.
  const straight = paint([
    { x: 0.15, y: 0.25 },
    { x: 0.5, y: 0.25 },
    { x: 0.85, y: 0.25 },
  ], 0.68)
  assert.ok(covered(straight, 200, 100), 'a straight marker covers its line')
  assert.ok(clear(straight, 200, 118), 'a straight marker does not wander off the line')

  const channels = (image, x, y) => {
    const index = (Math.round(y) * image.width + Math.round(x)) * 4
    return [...image.data.slice(index, index + 4)]
  }
  const same = (left, right) => left.every((value, index) => value === right[index])
  const cross = (brush, keep) => {
    const surface = createInkReadbackContext(200, 200)
    const coverage = createMarkerCoverage(200, 200)
    const horizontal = {
      points: [{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }],
      baseWidth: 18,
      pressureEnabled: false,
      color: '#ff0000',
      purpose: 'art',
      brush,
      colorEffect: 'solid',
      opacity: 1,
    }
    const vertical = {
      ...horizontal,
      points: [{ x: 0.5, y: 0.1 }, { x: 0.5, y: 0.9 }],
      color: '#0000ff',
      keepColor: keep,
    }
    const paintStroke = (stroke) => drawInkStroke(
      surface.context,
      stroke,
      200,
      200,
      0,
      1,
      200,
      200,
      stroke.points.length,
      { coverage, stamp: true },
    )
    paintStroke(horizontal)
    const before = channels(surface.getImageData(), 100, 100)
    paintStroke(vertical)
    return { image: surface.getImageData(), before }
  }
  for (const brush of ['marker', 'highlighter']) {
    const kept = cross(brush, true)
    const mixed = cross(brush, false)
    const keptCross = channels(kept.image, 100, 100)
    const keptBlue = channels(kept.image, 100, 30)
    assert.ok(same(keptCross, kept.before), `${brush} with the toggle must leave the first color`)
    assert.ok(keptCross[0] > keptCross[2] + 40, `${brush} with the toggle keeps the first stroke red`)
    assert.ok(keptBlue[2] > keptBlue[0] + 40, `${brush} with the toggle still paints empty paper`)
    assert.ok(!same(channels(mixed.image, 100, 100), mixed.before), `${brush} without the toggle still mixes`)
  }
  const overPen = createInkReadbackContext(200, 200)
  const penCoverage = createMarkerCoverage(200, 200)
  drawInkStroke(overPen.context, {
    points: [{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }],
    baseWidth: 4,
    pressureEnabled: false,
    color: '#111111',
    purpose: 'handwriting',
    brush: 'fineliner',
    colorEffect: 'solid',
    opacity: 1,
  }, 200, 200, 0, 1, 200, 200, 2, { coverage: penCoverage, stamp: true })
  drawInkStroke(overPen.context, {
    points: [{ x: 0.5, y: 0.1 }, { x: 0.5, y: 0.9 }],
    baseWidth: 18,
    pressureEnabled: false,
    color: '#ff0000',
    purpose: 'art',
    brush: 'marker',
    colorEffect: 'solid',
    opacity: 1,
    keepColor: true,
  }, 200, 200, 0, 1, 200, 200, 2, { coverage: penCoverage, stamp: true })
  const overInk = channels(overPen.getImageData(), 100, 100)
  assert.ok(overInk[0] > 150, 'the toggle does not block a marker from covering pen ink')

  return { turn: alphaAt(turn, 200, 200), hook: alphaAt(turn, 216, 220) }
}

try {
  const first = runOnce()
  const second = runOnce()
  assert.deepEqual(first, second)
  console.log(JSON.stringify(first))
  console.log('marker ok')
} finally {
  await server.close()
}
