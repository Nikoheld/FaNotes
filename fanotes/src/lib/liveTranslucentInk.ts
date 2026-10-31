import { inkStrokePaintScale } from './paperGrow'
import {
  consumeInkSegmentPaints,
  createInkReadbackContext,
  drawInkStroke,
  inkStrokePaintMargin,
  translucentPassAlphas,
  type InkPaintOptions,
  type InkPaintPoint,
  type InkPaintStroke,
} from './inkStrokePaint'

/**
 * Live see-through ink. A marker or highlighter composited once per sample
 * used to stroke the whole mark again, so a long stroke did work proportional
 * to length × samples and the joints went dark if those strokes overlapped
 * on the visible bitmap. Coverage keeps the opaque shape. Each new sample
 * strokes only the segments that became final, plus the still-open tail.
 * The visible bitmap replaces that box from the coverage at the pass alpha,
 * so a pixel is tinted once.
 */

type Rect = { x: number; y: number; w: number; h: number }

type InkCanvas = {
  width: number
  height: number
  pixels?: Uint8ClampedArray
}

type InkLayer = {
  canvas: InkCanvas
  context: CanvasRenderingContext2D
}

export type LiveTranslucentTarget = {
  context: CanvasRenderingContext2D
  width: number
  height: number
}

export type LiveTranslucentSession = {
  key: string
  bitmapWidth: number
  bitmapHeight: number
  permanentEnd: number
  segmentPaints: number
  points: number
  volatile: Rect | null
  dotBaked: boolean
  layers: Array<{ alpha: number; layer: InkLayer }>
}

const makeLayer = (width: number, height: number): InkLayer => {
  const w = Math.max(1, Math.ceil(width))
  const h = Math.max(1, Math.ceil(height))
  const host = globalThis as typeof globalThis & {
    OffscreenCanvas?: new (width: number, height: number) => OffscreenCanvas
    document?: Document
  }
  if (host.OffscreenCanvas) {
    const canvas = new host.OffscreenCanvas(w, h)
    const context = canvas.getContext('2d', { alpha: true })
    if (context) {
      context.imageSmoothingEnabled = false
      return { canvas, context: context as unknown as CanvasRenderingContext2D }
    }
  }
  if (host.document?.createElement) {
    const canvas = host.document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const context = canvas.getContext('2d', { alpha: true })
    if (context) {
      context.imageSmoothingEnabled = false
      return { canvas, context }
    }
  }
  const surface = createInkReadbackContext(w, h)
  const canvas = (surface.context as unknown as { canvas: InkCanvas }).canvas
  return { canvas, context: surface.context }
}

/** Marker, highlighter, watercolor, and other pass brushes. Spray and calligraphy stay on the full repaint. */
export const liveTranslucentCanGrow = (stroke: InkPaintStroke) => {
  if (stroke.symbolPaths?.length) return false
  const brush = stroke.purpose === 'art' ? stroke.brush ?? 'fineliner' : 'fineliner'
  if (brush === 'spray' || brush === 'calligraphy') return false
  return Boolean(translucentPassAlphas(stroke)?.length)
}

const deviceRect = (
  points: readonly { x: number; y: number }[],
  from: number,
  to: number,
  pageWidth: number,
  pageHeight: number,
  originX: number,
  originY: number,
  margin: number,
  bitmapWidth: number,
  bitmapHeight: number,
): Rect | null => {
  if (!points.length) return null
  const last = points.length - 1
  const start = Math.max(0, Math.min(from, to, last))
  const end = Math.max(start, Math.min(Math.max(from, to), last))
  let x0 = Number.POSITIVE_INFINITY
  let y0 = Number.POSITIVE_INFINITY
  let x1 = Number.NEGATIVE_INFINITY
  let y1 = Number.NEGATIVE_INFINITY
  for (let index = start; index <= end; index += 1) {
    const x = points[index].x * pageWidth + originX
    const y = points[index].y * pageHeight + originY
    if (x < x0) x0 = x
    if (y < y0) y0 = y
    if (x > x1) x1 = x
    if (y > y1) y1 = y
  }
  if (!Number.isFinite(x0)) return null
  const left = Math.max(0, Math.floor(x0 - margin))
  const top = Math.max(0, Math.floor(y0 - margin))
  const right = Math.min(bitmapWidth, Math.ceil(x1 + margin))
  const bottom = Math.min(bitmapHeight, Math.ceil(y1 + margin))
  if (right <= left || bottom <= top) return null
  return { x: left, y: top, w: right - left, h: bottom - top }
}

