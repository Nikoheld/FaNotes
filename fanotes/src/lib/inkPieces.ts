/**
 * Letter-sized pieces of handwriting.
 *
 * A pen stroke is often a whole word. The move tool treats a letter (and its
 * dot or crossbar) as the unit: the whole letter goes when the pen really
 * meets its ink, and the neighbouring letter stays.
 * A long straight mark, such as an underline, is not a letter — only the
 * span the pen actually covers is cut out.
 * A leap to ink that is not part of the letter starts a new piece.
 *
 * The eraser does not use letters: `cutPageStroke` below cuts away exactly the
 * ink the eraser path reaches and nothing else.
 */

export type InkPiecePoint = { x: number; y: number }

export type InkPieceStroke = {
  points: InkPiecePoint[]
  baseWidth: number
  purpose?: 'handwriting' | 'art'
  symbolId?: string
}

export type PieceKind = 'letter' | 'long' | 'mark'

export type PieceBounds = {
  minX: number
  minY: number
  maxX: number
  maxY: number
  width: number
  height: number
}

export type InkPiece<T> = {
  stroke: T
  strokeIndex: number
  start: number
  end: number
  kind: PieceKind
  bounds: PieceBounds
  group: number
}

type Pixel = { x: number; y: number }

const clamp01 = (value: number) => Math.max(0, Math.min(1, value))

export const distanceToSegment = (
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

export const pixelsOf = (
  points: readonly InkPiecePoint[],
  sourceWidth: number,
  sourceHeight: number,
): Pixel[] => points.map((point) => ({ x: point.x * sourceWidth, y: point.y * sourceHeight }))

export const boundsOfPixels = (pixels: readonly Pixel[], start: number, end: number): PieceBounds => {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (let index = start; index <= end; index += 1) {
    const pixel = pixels[index]
    minX = Math.min(minX, pixel.x)
    minY = Math.min(minY, pixel.y)
    maxX = Math.max(maxX, pixel.x)
    maxY = Math.max(maxY, pixel.y)
  }
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: Math.max(0, maxX - minX),
    height: Math.max(0, maxY - minY),
  }
}

/** Page-space leap the live pen already refuses to join into one stroke. */
const PAGE_LEAP = 0.12

const kindFor = (bounds: PieceBounds): PieceKind => {
  const flat = bounds.height <= 14
  const wideLine = bounds.width > Math.max(72, bounds.height * 3)
  if (flat && wideLine) return 'long'
  if (bounds.height <= 18 && bounds.width <= Math.max(56, bounds.height * 4)) return 'mark'
  if (bounds.width <= Math.max(40, Math.max(bounds.height, 12) * 2.15)) return 'letter'
  return 'long'
}

const rangeWidth = (pixels: readonly Pixel[], start: number, end: number) => (
  boundsOfPixels(pixels, start, end).width
)

/**
 * Cuts where one segment jumps to a different cluster of ink.
 * Both sides keep at least two points, so a plain stem stays one piece.
 */
const leapParts = (
  pixels: readonly Pixel[],
  sourceWidth: number,
  sourceHeight: number,
): Array<{ start: number; end: number }> => {
  const count = pixels.length
  if (count < 4 || sourceWidth < 1 || sourceHeight < 1) return []
  const spans: number[] = []
  for (let index = 1; index < count; index += 1) {
    const dx = (pixels[index].x - pixels[index - 1].x) / sourceWidth
    const dy = (pixels[index].y - pixels[index - 1].y) / sourceHeight
    spans.push(Math.hypot(dx, dy))
  }
  const ordered = [...spans].sort((left, right) => left - right)
  const median = ordered[Math.floor((ordered.length - 1) / 2)] ?? 0
  const cuts: number[] = []
  for (let index = 2; index <= count - 2; index += 1) {
    const span = spans[index - 1]
    const outlier = span > 0.09 && median > 0 && span > median * 4
    if (span > PAGE_LEAP || outlier) cuts.push(index)
  }
  if (!cuts.length) return []
  const parts: Array<{ start: number; end: number }> = []
  let start = 0
  for (const index of cuts) {
    if (index - 1 >= start) parts.push({ start, end: index - 1 })
    start = index
  }
  if (start <= count - 1) parts.push({ start, end: count - 1 })
  return parts.length > 1 ? parts : []
}

