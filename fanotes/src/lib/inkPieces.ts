/**
 * Letter-sized pieces of handwriting.
 *
 * A pen stroke is often a whole word. The eraser and the move tool treat a
 * letter (and its dot or crossbar) as the unit: the whole letter goes when
 * the pen really meets its ink, and the neighbouring letter stays.
 * A long straight mark, such as an underline, is not a letter — only the
 * span the pen actually covers is cut out.
 * A leap to ink that is not part of the letter starts a new piece.
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

const segmentDistance = (a: Pixel, b: Pixel, c: Pixel, d: Pixel) => Math.min(
  distanceToSegment(a.x, a.y, c.x, c.y, d.x, d.y),
  distanceToSegment(b.x, b.y, c.x, c.y, d.x, d.y),
  distanceToSegment(c.x, c.y, a.x, a.y, b.x, b.y),
  distanceToSegment(d.x, d.y, a.x, a.y, b.x, b.y),
)

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

const segmentHitsPath = (start: Pixel, end: Pixel, path: readonly Pixel[], reach: number) => {
  if (distanceToPath(start, path) <= reach || distanceToPath(end, path) <= reach) return true
  if (path.length === 1) return distanceToSegment(path[0].x, path[0].y, start.x, start.y, end.x, end.y) <= reach
  for (let index = 1; index < path.length; index += 1) {
    if (segmentDistance(start, end, path[index - 1], path[index]) <= reach) return true
  }
  return false
}

export const rangeHitsPath = (
  pixels: readonly Pixel[],
  start: number,
  end: number,
  reach: number,
  path: readonly Pixel[],
) => {
  if (!pixels.length || !path.length || end < start) return false
  if (start === end) return distanceToPath(pixels[start], path) <= reach
  for (let index = start + 1; index <= end; index += 1) {
    if (segmentHitsPath(pixels[index - 1], pixels[index], path, reach)) return true
  }
  return false
}

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

const hitParameter = (start: Pixel, end: Pixel, path: readonly Pixel[], reach: number, entering: boolean) => {
  let lo = 0
  let hi = 1
  for (let step = 0; step < 14; step += 1) {
    const mid = (lo + hi) / 2
    const pixel = {
      x: start.x + (end.x - start.x) * mid,
      y: start.y + (end.y - start.y) * mid,
    }
    const inside = distanceToPath(pixel, path) <= reach
    if (inside === entering) hi = mid
    else lo = mid
  }
  return entering ? hi : lo
}

/** Cuts a stroke down to the ink the eraser disk did not cover. */
export const cutPageStroke = <T extends InkPieceStroke>(
  stroke: T,
  pagePixels: readonly Pixel[],
  path: readonly Pixel[],
  reach: number,
  letterWidth: number,
  start = 0,
  end = stroke.points.length - 1,
): T[] => cutPrepared(stroke, pagePixels, path, reach, letterWidth, start, end)

