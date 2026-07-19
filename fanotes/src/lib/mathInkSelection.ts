import type { Stroke } from '../../../src/types'

export type InkSelectionRect = {
  x: number
  y: number
  width: number
  height: number
}

export type MathInkSelection<TStroke extends Stroke = Stroke> = {
  indexes: number[]
  strokes: TStroke[]
  rect: InkSelectionRect
}

export type MathInkLine<TStroke extends Stroke = Stroke> = {
  strokes: TStroke[]
  indexes: number[]
  rect: InkSelectionRect
}

type PixelBounds = {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
  centerX: number
  centerY: number
}

const gap = (firstStart: number, firstEnd: number, secondStart: number, secondEnd: number) => (
  Math.max(0, Math.max(firstStart, secondStart) - Math.min(firstEnd, secondEnd))
)

const boundsFor = (stroke: Stroke, width: number, height: number): PixelBounds | null => {
  if (!stroke.points.length) return null
  const padding = Math.max(1, stroke.baseWidth / 2)
  const left = Math.min(...stroke.points.map((point) => point.x * width)) - padding
  const right = Math.max(...stroke.points.map((point) => point.x * width)) + padding
  const top = Math.min(...stroke.points.map((point) => point.y * height)) - padding
  const bottom = Math.max(...stroke.points.map((point) => point.y * height)) + padding
  return {
    left,
    right,
    top,
    bottom,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
    centerX: (left + right) / 2,
    centerY: (top + bottom) / 2,
  }
}

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
  const lengthSquared = dx * dx + dy * dy
  if (!lengthSquared) return Math.hypot(px - ax, py - ay)
  const amount = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared))
  return Math.hypot(px - (ax + amount * dx), py - (ay + amount * dy))
}

const distanceToStroke = (stroke: Stroke, x: number, y: number, width: number, height: number) => {
  if (stroke.points.length === 1) {
    return Math.hypot(stroke.points[0].x * width - x, stroke.points[0].y * height - y)
  }
  return stroke.points.slice(1).reduce((closest, point, index) => {
    const previous = stroke.points[index]
    return Math.min(closest, distanceToSegment(
      x,
      y,
      previous.x * width,
      previous.y * height,
      point.x * width,
      point.y * height,
    ))
  }, Number.POSITIVE_INFINITY)
}

/**
 * A mathematical expression is a spatially connected component. Besides normal
 * horizontal neighbours, the relation deliberately includes vertically stacked
 * strokes so fractions, roots and super/subscripts stay in one selection.
 */
const related = (left: PixelBounds, right: PixelBounds) => {
  const horizontalGap = gap(left.left, left.right, right.left, right.right)
  const verticalGap = gap(left.top, left.bottom, right.top, right.bottom)
  const typicalHeight = Math.max(8, Math.min(55, (left.height + right.height) / 2))
  const largestHeight = Math.max(left.height, right.height)
  const horizontalNeighbour = horizontalGap <= Math.max(36, typicalHeight * 1.35)
    && verticalGap <= Math.max(10, typicalHeight * 0.42)
    && Math.abs(left.centerY - right.centerY) <= Math.max(15, largestHeight * 0.78)
  const longMathMark = (left.width >= typicalHeight * 1.5 || right.width >= typicalHeight * 1.5)
    && horizontalGap <= Math.max(18, typicalHeight * 0.62)
    && verticalGap <= Math.max(39, largestHeight * 1.7)
  return horizontalNeighbour || longMathMark
}

