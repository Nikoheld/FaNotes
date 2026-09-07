/**
 * PDF toolbar zoom as a camera.
 *
 * The page column keeps its layout width (ink is 0–1 of the paper, so the
 * column must not re-flow); "Breite", "Seite" and the ± buttons move the
 * sheet camera (CSS zoom on the plane) instead. Fit factors are computed
 * from layout px — the unzoomed column and page boxes — against the
 * scroller's client box.
 */
export type PdfZoomMode = 'fit-width' | 'fit-page' | 'custom'

/** Stage left visible beside a fitted page, in CSS px of the viewport. */
export const PDF_FIT_GUTTER = 18

export const PDF_CAMERA_STEP = 1.2

export type PdfFitInput = {
  viewWidth: number
  viewHeight: number
  /** Layout width of the page column (unzoomed CSS px). */
  columnWidth: number
  /** Layout height of one page including its bottom margin (unzoomed CSS px). */
  pageHeight: number
  min: number
  max: number
  gutter?: number
}

const finite = (value: number, fallback: number) => (Number.isFinite(value) ? value : fallback)

export const clampPdfZoom = (zoom: number, min: number, max: number) => {
  const lo = Math.max(0.01, finite(min, 0.01))
  const hi = Math.max(lo, finite(max, lo))
  return Math.min(hi, Math.max(lo, Math.round(finite(zoom, 1) * 1000) / 1000))
}

export const pdfFitWidthZoom = (input: PdfFitInput) => {
  const gutter = Math.max(0, finite(input.gutter ?? PDF_FIT_GUTTER, PDF_FIT_GUTTER))
  if (!(input.columnWidth > 0) || !(input.viewWidth > 0)) return clampPdfZoom(1, input.min, input.max)
  const usable = Math.max(1, input.viewWidth - gutter * 2)
  return clampPdfZoom(usable / input.columnWidth, input.min, input.max)
}

/** Whole page visible: the tighter of fit-height and fit-width. */
export const pdfFitPageZoom = (input: PdfFitInput) => {
  const gutter = Math.max(0, finite(input.gutter ?? PDF_FIT_GUTTER, PDF_FIT_GUTTER))
  const width = pdfFitWidthZoom(input)
  if (!(input.pageHeight > 0) || !(input.viewHeight > 0)) return width
  const usable = Math.max(1, input.viewHeight - gutter * 2)
  return clampPdfZoom(Math.min(width, usable / input.pageHeight), input.min, input.max)
}

/** Which toolbar mode the current camera zoom corresponds to. */
export const pdfZoomModeForZoom = (
  zoom: number,
  fit: { width: number; page: number },
  tolerance = 0.006,
): PdfZoomMode => {
  if (Math.abs(zoom - fit.width) <= tolerance) return 'fit-width'
  if (Math.abs(zoom - fit.page) <= tolerance) return 'fit-page'
  return 'custom'
}

/** Next zoom for the ± buttons: multiplicative steps, rounded so labels read cleanly. */
export const pdfZoomStep = (zoom: number, direction: 1 | -1, min: number, max: number, factor = PDF_CAMERA_STEP) => {
  const base = Math.max(0.01, finite(zoom, 1))
  const next = direction > 0 ? base * factor : base / factor
  return clampPdfZoom(Math.round(next * 100) / 100, min, max)
}

/** Scroll offset that puts the page column's visual centre under the viewport centre. */
export const pdfColumnCentreScrollLeft = (
  scroller: { clientWidth: number; scrollLeft: number },
  scrollerLeft: number,
  column: { left: number; width: number },
) => {
  if (!(column.width > 0) || !(scroller.clientWidth > 0)) return scroller.scrollLeft
  const columnCentre = column.left + column.width / 2
  const viewCentre = scrollerLeft + scroller.clientWidth / 2
  return Math.max(0, Math.round((scroller.scrollLeft + columnCentre - viewCentre) * 100) / 100)
}

/** Scroll offset that puts a page's visual top just under the viewport top. */
export const pdfPageTopScrollTop = (
  scroller: { scrollTop: number },
  scrollerTop: number,
  page: { top: number },
  gutter = PDF_FIT_GUTTER,
) => Math.max(0, Math.round((scroller.scrollTop + page.top - scrollerTop - gutter) * 100) / 100)
