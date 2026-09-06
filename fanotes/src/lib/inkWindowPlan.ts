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
