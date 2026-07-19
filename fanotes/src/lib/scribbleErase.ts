import type { Stroke } from '../../../src/types'

type PixelPoint = { x: number; y: number }

type PixelBounds = {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

export type ScribbleEraseMatch = {
  indexes: number[]
  intersectionCount: number
  reversalCount: number
  pathRatio: number
  rect: { x: number; y: number; width: number; height: number }
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

const pixelPoints = (stroke: Stroke, width: number, height: number): PixelPoint[] => stroke.points.map((point) => ({
  x: point.x * width,
  y: point.y * height,
}))

const boundsForPoints = (points: PixelPoint[], padding = 0): PixelBounds | null => {
  if (!points.length) return null
  const left = Math.min(...points.map((point) => point.x)) - padding
  const top = Math.min(...points.map((point) => point.y)) - padding
  const right = Math.max(...points.map((point) => point.x)) + padding
  const bottom = Math.max(...points.map((point) => point.y)) + padding
  return {
    left,
    top,
    right,
    bottom,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  }
}

const strokeBounds = (stroke: Stroke, width: number, height: number) => (
  boundsForPoints(pixelPoints(stroke, width, height), Math.max(1, stroke.baseWidth / 2))
)

const boundsOverlap = (left: PixelBounds, right: PixelBounds) => left.right >= right.left
  && left.left <= right.right
  && left.bottom >= right.top
  && left.top <= right.bottom

const pointToSegmentDistance = (
  point: PixelPoint,
  start: PixelPoint,
  end: PixelPoint,
) => {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const lengthSquared = dx * dx + dy * dy
  if (!lengthSquared) return Math.hypot(point.x - start.x, point.y - start.y)
  const amount = clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared, 0, 1)
  return Math.hypot(point.x - (start.x + amount * dx), point.y - (start.y + amount * dy))
}

const direction = (a: PixelPoint, b: PixelPoint, c: PixelPoint) => (
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
)

const segmentsIntersect = (a: PixelPoint, b: PixelPoint, c: PixelPoint, d: PixelPoint) => {
  const first = direction(a, b, c)
  const second = direction(a, b, d)
  const third = direction(c, d, a)
  const fourth = direction(c, d, b)
  return ((first > 0 && second < 0) || (first < 0 && second > 0))
    && ((third > 0 && fourth < 0) || (third < 0 && fourth > 0))
}

const segmentDistance = (a: PixelPoint, b: PixelPoint, c: PixelPoint, d: PixelPoint) => segmentsIntersect(a, b, c, d)
  ? 0
  : Math.min(
    pointToSegmentDistance(a, c, d),
    pointToSegmentDistance(b, c, d),
    pointToSegmentDistance(c, a, b),
    pointToSegmentDistance(d, a, b),
  )

const simplifyPoints = (points: PixelPoint[], minimumDistance = 1.6) => {
  if (points.length <= 2) return points
  const simplified = [points[0]]
  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = simplified.at(-1)!
    if (Math.hypot(points[index].x - previous.x, points[index].y - previous.y) >= minimumDistance) {
      simplified.push(points[index])
    }
  }
  const last = points.at(-1)!
  if (last !== simplified.at(-1)) simplified.push(last)
  return simplified
}

const pathLength = (points: PixelPoint[]) => points.slice(1).reduce((sum, point, index) => (
  sum + Math.hypot(point.x - points[index].x, point.y - points[index].y)
), 0)

const horizontalReversals = (points: PixelPoint[], span: number) => {
  if (points.length < 4) return 0
  const minimumExcursion = Math.max(7, span * 0.105)
  let directionSign = 0
  let anchorX = points[0].x
  let extremeX = anchorX
  let reversals = 0
  for (let index = 1; index < points.length; index += 1) {
    const delta = points[index].x - points[index - 1].x
    if (Math.abs(delta) < 0.7) continue
    const nextSign = Math.sign(delta)
    if (!directionSign) {
      directionSign = nextSign
      extremeX = points[index].x
      continue
    }
    if (nextSign === directionSign) {
      extremeX = directionSign > 0
        ? Math.max(extremeX, points[index].x)
        : Math.min(extremeX, points[index].x)
      continue
    }
    if (Math.abs(extremeX - anchorX) >= minimumExcursion) {
      reversals += 1
      anchorX = extremeX
      directionSign = nextSign
      extremeX = points[index].x
    }
  }
  return reversals
}

const selfIntersectionCount = (points: PixelPoint[]) => {
  let intersections = 0
  for (let first = 1; first < points.length; first += 1) {
    for (let second = first + 3; second < points.length; second += 1) {
      if (first === 1 && second === points.length - 1) continue
      if (segmentsIntersect(points[first - 1], points[first], points[second - 1], points[second])) {
        intersections += 1
        if (intersections >= 12) return intersections
      }
    }
  }
  return intersections
}

const collisionRuns = (
  gesture: PixelPoint[],
  target: PixelPoint[],
  threshold: number,
) => {
  if (!gesture.length || !target.length) return 0
  if (target.length === 1) {
    return gesture.slice(1).some((point, index) => (
      pointToSegmentDistance(target[0], gesture[index], point) <= threshold
    )) ? 1 : 0
  }
  let runs = 0
  let exactCrossings = 0
  let colliding = false
  for (let gestureIndex = 1; gestureIndex < gesture.length; gestureIndex += 1) {
    let crossing = false
    const hit = target.slice(1).some((point, targetIndex) => {
      if (segmentsIntersect(gesture[gestureIndex - 1], gesture[gestureIndex], target[targetIndex], point)) {
        crossing = true
        return true
      }
      return segmentDistance(
        gesture[gestureIndex - 1],
        gesture[gestureIndex],
        target[targetIndex],
        point,
      ) <= threshold
    })
    if (crossing) exactCrossings += 1
    if (hit && !colliding) runs += 1
    colliding = hit
  }
  return Math.max(runs, exactCrossings)
}

