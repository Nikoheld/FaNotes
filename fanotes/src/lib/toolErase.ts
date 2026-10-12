import {
  cutPageStroke,
  distanceToPath,
  distanceToSegment,
  pixelsOf,
  planInkPieces,
  rangeHitsPath,
  sliceStroke,
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
 * Removes the letter the eraser actually touches.
 * A dot or crossbar goes with its letter. Neighbouring letters stay, even
 * when they share a pen stroke. A long straight mark loses only the span
 * under the eraser.
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

  const near: T[] = []
  for (const stroke of strokes) {
    if (!stroke.points.length) continue
    const pixels = pixelsOf(stroke.points, sourceWidth, sourceHeight)
    let left = Number.POSITIVE_INFINITY
    let top = Number.POSITIVE_INFINITY
    let right = Number.NEGATIVE_INFINITY
    let bottom = Number.NEGATIVE_INFINITY
    for (const pixel of pixels) {
      left = Math.min(left, pixel.x)
      top = Math.min(top, pixel.y)
      right = Math.max(right, pixel.x)
      bottom = Math.max(bottom, pixel.y)
    }
    const pad = radius + visibleHalfWidth(stroke) + 96
    if (boundsOverlap(left, top, right, bottom, pathLeft - pad, pathTop - pad, pathRight + pad, pathBottom + pad)) {
      near.push(stroke)
    }
  }
  if (!near.length) return strokes

  const pieces = planInkPieces(near, sourceWidth, sourceHeight)
  const removeGroup = new Set<number>()
  const cutPiece = new Set<(typeof pieces)[number]>()
  for (const piece of pieces) {
    const pixels = pixelsOf(piece.stroke.points, sourceWidth, sourceHeight)
    const reach = radius + visibleHalfWidth(piece.stroke)
    const hit = rangeHitsPath(pixels, piece.start, piece.end, reach, path)
      || (piece.start === piece.end && distanceToPath(pixels[piece.start], path) <= reach)
    if (!hit) continue
    if (piece.kind === 'long') cutPiece.add(piece)
    else removeGroup.add(piece.group)
  }
  if (!removeGroup.size && !cutPiece.size) return strokes

  const byStroke = new Map<T, typeof pieces>()
  for (const piece of pieces) {
    const list = byStroke.get(piece.stroke)
    if (list) list.push(piece)
    else byStroke.set(piece.stroke, [piece])
  }

  let changed = false
  const next: T[] = []
  for (const stroke of strokes) {
    const mine = byStroke.get(stroke)
    if (!mine) {
      next.push(stroke)
      continue
    }
    const dropped = mine.some((piece) => piece.kind !== 'long' && removeGroup.has(piece.group))
    const cut = mine.some((piece) => cutPiece.has(piece))
    if (!dropped && !cut) {
      next.push(stroke)
      continue
    }
    changed = true
    const pixels = pixelsOf(stroke.points, sourceWidth, sourceHeight)
    const reach = radius + visibleHalfWidth(stroke)
    for (const piece of mine) {
      if (piece.kind !== 'long' && removeGroup.has(piece.group)) continue
      if (piece.kind === 'long' && cutPiece.has(piece)) {
        const letterWidth = piece.bounds.height >= 14 ? Math.max(32, piece.bounds.height * 1.15) : 0
        next.push(...cutPageStroke(stroke, pixels, path, reach, letterWidth, piece.start, piece.end))
        continue
      }
      next.push(sliceStroke(stroke, piece.start, piece.end))
    }
  }
  return changed ? next : strokes
}
