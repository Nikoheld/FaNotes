/**
 * Ink strokes as PDF content-stream operators.
 *
 * The geometry is the screen's: `drawInkStroke` (inkStrokePaint.ts) strokes one
 * quadratic curve per segment with a round cap and the width of the segment's
 * pressure. This file walks the same segments the same way (same smoothing
 * pull, same lift-hook trim, same brush passes) and writes them as stroked
 * paths, so a pressure-varying line looks like it does on screen and stays
 * sharp at any zoom. Opaque runs of equal width are joined into one path.
 * Translucent brushes (highlighter, marker, pencil, watercolor, opacity below 1)
 * are one shape painted once with a constant alpha, like the screen's scratch
 * composite: constant-width strokes are one stroked path, pressure strokes are
 * a transparency group. The highlighter uses the Multiply blend mode.
 *
 * Coordinates are sheet CSS pixels with y down; the caller sets the matrix.
 */
import { inkBrushPlan, inkInteriorPull, inkStrokeBitmapWidth, symbolStampLineWidth, type InkPaintPoint, type InkPaintStroke } from '../inkStrokePaint'
import { inkQuickTurnKeep } from '../inkTurn'

export type ExportInkStroke = InkPaintStroke

/** Registers page resources (graphics states, transparency groups) and returns their names. */
export type InkResources = {
  gs: (alpha: number, blend: 'Normal' | 'Multiply') => string
  /** A transparency group whose content is `content`; returns the form name to paint with `Do`. */
  group: (content: string, bbox: readonly [number, number, number, number]) => string
}

const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value))

/** One decimal: finer than 0.05 px, which no screen or printer shows. */
export const fmt = (value: number) => {
  const rounded = Math.round(value * 10) / 10
  return Object.is(rounded, -0) ? '0' : String(rounded)
}
const fmt3 = (value: number) => {
  const rounded = Math.round(value * 1000) / 1000
  return Object.is(rounded, -0) ? '0' : String(rounded)
}

/** `#rgb`, `#rrggbb`, `rgb()`/`rgba()`; anything else is the default ink. */
export const parseInkColor = (value: unknown): [number, number, number] => {
  const fallback: [number, number, number] = [32 / 255, 35 / 255, 51 / 255]
  if (typeof value !== 'string') return fallback
  const text = value.trim()
  let match = /^#([\da-f]{6})(?:[\da-f]{2})?$/iu.exec(text)
  if (match) {
    const hex = match[1]
    return [0, 2, 4].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255) as [number, number, number]
  }
  match = /^#([\da-f])([\da-f])([\da-f])$/iu.exec(text)
  if (match) return [1, 2, 3].map((at) => Number.parseInt(match![at] + match![at], 16) / 255) as [number, number, number]
  match = /^rgba?\(([^)]+)\)$/iu.exec(text)
  if (match) {
    const parts = match[1].split(/[,\s/]+/u).filter(Boolean).slice(0, 3).map(Number)
    if (parts.length === 3 && parts.every(Number.isFinite)) return parts.map((part) => clamp(part / 255)) as [number, number, number]
  }
  return fallback
}

export const rgbOperands = (color: readonly [number, number, number]) => color.map(fmt3).join(' ')

const seededUnit = (seed: number) => {
  const value = Math.sin(seed * 12.9898 + 78.233) * 43_758.5453
  return value - Math.floor(value)
}

/** Path writer with the three canvas calls the stroke code uses. */
class PathOps {
  readonly parts: string[] = []
  private cx = 0
  private cy = 0

  moveTo(x: number, y: number) {
    this.parts.push(`${fmt(x)} ${fmt(y)} m`)
    this.cx = x
    this.cy = y
  }

  lineTo(x: number, y: number) {
    this.parts.push(`${fmt(x)} ${fmt(y)} l`)
    this.cx = x
    this.cy = y
  }

  quadraticCurveTo(px: number, py: number, x: number, y: number) {
    const c1x = this.cx + (2 / 3) * (px - this.cx)
    const c1y = this.cy + (2 / 3) * (py - this.cy)
    const c2x = x + (2 / 3) * (px - x)
    const c2y = y + (2 / 3) * (py - y)
    this.parts.push(`${fmt(c1x)} ${fmt(c1y)} ${fmt(c2x)} ${fmt(c2y)} ${fmt(x)} ${fmt(y)} c`)
    this.cx = x
    this.cy = y
  }

