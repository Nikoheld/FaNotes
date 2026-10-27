import {
  pixelsOf,
  planInkPieces,
  sliceStroke,
  type InkPiece,
  type InkPieceStroke,
} from './inkPieces'

export type InkSelectRect = {
  x: number
  y: number
  width: number
  height: number
}

type PageRect = {
  left: number
  top: number
  right: number
  bottom: number
}

const pageRect = (rect: InkSelectRect, sourceWidth: number, sourceHeight: number): PageRect => ({
  left: rect.x * sourceWidth,
  top: rect.y * sourceHeight,
  right: (rect.x + rect.width) * sourceWidth,
  bottom: (rect.y + rect.height) * sourceHeight,
})

const pointInRect = (x: number, y: number, rect: PageRect, pad: number) => (
  x >= rect.left - pad
  && x <= rect.right + pad
  && y >= rect.top - pad
  && y <= rect.bottom + pad
)

const pieceSelected = <T extends InkPieceStroke>(
  piece: InkPiece<T>,
  sourceWidth: number,
  sourceHeight: number,
  rect: PageRect,
) => {
  const pixels = pixelsOf(piece.stroke.points, sourceWidth, sourceHeight)
  const pad = Math.max(0, piece.stroke.baseWidth / 2)
  let inside = 0
  const count = piece.end - piece.start + 1
  for (let index = piece.start; index <= piece.end; index += 1) {
    const pixel = pixels[index]
    if (pointInRect(pixel.x, pixel.y, rect, pad)) inside += 1
  }
  const ratio = inside / Math.max(1, count)
  const centerX = (piece.bounds.minX + piece.bounds.maxX) / 2
  const centerY = (piece.bounds.minY + piece.bounds.maxY) / 2
  return ratio >= 0.45 || (ratio >= 0.2 && pointInRect(centerX, centerY, rect, pad))
}

type Clip = { start: number; end: number; selected: boolean }

const clipsForLongPiece = <T extends InkPieceStroke>(
  piece: InkPiece<T>,
  sourceWidth: number,
  sourceHeight: number,
  rect: PageRect,
): Clip[] => {
  const pixels = pixelsOf(piece.stroke.points, sourceWidth, sourceHeight)
  const pad = Math.max(0, piece.stroke.baseWidth / 2)
  const count = piece.end - piece.start + 1
  const inside = Array.from({ length: count }, (_, offset) => {
    const pixel = pixels[piece.start + offset]
    return pointInRect(pixel.x, pixel.y, rect, pad)
  })
  const insideCount = inside.filter(Boolean).length
  if (!insideCount) return [{ start: piece.start, end: piece.end, selected: false }]
  if (insideCount / count >= 0.82) return [{ start: piece.start, end: piece.end, selected: true }]

  if (piece.bounds.height >= 14) {
    const letterWidth = Math.max(28, piece.bounds.height * 0.95)
    const runs: Array<[number, number]> = []
    let runStart = -1
    for (let index = 0; index < count; index += 1) {
      if (inside[index] && runStart < 0) runStart = index
      if ((!inside[index] || index === count - 1) && runStart >= 0) {
        const runEnd = inside[index] && index === count - 1 ? index : index - 1
        runs.push([runStart, runEnd])
        runStart = -1
      }
    }
    for (const [from, to] of runs) {
      let arc = 0
      for (let index = from + 1; index <= to; index += 1) {
        const previous = pixels[piece.start + index - 1]
        const current = pixels[piece.start + index]
        arc += Math.hypot(current.x - previous.x, current.y - previous.y)
      }
      if (arc < letterWidth * 0.22 && to - from < 2) {
        for (let index = from; index <= to; index += 1) inside[index] = false
        continue
      }
      let centerX = 0
      for (let index = from; index <= to; index += 1) centerX += pixels[piece.start + index].x
      centerX /= Math.max(1, to - from + 1)
      let walked = 0
      for (let index = from - 1; index >= 0; index -= 1) {
        const current = pixels[piece.start + index]
        const next = pixels[piece.start + index + 1]
        walked += Math.hypot(next.x - current.x, next.y - current.y)
        if (walked > letterWidth) break
        if (walked > letterWidth * 0.55 && Math.abs(current.x - centerX) > letterWidth * 0.55) break
        inside[index] = true
      }
      walked = 0
      for (let index = to + 1; index < count; index += 1) {
        const current = pixels[piece.start + index]
        const previous = pixels[piece.start + index - 1]
        walked += Math.hypot(current.x - previous.x, current.y - previous.y)
        if (walked > letterWidth) break
        if (walked > letterWidth * 0.55 && Math.abs(current.x - centerX) > letterWidth * 0.55) break
        inside[index] = true
      }
    }
  }

  if (!inside.some(Boolean)) return [{ start: piece.start, end: piece.end, selected: false }]
  const clips: Clip[] = []
  let start = 0
  let selected = inside[0]
  for (let index = 1; index < count; index += 1) {
    if (inside[index] === selected) continue
    const end = piece.start + index
    clips.push({ start: piece.start + start, end, selected })
    start = index
    selected = inside[index]
  }
  clips.push({ start: piece.start + start, end: piece.end, selected })
  return clips
}

/**
 * Selects the handwriting inside a rectangle.
 * A boxed letter moves as a whole, including its dot or crossbar.
 * A letter the rectangle only grazes stays put. Drawing strokes stay put.
 */
