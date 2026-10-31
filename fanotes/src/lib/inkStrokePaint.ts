import { inkQuickTurnKeep } from './inkTurn'
import { inkStrokePaintScale } from './paperGrow'
import { commitInkPointerSequence, type InkPointerLike } from './inkSampleMap'
import { markdownInkPageBox } from './noteCanvas'

/** A 3.5px pen must occupy at least this many backing-store pixels. */
export const INK_MIN_BITMAP_PX = 1

export type InkPaintPoint = {
  x: number
  y: number
  pressure?: number
}

export type InkPaintStroke = {
  points: InkPaintPoint[]
  baseWidth: number
  pressureEnabled?: boolean
  color: string
  purpose?: 'handwriting' | 'art'
  brush?: string
  colorEffect?: string
  opacity?: number
  textureSeed?: number
  symbolRotation?: number
  symbolPaths?: readonly string[]
  /** Math-figure line thickness in page units. Omitted stamps keep the 1.75 icon stroke. */
  figureLineWidth?: number
  /**
   * Marker and Textmarker only. When set, this stroke does not recolor pixels
   * already covered by an earlier marker or Textmarker.
   */
  keepColor?: boolean
}

/** Device-pixel coverage of marker and Textmarker ink. 0 empty, 1 claimed. */
export type MarkerCoverage = {
  width: number
  height: number
  mask: Uint8Array
}

export type InkPaintOptions = {
  coverage?: MarkerCoverage | null
  /** Write this stroke into the coverage mask. Live paint leaves this off. */
  stamp?: boolean
  /** Device pixels from this canvas's origin to the coverage bitmap's origin. */
  coverageOrigin?: { x: number; y: number }
  /**
   * Paint only this brush pass, fully opaque, and skip the per-stroke alpha
   * composite. The live layer uses it to extend a coverage bitmap by the new
   * segments, then applies each pass alpha once.
   */
  flatPass?: number
  /**
   * Curve a partial range toward points past its last segment. A live bake
   * passes the stroke length so the newest final segment fillets the same way
   * as one full path, instead of ending on a butt at the sample.
   */
  curvePointCount?: number
}

/** Segments actually stroked by `drawInkStroke` since the last consume. */
let inkSegmentPaintCount = 0

const noteInkSegments = (count: number) => {
  if (count > 0) inkSegmentPaintCount += count
}

/** Read and clear the segment-paint counter. */
export const consumeInkSegmentPaints = () => {
  const count = inkSegmentPaintCount
  inkSegmentPaintCount = 0
  return count
}

export const createMarkerCoverage = (width: number, height: number): MarkerCoverage => {
  const w = Math.max(1, Math.ceil(width))
  const h = Math.max(1, Math.ceil(height))
  return { width: w, height: h, mask: new Uint8Array(w * h) }
}

/** Same row move as `shiftInkWindowBitmap`: positive `dy` shifts content down. */
export const shiftMarkerCoverage = (coverage: MarkerCoverage, dy: number) => {
  const shift = Math.trunc(dy)
  if (!shift) return
  const { width, height, mask } = coverage
  const next = new Uint8Array(mask.length)
  if (shift > 0) {
    const rows = height - shift
    if (rows > 0) next.set(mask.subarray(0, rows * width), shift * width)
  } else {
    const up = -shift
    const rows = height - up
    if (rows > 0) next.set(mask.subarray(up * width), 0)
  }
  mask.set(next)
}

type MarkerGuard = {
  mask: Uint8Array
  width: number
  height: number
  originX: number
  originY: number
  keep: boolean
  stamp: boolean
  touched: boolean
  x0: number
  y0: number
  x1: number
  y1: number
}

const beginMarkerGuard = (
  coverage: MarkerCoverage,
  origin: { x: number; y: number } | undefined,
  keep: boolean,
  stamp: boolean,
): MarkerGuard => ({
  mask: coverage.mask,
  width: coverage.width,
  height: coverage.height,
  originX: Math.round(origin?.x ?? 0),
  originY: Math.round(origin?.y ?? 0),
  keep,
  stamp,
  touched: false,
  x0: coverage.width,
  y0: coverage.height,
  x1: -1,
  y1: -1,
})

const markerPixelBlocked = (guard: MarkerGuard, x: number, y: number) => {
  if (!guard.keep) return false
  const mx = Math.round(x) + guard.originX
  const my = Math.round(y) + guard.originY
  if (mx < 0 || my < 0 || mx >= guard.width || my >= guard.height) return false
  return guard.mask[my * guard.width + mx] === 1
}

const claimMarkerPixel = (guard: MarkerGuard, x: number, y: number) => {
  if (!guard.stamp) return
  const mx = Math.round(x) + guard.originX
  const my = Math.round(y) + guard.originY
  if (mx < 0 || my < 0 || mx >= guard.width || my >= guard.height) return
  const index = my * guard.width + mx
  if (guard.mask[index] !== 0) return
  guard.mask[index] = 2
  guard.touched = true
  if (mx < guard.x0) guard.x0 = mx
  if (my < guard.y0) guard.y0 = my
  if (mx > guard.x1) guard.x1 = mx
  if (my > guard.y1) guard.y1 = my
}

const commitMarkerGuard = (guard: MarkerGuard) => {
  if (!guard.stamp || !guard.touched) return
  const { mask, width, x0, y0, x1, y1 } = guard
  for (let y = y0; y <= y1; y += 1) {
    let index = y * width + x0
    for (let x = x0; x <= x1; x += 1, index += 1) {
      if (mask[index] === 2) mask[index] = 1
    }
  }
}

const markerBrush = (brush: string) => brush === 'marker' || brush === 'highlighter'

type InkPaintContext = CanvasRenderingContext2D

const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value))

/**
 * How far an interior segment slides its end off the sample toward the next
 * midpoint. `smoothing` 0 stays on the polyline; 1 pulls 85% of the way.
 * The slide is capped so the sample stays inside the nib: a sharp corner
 * cannot bow past the pen, and the open tip cannot leave the last sample.
 */
export const inkInteriorPull = (smoothing: number, legPx: number, nibPx: number) => {
  const wanted = clamp(smoothing, 0, 1) * 0.85
  if (!(legPx > 0.01) || !(nibPx > 0)) return wanted
  return Math.min(wanted, (nibPx * 0.35) / legPx)
}

export const pressureWidth = (stroke: { baseWidth: number; pressureEnabled?: boolean }, pressure: number) => {
  if (!stroke.pressureEnabled) return stroke.baseWidth
  return stroke.baseWidth * (0.4 + Math.max(0.08, pressure) * 1.12)
}

const seededUnit = (seed: number) => {
  const value = Math.sin(seed * 12.9898 + 78.233) * 43_758.5453
  return value - Math.floor(value)
}

const SPECIAL_INK_STOPS: Record<string, ReadonlyArray<readonly [number, string]>> = {
  rainbow: [[0, '#ff4d6d'], [.17, '#ffb13b'], [.34, '#e9e34a'], [.51, '#48ce87'], [.68, '#3aa8ff'], [.84, '#815cff'], [1, '#e84dba']],
  aurora: [[0, '#68f6ca'], [.34, '#32b9ef'], [.68, '#7968f4'], [1, '#e85bd2']],
  sunset: [[0, '#ffcf59'], [.36, '#ff754e'], [.68, '#d84dba'], [1, '#694ee8']],
  ocean: [[0, '#62ead5'], [.36, '#1eb6db'], [.7, '#2671df'], [1, '#4036a9']],
  gold: [[0, '#7c5013'], [.24, '#f7d779'], [.5, '#b27620'], [.76, '#fff0a8'], [1, '#8b5914']],
  silver: [[0, '#59616d'], [.24, '#f5f7fb'], [.5, '#8b929d'], [.76, '#ffffff'], [1, '#626975']],
  neon: [[0, '#45ffe6'], [.34, '#5e8bff'], [.68, '#db55ff'], [1, '#ff4ba8']],
}

