/**
 * Bounds of a stroke's points (0–1 sheet space), kept per points array.
 *
 * Culling a repaint, fitting the page, and finding strokes near the eraser
 * used to read every point of every stroke. On a 320k-sample note that is a
 * few hundred milliseconds per scroll repaint, stroke end, undo, or eraser
 * move. A committed stroke's points do not move, so its bounds are computed
 * once and reused.
 *
 * Points can still move in place:
 * - a page grow or rescale moves every stored point: call
 *   `bumpInkGeometryEpoch()` after it, and every cached bound is recomputed;
 * - a live stroke gains samples or has its first or last sample replaced, and
 *   a section move shifts whole strokes: the cached count, first point, and
 *   last point no longer match, so that stroke is recomputed.
 */
export type StrokeBounds = {
  /** +Infinity / -Infinity for a stroke without points. */
  minX: number
  minY: number
  maxX: number
  maxY: number
}

type BoundsPoint = { x: number; y: number }

type Entry = StrokeBounds & {
  epoch: number
  length: number
  firstX: number
  firstY: number
  lastX: number
  lastY: number
}

let geometryEpoch = 0
const cache = new WeakMap<readonly BoundsPoint[], Entry>()

/** Call after moving stored points in place without changing their arrays. */
export const bumpInkGeometryEpoch = () => {
  geometryEpoch += 1
}

/** Changes whenever `bumpInkGeometryEpoch` runs. */
export const inkGeometryEpoch = () => geometryEpoch

const fresh = (entry: Entry, points: readonly BoundsPoint[]) => {
  if (entry.epoch !== geometryEpoch || entry.length !== points.length) return false
  if (points.length === 0) return true
  const first = points[0]
  const last = points[points.length - 1]
  return Object.is(entry.firstX, first.x) && Object.is(entry.firstY, first.y)
    && Object.is(entry.lastX, last.x) && Object.is(entry.lastY, last.y)
}

/** Comparisons skip a NaN coordinate, the same as the loops this replaces. */
export const strokePointBounds = (points: readonly BoundsPoint[]): StrokeBounds => {
  const cached = cache.get(points)
  if (cached && fresh(cached, points)) return cached
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const point of points) {
    const { x, y } = point
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  const first = points[0]
  const last = points[points.length - 1]
  const entry: Entry = {
    minX,
    minY,
    maxX,
    maxY,
    epoch: geometryEpoch,
    length: points.length,
    firstX: first ? first.x : Number.NaN,
    firstY: first ? first.y : Number.NaN,
    lastX: last ? last.x : Number.NaN,
    lastY: last ? last.y : Number.NaN,
  }
  cache.set(points, entry)
  return entry
}