  circle(x: number, y: number, radius: number) {
    const k = 0.5522847498 * radius
    this.parts.push(
      `${fmt(x + radius)} ${fmt(y)} m`,
      `${fmt(x + radius)} ${fmt(y + k)} ${fmt(x + k)} ${fmt(y + radius)} ${fmt(x)} ${fmt(y + radius)} c`,
      `${fmt(x - k)} ${fmt(y + radius)} ${fmt(x - radius)} ${fmt(y + k)} ${fmt(x - radius)} ${fmt(y)} c`,
      `${fmt(x - radius)} ${fmt(y - k)} ${fmt(x - k)} ${fmt(y - radius)} ${fmt(x)} ${fmt(y - radius)} c`,
      `${fmt(x + k)} ${fmt(y - radius)} ${fmt(x + radius)} ${fmt(y - k)} ${fmt(x + radius)} ${fmt(y)} c`,
      'h',
    )
  }

  take() {
    return this.parts.join('\n')
  }
}

export type StrokeBox = { x0: number; y0: number; x1: number; y1: number }

/** Where a stroke can paint, in sheet pixels (samples widened by the widest nib). */
export const strokeBox = (stroke: ExportInkStroke, width: number, height: number): StrokeBox | null => {
  if (!stroke.points.length) return null
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const point of stroke.points) {
    const x = point.x * width
    const y = point.y * height
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
  }
  if (!Number.isFinite(x0) || !Number.isFinite(y0)) return null
  const symbol = stroke.symbolPaths?.length
  const reach = symbol
    ? stroke.baseWidth * Math.SQRT2 + 2
    : inkStrokeBitmapWidth(stroke, 1, 1) * 0.75 * 1.5 + 2
  return { x0: x0 - reach, y0: y0 - reach, x1: x1 + reach, y1: y1 + reach }
}

/**
 * Appends the operators of one stroke to `out`.
 * Returns false when the stroke needs a stamp painter (symbols), which the
 * caller draws itself.
 */