/**
 * Splits one stroke into letter-sized ranges. A short glyph stays one range.
 * Necks are the thin connectors between letters, not the arches inside m or w.
 */
export const letterRanges = (
  points: readonly InkPiecePoint[],
  sourceWidth: number,
  sourceHeight: number,
): Array<{ start: number; end: number; kind: PieceKind }> => {
  const count = points.length
  if (!count || sourceWidth < 1 || sourceHeight < 1) return []
  const pixels = pixelsOf(points, sourceWidth, sourceHeight)
  if (count === 1) return [{ start: 0, end: 0, kind: kindFor(boundsOfPixels(pixels, 0, 0)) }]

  const leaps = leapParts(pixels, sourceWidth, sourceHeight)
  if (leaps.length) {
    return leaps.flatMap((part) => letterRanges(
      points.slice(part.start, part.end + 1),
      sourceWidth,
      sourceHeight,
    ).map((range) => ({
      start: range.start + part.start,
      end: range.end + part.start,
      kind: range.kind,
    })))
  }

  const box = boundsOfPixels(pixels, 0, count - 1)
  const height = Math.max(box.height, 1)
  const letterLimit = Math.max(40, height * 2.15)
  const whole = (): Array<{ start: number; end: number; kind: PieceKind }> => (
    [{ start: 0, end: count - 1, kind: kindFor(box) }]
  )
  if (box.width <= letterLimit || box.height < 14) return whole()

  const binSize = Math.max(5, height * 0.16)
  const binCount = Math.max(1, Math.ceil((box.width + 0.01) / binSize))
  const bins = Array.from({ length: binCount }, () => ({
    minY: Number.POSITIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
    count: 0,
  }))
  const paint = (x: number, y: number) => {
    const bin = Math.min(binCount - 1, Math.max(0, Math.floor((x - box.minX) / binSize)))
    const entry = bins[bin]
    entry.minY = Math.min(entry.minY, y)
    entry.maxY = Math.max(entry.maxY, y)
    entry.count += 1
  }
  for (let index = 0; index < count; index += 1) {
    paint(pixels[index].x, pixels[index].y)
    if (index === 0) continue
    const previous = pixels[index - 1]
    const current = pixels[index]
    const span = Math.hypot(current.x - previous.x, current.y - previous.y)
    const steps = Math.ceil(span / Math.max(2, binSize * 0.5))
    for (let step = 1; step < steps; step += 1) {
      const t = step / steps
      paint(previous.x + (current.x - previous.x) * t, previous.y + (current.y - previous.y) * t)
    }
  }

  // A connector sits near the baseline. Letter bodies reach up, even when the
  // stroke itself is only a thin line and a single x-bin is not "tall".
  const rise = (index: number) => (bins[index].count ? box.maxY - bins[index].minY : 0)
  const reachesUp = (index: number) => rise(index) >= height * 0.55
  const staysDown = (index: number) => rise(index) <= height * 0.22
  const horizon = Math.max(4, Math.ceil((height * 1.4) / binSize))
  const neckBins: number[] = []
  for (let index = 1; index < binCount - 1; index += 1) {
    if (!staysDown(index)) continue
    let left = false
    let right = false
    for (let look = 1; look <= horizon; look += 1) {
      if (index - look >= 0 && reachesUp(index - look)) left = true
      if (index + look < binCount && reachesUp(index + look)) right = true
    }
    if (left && right) neckBins.push(index)
  }
  if (!neckBins.length) return whole()

  const cuts: number[] = []
  let runStart = neckBins[0]
  const flush = (runEnd: number) => {
    const runWidth = (runEnd - runStart + 1) * binSize
    if (runWidth < Math.max(8, height * 0.1)) return
    const center = box.minX + ((runStart + runEnd + 1) / 2) * binSize
    let best = -1
    let bestDistance = Number.POSITIVE_INFINITY
    for (let index = 1; index < count - 1; index += 1) {
      if (box.maxY - pixels[index].y > height * 0.35) continue
      const distance = Math.abs(pixels[index].x - center)
      if (distance < bestDistance) {
        bestDistance = distance
        best = index
      }
    }
    if (best > 0 && (!cuts.length || best - cuts[cuts.length - 1] >= 2)) cuts.push(best)
  }
  for (let index = 1; index < neckBins.length; index += 1) {
    if (neckBins[index] > neckBins[index - 1] + 1) {
      flush(neckBins[index - 1])
      runStart = neckBins[index]
    }
  }
  flush(neckBins[neckBins.length - 1])
  if (!cuts.length) return whole()

  const ranges: Array<{ start: number; end: number }> = []
  let start = 0
  for (const cut of cuts) {
    ranges.push({ start, end: cut })
    start = cut
  }
  ranges.push({ start, end: count - 1 })

  const minPiece = Math.max(6, height * 0.12)
  let merging = true
  while (merging) {
    merging = false
    for (let index = 0; index < ranges.length; index += 1) {
      if (ranges.length === 1) break
      if (rangeWidth(pixels, ranges[index].start, ranges[index].end) >= minPiece) continue
      const left = index > 0 ? ranges[index - 1] : null
      const right = index + 1 < ranges.length ? ranges[index + 1] : null
      const leftWidth = left ? rangeWidth(pixels, left.start, ranges[index].end) : Number.POSITIVE_INFINITY
      const rightWidth = right ? rangeWidth(pixels, ranges[index].start, right.end) : Number.POSITIVE_INFINITY
      const canLeft = Boolean(left) && leftWidth <= letterLimit * 1.05
      const canRight = Boolean(right) && rightWidth <= letterLimit * 1.05
      if (!canLeft && !canRight) continue
      if (canLeft && (!canRight || leftWidth <= rightWidth)) {
        ranges[index - 1] = { start: left!.start, end: ranges[index].end }
        ranges.splice(index, 1)
      } else {
        ranges[index + 1] = { start: ranges[index].start, end: right!.end }
        ranges.splice(index, 1)
      }
      merging = true
      break
    }
  }

  return ranges.map((range) => ({
    ...range,
    kind: kindFor(boundsOfPixels(pixels, range.start, range.end)),
  }))
}