export const takeInkSelection = <T extends InkPieceStroke>(
  strokes: readonly T[],
  rect: InkSelectRect,
  sourceWidth: number,
  sourceHeight: number,
): { strokes: T[]; indexes: number[] } => {
  if (!strokes.length || rect.width <= 0 || rect.height <= 0 || sourceWidth < 1 || sourceHeight < 1) {
    return { strokes: strokes as T[], indexes: [] }
  }
  const bounds = pageRect(rect, sourceWidth, sourceHeight)
  const handwriting = strokes.filter((stroke) => stroke.purpose !== 'art' && stroke.points.length)
  const planned = planInkPieces(handwriting, sourceWidth, sourceHeight)
  const selectedGroups = new Set<number>()
  for (const piece of planned) {
    if (piece.kind === 'long') continue
    if (pieceSelected(piece, sourceWidth, sourceHeight, bounds)) selectedGroups.add(piece.group)
  }

  const byStroke = new Map<T, Array<InkPiece<T>>>()
  for (const piece of planned) {
    const list = byStroke.get(piece.stroke)
    if (list) list.push(piece)
    else byStroke.set(piece.stroke, [piece])
  }

  let changed = false
  const next: T[] = []
  const indexes: number[] = []
  for (const stroke of strokes) {
    if (stroke.purpose === 'art' || !stroke.points.length) {
      next.push(stroke)
      continue
    }
    const mine = byStroke.get(stroke)
    if (!mine) {
      next.push(stroke)
      continue
    }
    const chunks: Array<{ stroke: T; selected: boolean }> = []
    for (const piece of mine) {
      if (piece.kind === 'long') {
        const clips = clipsForLongPiece(piece, sourceWidth, sourceHeight, bounds)
        if (clips.length > 1) changed = true
        for (const clip of clips) {
          chunks.push({
            stroke: sliceStroke(stroke, clip.start, clip.end),
            selected: clip.selected,
          })
        }
        continue
      }
      const selected = selectedGroups.has(piece.group)
      const sliced = sliceStroke(stroke, piece.start, piece.end)
      if (sliced !== stroke) changed = true
      chunks.push({ stroke: sliced, selected })
    }
    if (chunks.every((chunk) => !chunk.selected)) {
      next.push(stroke)
      continue
    }
    if (chunks.length === 1 && chunks[0].stroke === stroke) {
      indexes.push(next.length)
      next.push(stroke)
      continue
    }
    changed = true
    for (const chunk of chunks) {
      if (chunk.selected) indexes.push(next.length)
      next.push(chunk.stroke)
    }
  }

  if (!indexes.length) return { strokes: strokes as T[], indexes: [] }
  if (!changed && next.length === strokes.length && next.every((stroke, index) => stroke === strokes[index])) {
    return { strokes: strokes as T[], indexes }
  }
  return { strokes: next, indexes }
}

export const boundsOfInkIndexes = <T extends InkPieceStroke>(
  strokes: readonly T[],
  indexes: readonly number[],
): InkSelectRect | null => {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const index of indexes) {
    const stroke = strokes[index]
    if (!stroke) continue
    for (const point of stroke.points) {
      minX = Math.min(minX, point.x)
      minY = Math.min(minY, point.y)
      maxX = Math.max(maxX, point.x)
      maxY = Math.max(maxY, point.y)
    }
  }
  if (!Number.isFinite(minX)) return null
  const padX = 10 / 900
  const padY = 10 / 1273
  return {
    x: minX - padX,
    y: minY - padY,
    width: Math.max(0.012, maxX - minX + padX * 2),
    height: Math.max(0.012, maxY - minY + padY * 2),
  }
}

type EditablePoint = { x: number; y: number }

type EditableStroke = { points: EditablePoint[] }

const clampRange = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

const movedPoint = <T extends EditablePoint>(point: T, x: number, y: number): T => ({
  ...point,
  x: clampRange(x, 0, 1),
  y: clampRange(y, 0, 8),
})

/** Shallow copy of the stroke list, the snapshot the edit gesture pushes before it changes ink. */
export const inkEditUndoSnapshot = <T>(strokes: readonly T[]): T[] => strokes.slice()

export const moveInkSelection = <T extends EditableStroke>(
  strokes: readonly T[],
  indexes: readonly number[],
  dx: number,
  dy: number,
): T[] => {
  const selected = new Set(indexes)
  return strokes.map((stroke, index) => (
    selected.has(index)
      ? { ...stroke, points: stroke.points.map((point) => movedPoint(point, point.x + dx, point.y + dy)) }
      : stroke
  ))
}

/** Scales selected points away from the anchor. Unselected strokes stay the same objects. */
export const scaleInkSelection = <T extends EditableStroke>(
  strokes: readonly T[],
  indexes: readonly number[],
  anchor: EditablePoint,
  factor: number,
): T[] => {
  const selected = new Set(indexes)
  return strokes.map((stroke, index) => (
    selected.has(index)
      ? {
        ...stroke,
        points: stroke.points.map((point) => movedPoint(
          point,
          anchor.x + (point.x - anchor.x) * factor,
          anchor.y + (point.y - anchor.y) * factor,
        )),
      }
      : stroke
  ))
}

/**
 * Appends one duplicate per selected stroke. The originals stay in place.
 * The returned indexes are the copies.
 */
export const copyInkSelection = <T extends EditableStroke>(
  strokes: readonly T[],
  indexes: readonly number[],
  dx = 0.03,
  dy = 0.03,
): { strokes: T[]; indexes: number[] } => {
  const copies: T[] = []
  for (const index of indexes) {
    const stroke = strokes[index]
    if (!stroke) continue
    copies.push({
      ...stroke,
      points: stroke.points.map((point) => movedPoint(point, point.x + dx, point.y + dy)),
    })
  }
  const start = strokes.length
  return {
    strokes: [...strokes, ...copies],
    indexes: copies.map((_, offset) => start + offset),
  }
}