const strokePaint = (
  context: InkPaintContext,
  stroke: InkPaintStroke,
  width: number,
  height: number,
) => {
  const effect = stroke.colorEffect ?? 'solid'
  if (effect === 'solid') return stroke.color
  const stops = SPECIAL_INK_STOPS[effect]
  if (!stops) return stroke.color
  const gradient = context.createLinearGradient(0, height * .08, width, height * .28)
  stops.forEach(([offset, color]) => gradient.addColorStop(offset, color))
  return gradient
}

/** Icon-space stroke used when a stamp has no separate line thickness. */
export const FIGURE_ICON_STROKE = 1.75

/**
 * Stroke width inside the 24×24 stamp. A figure stores thickness in page
 * units, so changing the stamp size does not change the line.
 */
export const symbolStampLineWidth = (
  stroke: Pick<InkPaintStroke, 'baseWidth' | 'figureLineWidth'>,
) => {
  const page = stroke.figureLineWidth
  if (page == null || !(page > 0) || !(stroke.baseWidth > 0)) return FIGURE_ICON_STROKE
  return page * 24 / stroke.baseWidth
}

/** Bitmap px for a CSS pen so a normal stroke cannot collapse to a hairline. */
export const inkStrokeBitmapWidth = (
  stroke: { baseWidth: number; pressureEnabled?: boolean },
  pressure: number,
  scale: number,
) => Math.max(INK_MIN_BITMAP_PX, pressureWidth(stroke, pressure) * scale)

/**
 * How far (bitmap px) any paint of this stroke can reach from its points:
 * the widest pressure at the widest brush pass (watercolor, 1.48), the neon
 * glow (a shadow blur fades out over about twice its radius), a symbol
 * stamp's diagonal. Callers use it to clear and repaint only what a segment
 * can have touched.
 */
export const inkStrokePaintMargin = (
  stroke: Pick<InkPaintStroke, 'baseWidth' | 'pressureEnabled' | 'colorEffect' | 'symbolPaths' | 'brush' | 'purpose' | 'figureLineWidth'>,
  scale: number,
) => {
  if (stroke.symbolPaths?.length) {
    const extra = Math.max(0, symbolStampLineWidth(stroke) - FIGURE_ICON_STROKE) * stroke.baseWidth * scale / 24
    return stroke.baseWidth * scale * Math.SQRT2 + extra / 2 + 2
  }
  const widest = inkStrokeBitmapWidth(stroke, 1, scale) * 1.5
  const glow = stroke.colorEffect === 'neon' ? Math.max(4, stroke.baseWidth * scale * .85) * 2 : 0
  return widest / 2 + glow + 2
}

type InkPaintPass = {
  widthFactor: number
  alpha: number
  /** Pencil grain: per-segment offset in bitmap px per unit scale. */
  jitter?: number
}

const OPAQUE_PASS: readonly InkPaintPass[] = [{ widthFactor: 1, alpha: 1 }]

/**
 * Stroked passes of a brush, widest first. A pass with alpha below 1 is
 * composited as one shape (see `inkStrokeIsTranslucent`).
 */
const brushPasses = (brush: string): readonly InkPaintPass[] => {
  switch (brush) {
    case 'pencil':
      return [
        { widthFactor: .72, alpha: .58 },
        { widthFactor: .22, alpha: .2, jitter: 1.4 },
        { widthFactor: .18, alpha: .14, jitter: 1.8 },
      ]
    case 'paintbrush':
      return [{ widthFactor: 1.4, alpha: .16 }, { widthFactor: .92, alpha: .82 }]
    case 'highlighter':
      return [{ widthFactor: 1, alpha: .34 }]
    case 'watercolor':
      return [{ widthFactor: 1.48, alpha: .11 }, { widthFactor: 1.14, alpha: .17 }, { widthFactor: .78, alpha: .27 }]
    case 'marker':
      return [{ widthFactor: 1, alpha: .9 }]
    default:
      return OPAQUE_PASS
  }
}

const inkBrushOf = (stroke: Pick<InkPaintStroke, 'purpose' | 'brush'>) => (
  stroke.purpose === 'art' ? stroke.brush ?? 'fineliner' : 'fineliner'
)

const inkOpacityOf = (stroke: Pick<InkPaintStroke, 'purpose' | 'opacity'>) => (
  stroke.purpose === 'art' ? clamp(stroke.opacity ?? 1, .08, 1) : 1
)

/**
 * A stroke whose paint is see-through. Segments of such a stroke must not be
 * painted one by one on the visible bitmap: every place two segments meet
 * (round caps, a bend of a butt-capped highlighter) is covered twice and shows
 * as a dark band — the "lines inside the marker". The whole stroke is painted
 * opaque on a scratch layer and composited once. The live layer keeps that
 * coverage and appends only the new segments, then applies the pass alpha once
 * per pixel instead of stroking the whole mark again.
 */
export const inkStrokeIsTranslucent = (
  stroke: Pick<InkPaintStroke, 'purpose' | 'brush' | 'opacity' | 'symbolPaths'>,
) => {
  if (stroke.purpose !== 'art') return false
  if (stroke.symbolPaths?.length) return false
  const brush = inkBrushOf(stroke)
  if (brush === 'spray') return false
  const opacity = inkOpacityOf(stroke)
  if (opacity < .999) return true
  return brushPasses(brush).some((pass) => pass.alpha < .999)
}

/** Per-pass alpha of a see-through stroke. Null when the stroke is opaque. */
export const translucentPassAlphas = (
  stroke: Pick<InkPaintStroke, 'purpose' | 'brush' | 'opacity' | 'symbolPaths'>,
): readonly number[] | null => {
  if (!inkStrokeIsTranslucent(stroke)) return null
  const opacity = inkOpacityOf(stroke)
  return brushPasses(inkBrushOf(stroke)).map((pass) => opacity * pass.alpha)
}

type InkScratchCanvas = { width: number; height: number; getContext: (kind: '2d') => InkPaintContext | null }
let scratchCanvas: InkScratchCanvas | null = null
let scratchContext: InkPaintContext | null = null

/** Scratch layer for translucent passes; null where no canvas exists (Node checks). */
const acquireScratch = (width: number, height: number): InkPaintContext | null => {
  const w = Math.max(1, Math.ceil(width))
  const h = Math.max(1, Math.ceil(height))
  try {
    if (!scratchCanvas || scratchCanvas.width < w || scratchCanvas.height < h) {
      const nextW = Math.max(w, scratchCanvas?.width ?? 0)
      const nextH = Math.max(h, scratchCanvas?.height ?? 0)
      const host = globalThis as typeof globalThis & {
        OffscreenCanvas?: new (width: number, height: number) => OffscreenCanvas
        document?: Document
      }
      let canvas: InkScratchCanvas | null = null
      if (host.OffscreenCanvas) {
        canvas = new host.OffscreenCanvas(nextW, nextH) as unknown as InkScratchCanvas
      } else if (host.document?.createElement) {
        const element = host.document.createElement('canvas')
        element.width = nextW
        element.height = nextH
        canvas = element as unknown as InkScratchCanvas
      }
      if (!canvas) return null
      const context = canvas.getContext('2d')
      if (!context || typeof (context as { drawImage?: unknown }).drawImage !== 'function') return null
      scratchCanvas = canvas
      scratchContext = context
    }
    return scratchContext
  } catch {
    return null
  }
}

