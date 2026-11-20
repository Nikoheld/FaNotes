import { strokePointBounds } from './strokeBounds'
import {
  cutPageStroke,
  distanceToSegment,
  type InkPieceStroke,
} from './inkPieces'

export type ToolErasePoint = { x: number; y: number }

export type ToolEraseStroke = InkPieceStroke

const visibleHalfWidth = (stroke: ToolEraseStroke) => Math.max(0, stroke.baseWidth / 2)

/** True only when the eraser disk meets the ink, not merely its bounding box. */
export const strokeTouchesEraser = (
  stroke: ToolEraseStroke,
  paperX: number,
  paperY: number,
  radius: number,
  sourceWidth: number,
  sourceHeight: number,
) => {
  const points = stroke.points
  if (!points.length || radius < 0 || sourceWidth < 1 || sourceHeight < 1) return false
  const reach = radius + visibleHalfWidth(stroke)
  const padding = visibleHalfWidth(stroke)
  let left = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  for (const point of points) {
    const px = point.x * sourceWidth
    const py = point.y * sourceHeight
    left = Math.min(left, px - padding)
    right = Math.max(right, px + padding)
    top = Math.min(top, py - padding)
    bottom = Math.max(bottom, py + padding)
  }
  if (
    paperX + radius < left
    || paperX - radius > right
    || paperY + radius < top
    || paperY - radius > bottom
  ) return false
  if (points.length === 1) {
    return Math.hypot(points[0].x * sourceWidth - paperX, points[0].y * sourceHeight - paperY) <= reach
  }
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]
    const point = points[index]
    if (distanceToSegment(
      paperX,
      paperY,
      previous.x * sourceWidth,
      previous.y * sourceHeight,
      point.x * sourceWidth,
      point.y * sourceHeight,
    ) <= reach) return true
  }
  return false
}

const eraserPath = (
  samples: readonly ToolErasePoint[],
  sourceWidth: number,
  sourceHeight: number,
) => {
  const path: Array<{ x: number; y: number }> = []
  for (const sample of samples) {
    if (!Number.isFinite(sample.x) || !Number.isFinite(sample.y)) continue
    const next = { x: sample.x * sourceWidth, y: sample.y * sourceHeight }
    const previous = path[path.length - 1]
    if (previous && Math.hypot(next.x - previous.x, next.y - previous.y) < 0.4) continue
    path.push(next)
  }
  return path
}

const boundsOverlap = (
  left: number,
  top: number,
  right: number,
  bottom: number,
  otherLeft: number,
  otherTop: number,
  otherRight: number,
  otherBottom: number,
) => right >= otherLeft && left <= otherRight && bottom >= otherTop && top <= otherBottom

/**
 * Strictly local eraser: cuts away only the ink within the eraser's reach
 * (radius plus half the stroke width) along its path, at the page's scale.
 * Nothing else is removed or widened.
 */
export const applyToolErase = <T extends ToolEraseStroke>(
  strokes: T[],
  samples: readonly ToolErasePoint[],
  radius: number,
  sourceWidth: number,
  sourceHeight: number,
): T[] => {
  if (!strokes.length || !samples.length || radius < 0 || sourceWidth < 1 || sourceHeight < 1) return strokes
  const path = eraserPath(samples, sourceWidth, sourceHeight)
  if (!path.length) return strokes

  let pathLeft = Number.POSITIVE_INFINITY
  let pathTop = Number.POSITIVE_INFINITY
  let pathRight = Number.NEGATIVE_INFINITY
  let pathBottom = Number.NEGATIVE_INFINITY
  for (const point of path) {
    pathLeft = Math.min(pathLeft, point.x)
    pathTop = Math.min(pathTop, point.y)
    pathRight = Math.max(pathRight, point.x)
    pathBottom = Math.max(pathBottom, point.y)
  }

  // Cached bounds per stroke: reading every sample of every stroke on each
  // eraser move cost about 0.3 s per drag on a 320k-sample note. A stroke
  // whose bounds, grown by the eraser's reach, miss the path is not read at all.
  const near: T[] = []
  for (const stroke of strokes) {
    if (!stroke.points.length) continue
    const bounds = strokePointBounds(stroke.points)
    const left = bounds.minX * sourceWidth
    const top = bounds.minY * sourceHeight
    const right = bounds.maxX * sourceWidth
    const bottom = bounds.maxY * sourceHeight
    const pad = radius + visibleHalfWidth(stroke) + 1
    if (boundsOverlap(left, top, right, bottom, pathLeft - pad, pathTop - pad, pathRight + pad, pathBottom + pad)) {
      near.push(stroke)
    }
  }
  if (!near.length) return strokes

  // Strictly local: only the ink inside the eraser's reach is cut away. No
  // letter, dot or neighbouring-word grouping widens the erased area.
  const nearSet = new Set<T>(near)
  let changed = false
  const next: T[] = []
  for (const stroke of strokes) {
    if (!nearSet.has(stroke)) {
      next.push(stroke)
      continue
    }
    const reach = radius + visibleHalfWidth(stroke)
    const pieces = cutPageStroke(stroke, sourceWidth, sourceHeight, path, reach)
    if (!pieces) {
      next.push(stroke)
      continue
    }
    changed = true
    next.push(...pieces)
  }
  return changed ? next : strokes
}

export type EraserMode = 'area' | 'stroke'

export const readEraserMode = (value: unknown): EraserMode => (value === 'stroke' ? 'stroke' : 'area')

/**
 * Stroke eraser: every stroke the eraser disk touches along its path goes away
 * whole. Strokes the path misses keep their identity, so incremental paint
 * paths stay valid.
 */
export const applyStrokeErase = <T extends ToolEraseStroke>(
  strokes: T[],
  samples: readonly ToolErasePoint[],
  radius: number,
  sourceWidth: number,
  sourceHeight: number,
): T[] => {
  if (!strokes.length || !samples.length || radius < 0 || sourceWidth < 1 || sourceHeight < 1) return strokes
  const path = eraserPath(samples, sourceWidth, sourceHeight)
  if (!path.length) return strokes
  // Probe points along the path, dense enough that no stroke slips between two.
  const step = Math.max(1, radius * 0.5)
  const probes: Array<{ x: number; y: number }> = [path[0]]
  for (let index = 1; index < path.length; index += 1) {
    const from = path[index - 1]
    const to = path[index]
    const count = Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / step)
    for (let at = 1; at <= count; at += 1) {
      probes.push({ x: from.x + (to.x - from.x) * at / count, y: from.y + (to.y - from.y) * at / count })
    }
  }
  let left = Number.POSITIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  for (const point of path) {
    left = Math.min(left, point.x)
    top = Math.min(top, point.y)
    right = Math.max(right, point.x)
    bottom = Math.max(bottom, point.y)
  }
  let changed = false
  const next: T[] = []
  for (const stroke of strokes) {
    if (!stroke.points.length) {
      next.push(stroke)
      continue
    }
    const bounds = strokePointBounds(stroke.points)
    const pad = radius + visibleHalfWidth(stroke) + 1
    if (!boundsOverlap(
      bounds.minX * sourceWidth, bounds.minY * sourceHeight, bounds.maxX * sourceWidth, bounds.maxY * sourceHeight,
      left - pad, top - pad, right + pad, bottom + pad,
    )) {
      next.push(stroke)
      continue
    }
    if (probes.some((probe) => strokeTouchesEraser(stroke, probe.x, probe.y, radius, sourceWidth, sourceHeight))) {
      changed = true
      continue
    }
    next.push(stroke)
  }
  return changed ? next : strokes
}
