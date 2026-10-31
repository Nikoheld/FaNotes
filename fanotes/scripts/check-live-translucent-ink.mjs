// A growing marker must stroke each segment a constant number of times.
// The settled pixels match one full-stroke composite, so joints do not darken.
import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const { createInkReadbackContext } = await server.ssrLoadModule('/src/lib/inkStrokePaint.ts')
const {
  compositeTranslucentStrokeOnce,
  paintGrowingTranslucentStroke,
} = await server.ssrLoadModule('/src/lib/liveTranslucentInk.ts')

const width = 800
const height = 220
const smoothing = 0.68
const pointCount = 120

const markerPoints = Array.from({ length: pointCount }, (_, index) => {
  const t = index / (pointCount - 1)
  const x = 0.06 + t * 0.88
  const y = index < 90 ? 0.42 : 0.42 + ((index - 89) / 30) * 0.28
  return { x, y, pressure: 0.6 }
})

const marker = (points) => ({
  points,
  baseWidth: 16,
  pressureEnabled: false,
  color: '#202333',
  purpose: 'art',
  brush: 'marker',
  colorEffect: 'solid',
  opacity: 1,
})

const highlighterPoints = markerPoints.map((point) => ({ ...point, y: point.y * 0.5 + 0.08 }))
const highlighter = (points) => ({
  ...marker(points),
  brush: 'highlighter',
  color: '#f5d33d',
  baseWidth: 22,
})

const paintArgs = (stroke) => ({
  stroke,
  pageWidth: width,
  pageHeight: height,
  smoothing,
  sourceWidth: width,
  layoutWidth: width,
  originX: 0,
  originY: 0,
})

const grow = (build, points) => {
  const target = createInkReadbackContext(width, height)
  let session = null
  let segmentPaints = 0
  for (let count = 1; count <= points.length; count += 1) {
    const painted = paintGrowingTranslucentStroke({
      ...paintArgs(build(points.slice(0, count))),
      session,
      target,
      replace: count === 1,
      settle: count === points.length,
    })
    session = painted.session
    segmentPaints = painted.segmentPaints
  }
  return { image: target.getImageData(), segmentPaints, points: points.length }
}

const once = (build, points) => {
  const target = createInkReadbackContext(width, height)
  compositeTranslucentStrokeOnce({
    ...paintArgs(build(points)),
    target,
  })
  return target.getImageData()
}

const pixel = (image, x, y) => {
  const px = Math.max(0, Math.min(image.width - 1, Math.round(x)))
  const py = Math.max(0, Math.min(image.height - 1, Math.round(y)))
  const index = (py * image.width + px) * 4
  return [
    image.data[index],
    image.data[index + 1],
    image.data[index + 2],
    image.data[index + 3],
  ]
}

const channelGap = (left, right) => Math.max(
  Math.abs(left[0] - right[0]),
  Math.abs(left[1] - right[1]),
  Math.abs(left[2] - right[2]),
  Math.abs(left[3] - right[3]),
)

// Interior of a leg and the corner the pen actually reached. Both sit inside
// the nib, where one composite and the growing stroke must agree.
const samplesFor = (points) => {
  const at = (index) => ({
    x: points[index].x * width,
    y: points[index].y * height,
  })
  const mid = (index) => ({
    x: (points[index].x + points[index + 1].x) * 0.5 * width,
    y: (points[index].y + points[index + 1].y) * 0.5 * height,
  })
  return [mid(40), at(89), mid(100), mid(10)]
}

const assertSettled = (name, build, points) => {
  const grown = grow(build, points)
  const reference = once(build, points)
  assert.ok(grown.points >= 100, `${name} points`)
  assert.ok(
    grown.segmentPaints <= 4 * grown.points,
    `${name} segment paints ${grown.segmentPaints} exceed 4×${grown.points}`,
  )
  for (const sample of samplesFor(points)) {
    const left = pixel(grown.image, sample.x, sample.y)
    const right = pixel(reference, sample.x, sample.y)
    const gap = channelGap(left, right)
    assert.ok(gap <= 3, `${name} settled pixel ${sample.x.toFixed(1)},${sample.y.toFixed(1)} gap ${gap} grown ${left} once ${right}`)
    assert.ok(right[3] >= 80, `${name} sample missed the stroke at ${sample.x.toFixed(1)},${sample.y.toFixed(1)} alpha ${right[3]}`)
  }
  return grown
}

