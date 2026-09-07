/**
 * Ink window planning in paper layout px.
 *
 * The committed and live ink canvases cover a fixed-height slice of the sheet
 * (one viewport above and below the visible part) instead of the whole page,
 * so the bitmap stays sharp and small on long pages. Everything here is in
 * paper layout px, never fractions: growing the page does not move the slice,
 * and a slice move is quantized to whole bitmap rows so the painted bitmap can
 * be reused with an exact copy instead of a full repaint.
 */
import { FULL_INK_WINDOW, type InkWindow } from './pdfInkHit'

export type InkWindowLayout = { top: number; height: number }
export type InkVisibleRange = { top: number; bottom: number }

/** Slice height in viewports: the visible sheet plus one viewport above and below. */
export const INK_WINDOW_VIEWPORTS = 3
/** Move the slice once the visible sheet gets this close (in viewports) to its edge. */
export const INK_WINDOW_GUARD_VIEWPORTS = 0.5
/** inkWindowSpan floors the CSS span at 0.06; keep the slice above that. */
export const INK_WINDOW_MIN_SPAN = 0.061
/** A sheet within 2 % of the slice height paints as one full bitmap. */
export const INK_WINDOW_FULL_RATIO = 0.98

const finite = (value: number, fallback: number) => (Number.isFinite(value) ? value : fallback)

/**
 * Visible sheet range in paper layout px from client rects. The plane may be
 * CSS-zoomed, so scroll offsets are visual px while ink is layout px; the
 * paper rect carries that zoom. Rotation has no axis-aligned slice: null.
 */
export const measureVisibleInkLayout = (input: {
  scrollerTop: number
  scrollerHeight: number
  paperTop: number
  paperVisualHeight: number
  paperLayoutHeight: number
  rotation?: number
}): { visible: InkVisibleRange; viewportHeight: number; zoom: number } | null => {
  if (input.rotation && Math.abs(input.rotation) % 360 !== 0) return null
  const layoutHeight = Math.max(1, finite(input.paperLayoutHeight, 1))
  const visualHeight = finite(input.paperVisualHeight, 0)
  if (!(visualHeight > 0)) return null
  const zoom = visualHeight / layoutHeight
  const viewportHeight = Math.max(1, finite(input.scrollerHeight, 1)) / zoom
  const top = (finite(input.scrollerTop, 0) - finite(input.paperTop, 0)) / zoom
  return { visible: { top, bottom: top + viewportHeight }, viewportHeight, zoom }
}

/** Slice height for a sheet: three viewports, at least the CSS span floor, at most the sheet. */
export const inkWindowHeightFor = (paperHeight: number, viewportHeight: number) => {
  const paper = Math.max(1, finite(paperHeight, 1))
  const viewport = Math.max(1, finite(viewportHeight, 1))
  return Math.min(paper, Math.max(INK_WINDOW_VIEWPORTS * viewport, INK_WINDOW_MIN_SPAN * paper))
}

export const inkWindowIsFull = (paperHeight: number, height: number) => (
  height >= Math.max(1, paperHeight) * INK_WINDOW_FULL_RATIO
)

const clampTop = (top: number, paperHeight: number, height: number) => (
  Math.min(Math.max(0, paperHeight - height), Math.max(0, top))
)

/** Whether the visible sheet left the guarded middle of the slice. */
export const inkWindowNeedsMove = (
  current: InkWindowLayout,
  visible: InkVisibleRange,
  guard: number,
  paperHeight: number,
) => {
  const bottom = current.top + current.height
  const needsUp = current.top > 0.5 && visible.top < current.top + guard
  const needsDown = bottom < paperHeight - 0.5 && visible.bottom > bottom - guard
  return needsUp || needsDown
}

export type InkWindowPlan = { window: InkWindowLayout | null; changed: boolean }

/**
 * Keep-or-move decision for the slice. `null` means one full bitmap. The
 * slice keeps its height while the viewport and sheet fit it, so a move never
 * reallocates the bitmap, and it only moves when the visible sheet reaches
 * the guard zone — then it re-centres on the visible sheet.
 */