/**
 * Detects the deliberate “scribble over ink” gesture used by pen-first note apps.
 * Geometry is evaluated in page pixels so Windows Ink, Wayland and mouse input
 * share the exact same thresholds. A match is returned only when the gesture is
 * dense, reverses horizontally several times and actually crosses existing ink.
 */
export const detectScribbleErase = <TStroke extends Stroke>(
  gesture: TStroke,
  existing: TStroke[],
  page: { width: number; height: number },
  sensitivity = 50,
): ScribbleEraseMatch | null => {
  const normalizedSensitivity = Number.isFinite(sensitivity)
    ? clamp(sensitivity, 0, 100) / 100
    : 0.5
  const minimumLength = 110 - normalizedSensitivity * 48
  const minimumLengthRatio = 3.05 - normalizedSensitivity * 1.2
  const minimumPathRatio = 3 - normalizedSensitivity * 1.2
  const minimumReversals = Math.round(4 - normalizedSensitivity * 2)
  const minimumIntersections = Math.round(4 - normalizedSensitivity * 2)
  if (page.width <= 0 || page.height <= 0 || gesture.points.length < 8 || !existing.length) return null
  const gesturePoints = simplifyPoints(pixelPoints(gesture, page.width, page.height))
  if (gesturePoints.length < 7) return null
  const gestureBounds = boundsForPoints(gesturePoints)
  if (!gestureBounds || gestureBounds.width < 32 || gestureBounds.height < 3) return null
  if (gestureBounds.width < gestureBounds.height * 1.18 || gestureBounds.height > Math.max(82, gestureBounds.width * 0.82)) return null

  const length = pathLength(gesturePoints)
  const diagonal = Math.hypot(gestureBounds.width, gestureBounds.height)
  const pathRatio = diagonal ? length / diagonal : 0
  const reversalCount = horizontalReversals(gesturePoints, gestureBounds.width)
  const selfIntersections = selfIntersectionCount(gesturePoints)
  if (
    length < Math.max(minimumLength, gestureBounds.width * minimumLengthRatio)
    || pathRatio < minimumPathRatio
    || reversalCount < minimumReversals
  ) return null
  if (
    selfIntersections < 1
    && (reversalCount < minimumReversals + 1 || pathRatio < minimumPathRatio + 0.5)
  ) return null

  const collisionPadding = Math.max(5, gesture.baseWidth / 2 + 3)
  const collisionBounds: PixelBounds = {
    left: gestureBounds.left - collisionPadding,
    top: gestureBounds.top - collisionPadding,
    right: gestureBounds.right + collisionPadding,
    bottom: gestureBounds.bottom + collisionPadding,
    width: gestureBounds.width + collisionPadding * 2,
    height: gestureBounds.height + collisionPadding * 2,
  }
  const existingBounds = existing.map((stroke) => strokeBounds(stroke, page.width, page.height))
  const touched = new Map<number, number>()
  existing.forEach((stroke, index) => {
    const bounds = existingBounds[index]
    if (!bounds || !boundsOverlap(bounds, collisionBounds)) return
    const runs = collisionRuns(
      gesturePoints,
      simplifyPoints(pixelPoints(stroke, page.width, page.height)),
      collisionPadding + stroke.baseWidth / 2,
    )
    if (runs) touched.set(index, runs)
  })
  const intersectionCount = [...touched.values()].reduce((sum, runs) => sum + runs, 0)
  if (!touched.size || intersectionCount < minimumIntersections && touched.size < 2) return null

  const touchedBounds = [...touched.keys()]
    .map((index) => existingBounds[index])
    .filter((bounds): bounds is PixelBounds => Boolean(bounds))
  const seedTop = Math.min(gestureBounds.top, ...touchedBounds.map((bounds) => bounds.top))
  const seedBottom = Math.max(gestureBounds.bottom, ...touchedBounds.map((bounds) => bounds.bottom))
  const verticalPadding = Math.max(14, Math.min(30, gestureBounds.height * 0.85))
  const horizontalPadding = Math.max(5, Math.min(14, gestureBounds.height * 0.35))
  const deletionBounds: PixelBounds = {
    left: gestureBounds.left - horizontalPadding,
    right: gestureBounds.right + horizontalPadding,
    top: seedTop - verticalPadding,
    bottom: seedBottom + verticalPadding,
    width: gestureBounds.width + horizontalPadding * 2,
    height: seedBottom - seedTop + verticalPadding * 2,
  }
  const indexes = existingBounds.flatMap((bounds, index) => {
    if (!bounds || !boundsOverlap(bounds, deletionBounds)) return []
    const horizontalOverlap = Math.min(bounds.right, gestureBounds.right + horizontalPadding)
      - Math.max(bounds.left, gestureBounds.left - horizontalPadding)
    if (horizontalOverlap < 0) return []
    return [index]
  })
  if (!indexes.length) return null

  return {
    indexes,
    intersectionCount,
    reversalCount,
    pathRatio,
    rect: {
      x: clamp(deletionBounds.left / page.width, 0, 1),
      y: clamp(deletionBounds.top / page.height, 0, 1),
      width: clamp(deletionBounds.width / page.width, 0, 1),
      height: clamp(deletionBounds.height / page.height, 0, 1),
    },
  }
}