export const selectMathInkAtPoint = <TStroke extends Stroke>(
  strokes: TStroke[],
  point: { x: number; y: number },
  page: { width: number; height: number },
  hitRadius = 30,
): MathInkSelection<TStroke> | null => {
  if (!strokes.length || page.width <= 0 || page.height <= 0) return null
  const bounds = strokes.map((stroke) => boundsFor(stroke, page.width, page.height))
  const pixelX = point.x * page.width
  const pixelY = point.y * page.height
  let seed = -1
  let distance = Number.POSITIVE_INFINITY
  strokes.forEach((stroke, index) => {
    if (!bounds[index]) return
    const candidate = distanceToStroke(stroke, pixelX, pixelY, page.width, page.height)
    if (candidate < distance) {
      seed = index
      distance = candidate
    }
  })
  if (seed < 0 || distance > hitRadius) return null

  const selected = new Set([seed])
  const queue = [seed]
  while (queue.length) {
    const current = queue.shift()!
    const currentBounds = bounds[current]
    if (!currentBounds) continue
    bounds.forEach((candidate, index) => {
      if (!candidate || selected.has(index) || !related(currentBounds, candidate)) return
      selected.add(index)
      queue.push(index)
    })
  }

  const indexes = [...selected].sort((first, second) => first - second)
  const selectedBounds = indexes.map((index) => bounds[index]).filter((entry): entry is PixelBounds => Boolean(entry))
  const padding = 9
  const left = Math.max(0, Math.min(...selectedBounds.map((entry) => entry.left)) - padding)
  const top = Math.max(0, Math.min(...selectedBounds.map((entry) => entry.top)) - padding)
  const right = Math.min(page.width, Math.max(...selectedBounds.map((entry) => entry.right)) + padding)
  const bottom = Math.min(page.height, Math.max(...selectedBounds.map((entry) => entry.bottom)) + padding)
  return {
    indexes,
    strokes: indexes.map((index) => strokes[index]),
    rect: {
      x: left / page.width,
      y: top / page.height,
      width: Math.max(2, right - left) / page.width,
      height: Math.max(2, bottom - top) / page.height,
    },
  }
}

const aggregateBounds = (indexes: number[], bounds: Array<PixelBounds | null>): PixelBounds => {
  const selected = indexes.map((index) => bounds[index]).filter((entry): entry is PixelBounds => Boolean(entry))
  const left = Math.min(...selected.map((entry) => entry.left))
  const right = Math.max(...selected.map((entry) => entry.right))
  const top = Math.min(...selected.map((entry) => entry.top))
  const bottom = Math.max(...selected.map((entry) => entry.bottom))
  return {
    left,
    right,
    top,
    bottom,
    width: right - left,
    height: bottom - top,
    centerX: (left + right) / 2,
    centerY: (top + bottom) / 2,
  }
}

/** Groups a selected handwritten derivation into spatial rows without splitting fractions or scripts. */
export const groupMathInkLines = <TStroke extends Stroke>(
  strokes: TStroke[],
  page: { width: number; height: number },
): MathInkLine<TStroke>[] => {
  if (!strokes.length || page.width <= 0 || page.height <= 0) return []
  const bounds = strokes.map((stroke) => boundsFor(stroke, page.width, page.height))
  const remaining = new Set(strokes.map((_, index) => index).filter((index) => bounds[index]))
  const components: number[][] = []

  while (remaining.size) {
    const seed = remaining.values().next().value as number
    remaining.delete(seed)
    const component = [seed]
    const queue = [seed]
    while (queue.length) {
      const current = queue.shift()!
      for (const candidate of [...remaining]) {
        if (!related(bounds[current]!, bounds[candidate]!)) continue
        remaining.delete(candidate)
        component.push(candidate)
        queue.push(candidate)
      }
    }
    components.push(component)
  }

  const rows: Array<{ indexes: number[]; bounds: PixelBounds }> = []
  components
    .map((indexes) => ({ indexes, bounds: aggregateBounds(indexes, bounds) }))
    .sort((left, right) => left.bounds.centerY - right.bounds.centerY)
    .forEach((component) => {
      const matching = rows
        .map((row, index) => ({ row, index, distance: Math.abs(row.bounds.centerY - component.bounds.centerY) }))
        .filter(({ row, distance }) => distance <= Math.max(18, Math.min(row.bounds.height, component.bounds.height) * 0.68))
        .sort((left, right) => left.distance - right.distance)[0]
      if (!matching) {
        rows.push(component)
        return
      }
      matching.row.indexes.push(...component.indexes)
      matching.row.bounds = aggregateBounds(matching.row.indexes, bounds)
    })

  return rows
    .sort((left, right) => left.bounds.centerY - right.bounds.centerY)
    .map((row) => {
      const padding = 7
      const left = Math.max(0, row.bounds.left - padding)
      const top = Math.max(0, row.bounds.top - padding)
      const right = Math.min(page.width, row.bounds.right + padding)
      const bottom = Math.min(page.height, row.bounds.bottom + padding)
      const indexes = [...row.indexes].sort((first, second) => first - second)
      return {
        indexes,
        strokes: indexes.map((index) => strokes[index]),
        rect: {
          x: left / page.width,
          y: top / page.height,
          width: (right - left) / page.width,
          height: (bottom - top) / page.height,
        },
      }
    })
}