export const planInkWindow = (input: {
  paperHeight: number
  viewportHeight: number
  visible: InkVisibleRange
  current: InkWindowLayout | null
  force?: boolean
}): InkWindowPlan => {
  const paperHeight = Math.max(1, finite(input.paperHeight, 1))
  const viewportHeight = Math.max(1, finite(input.viewportHeight, 1))
  const height = inkWindowHeightFor(paperHeight, viewportHeight)
  const current = input.current
  if (inkWindowIsFull(paperHeight, height)) return { window: null, changed: current !== null }
  const sameHeight = current !== null && Math.abs(current.height - height) < 0.5
  if (current && sameHeight && !input.force) {
    const guard = INK_WINDOW_GUARD_VIEWPORTS * viewportHeight
    const clampedTop = clampTop(current.top, paperHeight, height)
    // A shorter sheet (undo of a grow) can leave the slice hanging below it.
    if (Math.abs(clampedTop - current.top) < 0.5 && !inkWindowNeedsMove(current, input.visible, guard, paperHeight)) {
      return { window: current, changed: false }
    }
  }
  const center = (finite(input.visible.top, 0) + finite(input.visible.bottom, 0)) / 2
  const top = clampTop(center - height / 2, paperHeight, height)
  if (current && sameHeight && Math.abs(current.top - top) < 0.5) return { window: current, changed: false }
  return { window: { top, height }, changed: true }
}

export type PlacedInkWindow = {
  window: InkWindow
  /** Layout px of the slice top after quantizing to whole bitmap rows. */
  top: number
  /** Bitmap rows between the sheet top and the slice top; the paint translate. */
  topPx: number
  /** Bitmap px the whole sheet would span at this scale (paint height for 0–1 ink). */
  virtualHeight: number
}

/**
 * Slice → paint geometry. The top is quantized to whole bitmap rows so the
 * committed bitmap can be shifted by an integer on a move and stays exact.
 * `y1 - y0` is the exact span, so `y0 * virtualHeight === topPx`.
 */
export const placeInkWindow = (
  window: InkWindowLayout | null,
  paperHeight: number,
  pixelHeight: number,
): PlacedInkWindow => {
  const paper = Math.max(1, finite(paperHeight, 1))
  const pixels = Math.max(1, finite(pixelHeight, 1))
  if (!window || inkWindowIsFull(paper, window.height)) {
    return { window: { ...FULL_INK_WINDOW }, top: 0, topPx: 0, virtualHeight: pixels }
  }
  const height = Math.min(paper, Math.max(1, window.height))
  const scaleY = pixels / height
  const topPx = Math.round(clampTop(window.top, paper, height) * scaleY)
  const top = topPx / scaleY
  const span = height / paper
  const y0 = top / paper
  return { window: { y0, y1: y0 + span }, top, topPx, virtualHeight: pixels / span }
}

export type InkWindowShift = {
  /** Rows the existing bitmap content moves (positive = down). */
  dy: number
  /** Newly exposed rows that must be painted from the model. */
  band: { y: number; height: number }
}

/** Bitmap copy for a slice move at the same size, or null when a full repaint is cheaper. */
export const inkWindowShift = (prevTopPx: number, nextTopPx: number, pixelHeight: number): InkWindowShift | null => {
  if (!Number.isInteger(prevTopPx) || !Number.isInteger(nextTopPx) || !(pixelHeight > 0)) return null
  const dy = prevTopPx - nextTopPx
  if (dy === 0) return { dy: 0, band: { y: 0, height: 0 } }
  if (Math.abs(dy) >= pixelHeight) return null
  return {
    dy,
    band: dy > 0 ? { y: 0, height: dy } : { y: pixelHeight + dy, height: -dy },
  }
}

/** Paper 0–1 window of a bitmap row band, for the stroke filter of a band paint. */
export const inkBandWindow = (topPx: number, band: { y: number; height: number }, virtualHeight: number): InkWindow => {
  const virtual = Math.max(1, virtualHeight)
  return {
    y0: (topPx + band.y) / virtual,
    y1: (topPx + band.y + band.height) / virtual,
  }
}

export type InkLayoutBox = { left: number; top: number; width: number; height: number }
export type InkLayoutSize = { width: number; height: number }
export type InkLayoutPoint = { x: number; y: number }

/**
 * Visible sheet box in paper layout px on both axes. Same zoom handling as
 * measureVisibleInkLayout: client rects carry the plane's CSS zoom, layout
 * ink does not.
 */
export const measureVisibleInkBox = (input: {
  scrollerLeft: number
  scrollerTop: number
  scrollerWidth: number
  scrollerHeight: number
  paperLeft: number
  paperTop: number
  paperVisualWidth: number
  paperVisualHeight: number
  paperLayoutWidth: number
  paperLayoutHeight: number
  rotation?: number
}): { visible: InkLayoutBox & InkVisibleRange; viewport: InkLayoutSize; zoom: number } | null => {
  const vertical = measureVisibleInkLayout({
    scrollerTop: input.scrollerTop,
    scrollerHeight: input.scrollerHeight,
    paperTop: input.paperTop,
    paperVisualHeight: input.paperVisualHeight,
    paperLayoutHeight: input.paperLayoutHeight,
    rotation: input.rotation,
  })
  if (!vertical) return null
  const { zoom, viewportHeight } = vertical
  const viewportWidth = Math.max(1, finite(input.scrollerWidth, 1)) / zoom
  const left = (finite(input.scrollerLeft, 0) - finite(input.paperLeft, 0)) / zoom
  return {
    visible: { ...vertical.visible, left, width: viewportWidth, height: viewportHeight },
    viewport: { width: viewportWidth, height: viewportHeight },
    zoom,
  }
}