const canComposite = (context: InkPaintContext) => (
  typeof (context as { drawImage?: unknown }).drawImage === 'function'
  && typeof (context as { getTransform?: unknown }).getTransform === 'function'
  && Boolean((context as { canvas?: unknown }).canvas)
)

const knockOutCoveredMarker = (
  scratch: InkPaintContext,
  box: { x: number; y: number; w: number; h: number },
  guard: MarkerGuard,
) => {
  const scratchCtx = scratch as CanvasRenderingContext2D
  if (typeof scratchCtx.getImageData !== 'function' || typeof scratchCtx.drawImage !== 'function') return
  const host = globalThis as typeof globalThis & {
    OffscreenCanvas?: new (width: number, height: number) => OffscreenCanvas
    document?: Document
  }
  const w = Math.max(1, Math.ceil(box.w))
  const h = Math.max(1, Math.ceil(box.h))
  let canvas: HTMLCanvasElement | OffscreenCanvas | null = null
  if (host.OffscreenCanvas) canvas = new host.OffscreenCanvas(w, h)
  else if (host.document?.createElement) {
    const element = host.document.createElement('canvas')
    element.width = w
    element.height = h
    canvas = element
  }
  if (!canvas) return
  const punch = canvas.getContext('2d')
  if (!punch) return
  const image = punch.createImageData(w, h)
  const { mask, width, height, originX, originY } = guard
  let covered = 0
  for (let y = 0; y < h; y += 1) {
    const my = box.y + y + originY
    if (my < 0 || my >= height) continue
    for (let x = 0; x < w; x += 1) {
      const mx = box.x + x + originX
      if (mx < 0 || mx >= width) continue
      if (mask[my * width + mx] !== 1) continue
      image.data[(y * w + x) * 4 + 3] = 255
      covered += 1
    }
  }
  if (!covered) return
  punch.putImageData(image, 0, 0)
  scratchCtx.save()
  scratchCtx.setTransform(1, 0, 0, 1, 0, 0)
  scratchCtx.globalCompositeOperation = 'destination-out'
  scratchCtx.globalAlpha = 1
  scratchCtx.drawImage(canvas, 0, 0)
  scratchCtx.restore()
}

const stampScratchCoverage = (
  scratch: InkPaintContext,
  box: { x: number; y: number; w: number; h: number },
  guard: MarkerGuard,
) => {
  if (!guard.stamp) return
  const scratchCtx = scratch as CanvasRenderingContext2D
  if (typeof scratchCtx.getImageData !== 'function') return
  const w = Math.max(1, Math.ceil(box.w))
  const h = Math.max(1, Math.ceil(box.h))
  const image = scratchCtx.getImageData(0, 0, w, h)
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (image.data[(y * w + x) * 4 + 3] < 8) continue
      claimMarkerPixel(guard, box.x + x, box.y + y)
    }
  }
}

/**
 * One paint path for live/committed ink. Tests call this — a missing line is a
 * failed pixel assertion, not a CSS-scale guess. Segments `startSegment` up to
 * (excluding) `endSegment` are painted; a segment's smoothing looks at the
 * point after it in the full `points` array, so a range paints exactly like
 * the same segments inside a whole-stroke paint.
 */