const unionRect = (a: Rect | null, b: Rect | null): Rect | null => {
  if (!a) return b
  if (!b) return a
  const x0 = Math.min(a.x, b.x)
  const y0 = Math.min(a.y, b.y)
  const x1 = Math.max(a.x + a.w, b.x + b.w)
  const y1 = Math.max(a.y + a.h, b.y + b.h)
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

const punchKeepColor = (
  context: CanvasRenderingContext2D,
  dirty: Rect,
  stroke: InkPaintStroke,
  options: InkPaintOptions | undefined,
) => {
  if (stroke.keepColor !== true || !options?.coverage) return
  const readable = context as CanvasRenderingContext2D & {
    getImageData?: (x: number, y: number, w: number, h: number) => ImageData
    putImageData?: (image: ImageData, x: number, y: number) => void
  }
  if (!readable.getImageData || !readable.putImageData) return
  const image = readable.getImageData(0, 0, dirty.w, dirty.h)
  const { mask, width, height } = options.coverage
  const ox = Math.round(options.coverageOrigin?.x ?? 0)
  const oy = Math.round(options.coverageOrigin?.y ?? 0)
  let changed = false
  for (let row = 0; row < dirty.h; row += 1) {
    for (let col = 0; col < dirty.w; col += 1) {
      const mx = dirty.x + col + ox
      const my = dirty.y + row + oy
      if (mx < 0 || my < 0 || mx >= width || my >= height) continue
      if (mask[my * width + mx] !== 1) continue
      const index = (row * dirty.w + col) * 4 + 3
      if (image.data[index] === 0) continue
      image.data[index] = 0
      changed = true
    }
  }
  if (changed) readable.putImageData(image, 0, 0)
}

const paintFlat = (
  layer: InkLayer,
  stroke: InkPaintStroke,
  pageWidth: number,
  pageHeight: number,
  smoothing: number,
  sourceWidth: number,
  layoutWidth: number,
  startSegment: number,
  endSegment: number,
  originX: number,
  originY: number,
  passIndex: number,
  options: InkPaintOptions | undefined,
  curvePointCount?: number,
) => {
  layer.context.save()
  layer.context.setTransform(1, 0, 0, 1, originX, originY)
  drawInkStroke(
    layer.context,
    stroke,
    pageWidth,
    pageHeight,
    smoothing,
    startSegment,
    sourceWidth,
    layoutWidth,
    endSegment,
    { ...options, flatPass: passIndex, curvePointCount },
  )
  layer.context.restore()
}

export type LiveTranslucentPaintInput = {
  session: LiveTranslucentSession | null
  target: LiveTranslucentTarget
  stroke: InkPaintStroke
  pageWidth: number
  pageHeight: number
  smoothing: number
  sourceWidth: number
  layoutWidth: number
  originX: number
  originY: number
  replace: boolean
  settle: boolean
  previewPoints?: readonly InkPaintPoint[]
  options?: InkPaintOptions
}

/**
 * Paint one growing see-through stroke. `segmentPaints` counts every segment
 * `drawInkStroke` stroked on this stroke so far, including the open tail.
 */
export const paintGrowingTranslucentStroke = (input: LiveTranslucentPaintInput) => {
  const alphas = translucentPassAlphas(input.stroke) ?? []
  const key = [
    input.target.width,
    input.target.height,
    input.pageWidth,
    input.pageHeight,
    input.originX,
    input.originY,
    input.sourceWidth,
    input.layoutWidth,
    alphas.join(','),
  ].join(':')
  let session = input.session
  let created = false
  if (!session || input.replace || session.key !== key || session.bitmapWidth !== input.target.width) {
    session = {
      key,
      bitmapWidth: input.target.width,
      bitmapHeight: input.target.height,
      permanentEnd: 0,
      segmentPaints: 0,
      points: 0,
      volatile: null,
      dotBaked: false,
      layers: alphas.map((alpha) => ({ alpha, layer: makeLayer(input.target.width, input.target.height) })),
    }
    created = true
  }
  const count = input.stroke.points.length
  if (!alphas.length || !count || !(input.pageWidth > 0) || !(input.pageHeight > 0)) {
    return { session, segmentPaints: session.segmentPaints, points: count }
  }
  if (created) {
    input.target.context.save()
    input.target.context.setTransform(1, 0, 0, 1, 0, 0)
    input.target.context.clearRect(0, 0, input.target.width, input.target.height)
    input.target.context.restore()
  }

  consumeInkSegmentPaints()
  const scale = inkStrokePaintScale(input.pageWidth, input.layoutWidth > 1 ? input.layoutWidth : input.sourceWidth)
  const margin = inkStrokePaintMargin(input.stroke, scale) + 4
  const box = (points: readonly { x: number; y: number }[], from: number, to: number) => deviceRect(
    points,
    from,
    to,
    input.pageWidth,
    input.pageHeight,
    input.originX,
    input.originY,
    margin,
    input.target.width,
    input.target.height,
  )

  const permanentEnd = input.settle ? count : Math.max(1, count - 1)
  let baked: Rect | null = null
  if (input.settle && count === 1 && !session.dotBaked) {
    session.layers.forEach(({ layer }, index) => {
      paintFlat(layer, input.stroke, input.pageWidth, input.pageHeight, input.smoothing, input.sourceWidth, input.layoutWidth, 1, 1, input.originX, input.originY, index, input.options)
    })
    session.dotBaked = true
    session.permanentEnd = 1
    baked = box(input.stroke.points, 0, 0)
  } else if (permanentEnd > session.permanentEnd && count > 1) {
    const start = Math.max(1, session.permanentEnd)
    if (permanentEnd > start) {
      // One path with the previous segment, so the new corner is a round
      // join. A segment baked alone is two butt caps and leaves the wedge.
      const whole = start <= 1 && permanentEnd >= count
      const joinedStart = whole ? start : Math.max(1, start - 1)
      const curvePointCount = whole ? undefined : count
      session.layers.forEach(({ layer }, index) => {
        paintFlat(layer, input.stroke, input.pageWidth, input.pageHeight, input.smoothing, input.sourceWidth, input.layoutWidth, joinedStart, permanentEnd, input.originX, input.originY, index, input.options, curvePointCount)
      })
      baked = box(input.stroke.points, joinedStart - 1, Math.max(joinedStart - 1, permanentEnd - 1))
    }
    session.permanentEnd = Math.max(session.permanentEnd, permanentEnd)
  }

  const brush = input.stroke.purpose === 'art' ? input.stroke.brush ?? 'fineliner' : 'fineliner'
  // Highlighter's one-shot paint multiplies onto a clear bitmap. Match that
  // once the dirty box has been cleared; other brushes source-over.
  const composite = brush === 'highlighter' ? 'multiply' : 'source-over'
  const preview = input.settle ? [] : input.previewPoints ?? []
  const tailStroke = count === 1 ? input.stroke : input.stroke
  let tail: Rect | null = null
  const paintTail = !input.settle && count >= 1
  if (paintTail && count === 1) tail = box(input.stroke.points, 0, 0)
  if (paintTail && count > 1) tail = box(input.stroke.points, count - 2, count - 1)
  const extensionPoints = preview.length && count >= 1
    ? [input.stroke.points[count - 1], ...preview]
    : []
  const extension = extensionPoints.length
    ? box(extensionPoints, 0, extensionPoints.length - 1)
    : null
  const dirty = [session.volatile, baked, tail, extension].reduce(unionRect, null)
  if (dirty && paintTail) {
    const extensionStroke: InkPaintStroke | null = extensionPoints.length
      ? { ...input.stroke, points: extensionPoints }
      : null
    session.layers.forEach(({ alpha, layer }, index) => {
      const patch = makeLayer(dirty.w, dirty.h)
      patch.context.save()
      patch.context.setTransform(1, 0, 0, 1, 0, 0)
      patch.context.clearRect(0, 0, dirty.w, dirty.h)
      patch.context.drawImage(layer.canvas as CanvasImageSource, dirty.x, dirty.y, dirty.w, dirty.h, 0, 0, dirty.w, dirty.h)
      patch.context.setTransform(1, 0, 0, 1, input.originX - dirty.x, input.originY - dirty.y)
      if (count === 1) {
        drawInkStroke(patch.context, tailStroke, input.pageWidth, input.pageHeight, input.smoothing, 1, input.sourceWidth, input.layoutWidth, 1, { ...input.options, flatPass: index })
      } else {
        drawInkStroke(patch.context, input.stroke, input.pageWidth, input.pageHeight, input.smoothing, Math.max(1, count - 1), input.sourceWidth, input.layoutWidth, count, { ...input.options, flatPass: index })
      }
      if (extensionStroke) {
        drawInkStroke(patch.context, extensionStroke, input.pageWidth, input.pageHeight, input.smoothing, 1, input.sourceWidth, input.layoutWidth, extensionStroke.points.length, { ...input.options, flatPass: index })
      }
      patch.context.restore()
      punchKeepColor(patch.context, dirty, input.stroke, input.options)
      input.target.context.save()
      input.target.context.setTransform(1, 0, 0, 1, 0, 0)
      input.target.context.globalCompositeOperation = composite
      input.target.context.globalAlpha = 1
      if (index === 0) input.target.context.clearRect(dirty.x, dirty.y, dirty.w, dirty.h)
      input.target.context.globalAlpha = alpha
      input.target.context.drawImage(
        patch.canvas as CanvasImageSource,
        0, 0, dirty.w, dirty.h,
        dirty.x, dirty.y, dirty.w, dirty.h,
      )
      input.target.context.restore()
    })
  } else if (dirty) {
    session.layers.forEach(({ alpha, layer }, index) => {
      const patch = makeLayer(dirty.w, dirty.h)
      patch.context.setTransform(1, 0, 0, 1, 0, 0)
      patch.context.drawImage(layer.canvas as CanvasImageSource, dirty.x, dirty.y, dirty.w, dirty.h, 0, 0, dirty.w, dirty.h)
      punchKeepColor(patch.context, dirty, input.stroke, input.options)
      input.target.context.save()
      input.target.context.setTransform(1, 0, 0, 1, 0, 0)
      input.target.context.globalCompositeOperation = composite
      input.target.context.globalAlpha = 1
      if (index === 0) input.target.context.clearRect(dirty.x, dirty.y, dirty.w, dirty.h)
      input.target.context.globalAlpha = alpha
      input.target.context.drawImage(
        patch.canvas as CanvasImageSource,
        0, 0, dirty.w, dirty.h,
        dirty.x, dirty.y, dirty.w, dirty.h,
      )
      input.target.context.restore()
    })
  }
  session.volatile = input.settle ? null : unionRect(tail, extension)
  session.points = count
  session.segmentPaints += consumeInkSegmentPaints()
  return { session, segmentPaints: session.segmentPaints, points: count }
}

/** One full-stroke composite: every segment is stroked once, then the pass alpha is applied once. */
export const compositeTranslucentStrokeOnce = (
  input: Omit<LiveTranslucentPaintInput, 'session' | 'replace' | 'settle' | 'previewPoints'>,
) => paintGrowingTranslucentStroke({
  ...input,
  session: null,
  replace: true,
  settle: true,
})
