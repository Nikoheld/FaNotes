/**
 * OneNote-like note canvas: one writable page that grows with ink/text,
 * plus a finite extra-paper scroll room that moves with that page.
 *
 * This is the live write/camera math. PaperView and DrawingBoard call these
 * functions. The extra room is the same paper, not a second dark stage, and
 * there is no nested A4 write-card.
 */

export const PAGE_START_WIDTH = 900
export const PAGE_START_HEIGHT = 1273

/** Extra writable paper past the last mark — OneNote blank at the end of the page. */
export const WRITE_MARGIN_X = 108
export const WRITE_MARGIN_Y = 144

/** Grow in the same chunks as the write margin so the page follows the pen. */
export const GROW_STEP_X = WRITE_MARGIN_X
export const GROW_STEP_Y = WRITE_MARGIN_Y

/**
 * Finite extra pan room past the write page. Far enough to pan, never unbounded.
 * Same paper as the page — not a dark stage / second surface.
 */
export const SCROLL_ROOM = 560

export const WRITE_CAP_WIDTH = PAGE_START_WIDTH * 20
export const WRITE_CAP_HEIGHT = PAGE_START_HEIGHT * 40

export const PAGE_BACKGROUND = '#fff'

export type CanvasBox = {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export type CanvasSize = {
  width: number
  height: number
}

export type CanvasPoint = {
  x: number
  y: number
}

export type CanvasViewport = {
  width: number
  height: number
}

const finitePositive = (value: number) => (Number.isFinite(value) && value > 0 ? value : 0)

/** Grow the max edge so a 0–1 mark plus write margin still fits. Repeats at the new edge. */
export const growWriteExtent = (
  normalized: number | undefined,
  current: number,
  margin: number,
  step: number,
) => {
  if (typeof normalized !== 'number' || !Number.isFinite(normalized)) return current
  if (!Number.isFinite(current) || current < 1) return current
  if (!Number.isFinite(margin) || !Number.isFinite(step) || step < 1) return current
  const needed = normalized * current + margin
  if (!(needed > current)) return current
  return Math.max(current, Math.ceil(needed / step) * step)
}

/** Extra origin pad when writing near or past the min edge (left or top). */
export const growWriteOrigin = (
  normalized: number | undefined,
  current: number,
  margin: number,
  step: number,
) => {
  if (typeof normalized !== 'number' || !Number.isFinite(normalized)) return 0
  if (!Number.isFinite(current) || current < 1) return 0
  if (!Number.isFinite(margin) || !Number.isFinite(step) || step < 1) return 0
  const pixel = normalized * current
  if (pixel >= margin) return 0
  return Math.ceil((margin - pixel) / step) * step
}

export const paperMinEdgeGrows = (
  normalized: number | undefined,
  current: number,
  margin: number,
  step: number,
) => growWriteOrigin(normalized, current, margin, step) > 0

const skipMaxGrowIfPaintedCovers = (
  wanted: number,
  current: number,
  painted: number,
  mustGrow: boolean,
) => {
  if (mustGrow) return wanted
  if (!Number.isFinite(painted) || !(painted > 1)) return wanted
  if (Number.isFinite(wanted) && wanted <= painted) return current
  return wanted
}

/** Grow the write page around a mark. Left/top pad and right/bottom extent both move. */
export const growPageFromMark = (
  extent: CanvasSize,
  mark: { x?: number; y?: number },
  painted: { width?: number; height?: number } = {},
) => {
  const padX = growWriteOrigin(mark.x, extent.width, WRITE_MARGIN_X, GROW_STEP_X)
  const padY = growWriteOrigin(mark.y, extent.height, WRITE_MARGIN_Y, GROW_STEP_Y)
  let width = Math.max(
    growWriteExtent(mark.x, extent.width, WRITE_MARGIN_X, GROW_STEP_X),
    extent.width + padX,
  )
  let height = Math.max(
    growWriteExtent(mark.y, extent.height, WRITE_MARGIN_Y, GROW_STEP_Y),
    extent.height + padY,
  )
  width = skipMaxGrowIfPaintedCovers(width, extent.width, painted.width ?? 0, padX > 0)
  height = skipMaxGrowIfPaintedCovers(height, extent.height, painted.height ?? 0, padY > 0)
  return {
    width: Math.min(WRITE_CAP_WIDTH, Math.max(extent.width, width)),
    height: Math.min(WRITE_CAP_HEIGHT, Math.max(extent.height, height)),
    padX,
    padY,
  }
}

/** Keep a 0–1 mark at the same page-pixel position after the page grows. */
export const keepMarkOnPage = (
  value: number,
  prevExtent: number,
  nextExtent: number,
  minPad = 0,
) => {
  if (!Number.isFinite(value) || !(prevExtent > 0) || !(nextExtent > 0)) return value
  const pad = Math.max(0, Number.isFinite(minPad) ? minPad : 0)
  if (Math.abs(nextExtent - prevExtent) < 1e-6 && pad === 0) return value
  return (value * prevExtent + pad) / nextExtent
}

export const markPagePosition = (normalized: number, extent: number) => (
  Number.isFinite(normalized) && Number.isFinite(extent) ? normalized * extent : 0
)

/** Scroll range = content plus the same finite extra room on every side. */
export const canvasScrollBounds = (
  content: CanvasBox,
  room = SCROLL_ROOM,
): CanvasBox => {
  const extra = Math.max(0, Number.isFinite(room) ? room : 0)
  return {
    minX: (Number.isFinite(content.minX) ? content.minX : 0) - extra,
    minY: (Number.isFinite(content.minY) ? content.minY : 0) - extra,
    maxX: (Number.isFinite(content.maxX) ? content.maxX : 0) + extra,
    maxY: (Number.isFinite(content.maxY) ? content.maxY : 0) + extra,
  }
}

export const paperScrollPad = (bounds: CanvasBox) => ({
  left: Math.max(0, -(Number.isFinite(bounds.minX) ? bounds.minX : 0)),
  top: Math.max(0, -(Number.isFinite(bounds.minY) ? bounds.minY : 0)),
})

/** Clamp pan/scroll to the finite extra-paper range. Far offsets stop at the bound. */
export const clampCanvasScroll = (
  offset: { x: number; y: number },
  bounds: CanvasBox,
  viewport: CanvasViewport,
) => {
  const viewW = Math.max(0, viewport.width)
  const viewH = Math.max(0, viewport.height)
  const maxScrollX = Math.max(0, bounds.maxX - viewW)
  const maxScrollY = Math.max(0, bounds.maxY - viewH)
  const x = Number.isFinite(offset.x) ? offset.x : 0
  const y = Number.isFinite(offset.y) ? offset.y : 0
  return {
    x: Math.min(maxScrollX, Math.max(0, x)),
    y: Math.min(maxScrollY, Math.max(0, y)),
  }
}

export const writeExtentFromContent = (content: CanvasBox) => {
  const maxX = Math.max(0, Number.isFinite(content.maxX) ? content.maxX : 0) + WRITE_MARGIN_X
  const maxY = Math.max(0, Number.isFinite(content.maxY) ? content.maxY : 0) + WRITE_MARGIN_Y
  return {
    width: Math.min(WRITE_CAP_WIDTH, Math.max(PAGE_START_WIDTH, maxX)),
    height: Math.min(WRITE_CAP_HEIGHT, Math.max(WRITE_MARGIN_Y, maxY)),
  }
}

/** One write page at the origin, plus extra paper as scroll room on every side. */
export const pageCanvasLayout = (page: CanvasSize, room = SCROLL_ROOM) => {
  const pad = Math.max(0, Number.isFinite(room) ? room : 0)
  const width = Math.max(1, finitePositive(page.width) || 1)
  const height = Math.max(1, finitePositive(page.height) || 1)
  return {
    pad,
    page: { x: 0, y: 0, width, height },
    scroll: { x: -pad, y: -pad, width: width + pad * 2, height: height + pad * 2 },
  }
}

/**
 * Hit overlay must cover the write page. Covering the extra paper as well is
 * fine (writing in that blank grows the page). A 0×0 overlay falls back to the
 * page plus extra room so the pen still hits paper.
 */
export const inkOverlaySize = (
  overlay: CanvasSize,
  page: CanvasSize,
  plane: CanvasSize = { width: 0, height: 0 },
) => {
  const overlayW = finitePositive(overlay.width)
  const overlayH = finitePositive(overlay.height)
  const pageW = finitePositive(page.width)
  const pageH = finitePositive(page.height)
  const planeW = finitePositive(plane.width)
  const planeH = finitePositive(plane.height)
  const layout = pageW > 8 && pageH > 8 ? pageCanvasLayout({ width: pageW, height: pageH }) : null
  const minW = layout ? layout.page.width : 0
  const minH = layout ? layout.page.height : 0
  if (overlayW >= minW - 1 && overlayH >= minH - 1 && overlayW >= 8 && overlayH >= 8) {
    return { width: overlayW, height: overlayH }
  }
  if (planeW >= 8 && planeH >= 8) return { width: planeW, height: planeH }
  if (layout) return { width: layout.scroll.width, height: layout.scroll.height }
  if (overlayW >= 8 && overlayH >= 8) return { width: overlayW, height: overlayH }
  return { width: 0, height: 0 }
}

/** Map a pointer onto the write page. Values may sit slightly outside 0–1 to grow it. */
export const mapClientToPage = (
  clientX: number,
  clientY: number,
  page: { left: number; top: number; width: number; height: number },
) => {
  if (!(page.width > 0) || !(page.height > 0)) return null
  const x = (clientX - page.left) / page.width
  const y = (clientY - page.top) / page.height
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x, y }
}