export const drawInkStroke = (
  context: InkPaintContext,
  stroke: InkPaintStroke,
  width: number,
  height: number,
  smoothing: number,
  startSegment = 1,
  sourceWidth = 900,
  layoutWidth = 0,
  endSegment = stroke.points.length,
  options?: InkPaintOptions,
  trimLiftHook = true,
) => {
  if (stroke.points.length === 0) return
  if (!(width > 0) || !(height > 0)) return
  const layout = layoutWidth > 1 ? layoutWidth : width
  const scale = inkStrokePaintScale(width, layout > 1 ? layout : sourceWidth)
  // The stored stroke keeps the lift hook (recognition). A paint of the
  // current end leaves that hook out, once: the shortened view does not trim again.
  if (trimLiftHook && endSegment >= stroke.points.length && stroke.points.length > 1 && !stroke.symbolPaths?.length) {
    const last = stroke.points[stroke.points.length - 1]
    const nib = inkStrokeBitmapWidth(stroke, last.pressure ?? 0.5, scale)
    const keep = inkQuickTurnKeep(stroke.points, width, height, nib)
    if (keep < stroke.points.length - 1) {
      drawInkStroke(
        context,
        { ...stroke, points: stroke.points.slice(0, keep + 1) },
        width,
        height,
        smoothing,
        startSegment,
        sourceWidth,
        layoutWidth,
        Math.min(endSegment, keep + 1),
        options,
        false,
      )
      return
    }
  }
  const lastSegment = Math.min(endSegment, stroke.points.length)
  if (stroke.points.length > 1 && lastSegment <= Math.max(1, startSegment)) return
  const first = stroke.points[0]
  const brush = inkBrushOf(stroke)
  const opacity = inkOpacityOf(stroke)
  const paint = strokePaint(context, stroke, width, height)
  const markerLike = markerBrush(brush)
  const guard = options?.coverage && markerLike
    ? beginMarkerGuard(options.coverage, options.coverageOrigin, stroke.keepColor === true, options.stamp === true)
    : null
  const guardHost = context as InkPaintContext & { setMarkerGuard?: (value: MarkerGuard | null) => void }
  if (guard) guardHost.setMarkerGuard?.(guard)
  try {
  context.save()
  context.strokeStyle = paint
  context.fillStyle = paint
  context.lineCap = 'round'
  context.lineJoin = 'round'
  if (options?.flatPass != null) context.globalCompositeOperation = 'source-over'
  else if (brush === 'highlighter') context.globalCompositeOperation = 'multiply'
  if (stroke.colorEffect === 'neon') {
    context.shadowColor = stroke.color
    context.shadowBlur = Math.max(4, stroke.baseWidth * scale * .85)
  }

  const symbolPaths = stroke.symbolPaths
  if (symbolPaths?.length) {
    const symbolScale = stroke.baseWidth * scale / 24
    context.globalAlpha = opacity
    context.translate(first.x * width, first.y * height)
    context.rotate((stroke.symbolRotation ?? 0) * Math.PI / 180)
    context.scale(symbolScale, symbolScale)
    context.translate(-12, -12)
    context.lineWidth = symbolStampLineWidth(stroke)
    if (typeof Path2D === 'function') {
      symbolPaths.forEach((path) => context.stroke(new Path2D(path)))
    }
    context.restore()
    return
  }

  const spraySegment = (previous: InkPaintPoint, point: InkPaintPoint, index: number) => {
    const previousX = previous.x * width
    const previousY = previous.y * height
    const pointX = point.x * width
    const pointY = point.y * height
    const radius = inkStrokeBitmapWidth(stroke, ((previous.pressure ?? 0.5) + (point.pressure ?? 0.5)) / 2, scale) / 2
    const particles = Math.round(clamp(stroke.baseWidth * .68, 6, 24))
    const seed = stroke.textureSeed ?? 1
    for (let particle = 0; particle < particles; particle += 1) {
      const key = seed + index * 1_009 + particle * 37
      const progress = seededUnit(key + 1)
      const angle = seededUnit(key + 2) * Math.PI * 2
      const spread = Math.sqrt(seededUnit(key + 3)) * radius
      const x = previousX + (pointX - previousX) * progress + Math.cos(angle) * spread
      const y = previousY + (pointY - previousY) * progress + Math.sin(angle) * spread
      const particleRadius = Math.max(.35, scale * (.28 + seededUnit(key + 4) * .62))
      context.globalAlpha = opacity * (.2 + seededUnit(key + 5) * .5)
      context.beginPath()
      context.arc(x, y, particleRadius, 0, Math.PI * 2)
      context.fill()
    }
  }

  const calligraphyNib = (target: InkPaintContext, previous: InkPaintPoint, point: InkPaintPoint) => {
    const previousX = previous.x * width
    const previousY = previous.y * height
    const pointX = point.x * width
    const pointY = point.y * height
    const nibWidth = inkStrokeBitmapWidth(stroke, ((previous.pressure ?? 0.5) + (point.pressure ?? 0.5)) / 2, scale)
    const nibX = Math.cos(-Math.PI * .22) * nibWidth / 2
    const nibY = Math.sin(-Math.PI * .22) * nibWidth / 2
    target.beginPath()
    target.moveTo(previousX + nibX, previousY + nibY)
    target.lineTo(pointX + nibX, pointY + nibY)
    target.lineTo(pointX - nibX, pointY - nibY)
    target.lineTo(previousX - nibX, previousY - nibY)
    target.closePath()
    target.fill()
  }
  const calligraphySegment = (previous: InkPaintPoint, point: InkPaintPoint) => {
    context.globalAlpha = opacity
    calligraphyNib(context, previous, point)
  }

  if (stroke.points.length === 1 && startSegment <= 1) {
    if (brush === 'spray') {
      spraySegment(first, first, 0)
    } else if (brush === 'calligraphy') {
      const nibWidth = inkStrokeBitmapWidth(stroke, first.pressure ?? 0.5, scale)
      context.globalAlpha = opacity
      context.beginPath()
      context.ellipse(first.x * width, first.y * height, nibWidth / 2, Math.max(.5, nibWidth * .16), -Math.PI * .22, 0, Math.PI * 2)
      context.fill()
    } else {
      context.globalAlpha = options?.flatPass != null
        ? 1
        : (brush === 'highlighter' ? opacity * .32 : opacity)
      context.beginPath()
      context.arc(
        first.x * width,
        first.y * height,
        inkStrokeBitmapWidth(stroke, first.pressure ?? 0.5, scale) / 2,
        0,
        Math.PI * 2,
      )
      context.fill()
      noteInkSegments(1)
    }
    context.restore()
    return
  }

  const firstSegment = Math.max(1, startSegment)
  if (brush === 'spray') {
    for (let index = firstSegment; index < lastSegment; index += 1) {
      spraySegment(stroke.points[index - 1], stroke.points[index], index)
    }
    context.restore()
    return
  }

  const nibBetween = (a: InkPaintPoint, b: InkPaintPoint) => inkStrokeBitmapWidth(
    stroke,
    ((a.pressure ?? 0.5) + (b.pressure ?? 0.5)) / 2,
    scale,
  )
  /**
   * Where the segment that arrives at `sampleIndex` ends. Interior segments
   * stop a nib-limited step toward the next sample; the open tip stops on
   * the sample itself. The next piece starts at this same point, so a new
   * sample cannot leave a step or a hook in the previous direction.
   */
  const segmentEnd = (sampleIndex: number, pointCount: number) => {
    const sample = stroke.points[sampleIndex]
    const sx = sample.x * width
    const sy = sample.y * height
    if (!(smoothing > 0) || sampleIndex >= pointCount - 1) return { x: sx, y: sy }
    const next = stroke.points[sampleIndex + 1]
    const nx = next.x * width
    const ny = next.y * height
    const before = sampleIndex > 0 ? stroke.points[sampleIndex - 1] : sample
    const pull = inkInteriorPull(
      smoothing,
      Math.hypot(nx - sx, ny - sy),
      Math.min(nibBetween(before, sample), nibBetween(sample, next)),
    )
    return { x: sx + (nx - sx) * pull * 0.5, y: sy + (ny - sy) * pull * 0.5 }
  }
  /** Curve of segment `index` (points index-1 → index). */
  const segmentCurve = (
    index: number,
    offsetX: number,
    offsetY: number,
    target: InkPaintContext,
    connected: boolean,
    pointCount = stroke.points.length,
  ) => {
    const point = stroke.points[index]
    const pointX = point.x * width
    const pointY = point.y * height
    const start = index <= 1
      ? { x: stroke.points[0].x * width, y: stroke.points[0].y * height }
      : segmentEnd(index - 1, pointCount)
    if (!connected) target.moveTo(start.x + offsetX, start.y + offsetY)
    if (smoothing > 0 && index < pointCount - 1) {
      const end = segmentEnd(index, pointCount)
      if (Math.hypot(end.x - pointX, end.y - pointY) > 0.15) {
        target.quadraticCurveTo(pointX + offsetX, pointY + offsetY, end.x + offsetX, end.y + offsetY)
        return
      }
    }
    target.lineTo(pointX + offsetX, pointY + offsetY)
  }
  const segmentWidth = (index: number, widthFactor: number) => inkStrokeBitmapWidth(
    stroke,
    ((stroke.points[index - 1].pressure ?? 0.5) + (stroke.points[index].pressure ?? 0.5)) / 2,
    scale,
  ) * widthFactor
  const passOffset = (pass: InkPaintPass, passIndex: number, index: number): [number, number] => {
    if (!pass.jitter) return [0, 0]
    const seed = (stroke.textureSeed ?? 1) + index * 53 + (passIndex - 1) * 2
    return [(seededUnit(seed) - .5) * scale * pass.jitter, (seededUnit(seed + 1) - .5) * scale * pass.jitter]
  }
  /** Direct paint, one `stroke()` per segment, exactly as before. */
  const paintPassSegments = (target: InkPaintContext, pass: InkPaintPass, passIndex: number, alpha: number) => {
    for (let index = firstSegment; index < lastSegment; index += 1) {
      const previous = stroke.points[index - 1]
      const point = stroke.points[index]
      // A round cap on a zero-length segment is a disk. Real samples are at
      // least ~0.35 CSS px apart, so this only skips a duplicate.
      if (Math.hypot((point.x - previous.x) * width, (point.y - previous.y) * height) < 0.2) continue
      const [offsetX, offsetY] = passOffset(pass, passIndex, index)
      target.globalAlpha = alpha
      target.beginPath()
      segmentCurve(index, offsetX, offsetY, target, false)
      target.lineWidth = segmentWidth(index, pass.widthFactor)
      target.stroke()
      noteInkSegments(1)
    }
  }
  /** Constant width: the whole range is one path, so bends are joins, not seams. */
  const paintPassPath = (target: InkPaintContext, pass: InkPaintPass, alpha: number) => {
    target.globalAlpha = alpha
    const lineWidth = segmentWidth(firstSegment, pass.widthFactor)
    target.lineWidth = lineWidth
    // The pen-up sample often sits a pixel or two off the last move; a butt
    // cap on that stub cuts a notch across a wide highlighter. Leave it out.
    let end = lastSegment
    if (end === stroke.points.length && end - 1 > firstSegment) {
      const tail = stroke.points[end - 1]
      const beforeTail = stroke.points[end - 2]
      const stub = Math.hypot((tail.x - beforeTail.x) * width, (tail.y - beforeTail.y) * height)
      if (stub < lineWidth * .3) end -= 1
    }
    target.beginPath()
    // A partial range still has to fillet toward the next known sample. Using
    // `end` made that last segment a line to the point, so a highlighter
    // corner grew a disk the full path never paints.
    const curveCount = Math.max(end, options?.curvePointCount ?? end)
    for (let index = firstSegment; index < end; index += 1) {
      segmentCurve(index, 0, 0, target, index > firstSegment, curveCount)
    }
    target.stroke()
    noteInkSegments(end - firstSegment)
  }

  /**
   * Marker centerline. A quadratic fillet sits inside each corner and the
   * stroke ends on the last sample. The old last-segment control kept going
   * in the previous direction, so a turn ballooned past the nib and then
   * snapped back when the next sample arrived.
   */
  const paintMarkerStroke = (target: InkPaintContext, alpha: number) => {
    target.globalAlpha = alpha
    target.lineJoin = 'round'
    target.lineCap = 'round'
    target.lineWidth = segmentWidth(Math.min(firstSegment, stroke.points.length - 1), 1)
    const from = Math.max(0, firstSegment - 1)
    const to = Math.max(from, lastSegment - 1)
    const px = (index: number) => stroke.points[index].x * width
    const py = (index: number) => stroke.points[index].y * height
    target.beginPath()
    target.moveTo(px(from), py(from))
    if (to === from) {
      target.stroke()
      noteInkSegments(1)
      return
    }
    const radius = target.lineWidth / 2
    const smooth = clamp(smoothing, 0, 1)
    if (smooth <= 0 || to - from < 2) {
      for (let index = from + 1; index <= to; index += 1) target.lineTo(px(index), py(index))
      target.stroke()
      noteInkSegments(to - from)
      return
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
        target.lineTo(bx, by)
        cursorX = bx
        cursorY = by
        continue
      }
      const dot = clamp((inX * outX + inY * outY) / (inLen * outLen), -1, 1)
      const turn = Math.acos(dot)
      const sinHalf = Math.sin(turn / 2)
      let trim = 0
      if (sinHalf > 0.02) {
        // Keep the centerline inside the nib of the sample so the pen point
        // stays covered, and inside each leg so neighbouring fillets cannot cross.
        const maxByNib = (1.7 * radius) / sinHalf
        const maxByLeg = 0.45 * Math.min(inLen, outLen)
        trim = Math.min(maxByNib, maxByLeg) * smooth
      }
      if (trim < 0.75) {
        target.lineTo(bx, by)
        cursorX = bx
        cursorY = by
        continue
      }
      const startX = bx - (inX / inLen) * trim
      const startY = by - (inY / inLen) * trim
      const endX = bx + (outX / outLen) * trim
      const endY = by + (outY / outLen) * trim
      if (Math.hypot(startX - cursorX, startY - cursorY) > 0.4) target.lineTo(startX, startY)
      target.quadraticCurveTo(bx, by, endX, endY)
      cursorX = endX
      cursorY = endY
    }
    target.lineTo(px(to), py(to))
    target.stroke()
    noteInkSegments(to - from)
  }

  const passes = brush === 'calligraphy' ? OPAQUE_PASS : brushPasses(brush)
  const constantWidth = !stroke.pressureEnabled
  const translucent = inkStrokeIsTranslucent(stroke)
  let compositeBox: { x: number; y: number; w: number; h: number; ex: number; ey: number } | null = null
  if (translucent && options?.flatPass == null && canComposite(context)) {
    // Device-pixel box of this range — the samples and one neighbour on
    // each side, since the curve stays inside them — clipped to the bitmap.
    const margin = inkStrokePaintMargin(stroke, scale)
    const transform = context.getTransform()
    const ex = transform.e
    const ey = transform.f
    let x0 = Number.POSITIVE_INFINITY
    let y0 = Number.POSITIVE_INFINITY
    let x1 = Number.NEGATIVE_INFINITY
    let y1 = Number.NEGATIVE_INFINITY
    const include = (px: number, py: number) => {
      if (px < x0) x0 = px
      if (py < y0) y0 = py
      if (px > x1) x1 = px
      if (py > y1) y1 = py
    }
    const last = stroke.points.length - 1
    for (let index = Math.max(0, firstSegment - 2); index <= Math.min(last, lastSegment); index += 1) {
      include(stroke.points[index].x * width, stroke.points[index].y * height)
    }
    const targetCanvas = (context as unknown as { canvas: { width: number; height: number } }).canvas
    const dx0 = Math.max(0, Math.floor(x0 - margin + ex))
    const dy0 = Math.max(0, Math.floor(y0 - margin + ey))
    const dx1 = Math.min(targetCanvas.width, Math.ceil(x1 + margin + ex))
    const dy1 = Math.min(targetCanvas.height, Math.ceil(y1 + margin + ey))
    if (dx1 <= dx0 || dy1 <= dy0) {
      context.restore()
      return
    }
    compositeBox = { x: dx0, y: dy0, w: dx1 - dx0, h: dy1 - dy0, ex, ey }
  }

  passes.forEach((pass, passIndex) => {
    if (options?.flatPass != null && passIndex !== options.flatPass) return
    const alpha = options?.flatPass != null ? 1 : opacity * pass.alpha
    const scratch = options?.flatPass == null && compositeBox && alpha < .999
      ? acquireScratch(compositeBox.w, compositeBox.h)
      : null
    if (scratch && compositeBox) {
      const box = compositeBox
      const source = (scratch as unknown as { canvas: CanvasImageSource }).canvas
      scratch.save()
      scratch.setTransform(1, 0, 0, 1, 0, 0)
      scratch.globalCompositeOperation = 'source-over'
      scratch.globalAlpha = 1
      scratch.clearRect(0, 0, box.w, box.h)
      // Scratch pixel (0,0) is target device pixel (box.x, box.y); user
      // space stays the caller's so points and gradients need no remap.
      scratch.setTransform(1, 0, 0, 1, box.ex - box.x, box.ey - box.y)
      const scratchPaint = strokePaint(scratch, stroke, width, height)
      scratch.strokeStyle = scratchPaint
      scratch.fillStyle = scratchPaint
      scratch.lineJoin = 'round'
      scratch.lineCap = brush === 'highlighter' && constantWidth ? 'butt' : 'round'
      if (brush === 'calligraphy') {
        scratch.globalAlpha = 1
        for (let index = firstSegment; index < lastSegment; index += 1) {
          calligraphyNib(scratch, stroke.points[index - 1], stroke.points[index])
        }
      } else if (brush === 'marker') {
        paintMarkerStroke(scratch, 1)
      } else if (constantWidth) {
        paintPassPath(scratch, pass, 1)
      } else {
        paintPassSegments(scratch, pass, passIndex, 1)
      }
      scratch.restore()
      if (guard?.keep) knockOutCoveredMarker(scratch, box, guard)
      const restoreTransform = context.getTransform()
      context.setTransform(1, 0, 0, 1, 0, 0)
      context.globalAlpha = alpha
      context.drawImage(source, 0, 0, box.w, box.h, box.x, box.y, box.w, box.h)
      context.setTransform(restoreTransform)
      if (guard && !guardHost.setMarkerGuard) stampScratchCoverage(scratch, box, guard)
      return
    }
    if (brush === 'calligraphy') {
      for (let index = firstSegment; index < lastSegment; index += 1) {
        calligraphySegment(stroke.points[index - 1], stroke.points[index])
      }
      return
    }
    if (brush === 'marker') {
      paintMarkerStroke(context, alpha)
      return
    }
    if (brush === 'highlighter') context.lineCap = 'butt'
    // A flat coverage pass is one path, same as the scratch composite, so a
    // constant-width highlighter does not seam while the alpha is still 1.
    if (options?.flatPass != null && constantWidth) {
      paintPassPath(context, pass, alpha)
      return
    }
    paintPassSegments(context, pass, passIndex, alpha)
  })
  context.restore()
  } finally {
    if (guard) {
      commitMarkerGuard(guard)
      guardHost.setMarkerGuard?.(null)
    }
  }
}