const attaches = (mark: PieceBounds, host: PieceBounds) => {
  const centerX = (mark.minX + mark.maxX) / 2
  if (centerX < host.minX - 8 || centerX > host.maxX + 8) return false
  if (mark.height > host.height * 0.55 && mark.width > host.width * 0.7) return false
  const gap = Math.max(0, Math.max(mark.minY, host.minY) - Math.min(mark.maxY, host.maxY))
  // A dot or crossbar sits on the letter. A short stroke farther down the
  // page is a different line, even when the stem is tall.
  return gap <= Math.min(36, Math.max(18, host.height * 0.45))
}

/** Letter pieces for every stroke, with dots and crossbars grouped onto their letter. */
export const planInkPieces = <T extends InkPieceStroke>(
  strokes: readonly T[],
  sourceWidth: number,
  sourceHeight: number,
): Array<InkPiece<T>> => {
  const pieces: Array<InkPiece<T>> = []
  strokes.forEach((stroke, strokeIndex) => {
    if (!stroke.points.length) return
    const pixels = pixelsOf(stroke.points, sourceWidth, sourceHeight)
    const ranges = letterRanges(stroke.points, sourceWidth, sourceHeight)
    for (const range of ranges) {
      pieces.push({
        stroke,
        strokeIndex,
        start: range.start,
        end: range.end,
        kind: range.kind,
        bounds: boundsOfPixels(pixels, range.start, range.end),
        group: pieces.length,
      })
    }
  })

  for (const mark of pieces) {
    if (mark.kind !== 'mark') continue
    let host: InkPiece<T> | null = null
    let bestGap = Number.POSITIVE_INFINITY
    for (const letter of pieces) {
      if (letter.kind !== 'letter' || letter.strokeIndex === mark.strokeIndex && letter.start === mark.start) continue
      if (!attaches(mark.bounds, letter.bounds)) continue
      const gap = Math.hypot(
        (mark.bounds.minX + mark.bounds.maxX) / 2 - (letter.bounds.minX + letter.bounds.maxX) / 2,
        (mark.bounds.minY + mark.bounds.maxY) / 2 - (letter.bounds.minY + letter.bounds.maxY) / 2,
      )
      if (gap < bestGap) {
        bestGap = gap
        host = letter
      }
    }
    if (host) mark.group = host.group
  }
  return pieces
}