export const emitStroke = (
  out: string[],
  res: InkResources,
  input: ExportInkStroke,
  width: number,
  height: number,
  smoothing: number,
): boolean => {
  let stroke = input
  if (!stroke.points.length || !(width > 0) || !(height > 0)) return true
  if (stroke.symbolPaths?.length) return false
  // The stored stroke keeps the lift hook; the paint view leaves it out.
  if (stroke.points.length > 1) {
    const last = stroke.points[stroke.points.length - 1]
    const nib = inkStrokeBitmapWidth(stroke, last.pressure ?? 0.5, 1)
    const keep = inkQuickTurnKeep(stroke.points, width, height, nib)
    if (keep < stroke.points.length - 1) stroke = { ...stroke, points: stroke.points.slice(0, keep + 1) }
  }
  const points = stroke.points
  const { brush, opacity, passes } = inkBrushPlan(stroke)
  const color = rgbOperands(parseInkColor(stroke.color))
  const blend: 'Normal' | 'Multiply' = brush === 'highlighter' ? 'Multiply' : 'Normal'
  const constantWidth = !stroke.pressureEnabled
  const first = points[0]
  const px = (index: number) => points[index].x * width
  const py = (index: number) => points[index].y * height

  const nibBetween = (a: InkPaintPoint, b: InkPaintPoint) => inkStrokeBitmapWidth(
    stroke,
    ((a.pressure ?? 0.5) + (b.pressure ?? 0.5)) / 2,
    1,
  )
  const segmentWidth = (index: number, factor: number) => nibBetween(points[index - 1], points[index]) * factor

  if (points.length === 1) {
    if (brush === 'spray') {
      emitSpray(out, res, stroke, width, height, opacity, color)
      return true
    }
    const radius = inkStrokeBitmapWidth(stroke, first.pressure ?? 0.5, 1) / 2
    const alpha = brush === 'highlighter' ? opacity * 0.32 : opacity
    const path = new PathOps()
    if (brush === 'calligraphy') {
      const nib = inkStrokeBitmapWidth(stroke, first.pressure ?? 0.5, 1)
      // An ellipse turned by -0.22 pi: a rotated circle scaled in y.
      const angle = -Math.PI * 0.22
      const cos = Math.cos(angle)
      const sin = Math.sin(angle)
      const ry = Math.max(0.5, nib * 0.16)
      out.push(`q ${alpha < 0.999 ? `/${res.gs(alpha, 'Normal')} gs ` : ''}${color} rg ${fmt3(cos)} ${fmt3(sin)} ${fmt3(-sin)} ${fmt3(cos)} ${fmt(px(0))} ${fmt(py(0))} cm`)
      path.circle(0, 0, 1)
      out.push(`${fmt3(nib / 2)} 0 0 ${fmt3(ry)} 0 0 cm`, path.take(), 'f', 'Q')
      return true
    }
    path.circle(px(0), py(0), radius)
    out.push(`q ${alpha < 0.999 ? `/${res.gs(alpha, blend)} gs ` : ''}${color} rg`, path.take(), 'f', 'Q')
    return true
  }

  if (brush === 'spray') {
    emitSpray(out, res, stroke, width, height, opacity, color)
    return true
  }

  const lastSegment = points.length
  const firstSegment = 1

  /** Where the segment that arrives at `sampleIndex` ends (see drawInkStroke). */
  const ends = new Map<number, { x: number; y: number }>()
  const segmentEnd = (sampleIndex: number, pointCount: number) => {
    // Every segment asks for both of its ends and the next one asks again.
    if (pointCount === points.length) {
      const known = ends.get(sampleIndex)
      if (known) return known
      const made = segmentEndAt(sampleIndex, pointCount)
      ends.set(sampleIndex, made)
      return made
    }
    return segmentEndAt(sampleIndex, pointCount)
  }
  const segmentEndAt = (sampleIndex: number, pointCount: number) => {
    const sx = px(sampleIndex)
    const sy = py(sampleIndex)
    if (!(smoothing > 0) || sampleIndex >= pointCount - 1) return { x: sx, y: sy }
    const nx = px(sampleIndex + 1)
    const ny = py(sampleIndex + 1)
    const before = sampleIndex > 0 ? points[sampleIndex - 1] : points[sampleIndex]
    const pull = inkInteriorPull(
      smoothing,
      Math.hypot(nx - sx, ny - sy),
      Math.min(nibBetween(before, points[sampleIndex]), nibBetween(points[sampleIndex], points[sampleIndex + 1])),
    )
    return { x: sx + (nx - sx) * pull * 0.5, y: sy + (ny - sy) * pull * 0.5 }
  }

  const segmentCurve = (index: number, offX: number, offY: number, target: PathOps, connected: boolean, pointCount = points.length) => {
    const pointX = px(index)
    const pointY = py(index)
    const start = index <= 1 ? { x: px(0), y: py(0) } : segmentEnd(index - 1, pointCount)
    if (!connected) target.moveTo(start.x + offX, start.y + offY)
    if (smoothing > 0 && index < pointCount - 1) {
      const end = segmentEnd(index, pointCount)
      if (Math.hypot(end.x - pointX, end.y - pointY) > 0.15) {
        target.quadraticCurveTo(pointX + offX, pointY + offY, end.x + offX, end.y + offY)
        return
      }
    }
    target.lineTo(pointX + offX, pointY + offY)
  }

  const passOffset = (jitter: number | undefined, passIndex: number, index: number): [number, number] => {
    if (!jitter) return [0, 0]
    const seed = (stroke.textureSeed ?? 1) + index * 53 + (passIndex - 1) * 2
    return [(seededUnit(seed) - 0.5) * jitter, (seededUnit(seed + 1) - 0.5) * jitter]
  }

  /** One stroked path per run of segments with the same (0.1 px) width. */
  const segmentRuns = (factor: number, jitter: number | undefined, passIndex: number) => {
    const target: string[] = []
    let path: PathOps | null = null
    let runWidth = -1
    let endX = Number.NaN
    let endY = Number.NaN
    const flush = () => {
      if (!path) return
      target.push(`${fmt(runWidth)} w`, path.take(), 'S')
      path = null
    }
    for (let index = firstSegment; index < lastSegment; index += 1) {
      const previous = points[index - 1]
      const point = points[index]
      if (Math.hypot((point.x - previous.x) * width, (point.y - previous.y) * height) < 0.2) continue
      const [offX, offY] = passOffset(jitter, passIndex, index)
      const widthNow = Math.round(segmentWidth(index, factor) * 10) / 10 || 0.1
      const start = index <= 1 ? { x: px(0), y: py(0) } : segmentEnd(index - 1, points.length)
      const joins = path && !jitter && widthNow === runWidth && Math.abs(start.x - endX) < 0.01 && Math.abs(start.y - endY) < 0.01
      if (!joins) {
        flush()
        path = new PathOps()
        runWidth = widthNow
      }
      segmentCurve(index, offX, offY, path!, Boolean(joins))
      const end = index < points.length - 1 && smoothing > 0 ? segmentEnd(index, points.length) : { x: px(index), y: py(index) }
      endX = Math.hypot(end.x - px(index), end.y - py(index)) > 0.15 ? end.x : px(index)
      endY = Math.hypot(end.x - px(index), end.y - py(index)) > 0.15 ? end.y : py(index)
    }
    flush()
    return target.join('\n')
  }

  /** Constant width: the whole stroke is one path (bends are joins, not seams). */
  const wholePath = (factor: number) => {
    const lineWidth = segmentWidth(firstSegment, factor)
    let end = lastSegment
    if (end - 1 > firstSegment) {
      const stub = Math.hypot((points[end - 1].x - points[end - 2].x) * width, (points[end - 1].y - points[end - 2].y) * height)
      if (stub < lineWidth * 0.3) end -= 1
    }
    const path = new PathOps()
    for (let index = firstSegment; index < end; index += 1) segmentCurve(index, 0, 0, path, index > firstSegment, end)
    return `${fmt(Math.max(0.1, lineWidth))} w\n${path.take()}\nS`
  }

  /** Marker centerline: a quadratic fillet inside each corner, ending on the last sample. */
  const markerPath = () => {
    const lineWidth = segmentWidth(Math.min(firstSegment, points.length - 1), 1)
    const from = 0
    const to = points.length - 1
    const path = new PathOps()
    path.moveTo(px(from), py(from))
    const radius = lineWidth / 2
    const smooth = clamp(smoothing, 0, 1)
    if (smooth <= 0 || to - from < 2) {
      for (let index = from + 1; index <= to; index += 1) path.lineTo(px(index), py(index))
      return `${fmt(Math.max(0.1, lineWidth))} w\n${path.take()}\nS`
    }
    let cursorX = px(from)
    let cursorY = py(from)
    for (let index = from + 1; index < to; index += 1) {
      const ax = px(index - 1)
      const ay = py(index - 1)
      const bx = px(index)
      const by = py(index)
      const cx = px(index + 1)
      const cy = py(index + 1)
      const inX = bx - ax
      const inY = by - ay
      const outX = cx - bx
      const outY = cy - by
      const inLen = Math.hypot(inX, inY)
      const outLen = Math.hypot(outX, outY)
      if (inLen < 0.01 || outLen < 0.01) {
        path.lineTo(bx, by)
        cursorX = bx
        cursorY = by
        continue
      }
      const dot = clamp((inX * outX + inY * outY) / (inLen * outLen), -1, 1)
      const turn = Math.acos(dot)
      const sinHalf = Math.sin(turn / 2)
      let trim = 0
      if (sinHalf > 0.02) {
        const maxByNib = (1.7 * radius) / sinHalf
        const maxByLeg = 0.45 * Math.min(inLen, outLen)
        trim = Math.min(maxByNib, maxByLeg) * smooth
      }
      if (trim < 0.75) {
        path.lineTo(bx, by)
        cursorX = bx
        cursorY = by
        continue
      }
      const startX = bx - (inX / inLen) * trim
      const startY = by - (inY / inLen) * trim
      const endX = bx + (outX / outLen) * trim
      const endY = by + (outY / outLen) * trim
      if (Math.hypot(startX - cursorX, startY - cursorY) > 0.4) path.lineTo(startX, startY)
      path.quadraticCurveTo(bx, by, endX, endY)
      cursorX = endX
      cursorY = endY
    }
    path.lineTo(px(to), py(to))
    return `${fmt(Math.max(0.1, lineWidth))} w\n${path.take()}\nS`
  }

  /** Calligraphy: one flat nib quad per segment, all wound the same way so the union fills. */
  const calligraphyPath = () => {
    const path = new PathOps()
    for (let index = firstSegment; index < lastSegment; index += 1) {
      const nib = nibBetween(points[index - 1], points[index])
      const nibX = Math.cos(-Math.PI * 0.22) * nib / 2
      const nibY = Math.sin(-Math.PI * 0.22) * nib / 2
      const ax = px(index - 1)
      const ay = py(index - 1)
      const bx = px(index)
      const by = py(index)
      const quad: Array<[number, number]> = [[ax + nibX, ay + nibY], [bx + nibX, by + nibY], [bx - nibX, by - nibY], [ax - nibX, ay - nibY]]
      let area = 0
      for (let at = 0; at < 4; at += 1) {
        const [x0, y0] = quad[at]
        const [x1, y1] = quad[(at + 1) % 4]
        area += x0 * y1 - x1 * y0
      }
      if (area < 0) quad.reverse()
      path.moveTo(quad[0][0], quad[0][1])
      for (let at = 1; at < 4; at += 1) path.lineTo(quad[at][0], quad[at][1])
      path.parts.push('h')
    }
    return path.take()
  }

  const isMarker = brush === 'marker'
  const isCalligraphy = brush === 'calligraphy'

  passes.forEach((pass, passIndex) => {
    const alpha = opacity * pass.alpha
    const translucent = alpha < 0.999
    const cap = brush === 'highlighter' && constantWidth ? 0 : 1
    const setup = `${color} RG ${color} rg 1 j`
    if (isCalligraphy) {
      const body = calligraphyPath()
      if (!translucent) out.push(`q ${setup}`, body, 'f', 'Q')
      else out.push(`q /${res.gs(alpha, blend)} gs ${setup}`, body, 'f', 'Q')
      return
    }
    const build = () => {
      if (isMarker) return markerPath()
      if (constantWidth && !pass.jitter) return wholePath(pass.widthFactor)
      return segmentRuns(pass.widthFactor, pass.jitter, passIndex)
    }
    if (!translucent) {
      out.push(`q ${setup} 1 J`, build(), 'Q')
      return
    }
    if (constantWidth && !isMarker && !pass.jitter) {
      out.push(`q /${res.gs(alpha, blend)} gs ${setup} ${cap} J`, build(), 'Q')
      return
    }
    // One composite of the whole stroke: a group keeps overlaps of segments from darkening.
    const box = strokeBox(stroke, width, height)
    if (!box) return
    const content = `${setup} 1 J\n${build()}`
    const name = res.group(content, [box.x0, box.y0, box.x1, box.y1])
    out.push(`q /${res.gs(alpha, blend)} gs /${name} Do Q`)
  })
  return true
}