const parseCssColor = (value: string | CanvasGradient): [number, number, number, number] => {
  if (typeof value !== 'string') return [32, 35, 51, 1]
  const hex = value.trim()
  if (/^#[\da-f]{6}$/iu.test(hex)) {
    return [
      Number.parseInt(hex.slice(1, 3), 16),
      Number.parseInt(hex.slice(3, 5), 16),
      Number.parseInt(hex.slice(5, 7), 16),
      1,
    ]
  }
  if (/^#[\da-f]{3}$/iu.test(hex)) {
    return [
      Number.parseInt(hex[1] + hex[1], 16),
      Number.parseInt(hex[2] + hex[2], 16),
      Number.parseInt(hex[3] + hex[3], 16),
      1,
    ]
  }
  return [32, 35, 51, 1]
}

type ReadbackPathCmd =
  | { kind: 'move'; x: number; y: number }
  | { kind: 'line'; x: number; y: number }
  | { kind: 'quad'; cpx: number; cpy: number; x: number; y: number }
  | { kind: 'close' }
  | { kind: 'arc'; x: number; y: number; radius: number }
  | { kind: 'ellipse'; x: number; y: number; rx: number; ry: number; rotation: number }

export type InkReadbackSurface = {
  width: number
  height: number
  context: InkPaintContext
  getImageData: (x?: number, y?: number, w?: number, h?: number) => ImageData
}