export const distanceToPath = (pixel: Pixel, path: readonly Pixel[]) => {
  if (!path.length) return Number.POSITIVE_INFINITY
  let best = Math.hypot(pixel.x - path[0].x, pixel.y - path[0].y)
  for (let index = 1; index < path.length; index += 1) {
    best = Math.min(best, distanceToSegment(
      pixel.x,
      pixel.y,
      path[index - 1].x,
      path[index - 1].y,
      path[index].x,
      path[index].y,
    ))
  }
  return best
}

/*
 * Erasing.
 *
 * The eraser is a disk swept along a polyline of samples, and a stroke's ink is
 * its centre line thickened by half the stroke width. So a point of a stroke is
 * erased when it lies within `reach` (eraser radius plus half the stroke width)
 * of the eraser path. The code below works segment by segment and solves the
 * circle and slab intersections in closed form: cut points sit exactly on the
 * rim of the eraser however sparse the stroke or the eraser path is, and a
 * swipe that crosses a long segment between two vertices still cuts it.
 */

/** Rounding level: squared px for a segment length, px for a change along an axis. */
const EPSILON = 1e-12
/**
 * A stretch shorter than this many px is the rim of an earlier cut met again
 * through rounding, not ink to cut. Erasing the same place twice changes nothing.
 */
const MIN_CUT_LENGTH = 1e-3
/** A cut this close (in "vertex index + fraction") to a vertex is that vertex. */
const VERTEX_SNAP = 1e-9

/**
 * Shortest piece worth keeping after a cut, in px. A shorter remainder is a
 * crumb: a dot as wide as the stroke that nobody drew and that is hard to hit.
 */
const crumbLength = (baseWidth: number) => (
  Math.max(0.5, (Number.isFinite(baseWidth) ? baseWidth : 0) / 4)
)

const lerpPoint = <P extends InkPiecePoint>(start: P, end: P, t: number): P => {
  const next = { ...start }
  for (const key of Object.keys(start) as Array<keyof P>) {
    const from = start[key]
    const to = end[key]
    if (typeof from === 'number' && typeof to === 'number') {
      next[key] = (from + (to - from) * t) as P[keyof P]
    }
  }
  return next
}

/**
 * Narrows `span` (a [from, to] pair of positions t along a segment) to where
 * `start + rate * t` lies between `min` and `max`. False when nothing is left.
 */
const clipSpan = (span: number[], start: number, rate: number, min: number, max: number) => {
  if (rate > -EPSILON && rate < EPSILON) return start >= min && start <= max
  let enter = (min - start) / rate
  let leave = (max - start) / rate
  if (enter > leave) {
    const swap = enter
    enter = leave
    leave = swap
  }
  if (enter > span[0]) span[0] = enter
  if (leave < span[1]) span[1] = leave
  return span[0] <= span[1]
}

/** Where the segment a + t*d (t in 0..1) is inside the disk around (cx, cy). */
const diskSpan = (
  ax: number,
  ay: number,
  dx: number,
  dy: number,
  cx: number,
  cy: number,
  reach: number,
  span: number[],
) => {
  const fx = ax - cx
  const fy = ay - cy
  const squared = dx * dx + dy * dy
  if (squared < EPSILON) {
    // The segment is a point (a repeated sample).
    if (!(fx * fx + fy * fy <= reach * reach)) return false
    span[0] = 0
    span[1] = 1
    return true
  }
  const length = Math.sqrt(squared)
  // The closest approach to the centre, and how far the line passes from it.
  const closest = -(fx * dx + fy * dy) / squared
  const offset = (fx * dy - fy * dx) / length
  const rest = reach * reach - offset * offset
  if (!(rest >= 0)) return false
  const half = Math.sqrt(rest) / length
  const enter = Math.max(0, closest - half)
  const leave = Math.min(1, closest + half)
  if (!(enter <= leave)) return false
  span[0] = enter
  span[1] = leave
  return true
}

/**
 * Where the segment a + t*d (t in 0..1) is inside the straight part of a swept
 * disk: the rectangle `reach` to either side of the line from q to e.
 */