const cutPrepared = <T extends InkPieceStroke>(
  stroke: T,
  pagePixels: readonly Pixel[],
  path: readonly Pixel[],
  reach: number,
  letterWidth: number,
  start: number,
  end: number,
): T[] => {
  const count = end - start + 1
  if (count <= 0) return []
  const local = pagePixels.slice(start, end + 1)
  const points = stroke.points.slice(start, end + 1)
  if (count === 1) {
    return distanceToPath(local[0], path) <= reach ? [] : [stroke]
  }

  const vertexHit = local.map((pixel) => distanceToPath(pixel, path) <= reach)
  if (letterWidth > 0) expandHits(local, vertexHit, letterWidth, path, reach)

  const emit = (slice: T['points'][]) => slice
    .filter((entry) => entry.length > 0)
    .map((entry) => ({ ...stroke, points: entry }))

  const kept: Array<T['points']> = []
  let run: T['points'] = []
  const flush = () => {
    if (run.length) kept.push(run)
    run = []
  }
  const pushRun = (point: T['points'][number]) => {
    run.push(point)
  }
  const ensureStart = (index: number) => {
    if (!run.length || run[run.length - 1] !== points[index]) pushRun(points[index])
  }

  for (let index = 0; index < count - 1; index += 1) {
    const startHit = vertexHit[index]
    const endHit = vertexHit[index + 1]
    const segmentHit = segmentHitsPath(local[index], local[index + 1], path, reach)
    if (!startHit && !endHit && !segmentHit) {
      ensureStart(index)
      pushRun(points[index + 1])
      continue
    }
    if (!startHit && !endHit && segmentHit) {
      const enter = hitParameter(local[index], local[index + 1], path, reach, true)
      const after = {
        x: local[index].x + (local[index + 1].x - local[index].x) * enter,
        y: local[index].y + (local[index + 1].y - local[index].y) * enter,
      }
      const exitLocal = hitParameter(after, local[index + 1], path, reach, false)
      const exit = enter + (1 - enter) * exitLocal
      ensureStart(index)
      if (enter > 0.02) pushRun(lerpPoint(points[index], points[index + 1], enter))
      flush()
      if (exit < 0.98) pushRun(lerpPoint(points[index], points[index + 1], exit))
      continue
    }
    if (!startHit && endHit) {
      ensureStart(index)
      if (segmentHit || distanceToPath(local[index + 1], path) <= reach) {
        const t = hitParameter(local[index], local[index + 1], path, reach, true)
        if (t > 0.02 && t < 0.98) pushRun(lerpPoint(points[index], points[index + 1], t))
      }
      flush()
      continue
    }
    if (startHit && !endHit) {
      if (segmentHit || distanceToPath(local[index], path) <= reach) {
        const t = hitParameter(local[index], local[index + 1], path, reach, false)
        if (t > 0.02 && t < 0.98) pushRun(lerpPoint(points[index], points[index + 1], t))
      }
      pushRun(points[index + 1])
      continue
    }
    flush()
  }
  if (!vertexHit[count - 1]) {
    const last = points[count - 1]
    if (!run.length || run[run.length - 1] !== last) pushRun(last)
  }
  flush()
  return emit(kept)
}

const expandHits = (
  pixels: readonly Pixel[],
  vertexHit: boolean[],
  letterWidth: number,
  path: readonly Pixel[],
  reach: number,
) => {
  const hitIndexes: number[] = []
  vertexHit.forEach((hit, index) => {
    if (hit) hitIndexes.push(index)
  })
  for (let index = 1; index < pixels.length; index += 1) {
    if (vertexHit[index] || vertexHit[index - 1]) continue
    if (segmentHitsPath(pixels[index - 1], pixels[index], path, reach)) {
      vertexHit[index - 1] = true
      vertexHit[index] = true
      hitIndexes.push(index - 1, index)
    }
  }
  if (!hitIndexes.length) return
  hitIndexes.sort((left, right) => left - right)
  const runs: Array<[number, number]> = []
  let runStart = hitIndexes[0]
  let previous = hitIndexes[0]
  for (let index = 1; index < hitIndexes.length; index += 1) {
    if (hitIndexes[index] > previous + 1) {
      runs.push([runStart, previous])
      runStart = hitIndexes[index]
    }
    previous = hitIndexes[index]
  }
  runs.push([runStart, previous])

  for (const [from, to] of runs) {
    let centerX = 0
    for (let index = from; index <= to; index += 1) centerX += pixels[index].x
    centerX /= Math.max(1, to - from + 1)
    let arc = 0
    for (let index = from - 1; index >= 0; index -= 1) {
      arc += Math.hypot(pixels[index + 1].x - pixels[index].x, pixels[index + 1].y - pixels[index].y)
      if (arc > letterWidth) break
      if (arc > letterWidth * 0.55 && Math.abs(pixels[index].x - centerX) > letterWidth * 0.55) break
      vertexHit[index] = true
    }
    arc = 0
    for (let index = to + 1; index < pixels.length; index += 1) {
      arc += Math.hypot(pixels[index].x - pixels[index - 1].x, pixels[index].y - pixels[index - 1].y)
      if (arc > letterWidth) break
      if (arc > letterWidth * 0.55 && Math.abs(pixels[index].x - centerX) > letterWidth * 0.55) break
      vertexHit[index] = true
    }
  }
}

export const sliceStroke = <T extends InkPieceStroke>(stroke: T, start: number, end: number): T => {
  if (start <= 0 && end >= stroke.points.length - 1) return stroke
  return { ...stroke, points: stroke.points.slice(start, end + 1) }
}