/**
 * Offscreen paint target for checks. Uses a real canvas when the host has one;
 * otherwise a software round-cap rasterizer so Node can assert opaque pixels.
 */
export const createInkReadbackContext = (width: number, height: number): InkReadbackSurface => {
  const w = Math.max(1, Math.round(width))
  const h = Math.max(1, Math.round(height))
  const host = globalThis as typeof globalThis & {
    OffscreenCanvas?: new (width: number, height: number) => OffscreenCanvas
    document?: Document
  }
  try {
    const canvas = host.OffscreenCanvas
      ? new host.OffscreenCanvas(w, h)
      : host.document?.createElement('canvas') ?? null
    if (canvas) {
      if (!('OffscreenCanvas' in host) && 'width' in canvas) {
        (canvas as HTMLCanvasElement).width = w
        ;(canvas as HTMLCanvasElement).height = h
      }
      const context = (canvas as HTMLCanvasElement | OffscreenCanvas).getContext('2d', { alpha: true }) as CanvasRenderingContext2D | null
      if (context) {
        return {
          width: w,
          height: h,
          context: context as unknown as InkPaintContext,
          getImageData: (x = 0, y = 0, sliceW = w, sliceH = h) => context.getImageData(x, y, sliceW, sliceH),
        }
      }
    }
  } catch {
    // Fall through to the software rasterizer.
  }

  const data = new Uint8ClampedArray(w * h * 4)
  type Style = {
    strokeStyle: string | CanvasGradient
    fillStyle: string | CanvasGradient
    lineWidth: number
    lineCap: CanvasLineCap
    lineJoin: CanvasLineJoin
    globalAlpha: number
    globalCompositeOperation: string
    shadowColor: string
    shadowBlur: number
    transform: [number, number, number, number, number, number]
  }
  const baseStyle = (): Style => ({
    strokeStyle: '#202333',
    fillStyle: '#202333',
    lineWidth: 1,
    lineCap: 'round',
    lineJoin: 'round',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    shadowColor: 'transparent',
    shadowBlur: 0,
    transform: [1, 0, 0, 1, 0, 0],
  })
  const stack: Style[] = []
  let style = baseStyle()
  let guard: MarkerGuard | null = null
  let path: ReadbackPathCmd[] = []
  let pathStart: { x: number; y: number } | null = null
  let pathAt: { x: number; y: number } | null = null

  const apply = (x: number, y: number) => {
    const [a, b, c, d, e, f] = style.transform
    return { x: a * x + c * y + e, y: b * x + d * y + f }
  }

  const blend = (px: number, py: number, rgba: [number, number, number, number], alpha: number) => {
    if (px < 0 || py < 0 || px >= w || py >= h) return
    const sa = Math.max(0, Math.min(1, rgba[3] * alpha * style.globalAlpha))
    if (sa <= 0) return
    if (guard && markerPixelBlocked(guard, px, py)) return
    const i = (py * w + px) * 4
    const da = data[i + 3] / 255
    const outA = sa + da * (1 - sa)
    if (outA <= 0) return
    data[i] = Math.round((rgba[0] * sa + data[i] * da * (1 - sa)) / outA)
    data[i + 1] = Math.round((rgba[1] * sa + data[i + 1] * da * (1 - sa)) / outA)
    data[i + 2] = Math.round((rgba[2] * sa + data[i + 2] * da * (1 - sa)) / outA)
    data[i + 3] = Math.round(outA * 255)
    if (guard) claimMarkerPixel(guard, px, py)
  }

  const stampDisk = (cx: number, cy: number, radius: number, rgba: [number, number, number, number], alpha: number) => {
    const r = Math.max(0.6, radius)
    const r2 = (r + 0.35) * (r + 0.35)
    const x0 = Math.max(0, Math.floor(cx - r - 1))
    const x1 = Math.min(w - 1, Math.ceil(cx + r + 1))
    const y0 = Math.max(0, Math.floor(cy - r - 1))
    const y1 = Math.min(h - 1, Math.ceil(cy + r + 1))
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const dx = x + 0.5 - cx
        const dy = y + 0.5 - cy
        if (dx * dx + dy * dy > r2) continue
        blend(x, y, rgba, alpha)
      }
    }
  }

  const stampLine = (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    radius: number,
    rgba: [number, number, number, number],
    alpha: number,
  ) => {
    const dist = Math.hypot(x1 - x0, y1 - y0)
    const steps = Math.max(1, Math.ceil(dist / Math.max(0.45, radius * 0.4)))
    for (let step = 0; step <= steps; step += 1) {
      const t = step / steps
      stampDisk(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, radius, rgba, alpha)
    }
  }

  const strokePath = (alpha = 1) => {
    const rgba = parseCssColor(style.strokeStyle)
    const radius = Math.max(INK_MIN_BITMAP_PX / 2, style.lineWidth / 2)
    let cursor: { x: number; y: number } | null = null
    let start: { x: number; y: number } | null = null
    for (const cmd of path) {
      if (cmd.kind === 'move') {
        cursor = apply(cmd.x, cmd.y)
        start = cursor
        stampDisk(cursor.x, cursor.y, radius, rgba, alpha)
      } else if (cmd.kind === 'line' && cursor) {
        const next = apply(cmd.x, cmd.y)
        stampLine(cursor.x, cursor.y, next.x, next.y, radius, rgba, alpha)
        cursor = next
      } else if (cmd.kind === 'quad' && cursor) {
        const end = apply(cmd.x, cmd.y)
        const control = apply(cmd.cpx, cmd.cpy)
        let previous = cursor
        for (let step = 1; step <= 8; step += 1) {
          const t = step / 8
          const mt = 1 - t
          const x = mt * mt * cursor.x + 2 * mt * t * control.x + t * t * end.x
          const y = mt * mt * cursor.y + 2 * mt * t * control.y + t * t * end.y
          stampLine(previous.x, previous.y, x, y, radius, rgba, alpha)
          previous = { x, y }
        }
        cursor = end
      } else if (cmd.kind === 'close' && cursor && start) {
        stampLine(cursor.x, cursor.y, start.x, start.y, radius, rgba, alpha)
        cursor = start
      } else if (cmd.kind === 'arc') {
        const center = apply(cmd.x, cmd.y)
        stampDisk(center.x, center.y, Math.max(radius, cmd.radius), rgba, alpha)
        cursor = center
      } else if (cmd.kind === 'ellipse') {
        const center = apply(cmd.x, cmd.y)
        stampDisk(center.x, center.y, Math.max(radius, cmd.rx, cmd.ry * 0.4), rgba, alpha)
        cursor = center
      }
    }
  }

  const fillPath = (alpha = 1) => {
    const rgba = parseCssColor(style.fillStyle)
    for (const cmd of path) {
      if (cmd.kind === 'arc') {
        const center = apply(cmd.x, cmd.y)
        stampDisk(center.x, center.y, Math.max(0.6, cmd.radius), rgba, alpha)
      } else if (cmd.kind === 'ellipse') {
        const center = apply(cmd.x, cmd.y)
        stampDisk(center.x, center.y, Math.max(0.6, cmd.rx), rgba, alpha)
      } else if (cmd.kind === 'move' || cmd.kind === 'line') {
        const point = apply(cmd.x, cmd.y)
        stampDisk(point.x, point.y, Math.max(0.6, style.lineWidth / 2), rgba, alpha)
      }
    }
    strokePath(alpha)
  }

  const context = {
    get strokeStyle() { return style.strokeStyle },
    set strokeStyle(value) { style.strokeStyle = value },
    get fillStyle() { return style.fillStyle },
    set fillStyle(value) { style.fillStyle = value },
    get lineWidth() { return style.lineWidth },
    set lineWidth(value) { style.lineWidth = value },
    get lineCap() { return style.lineCap },
    set lineCap(value) { style.lineCap = value },
    get lineJoin() { return style.lineJoin },
    set lineJoin(value) { style.lineJoin = value },
    get globalAlpha() { return style.globalAlpha },
    set globalAlpha(value) { style.globalAlpha = value },
    get globalCompositeOperation() { return style.globalCompositeOperation },
    set globalCompositeOperation(value) { style.globalCompositeOperation = value },
    get shadowColor() { return style.shadowColor },
    set shadowColor(value) { style.shadowColor = value },
    get shadowBlur() { return style.shadowBlur },
    set shadowBlur(value) { style.shadowBlur = value },
    save: () => { stack.push({ ...style, transform: [...style.transform] as Style['transform'] }) },
    restore: () => { style = stack.pop() ?? baseStyle() },
    beginPath: () => { path = []; pathStart = null; pathAt = null },
    moveTo: (x: number, y: number) => {
      path.push({ kind: 'move', x, y })
      pathStart = { x, y }
      pathAt = { x, y }
    },
    lineTo: (x: number, y: number) => {
      path.push({ kind: 'line', x, y })
      pathAt = { x, y }
    },
    quadraticCurveTo: (cpx: number, cpy: number, x: number, y: number) => {
      path.push({ kind: 'quad', cpx, cpy, x, y })
      pathAt = { x, y }
    },
    closePath: () => {
      path.push({ kind: 'close' })
      pathAt = pathStart
    },
    arc: (x: number, y: number, radius: number) => {
      path.push({ kind: 'arc', x, y, radius })
      pathAt = { x, y }
    },
    ellipse: (x: number, y: number, rx: number, ry: number, rotation: number) => {
      path.push({ kind: 'ellipse', x, y, rx, ry, rotation })
      pathAt = { x, y }
    },
    rect: (x: number, y: number, rectW: number, rectH: number) => {
      path.push({ kind: 'move', x, y })
      path.push({ kind: 'line', x: x + rectW, y })
      path.push({ kind: 'line', x: x + rectW, y: y + rectH })
      path.push({ kind: 'line', x, y: y + rectH })
      path.push({ kind: 'close' })
    },
    stroke: () => { strokePath(1) },
    fill: () => { fillPath(1) },
    clip: () => {},
    translate: (x: number, y: number) => {
      const [a, b, c, d, e, f] = style.transform
      style.transform = [a, b, c, d, e + a * x + c * y, f + b * x + d * y]
    },
    rotate: () => {},
    scale: (x: number, y: number) => {
      const [a, b, c, d, e, f] = style.transform
      style.transform = [a * x, b * x, c * y, d * y, e, f]
    },
    setTransform: (a: number, b: number, c: number, d: number, e: number, f: number) => { style.transform = [a, b, c, d, e, f] },
    createLinearGradient: () => ({ addColorStop: () => {} }),
    setMarkerGuard: (value: MarkerGuard | null) => { guard = value },
    clearRect: (x: number, y: number, rectW: number, rectH: number) => {
      const x0 = Math.max(0, Math.floor(x))
      const y0 = Math.max(0, Math.floor(y))
      const x1 = Math.min(w, Math.ceil(x + rectW))
      const y1 = Math.min(h, Math.ceil(y + rectH))
      for (let row = y0; row < y1; row += 1) {
        data.fill(0, (row * w + x0) * 4, (row * w + x1) * 4)
      }
    },
    getImageData: (x = 0, y = 0, sliceW = w, sliceH = h) => {
      const out = new Uint8ClampedArray(sliceW * sliceH * 4)
      for (let row = 0; row < sliceH; row += 1) {
        const src = ((y + row) * w + x) * 4
        out.set(data.subarray(src, src + sliceW * 4), row * sliceW * 4)
      }
      return { width: sliceW, height: sliceH, data: out, colorSpace: 'srgb' } as ImageData
    },
    putImageData: (image: ImageData, x: number, y: number) => {
      for (let row = 0; row < image.height; row += 1) {
        const dy = y + row
        if (dy < 0 || dy >= h) continue
        for (let col = 0; col < image.width; col += 1) {
          const dx = x + col
          if (dx < 0 || dx >= w) continue
          const si = (row * image.width + col) * 4
          const di = (dy * w + dx) * 4
          data[di] = image.data[si]
          data[di + 1] = image.data[si + 1]
          data[di + 2] = image.data[si + 2]
          data[di + 3] = image.data[si + 3]
        }
      }
    },
    drawImage: (
      source: { width?: number; height?: number; pixels?: Uint8ClampedArray },
      sx?: number,
      sy?: number,
      sw?: number,
      sh?: number,
      dx?: number,
      dy?: number,
      dw?: number,
      dh?: number,
    ) => {
      const pixels = source?.pixels
      const srcW = source?.width ?? 0
      const srcH = source?.height ?? 0
      if (!pixels || !(srcW > 0) || !(srcH > 0)) return
      const sourceX = sx ?? 0
      const sourceY = sy ?? 0
      const copyW = sw ?? srcW
      const copyH = sh ?? srcH
      const destX = dx ?? sourceX
      const destY = dy ?? sourceY
      const destW = dw ?? copyW
      const destH = dh ?? copyH
      if (!(copyW > 0) || !(copyH > 0) || destW !== copyW || destH !== copyH) return
      const alphaScale = style.globalAlpha
      for (let row = 0; row < copyH; row += 1) {
        const srcRow = sourceY + row
        const destRow = destY + row
        if (srcRow < 0 || srcRow >= srcH || destRow < 0 || destRow >= h) continue
        for (let col = 0; col < copyW; col += 1) {
          const srcCol = sourceX + col
          const destCol = destX + col
          if (srcCol < 0 || srcCol >= srcW || destCol < 0 || destCol >= w) continue
          const si = (srcRow * srcW + srcCol) * 4
          const sa = (pixels[si + 3] / 255) * alphaScale
          if (sa <= 0) continue
          const di = (destRow * w + destCol) * 4
          const da = data[di + 3] / 255
          const outA = sa + da * (1 - sa)
          if (outA <= 0) continue
          data[di] = Math.round((pixels[si] * sa + data[di] * da * (1 - sa)) / outA)
          data[di + 1] = Math.round((pixels[si + 1] * sa + data[di + 1] * da * (1 - sa)) / outA)
          data[di + 2] = Math.round((pixels[si + 2] * sa + data[di + 2] * da * (1 - sa)) / outA)
          data[di + 3] = Math.round(outA * 255)
        }
      }
    },
  }

  const softwareCanvas = {
    width: w,
    height: h,
    pixels: data,
    getContext: () => context,
  }
  ;(context as unknown as { canvas: typeof softwareCanvas }).canvas = softwareCanvas

  void pathAt
  return {
    width: w,
    height: h,
    context: context as unknown as CanvasRenderingContext2D,
    getImageData: (x = 0, y = 0, sliceW = w, sliceH = h) => {
      const out = new Uint8ClampedArray(sliceW * sliceH * 4)
      for (let row = 0; row < sliceH; row += 1) {
        const src = ((y + row) * w + x) * 4
        out.set(data.subarray(src, src + sliceW * 4), row * sliceW * 4)
      }
      return { width: sliceW, height: sliceH, data: out, colorSpace: 'srgb' } as ImageData
    },
  }
}