/** Airbrush: seeded particles, grouped by alpha level so one fill covers many dots. */
const emitSpray = (
  out: string[],
  res: InkResources,
  stroke: ExportInkStroke,
  width: number,
  height: number,
  opacity: number,
  color: string,
) => {
  const points = stroke.points
  const levels = [0.25, 0.4, 0.55, 0.7]
  const buckets = levels.map(() => new PathOps())
  const seed = stroke.textureSeed ?? 1
  const particles = Math.round(clamp(stroke.baseWidth * 0.68, 6, 24))
  const spray = (previous: InkPaintPoint, point: InkPaintPoint, index: number) => {
    const previousX = previous.x * width
    const previousY = previous.y * height
    const pointX = point.x * width
    const pointY = point.y * height
    const radius = inkStrokeBitmapWidth(stroke, ((previous.pressure ?? 0.5) + (point.pressure ?? 0.5)) / 2, 1) / 2
    for (let particle = 0; particle < particles; particle += 1) {
      const key = seed + index * 1_009 + particle * 37
      const progress = seededUnit(key + 1)
      const angle = seededUnit(key + 2) * Math.PI * 2
      const spread = Math.sqrt(seededUnit(key + 3)) * radius
      const x = previousX + (pointX - previousX) * progress + Math.cos(angle) * spread
      const y = previousY + (pointY - previousY) * progress + Math.sin(angle) * spread
      const particleRadius = Math.max(0.35, 0.28 + seededUnit(key + 4) * 0.62)
      const alpha = 0.2 + seededUnit(key + 5) * 0.5
      const level = Math.min(levels.length - 1, Math.max(0, Math.round((alpha - 0.25) / 0.15)))
      buckets[level].circle(x, y, particleRadius)
    }
  }
  if (points.length === 1) spray(points[0], points[0], 0)
  for (let index = 1; index < points.length; index += 1) spray(points[index - 1], points[index], index)
  buckets.forEach((bucket, level) => {
    if (!bucket.parts.length) return
    out.push(`q /${res.gs(opacity * levels[level], 'Normal')} gs ${color} rg`, bucket.take(), 'f', 'Q')
  })
}

export { symbolStampLineWidth }