// A constant-width highlighter used to bake each new segment as its own
// butt-capped path. At a 90° turn that disk sits off the centerline, outside
// the fillet one full path paints. These samples are that outside wedge.
const assertHighlighterCorner = () => {
  const cornerWidth = 400
  const cornerHeight = 400
  const leg = 16
  const cornerPoints = []
  for (let index = 0; index <= leg; index += 1) {
    cornerPoints.push({ x: (40 + index * 10) / cornerWidth, y: 180 / cornerHeight, pressure: 0.6 })
  }
  for (let index = 1; index <= leg; index += 1) {
    cornerPoints.push({ x: (40 + leg * 10) / cornerWidth, y: (180 + index * 10) / cornerHeight, pressure: 0.6 })
  }
  const build = (pts) => highlighter(pts)
  const args = (stroke) => ({
    stroke,
    pageWidth: cornerWidth,
    pageHeight: cornerHeight,
    smoothing,
    sourceWidth: cornerWidth,
    layoutWidth: cornerWidth,
    originX: 0,
    originY: 0,
  })
  const target = createInkReadbackContext(cornerWidth, cornerHeight)
  let session = null
  let segmentPaints = 0
  for (let count = 1; count <= cornerPoints.length; count += 1) {
    const painted = paintGrowingTranslucentStroke({
      ...args(build(cornerPoints.slice(0, count))),
      session,
      target,
      replace: count === 1,
      settle: count === cornerPoints.length,
    })
    session = painted.session
    segmentPaints = painted.segmentPaints
  }
  const referenceTarget = createInkReadbackContext(cornerWidth, cornerHeight)
  compositeTranslucentStrokeOnce({ ...args(build(cornerPoints)), target: referenceTarget })
  const grownImage = target.getImageData()
  const referenceImage = referenceTarget.getImageData()
  const cx = cornerPoints[leg].x * cornerWidth
  const cy = cornerPoints[leg].y * cornerHeight
  const outside = [[8, -8], [6, -8], [8, -6], [10, -4], [4, -10]]
  for (const [dx, dy] of outside) {
    const x = cx + dx
    const y = cy + dy
    assert.ok(Math.hypot(dx, dy) > 4, 'corner sample must leave the centerline')
    const left = pixel(grownImage, x, y)
    const right = pixel(referenceImage, x, y)
    const gap = channelGap(left, right)
    assert.ok(gap <= 3, `highlighter corner off-center ${x.toFixed(1)},${y.toFixed(1)} gap ${gap} grown ${left} once ${right}`)
  }
  const legX = cornerPoints[8].x * cornerWidth
  const legY = cornerPoints[8].y * cornerHeight - 6
  const legGrown = pixel(grownImage, legX, legY)
  const legOnce = pixel(referenceImage, legX, legY)
  assert.ok(channelGap(legGrown, legOnce) <= 3, `highlighter leg off-center gap grown ${legGrown} once ${legOnce}`)
  assert.ok(legOnce[3] >= 80, `highlighter leg sample missed the stroke alpha ${legOnce[3]}`)
  assert.ok(segmentPaints <= 4 * cornerPoints.length, `highlighter corner segment paints ${segmentPaints}`)
  return segmentPaints
}

try {
  const markerGrown = assertSettled('marker', marker, markerPoints)
  const highlighterGrown = assertSettled('highlighter', highlighter, highlighterPoints)
  assertHighlighterCorner()
  const line = `points>=${markerGrown.points} segmentPaints<=${markerGrown.segmentPaints} settled=match`
  assert.match(line, /^points>=(\d+) segmentPaints<=(\d+) settled=match$/u)
  const paints = Number(line.match(/segmentPaints<=(\d+)/u)[1])
  const points = Number(line.match(/points>=(\d+)/u)[1])
  assert.ok(points >= 100)
  assert.ok(paints <= 4 * points)
  assert.ok(highlighterGrown.segmentPaints <= 4 * highlighterGrown.points)
  console.log(line)
} finally {
  await server.close()
}
