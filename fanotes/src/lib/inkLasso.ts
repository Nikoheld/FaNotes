/** Freehand lasso over normalised ink points. One call is one undo step. */

export type LassoPoint = { x: number; y: number }

export type LassoStroke = {
  points: LassoPoint[]
  color?: string
}

export type LassoAction = 'delete' | 'move' | 'copy' | 'recolor'

export const pointInPolygon = (point: LassoPoint, polygon: readonly LassoPoint[]) => {
  if (polygon.length < 3) return false
  let inside = false
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const current = polygon[index]
    const before = polygon[previous]
    const crosses = (current.y > point.y) !== (before.y > point.y)
    if (!crosses) continue
    const x = ((before.x - current.x) * (point.y - current.y)) / ((before.y - current.y) || 1e-9) + current.x
    if (point.x < x) inside = !inside
  }
  return inside
}

export const strokeMostlyInside = (stroke: LassoStroke, polygon: readonly LassoPoint[]) => {
  if (!stroke.points.length || polygon.length < 3) return false
  let inside = 0
  for (const point of stroke.points) if (pointInPolygon(point, polygon)) inside += 1
  return inside / stroke.points.length >= 0.5
}

export const strokesInsideLasso = <T extends LassoStroke>(strokes: readonly T[], polygon: readonly LassoPoint[]) => (
  strokes.flatMap((stroke, index) => (strokeMostlyInside(stroke, polygon) ? [index] : []))
)

const LOOP_EPS = 1e-10

const orient = (a: LassoPoint, b: LassoPoint, c: LassoPoint) => (
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
)

const pointOnSegment = (a: LassoPoint, b: LassoPoint, point: LassoPoint) => (
  Math.abs(orient(a, b, point)) <= LOOP_EPS
  && point.x <= Math.max(a.x, b.x) + LOOP_EPS
  && point.x >= Math.min(a.x, b.x) - LOOP_EPS
  && point.y <= Math.max(a.y, b.y) + LOOP_EPS
  && point.y >= Math.min(a.y, b.y) - LOOP_EPS
)

/** True when the segments cross, touch at an endpoint, or overlap. */
export const segmentsIntersect = (a: LassoPoint, b: LassoPoint, c: LassoPoint, d: LassoPoint) => {
  const o1 = orient(a, b, c)
  const o2 = orient(a, b, d)
  const o3 = orient(c, d, a)
  const o4 = orient(c, d, b)
  if (Math.abs(o1) <= LOOP_EPS && pointOnSegment(a, b, c)) return true
  if (Math.abs(o2) <= LOOP_EPS && pointOnSegment(a, b, d)) return true
  if (Math.abs(o3) <= LOOP_EPS && pointOnSegment(c, d, a)) return true
  if (Math.abs(o4) <= LOOP_EPS && pointOnSegment(c, d, b)) return true
  return (o1 > LOOP_EPS) !== (o2 > LOOP_EPS) && (o3 > LOOP_EPS) !== (o4 > LOOP_EPS)
}

const loopBounds = (points: readonly LassoPoint[]) => {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const point of points) {
    if (point.x < minX) minX = point.x
    if (point.y < minY) minY = point.y
    if (point.x > maxX) maxX = point.x
    if (point.y > maxY) maxY = point.y
  }
  return { minX, minY, maxX, maxY }
}

/**
 * The select loop is closed: the last point connects back to the first.
 * A stroke is hit when any of it lies inside that loop or meets the line,
 * including a crossing that has no vertex inside. A majority is not required.
 */
export const strokeMeetsLoop = (stroke: LassoStroke, polygon: readonly LassoPoint[]) => {
  if (polygon.length < 3 || !stroke.points.length) return false
  const loop = loopBounds(polygon)
  const ink = loopBounds(stroke.points)
  if (ink.maxX < loop.minX || loop.maxX < ink.minX || ink.maxY < loop.minY || loop.maxY < ink.minY) return false
  const edgeCount = polygon.length
  for (const point of stroke.points) {
    if (pointInPolygon(point, polygon)) return true
    for (let edge = 0; edge < edgeCount; edge += 1) {
      if (pointOnSegment(polygon[edge], polygon[(edge + 1) % edgeCount], point)) return true
    }
  }
  for (let index = 0; index < stroke.points.length - 1; index += 1) {
    const start = stroke.points[index]
    const end = stroke.points[index + 1]
    const minX = Math.min(start.x, end.x)
    const maxX = Math.max(start.x, end.x)
    const minY = Math.min(start.y, end.y)
    const maxY = Math.max(start.y, end.y)
    for (let edge = 0; edge < edgeCount; edge += 1) {
      const from = polygon[edge]
      const to = polygon[(edge + 1) % edgeCount]
      if (maxX < Math.min(from.x, to.x) || Math.max(from.x, to.x) < minX) continue
      if (maxY < Math.min(from.y, to.y) || Math.max(from.y, to.y) < minY) continue
      if (segmentsIntersect(start, end, from, to)) return true
    }
  }
  return false
}

export const strokesTouchingLasso = <T extends LassoStroke>(strokes: readonly T[], polygon: readonly LassoPoint[]) => (
  strokes.flatMap((stroke, index) => (strokeMeetsLoop(stroke, polygon) ? [index] : []))
)

/** A click or a tiny jitter is not a loop. A long thin stroke still counts. */
export const loopIsDrawable = (polygon: readonly LassoPoint[]) => {
  if (polygon.length < 3) return false
  const box = loopBounds(polygon)
  return box.maxX - box.minX >= 0.012 || box.maxY - box.minY >= 0.012
}

/** Keeps the freehand path, dropping samples that sit on the previous point. */
export const appendLoopPoint = (loop: readonly LassoPoint[], point: LassoPoint, limit = 720): LassoPoint[] => {
  const last = loop[loop.length - 1]
  if (last && (point.x - last.x) ** 2 + (point.y - last.y) ** 2 < 0.0015 ** 2) return loop as LassoPoint[]
  if (loop.length >= limit) return loop as LassoPoint[]
  return [...loop, { x: point.x, y: point.y }]
}

const shiftPoint = (point: LassoPoint, dx: number, dy: number): LassoPoint => ({
  ...point,
  x: point.x + dx,
  y: point.y + dy,
})

export const applyLasso = <T extends LassoStroke>(
  strokes: readonly T[],
  indexes: readonly number[],
  action: LassoAction,
  options: { dx?: number; dy?: number; color?: string } = {},
): T[] => {
  const selected = new Set(indexes)
  if (action === 'delete') return strokes.filter((_, index) => !selected.has(index))
  if (action === 'recolor') {
    const color = options.color || '#202333'
    return strokes.map((stroke, index) => (selected.has(index) ? { ...stroke, color } : stroke))
  }
  const dx = options.dx ?? 0
  const dy = options.dy ?? 0
  if (action === 'move') {
    return strokes.map((stroke, index) => (
      selected.has(index)
        ? { ...stroke, points: stroke.points.map((point) => shiftPoint(point, dx, dy)) }
        : stroke
    ))
  }
  const copies = strokes.flatMap((stroke, index) => (
    selected.has(index)
      ? [{ ...stroke, points: stroke.points.map((point) => shiftPoint(point, dx || 0.03, dy || 0.03)) }]
      : []
  ))
  return [...strokes, ...copies]
}
