import { inkStrokePaintScale } from './paperGrow'
import { commitInkPointerSequence } from './inkSampleMap'

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
}

type InkPaintContext = CanvasRenderingContext2D

const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value))

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

/** Bitmap px for a CSS pen so a normal stroke cannot collapse to a hairline. */
export const inkStrokeBitmapWidth = (
  stroke: { baseWidth: number; pressureEnabled?: boolean },
  pressure: number,
  scale: number,
) => Math.max(INK_MIN_BITMAP_PX, pressureWidth(stroke, pressure) * scale)

/**
 * One paint path for live/committed ink. Tests call this — a missing line is a
 * failed pixel assertion, not a CSS-scale guess.
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
) => {
  if (stroke.points.length === 0) return
  if (!(width > 0) || !(height > 0)) return
  const first = stroke.points[0]
  const layout = layoutWidth > 1 ? layoutWidth : width
  const scale = inkStrokePaintScale(width, layout > 1 ? layout : sourceWidth)
  const brush = stroke.purpose === 'art' ? stroke.brush ?? 'fineliner' : 'fineliner'
  const opacity = stroke.purpose === 'art' ? clamp(stroke.opacity ?? 1, .08, 1) : 1
  const paint = strokePaint(context, stroke, width, height)
  context.save()
  context.strokeStyle = paint
  context.fillStyle = paint
  context.lineCap = 'round'
  context.lineJoin = 'round'
  if (brush === 'highlighter') context.globalCompositeOperation = 'multiply'
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
    context.lineWidth = 1.75
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

  const calligraphySegment = (previous: InkPaintPoint, point: InkPaintPoint) => {
    const previousX = previous.x * width
    const previousY = previous.y * height
    const pointX = point.x * width
    const pointY = point.y * height
    const nibWidth = inkStrokeBitmapWidth(stroke, ((previous.pressure ?? 0.5) + (point.pressure ?? 0.5)) / 2, scale)
    const nibX = Math.cos(-Math.PI * .22) * nibWidth / 2
    const nibY = Math.sin(-Math.PI * .22) * nibWidth / 2
    context.globalAlpha = opacity
    context.beginPath()
    context.moveTo(previousX + nibX, previousY + nibY)
    context.lineTo(pointX + nibX, pointY + nibY)
    context.lineTo(pointX - nibX, pointY - nibY)
    context.lineTo(previousX - nibX, previousY - nibY)
    context.closePath()
    context.fill()
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
      context.globalAlpha = brush === 'highlighter' ? opacity * .32 : opacity
      context.beginPath()
      context.arc(
        first.x * width,
        first.y * height,
        inkStrokeBitmapWidth(stroke, first.pressure ?? 0.5, scale) / 2,
        0,
        Math.PI * 2,
      )
      context.fill()
    }
    context.restore()
    return
  }

  for (let index = Math.max(1, startSegment); index < stroke.points.length; index += 1) {
    const previous = stroke.points[index - 1]
    const point = stroke.points[index]
    const previousX = previous.x * width
    const previousY = previous.y * height
    const pointX = point.x * width
    const pointY = point.y * height
    if (brush === 'spray') {
      spraySegment(previous, point, index)
      continue
    }
    if (brush === 'calligraphy') {
      calligraphySegment(previous, point)
      continue
    }

    const segment = (widthFactor: number, alpha: number, offsetX = 0, offsetY = 0) => {
      context.globalAlpha = opacity * alpha
      context.beginPath()
      context.moveTo(previousX + offsetX, previousY + offsetY)
      if (smoothing > 0 && index < stroke.points.length - 1) {
        const next = stroke.points[index + 1]
        const blend = clamp(smoothing, 0, .92)
        const midpointX = pointX * (1 - blend * .35) + ((pointX + next.x * width) / 2) * blend * .35
        const midpointY = pointY * (1 - blend * .35) + ((pointY + next.y * height) / 2) * blend * .35
        context.quadraticCurveTo(pointX + offsetX, pointY + offsetY, midpointX + offsetX, midpointY + offsetY)
      } else if (smoothing > 0 && index >= 2) {
        const before = stroke.points[index - 2]
        const blend = clamp(smoothing, 0, .92)
        const controlX = previousX + (previous.x - before.x) * width * blend * 0.4
        const controlY = previousY + (previous.y - before.y) * height * blend * 0.4
        context.quadraticCurveTo(controlX + offsetX, controlY + offsetY, pointX + offsetX, pointY + offsetY)
      } else {
        context.lineTo(pointX + offsetX, pointY + offsetY)
      }
      context.lineWidth = inkStrokeBitmapWidth(
        stroke,
        ((previous.pressure ?? 0.5) + (point.pressure ?? 0.5)) / 2,
        scale,
      ) * widthFactor
      context.stroke()
    }

    if (brush === 'pencil') {
      segment(.72, .58)
      const seed = (stroke.textureSeed ?? 1) + index * 53
      segment(.22, .2, (seededUnit(seed) - .5) * scale * 1.4, (seededUnit(seed + 1) - .5) * scale * 1.4)
      segment(.18, .14, (seededUnit(seed + 2) - .5) * scale * 1.8, (seededUnit(seed + 3) - .5) * scale * 1.8)
    } else if (brush === 'paintbrush') {
      segment(1.4, .16)
      segment(.92, .82)
    } else if (brush === 'highlighter') {
      context.lineCap = 'butt'
      segment(1, .34)
    } else if (brush === 'watercolor') {
      segment(1.48, .11)
      segment(1.14, .17)
      segment(.78, .27)
    } else if (brush === 'marker') {
      segment(1, .9)
    } else {
      segment(1, 1)
    }
  }
  context.restore()
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
    const i = (py * w + px) * 4
    const da = data[i + 3] / 255
    const outA = sa + da * (1 - sa)
    if (outA <= 0) return
    data[i] = Math.round((rgba[0] * sa + data[i] * da * (1 - sa)) / outA)
    data[i + 1] = Math.round((rgba[1] * sa + data[i + 1] * da * (1 - sa)) / outA)
    data[i + 2] = Math.round((rgba[2] * sa + data[i + 2] * da * (1 - sa)) / outA)
    data[i + 3] = Math.round(outA * 255)
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
  }

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

export const opaqueInkStats = (image: ImageData, minAlpha = 24) => {
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
  points: number
  opaque: number
  boxW: number
  boxH: number
  area: number
}

/**
 * Drive a markdown-note pen sample through the shipped map + paint path and
 * read the pixels back. A ghost 0,0 down must not swallow the real stroke.
 */