const slabSpan = (
  ax: number,
  ay: number,
  dx: number,
  dy: number,
  qx: number,
  qy: number,
  ex: number,
  ey: number,
  reach: number,
  span: number[],
) => {
  const length = Math.hypot(ex - qx, ey - qy)
  if (!(length > EPSILON)) return false
  const ux = (ex - qx) / length
  const uy = (ey - qy) / length
  const rx = ax - qx
  const ry = ay - qy
  span[0] = 0
  span[1] = 1
  return clipSpan(span, rx * ux + ry * uy, dx * ux + dy * uy, 0, length)
    && clipSpan(span, ux * ry - uy * rx, ux * dy - uy * dx, -reach, reach)
}

/** Sorts [from, to] pairs by `from` and joins the ones that touch. */
const mergeSpans = (spans: number[]) => {
  if (spans.length <= 2) return spans
  for (let index = 2; index < spans.length; index += 2) {
    const from = spans[index]
    const to = spans[index + 1]
    let before = index - 2
    while (before >= 0 && spans[before] > from) {
      spans[before + 2] = spans[before]
      spans[before + 3] = spans[before + 1]
      before -= 2
    }
    spans[before + 2] = from
    spans[before + 3] = to
  }
  const merged = [spans[0], spans[1]]
  for (let index = 2; index < spans.length; index += 2) {
    const last = merged.length - 1
    if (spans[index] <= merged[last] + EPSILON) {
      if (spans[index + 1] > merged[last]) merged[last] = spans[index + 1]
    } else {
      merged.push(spans[index], spans[index + 1])
    }
  }
  return merged
}

/**
 * The parts of the stroke segment (ax, ay) to (bx, by) that lie within `reach`
 * of the eraser path, as ascending, disjoint [from, to] pairs of t in 0..1; null
 * when the segment stays clear. The swept disk is the union of one disk per
 * path vertex and one rectangle per path segment, so a segment that crosses the
 * path between two vertices of either one is found exactly.
 */
const segmentSpans = (
  ax: number,
  ay: number,
  bx: number,
  by: number,
  path: readonly Pixel[],
  reach: number,
): number[] | null => {
  const dx = bx - ax
  const dy = by - ay
  const left = Math.min(ax, bx)
  const right = Math.max(ax, bx)
  const top = Math.min(ay, by)
  const bottom = Math.max(ay, by)
  const span = [0, 0]
  let found: number[] | null = null
  for (let index = 0; index < path.length; index += 1) {
    const from = path[index]
    if (
      from.x + reach >= left && from.x - reach <= right
      && from.y + reach >= top && from.y - reach <= bottom
      && diskSpan(ax, ay, dx, dy, from.x, from.y, reach, span)
    ) (found ??= []).push(span[0], span[1])
    const to = path[index + 1]
    if (!to) continue
    if (
      Math.max(from.x, to.x) + reach >= left && Math.min(from.x, to.x) - reach <= right
      && Math.max(from.y, to.y) + reach >= top && Math.min(from.y, to.y) - reach <= bottom
      && slabSpan(ax, ay, dx, dy, from.x, from.y, to.x, to.y, reach, span)
    ) (found ??= []).push(span[0], span[1])
  }
  return found && mergeSpans(found)
}

type Stretch = {
  /** First and last erased position, as "vertex index + fraction of the next segment". */
  from: number
  to: number
  /** Length of ink the stretch covers, in px. */
  ink: number
}

