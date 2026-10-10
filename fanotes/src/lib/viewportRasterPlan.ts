/**
 * Geometry of the viewport raster: one box in paper layout px (the visible
 * sheet plus the live guard, see `planLiveInkWindow`) painted at the camera's
 * device scale. The canvases sit inside the CSS-zoomed sheet, so a bitmap of
 * `box × zoom × dpr` lands at one bitmap px per screen px at any zoom.
 */
import type { InkLayoutBox, InkLayoutSize } from './inkWindowPlan'

export const VIEWPORT_RASTER_MAX_DPR = 4
export const VIEWPORT_RASTER_MIN_ZOOM = 0.05
/** Same caps as the slice bitmap; only a rotated sheet (no axis-aligned box) can reach them. */
export const VIEWPORT_RASTER_MAX_EDGE = 16_384
export const VIEWPORT_RASTER_MAX_PIXELS = 48_000_000

export type ViewportRasterSlice = { leftPx: number; topPx: number; width: number; height: number }

export type ViewportRasterPlacement = {
  /** Device px per layout px. */
  scale: number
  dpr: number
  /** The whole sheet in device px: the paint space live ink is drawn in. */
  paint: InkLayoutSize
  /** Bitmap of both canvases: size and offset inside the paint space. */
  slice: ViewportRasterSlice
  /** CSS box of both canvases, layout px, snapped to whole bitmap px. */
  box: InkLayoutBox
  key: string
}

export type ViewportRasterView = {
  scale: number
  dpr: number
  originX: number
  originY: number
  width: number
  height: number
}

export type ViewportRasterRegion = { x: number; y: number; width: number; height: number }

const finite = (value: number, fallback: number) => (Number.isFinite(value) ? value : fallback)

export const viewportRasterDpr = (devicePixelRatio: number) => (
  Math.min(Math.max(finite(devicePixelRatio, 1), 1), VIEWPORT_RASTER_MAX_DPR)
)

export const placeViewportRaster = (
  box: InkLayoutBox | null,
  layout: InkLayoutSize,
  zoom: number,
  devicePixelRatio: number,
): ViewportRasterPlacement => {
  const dpr = viewportRasterDpr(devicePixelRatio)
  const layoutW = Math.max(1, finite(layout.width, 1))
  const layoutH = Math.max(1, finite(layout.height, 1))
  const left = Math.min(layoutW, Math.max(0, finite(box?.left ?? 0, 0)))
  const top = Math.min(layoutH, Math.max(0, finite(box?.top ?? 0, 0)))
  const right = box ? Math.min(layoutW, Math.max(left, left + finite(box.width, 0))) : layoutW
  const bottom = box ? Math.min(layoutH, Math.max(top, top + finite(box.height, 0))) : layoutH
  let scale = Math.max(VIEWPORT_RASTER_MIN_ZOOM, finite(zoom, 1)) * dpr
  const edge = Math.max(right - left, bottom - top) * scale
  if (edge > VIEWPORT_RASTER_MAX_EDGE) scale *= VIEWPORT_RASTER_MAX_EDGE / edge
  const snap = () => {
    const leftPx = Math.floor(left * scale)
    const topPx = Math.floor(top * scale)
    return {
      leftPx,
      topPx,
      width: Math.max(1, Math.ceil(right * scale) - leftPx),
      height: Math.max(1, Math.ceil(bottom * scale) - topPx),
    }
  }
  let snapped = snap()
  // Whole-px snapping adds up to one row and column; shrink until the budget holds after it.
  for (let attempt = 0; attempt < 4 && snapped.width * snapped.height > VIEWPORT_RASTER_MAX_PIXELS; attempt += 1) {
    scale *= Math.sqrt(VIEWPORT_RASTER_MAX_PIXELS / (snapped.width * snapped.height)) * 0.999
    snapped = snap()
  }
  const { leftPx, topPx, width, height } = snapped
  return {
    scale,
    dpr,
    paint: { width: layoutW * scale, height: layoutH * scale },
    slice: { leftPx, topPx, width, height },
    box: { left: leftPx / scale, top: topPx / scale, width: width / scale, height: height / scale },
    key: [scale, leftPx, topPx, width, height].join(':'),
  }
}

export const viewportRasterViewOf = (placement: ViewportRasterPlacement): ViewportRasterView => ({
  scale: placement.scale,
  dpr: placement.dpr,
  originX: placement.slice.leftPx,
  originY: placement.slice.topPx,
  width: placement.slice.width,
  height: placement.slice.height,
})

/**
 * A box move at the same scale and size: the bitmap content moves by
 * (dx, dy) and only the exposed strips need paint. Null when a full paint is needed.
 */
export const viewportRasterShift = (previous: ViewportRasterView | null, next: ViewportRasterView) => {
  if (!previous) return null
  if (previous.scale !== next.scale || previous.width !== next.width || previous.height !== next.height) return null
  const dx = previous.originX - next.originX
  const dy = previous.originY - next.originY
  if (Math.abs(dx) >= next.width || Math.abs(dy) >= next.height) return null
  const regions: ViewportRasterRegion[] = []
  if (dx > 0) regions.push({ x: 0, y: 0, width: dx, height: next.height })
  if (dx < 0) regions.push({ x: next.width + dx, y: 0, width: -dx, height: next.height })
  if (dy > 0) regions.push({ x: 0, y: 0, width: next.width, height: dy })
  if (dy < 0) regions.push({ x: 0, y: next.height + dy, width: next.width, height: -dy })
  return { dx, dy, regions }
}