export const paintVisibleInkSample = (): VisibleInkSample => {
  const layoutWidth = 900
  const layoutHeight = 1273
  const bitmapWidth = 900
  const bitmapHeight = 1273
  const surface = {
    left: 40,
    top: 24,
    width: layoutWidth,
    height: layoutHeight,
    offsetWidth: layoutWidth,
    offsetHeight: layoutHeight,
  }
  const at = (nx: number, ny: number, timeStamp: number, type = 'pointermove') => ({
    type,
    clientX: surface.left + nx * surface.width,
    clientY: surface.top + ny * surface.height,
    pressure: 0.55,
    pointerType: 'pen' as const,
    timeStamp,
  })
  const events = [
    { type: 'pointerdown', clientX: 0, clientY: 0, pressure: 0, pointerType: 'pen' as const, timeStamp: 0 },
    at(0.22, 0.28, 16, 'pointerdown'),
    at(0.28, 0.34, 32),
    at(0.36, 0.41, 48),
    at(0.44, 0.47, 64),
  ]
  const points = commitInkPointerSequence(events, surface, layoutWidth, layoutHeight)
  const { context, getImageData } = createInkReadbackContext(bitmapWidth, bitmapHeight)
  drawInkStroke(
    context,
    {
      points,
      baseWidth: 3.5,
      pressureEnabled: true,
      color: '#202333',
      purpose: 'handwriting',
      brush: 'fineliner',
      colorEffect: 'solid',
      opacity: 1,
    },
    bitmapWidth,
    bitmapHeight,
    0,
    1,
    layoutWidth,
    layoutWidth,
  )
  return { points: points.length, ...opaqueInkStats(getImageData()) }
}