/** Every stretch of the stroke the eraser path reaches, in order and apart. */
const erasedStretches = (
  points: readonly InkPiecePoint[],
  sourceWidth: number,
  sourceHeight: number,
  path: readonly Pixel[],
  reach: number,
) => {
  let pathLeft = Number.POSITIVE_INFINITY
  let pathTop = Number.POSITIVE_INFINITY
  let pathRight = Number.NEGATIVE_INFINITY
  let pathBottom = Number.NEGATIVE_INFINITY
  for (const vertex of path) {
    if (vertex.x < pathLeft) pathLeft = vertex.x
    if (vertex.x > pathRight) pathRight = vertex.x
    if (vertex.y < pathTop) pathTop = vertex.y
    if (vertex.y > pathBottom) pathBottom = vertex.y
  }
  pathLeft -= reach
  pathTop -= reach
  pathRight += reach
  pathBottom += reach

  const stretches: Stretch[] = []
  let ax = points[0].x * sourceWidth
  let ay = points[0].y * sourceHeight
  for (let index = 1; index < points.length; index += 1) {
    const bx = points[index].x * sourceWidth
    const by = points[index].y * sourceHeight
    // Comparisons are written so that a NaN coordinate never passes.
    const spans = Math.max(ax, bx) >= pathLeft && Math.min(ax, bx) <= pathRight
      && Math.max(ay, by) >= pathTop && Math.min(ay, by) <= pathBottom
      ? segmentSpans(ax, ay, bx, by, path, reach)
      : null
    if (spans) {
      const length = Math.hypot(bx - ax, by - ay)
      for (let at = 0; at < spans.length; at += 2) {
        const from = index - 1 + spans[at]
        const to = index - 1 + spans[at + 1]
        // A segment covered end to end counts even when it is a repeated sample.
        const ink = spans[at] <= 0 && spans[at + 1] >= 1
          ? Math.max(length, MIN_CUT_LENGTH)
          : (spans[at + 1] - spans[at]) * length
        const previous = stretches[stretches.length - 1]
        if (previous && from <= previous.to + VERTEX_SNAP) {
          if (to > previous.to) previous.to = to
          previous.ink += ink
        } else {
          stretches.push({ from, to, ink })
        }
      }
    }
    ax = bx
    ay = by
  }
  return stretches.filter((stretch) => stretch.ink >= MIN_CUT_LENGTH)
}

/** The ink between the stretches, with new end points exactly where the cuts are. */
const keptPieces = <T extends InkPieceStroke>(
  stroke: T,
  sourceWidth: number,
  sourceHeight: number,
  stretches: readonly Stretch[],
): T[] => {
  const points = stroke.points
  const lastIndex = points.length - 1
  const minLength = crumbLength(stroke.baseWidth)
  const pieces: T[] = []
  const vertexAt = (position: number) => {
    const nearest = Math.round(position)
    return Math.abs(position - nearest) <= VERTEX_SNAP ? nearest : -1
  }
  const pointAt = (position: number) => {
    const index = Math.floor(position)
    return lerpPoint(points[index], points[index + 1], position - index)
  }
  const keep = (from: number, to: number) => {
    if (!(to - from > VERTEX_SNAP)) return
    const firstVertex = vertexAt(from)
    const lastVertex = vertexAt(to)
    const run: T['points'] = []
    if (firstVertex < 0) run.push(pointAt(from))
    const inner = lastVertex < 0 ? Math.floor(to) : lastVertex
    for (let index = firstVertex < 0 ? Math.ceil(from) : firstVertex; index <= inner; index += 1) {
      run.push(points[index])
    }
    if (lastVertex < 0) run.push(pointAt(to))
    if (run.length < 2) return
    let length = 0
    for (let index = 1; index < run.length; index += 1) {
      length += Math.hypot(
        (run[index].x - run[index - 1].x) * sourceWidth,
        (run[index].y - run[index - 1].y) * sourceHeight,
      )
    }
    if (length < minLength) return
    pieces.push({ ...stroke, points: run })
  }
  let start = 0
  for (const stretch of stretches) {
    keep(start, stretch.from)
    start = stretch.to
  }
  keep(start, lastIndex)
  return pieces
}

/**
 * Cuts out the ink of `stroke` that lies within `reach` of the eraser `path`
 * (page pixels) and returns what is left: no piece, one or several. Returns
 * null when the path does not touch the stroke, so callers keep the original.
 * A remainder shorter than a crumb (a quarter of the stroke width, at least
 * half a pixel) is dropped.
 */
export const cutPageStroke = <T extends InkPieceStroke>(
  stroke: T,
  sourceWidth: number,
  sourceHeight: number,
  path: readonly Pixel[],
  reach: number,
): T[] | null => {
  const points = stroke.points
  if (!points.length || !path.length) return null
  if (points.length === 1) {
    const dot = { x: points[0].x * sourceWidth, y: points[0].y * sourceHeight }
    return distanceToPath(dot, path) <= reach ? [] : null
  }
  const stretches = erasedStretches(points, sourceWidth, sourceHeight, path, reach)
  if (!stretches.length) return null
  return keptPieces(stroke, sourceWidth, sourceHeight, stretches)
}

export const sliceStroke = <T extends InkPieceStroke>(stroke: T, start: number, end: number): T => {
  if (start <= 0 && end >= stroke.points.length - 1) return stroke
  return { ...stroke, points: stroke.points.slice(start, end + 1) }
}