export const opaqueInkStats = (image: Pick<ImageData, 'width' | 'height' | 'data'>, minAlpha = 24) => {
  let opaque = 0
  let minX = image.width
  let minY = image.height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const alpha = image.data[(y * image.width + x) * 4 + 3]
      if (alpha < minAlpha) continue
      opaque += 1
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }
  const boxW = maxX >= minX ? maxX - minX + 1 : 0
  const boxH = maxY >= minY ? maxY - minY + 1 : 0
  return { opaque, boxW, boxH, area: boxW * boxH }
}

export type VisibleInkSample = {
  overlayWidth: number
  overlayHeight: number
  bitmapWidth: number
  bitmapHeight: number
  points: number
  opaque: number
  boxW: number
  boxH: number
  area: number
}

const emptyInkSample = (): VisibleInkSample => ({
  overlayWidth: 0,
  overlayHeight: 0,
  bitmapWidth: 0,
  bitmapHeight: 0,
  points: 0,
  opaque: 0,
  boxW: 0,
  boxH: 0,
  area: 0,
})

/** Paints one stroke into a `width` × `height` bitmap and returns its pixels (the viewport raster in checks). */
export type InkStrokeRasterizer = (
  stroke: InkPaintStroke,
  width: number,
  height: number,
  layoutWidth: number,
) => Pick<ImageData, 'width' | 'height' | 'data'>

