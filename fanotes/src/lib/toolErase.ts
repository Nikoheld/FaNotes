export type ToolErasePoint = { x: number; y: number }

export type ToolEraseStroke = {
  points: ToolErasePoint[]
  baseWidth: number
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value))

const distanceToSegment = (
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
) => {
  const dx = bx - ax
  const dy = by - ay
  if (dx === 0 && dy === 0) return Math.hypot(px - ax, py - ay)
  const t = clamp01(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

const visibleHalfWidth = (stroke: ToolEraseStroke) => Math.max(0, stroke.baseWidth / 2)

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

export const applyToolErase = <T extends ToolEraseStroke>(
  strokes: T[],
  samples: ToolErasePoint[],
  radius: number,
  sourceWidth: number,
  sourceHeight: number,
): T[] => {
  if (!strokes.length || !samples.length) return strokes
  const eraserPoints = samples
    .filter((sample) => Number.isFinite(sample.x) && Number.isFinite(sample.y))
    .map((sample) => ({ x: sample.x * sourceWidth, y: sample.y * sourceHeight }))
  if (!eraserPoints.length) return strokes
  const kept = strokes.filter((stroke) => !eraserPoints.some((point) => (
    strokeTouchesEraser(stroke, point.x, point.y, radius, sourceWidth, sourceHeight)
  )))
  return kept.length === strokes.length ? strokes : kept
}
