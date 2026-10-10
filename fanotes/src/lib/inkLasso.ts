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