export const writePageSurface = (page: { x: number; y: number; width: number; height: number }) => ({
  x: page.x,
  y: page.y,
  width: page.width,
  height: page.height,
})

export const writeSurfaceIsPage = (
  surface: { x: number; y: number; width: number; height: number },
  page: { x: number; y: number; width: number; height: number },
) => (
  surface.x === page.x
  && surface.y === page.y
  && surface.width === page.width
  && surface.height === page.height
)

/** Visual (zoomed) paper rect in scroller coordinates. Does not add write margin. */
export const paperScrollBoundsFromVisualRect = (
  paper: { left: number; top: number; right: number; bottom: number },
  scroller: { left: number; top: number; scrollLeft: number; scrollTop: number },
): CanvasBox => {
  const minX = paper.left - scroller.left + scroller.scrollLeft
  const minY = paper.top - scroller.top + scroller.scrollTop
  const maxX = paper.right - scroller.left + scroller.scrollLeft
  const maxY = paper.bottom - scroller.top + scroller.scrollTop
  return {
    minX: Number.isFinite(minX) ? minX : 0,
    minY: Number.isFinite(minY) ? minY : 0,
    maxX: Number.isFinite(maxX) ? maxX : 0,
    maxY: Number.isFinite(maxY) ? maxY : 0,
  }
}