/**
 * Same hit-size + map + paint path DrawingBoard uses on a markdown note.
 * Overlay covers extra paper; 0–1 map and paint stay on the write page.
 * `rasterize` swaps the canvas paint for another painter on the same samples.
 */
export const paintMarkdownNoteStiftStroke = (input: {
  overlay: { left: number; top: number; width: number; height: number }
  paper: { width: number; height: number }
  plane?: { width: number; height: number }
  events: InkPointerLike[]
  rasterize?: InkStrokeRasterizer
}): VisibleInkSample & {
  page: { left: number; top: number; width: number; height: number }
  samples: Array<{ y: number; paintedY: number; pointerY: number }>
} => {
  const { overlaySize, page } = markdownInkPageBox(input.overlay, input.paper, input.plane)
  const paintW = page.width
  const paintH = page.height
  if (!(overlaySize.width > 0) || !(overlaySize.height > 0) || !(paintW > 0) || !(paintH > 0)) {
    return { ...emptyInkSample(), page, samples: [] }
  }
  const points = commitInkPointerSequence(input.events, page, paintW, paintH)
    .filter((point) => point.x >= 0 && point.y >= 0)
  const samples = points.map((point) => ({
    y: point.y,
    paintedY: point.y * paintH,
    pointerY: point.y * page.height,
  }))
  if (!points.length) {
    return {
      ...emptyInkSample(),
      overlayWidth: overlaySize.width,
      overlayHeight: overlaySize.height,
      page,
      samples,
    }
  }
  const stroke: InkPaintStroke = {
    points,
    baseWidth: 3.5,
    pressureEnabled: true,
    color: '#202333',
    purpose: 'handwriting',
    brush: 'fineliner',
    colorEffect: 'solid',
    opacity: 1,
  }
  let image: Pick<ImageData, 'width' | 'height' | 'data'>
  if (input.rasterize) {
    image = input.rasterize(stroke, paintW, paintH, paintW)
  } else {
    const { context, getImageData } = createInkReadbackContext(paintW, paintH)
    drawInkStroke(
      context,
      stroke,
      paintW,
      paintH,
      0,
      1,
      paintW,
      paintW,
    )
    image = getImageData()
  }
  return {
    overlayWidth: overlaySize.width,
    overlayHeight: overlaySize.height,
    bitmapWidth: paintW,
    bitmapHeight: paintH,
    points: points.length,
    page,
    samples,
    ...opaqueInkStats(image),
  }
}

/**
 * Drive a markdown-note pen sample through the shipped map + paint path and
 * read the pixels back. A ghost 0,0 down must not swallow the real stroke.
 * Overlay starts at 0×0 — the Linux report path — and must still paint.
 */
export const paintVisibleInkSample = (rasterize?: InkStrokeRasterizer): VisibleInkSample => {
  const paper = { width: 900, height: 1273 }
  const overlay = { left: 40, top: 24, width: 0, height: 0 }
  const at = (nx: number, ny: number, timeStamp: number, type = 'pointermove') => ({
    type,
    clientX: overlay.left + nx * paper.width,
    clientY: overlay.top + ny * paper.height,
    pressure: 0.55,
    pointerType: 'pen' as const,
    timeStamp,
  })
  return paintMarkdownNoteStiftStroke({
    overlay,
    paper,
    rasterize,
    events: [
      { type: 'pointerdown', clientX: 0, clientY: 0, pressure: 0, pointerType: 'pen', timeStamp: 0 },
      at(0.22, 0.28, 16, 'pointerdown'),
      at(0.28, 0.34, 32),
      at(0.36, 0.41, 48),
      at(0.44, 0.47, 64),
    ],
  })
}
