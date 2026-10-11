/**
 * Thin calls into the Rust viewport raster (`fanotes-raster-wasm`).
 * DrawingBoard imports this module dynamically, only when the flag is on.
 */
import {
  initSync,
  InkRaster,
  pressureWidth as pressureWidthWasm,
  tileBudget,
  tilePx,
  zoomBucket,
} from './rasterWasm/fanotes_raster_wasm.js'
import { RASTER_WASM_BASE64 } from './rasterWasm/bytes'
import type { ViewportRasterRegion, ViewportRasterView } from './viewportRasterPlan'

let ready = false

export const ensureViewportRasterWasm = () => {
  if (ready) return
  const binary = atob(RASTER_WASM_BASE64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  initSync({ module: bytes })
  ready = true
}

/** Order matches `fanotes_raster::Brush` and `Effect`. */
const BRUSH_IDS = ['fineliner', 'pencil', 'marker', 'paintbrush', 'calligraphy', 'highlighter', 'watercolor', 'spray']
const EFFECT_IDS = ['solid', 'rainbow', 'aurora', 'sunset', 'ocean', 'gold', 'silver', 'neon']
/** `fanotes_raster::PACKED_STROKE_FIELDS`. */
export const RASTER_STROKE_FIELDS = 11

export type RasterInkPoint = { x: number; y: number; pressure?: number }

export type RasterInkStroke = {
  points: ReadonlyArray<RasterInkPoint>
  baseWidth: number
  pressureEnabled?: boolean
  color: string
  purpose?: string
  brush?: string
  colorEffect?: string
  opacity?: number
  textureSeed?: number
  symbolId?: string
  symbolRotation?: number
}

export type RasterSymbol = { id: string; paths: readonly string[] }

export type RasterImage = { width: number; height: number; data: Uint8ClampedArray }

const parseColor = (value: string) => {
  const hex = typeof value === 'string' ? value.trim() : ''
  if (/^#[\da-f]{6}$/iu.test(hex)) return Number.parseInt(hex.slice(1), 16)
  if (/^#[\da-f]{3}$/iu.test(hex)) return Number.parseInt(`${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`, 16)
  return 0x202333
}

const finiteOr = (value: unknown, fallback: number) => (
  typeof value === 'number' && Number.isFinite(value) ? value : fallback
)

/** Flat arrays for `InkRaster.setScene`: one header row per stroke, then `x, y, pressure` per point. */
export const packRasterStrokes = (
  strokes: ReadonlyArray<RasterInkStroke>,
  symbolIndex: ReadonlyMap<string, number> = new Map(),
) => {
  let pointCount = 0
  for (const stroke of strokes) pointCount += stroke.points.length
  const header = new Float64Array(strokes.length * RASTER_STROKE_FIELDS)
  const points = new Float64Array(pointCount * 3)
  let cursor = 0
  strokes.forEach((stroke, index) => {
    const row = index * RASTER_STROKE_FIELDS
    header[row] = stroke.points.length
    header[row + 1] = finiteOr(stroke.baseWidth, 4)
    header[row + 2] = stroke.pressureEnabled ? 1 : 0
    header[row + 3] = parseColor(stroke.color)
    header[row + 4] = stroke.purpose === 'art' ? 1 : 0
    header[row + 5] = stroke.brush ? BRUSH_IDS.indexOf(stroke.brush) : -1
    header[row + 6] = Math.max(0, EFFECT_IDS.indexOf(stroke.colorEffect ?? 'solid'))
    header[row + 7] = finiteOr(stroke.opacity, Number.NaN)
    header[row + 8] = finiteOr(stroke.textureSeed, Number.NaN)
    header[row + 9] = stroke.symbolId ? symbolIndex.get(stroke.symbolId) ?? -1 : -1
    header[row + 10] = finiteOr(stroke.symbolRotation, 0)
    for (const point of stroke.points) {
      points[cursor] = finiteOr(point.x, 0)
      points[cursor + 1] = finiteOr(point.y, 0)
      points[cursor + 2] = finiteOr(point.pressure, 0.5)
      cursor += 3
    }
  })
  return { header, points }
}

export type ViewportRaster = {
  /** Replaces the page; returns whether any committed pixel may have changed. */
  setScene: (layoutWidth: number, layoutHeight: number, smoothing: number, strokes: ReadonlyArray<RasterInkStroke>) => boolean
  /** Part of the view whose pixels changed since `clearDirty`. */
  dirtyRegion: (view: ViewportRasterView) => ViewportRasterRegion | null
  clearDirty: () => void
  /** Straight RGBA of one region of the view's bitmap. */
  paint: (view: ViewportRasterView, region: ViewportRasterRegion) => RasterImage
  /** Zoom bucket of the last paint, null when it painted at the exact scale. */
  lastBucket: () => number | null
  lastTilesRendered: () => number
  tileCount: () => number
  dispose: () => void
}

export const createViewportRaster = (symbols: ReadonlyArray<RasterSymbol> = []): ViewportRaster => {
  ensureViewportRasterWasm()
  const raster = new InkRaster()
  const symbolIndex = new Map<string, number>()
  for (const symbol of symbols) symbolIndex.set(symbol.id, raster.addSymbol([...symbol.paths]))
  return {
    setScene: (layoutWidth, layoutHeight, smoothing, strokes) => {
      const { header, points } = packRasterStrokes(strokes, symbolIndex)
      return raster.setScene(layoutWidth, layoutHeight, smoothing, header, points)
    },
    dirtyRegion: (view) => {
      const rect = raster.dirtyRegion(view.scale, view.dpr, view.originX, view.originY, view.width, view.height)
      return rect.length === 4 ? { x: rect[0], y: rect[1], width: rect[2], height: rect[3] } : null
    },
    clearDirty: () => raster.clearDirty(),
    paint: (view, region) => {
      const bytes = raster.paint(
        view.scale,
        view.dpr,
        view.originX,
        view.originY,
        region.x,
        region.y,
        region.width,
        region.height,
      )
      const complete = bytes.length === region.width * region.height * 4
      return {
        width: complete ? region.width : 0,
        height: complete ? region.height : 0,
        data: new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, complete ? bytes.length : 0),
      }
    },
    lastBucket: () => {
      const bucket = raster.lastBucket()
      return bucket > 0 ? bucket : null
    },
    lastTilesRendered: () => raster.lastTilesRendered(),
    tileCount: () => raster.tileCount(),
    dispose: () => raster.free(),
  }
}

/** Tile bucket the raster uses at this camera zoom, null when it paints at the exact device scale. */
export const viewportRasterBucket = (zoom: number) => {
  ensureViewportRasterWasm()
  const bucket = zoomBucket(zoom)
  return bucket > 0 ? bucket : null
}

export const viewportRasterTilePx = () => {
  ensureViewportRasterWasm()
  return tilePx()
}

export const viewportRasterTileBudget = () => {
  ensureViewportRasterWasm()
  return tileBudget()
}

export const rasterPressureWidth = (baseWidth: number, pressureEnabled: boolean, pressure: number) => {
  ensureViewportRasterWasm()
  return pressureWidthWasm(baseWidth, pressureEnabled, pressure)
}

/**
 * Paints strokes into a `width` × `height` bitmap of a page `layoutWidth`
 * layout px wide, through the same scene and tiles the board uses —
 * the Rust counterpart of `drawInkStroke` into a readback canvas.
 */
export const rasterizeInkStrokes = (
  strokes: ReadonlyArray<RasterInkStroke>,
  width: number,
  height: number,
  options: { layoutWidth?: number; smoothing?: number; symbols?: ReadonlyArray<RasterSymbol> } = {},
): RasterImage => {
  const w = Math.max(1, Math.round(width))
  const h = Math.max(1, Math.round(height))
  const layoutWidth = options.layoutWidth && options.layoutWidth > 1 ? options.layoutWidth : w
  const scale = w / layoutWidth
  const raster = createViewportRaster(options.symbols)
  try {
    raster.setScene(layoutWidth, h / scale, options.smoothing ?? 0, strokes)
    return raster.paint(
      { scale, dpr: scale, originX: 0, originY: 0, width: w, height: h },
      { x: 0, y: 0, width: w, height: h },
    )
  } finally {
    raster.dispose()
  }
}