/**
 * Live layer: the stroke in progress only needs a bitmap around the visible
 * sheet. Guard on each side, in viewports — the pen may cross the visible
 * edge by this much (auto-scroll, capture) before the slice has to move.
 */
export const LIVE_INK_GUARD_VIEWPORTS = 0.15
/** Pen samples closer than this (layout px) to the live slice edge move it. */
export const LIVE_INK_EDGE_PX = 24

export const liveInkWindowSize = (paper: InkLayoutSize, viewport: InkLayoutSize): InkLayoutSize => {
  const paperW = Math.max(1, finite(paper.width, 1))
  const paperH = Math.max(1, finite(paper.height, 1))
  const grow = 1 + 2 * LIVE_INK_GUARD_VIEWPORTS
  return {
    width: Math.min(paperW, Math.max(1, finite(viewport.width, 1)) * grow),
    height: Math.min(paperH, Math.max(1, finite(viewport.height, 1)) * grow),
  }
}

const boxContains = (box: InkLayoutBox, inner: InkLayoutBox, tolerance = 0.5) => (
  inner.left >= box.left - tolerance
  && inner.top >= box.top - tolerance
  && inner.left + inner.width <= box.left + box.width + tolerance
  && inner.top + inner.height <= box.top + box.height + tolerance
)

const clampBoxToPaper = (box: InkLayoutBox, paper: InkLayoutSize): InkLayoutBox => ({
  left: Math.min(Math.max(0, paper.width - box.width), Math.max(0, box.left)),
  top: Math.min(Math.max(0, paper.height - box.height), Math.max(0, box.top)),
  width: box.width,
  height: box.height,
})

const sameBox = (a: InkLayoutBox, b: InkLayoutBox) => (
  Math.abs(a.left - b.left) < 0.5
  && Math.abs(a.top - b.top) < 0.5
  && Math.abs(a.width - b.width) < 0.5
  && Math.abs(a.height - b.height) < 0.5
)

/** True when a layout point lies inside the box, at least `inset` from every edge. */
export const liveInkWindowHolds = (box: InkLayoutBox | null, point: InkLayoutPoint, inset = LIVE_INK_EDGE_PX) => (
  !box || (
    point.x >= box.left + inset
    && point.x <= box.left + box.width - inset
    && point.y >= box.top + inset
    && point.y <= box.top + box.height - inset
  )
)

export type LiveInkWindowPlan = { window: InkLayoutBox | null; changed: boolean }

/**
 * Keep-or-move decision for the live slice. `null` means the live layer
 * shares the committed slice (the viewport plus guard covers the sheet). The
 * slice keeps its size while the viewport does, so a move never reallocates
 * the bitmap. It stays while it holds the visible sheet (and the pen, when
 * given); otherwise it re-centres on the visible sheet, shifted toward the
 * pen as far as the guard allows, and clamped to the sheet.
 */