/** Names used by 0–1 ink storage, CSS extent, and older call sites. */
export const PAPER_SOURCE_WIDTH = PAGE_START_WIDTH
export const PAPER_SOURCE_HEIGHT = PAGE_START_HEIGHT
export const WRITE_SLACK_WIDTH = WRITE_MARGIN_X
export const WRITE_SLACK_HEIGHT = WRITE_MARGIN_Y
export const PAGE_GROW_STEP_WIDTH = GROW_STEP_X
export const PAGE_GROW_STEP_HEIGHT = GROW_STEP_Y
export const WRITE_MEMORY_CAP_WIDTH = WRITE_CAP_WIDTH
export const WRITE_MEMORY_CAP_HEIGHT = WRITE_CAP_HEIGHT
export const neededWriteExtent = growWriteExtent
export const neededWriteMinPad = growWriteOrigin
export const remapNormalizedAfterExtent = keepMarkOnPage
export const paperScrollBounds = canvasScrollBounds
export const clampPaperScrollOffset = clampCanvasScroll
export const paperSourceExtentFromContent = writeExtentFromContent
export const mapClientToOneCanvas = mapClientToPage
export const oneCanvasSurface = writePageSurface
export const writeSurfaceIsPlane = writeSurfaceIsPage
export const inkOverlayCoversStage = inkOverlaySize