export const planLiveInkWindow = (input: {
  paper: InkLayoutSize
  viewport: InkLayoutSize
  visible: InkLayoutBox
  current: InkLayoutBox | null
  pen?: InkLayoutPoint | null
  force?: boolean
}): LiveInkWindowPlan => {
  const paper = { width: Math.max(1, finite(input.paper.width, 1)), height: Math.max(1, finite(input.paper.height, 1)) }
  const size = liveInkWindowSize(paper, input.viewport)
  const current = input.current
  if (size.width >= paper.width * INK_WINDOW_FULL_RATIO && size.height >= paper.height * INK_WINDOW_FULL_RATIO) {
    return { window: null, changed: current !== null }
  }
  // The visible sheet, clipped to the sheet: a viewport larger than the sheet
  // shows margins the slice never needs to cover.
  const visLeft = Math.min(Math.max(0, finite(input.visible.left, 0)), paper.width)
  const visTop = Math.min(Math.max(0, finite(input.visible.top, 0)), paper.height)
  const visRight = Math.max(visLeft, Math.min(paper.width, finite(input.visible.left, 0) + finite(input.visible.width, 0)))
  const visBottom = Math.max(visTop, Math.min(paper.height, finite(input.visible.top, 0) + finite(input.visible.height, 0)))
  const visible: InkLayoutBox = { left: visLeft, top: visTop, width: visRight - visLeft, height: visBottom - visTop }
  const pen = input.pen && Number.isFinite(input.pen.x) && Number.isFinite(input.pen.y) ? input.pen : null
  const sameSize = current !== null && Math.abs(current.width - size.width) < 0.5 && Math.abs(current.height - size.height) < 0.5
  if (current && sameSize && !input.force && boxContains(current, visible) && (!pen || liveInkWindowHolds(current, pen))) {
    return { window: current, changed: false }
  }
  let left = visLeft + visible.width / 2 - size.width / 2
  let top = visTop + visible.height / 2 - size.height / 2
  if (pen) {
    // Slide toward the pen, but never uncover the visible sheet.
    const slackX = Math.max(0, (size.width - visible.width) / 2)
    const slackY = Math.max(0, (size.height - visible.height) / 2)
    const wantLeft = pen.x < left + LIVE_INK_EDGE_PX
      ? pen.x - LIVE_INK_EDGE_PX
      : pen.x > left + size.width - LIVE_INK_EDGE_PX
        ? pen.x + LIVE_INK_EDGE_PX - size.width
        : left
    const wantTop = pen.y < top + LIVE_INK_EDGE_PX
      ? pen.y - LIVE_INK_EDGE_PX
      : pen.y > top + size.height - LIVE_INK_EDGE_PX
        ? pen.y + LIVE_INK_EDGE_PX - size.height
        : top
    left = Math.min(left + slackX, Math.max(left - slackX, wantLeft))
    top = Math.min(top + slackY, Math.max(top - slackY, wantTop))
  }
  const next = clampBoxToPaper({ left, top, width: size.width, height: size.height }, paper)
  if (current && sameBox(current, next)) return { window: current, changed: false }
  return { window: next, changed: true }
}

export type LiveInkSlice = { leftPx: number; topPx: number; width: number; height: number }

export type PlacedLiveInkWindow = {
  /** Bitmap px of the live canvas and its offset in the sheet's paint space. */
  slice: LiveInkSlice
  /** Layout px box after quantizing to whole bitmap px — the CSS box. */
  box: InkLayoutBox
}

/**
 * Live slice → paint geometry. `paint` is the whole sheet in bitmap px at the
 * committed scale (pixel width, virtual height), so the live bitmap has the
 * same px pitch as the committed one and its offset is whole px: a stroke
 * moving from the live to the committed layer lands on the same texels.
 */
export const placeLiveInkWindow = (
  window: InkLayoutBox,
  paper: InkLayoutSize,
  paint: InkLayoutSize,
): PlacedLiveInkWindow => {
  const paperW = Math.max(1, finite(paper.width, 1))
  const paperH = Math.max(1, finite(paper.height, 1))
  const paintW = Math.max(1, Math.round(finite(paint.width, 1)))
  const paintH = Math.max(1, Math.round(finite(paint.height, 1)))
  const scaleX = paintW / paperW
  const scaleY = paintH / paperH
  const width = Math.min(paintW, Math.max(1, Math.round(window.width * scaleX)))
  const height = Math.min(paintH, Math.max(1, Math.round(window.height * scaleY)))
  const leftPx = Math.min(paintW - width, Math.max(0, Math.round(window.left * scaleX)))
  const topPx = Math.min(paintH - height, Math.max(0, Math.round(window.top * scaleY)))
  return {
    slice: { leftPx, topPx, width, height },
    box: { left: leftPx / scaleX, top: topPx / scaleY, width: width / scaleX, height: height / scaleY },
  }
}

export const sameLiveInkSlice = (a: LiveInkSlice | null, b: LiveInkSlice | null) => (
  a === b || (
    a !== null && b !== null
    && a.leftPx === b.leftPx && a.topPx === b.topPx && a.width === b.width && a.height === b.height
  )
)

/** True when a pen sample (layout px) sits in the guard zone or outside the slice. */
export const inkWindowGuardHit = (
  window: InkWindowLayout | null,
  layoutY: number,
  viewportHeight: number,
  paperHeight: number,
) => {
  if (!window) return false
  const guard = INK_WINDOW_GUARD_VIEWPORTS * Math.max(1, viewportHeight)
  const bottom = window.top + window.height
  if (window.top > 0.5 && layoutY < window.top + guard) return true
  if (bottom < paperHeight - 0.5 && layoutY > bottom - guard) return true
  return layoutY < window.top || layoutY > bottom
}
