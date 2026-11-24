import type { WorksheetPlacement } from '../types'

/**
 * Geometry for pictures that float on the sheet. A placement is stored in the
 * worksheet JSON as fractions of the paper width (`--paper-width`), so it does
 * not depend on zoom, window size or how long the text above it is:
 *   x, width: left edge and width as a fraction of the paper width
 *   y:        top edge in paper widths from the top of the sheet
 * The height follows from the picture's own aspect (height / width).
 */
export const SHEET_IMAGE_MIN_WIDTH = 0.08
export const SHEET_IMAGE_MAX_WIDTH = 1
/** Widest a fresh picture starts, so it never covers the whole page. */
export const SHEET_IMAGE_START_WIDTH = 0.85
const MIN_ASPECT = 0.02
const MAX_ASPECT = 50

const finite = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)

export const clampSheetAspect = (value: unknown): number => Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, finite(value, 0.75)))

/** Keeps a placement on the sheet: inside the width, never above the top edge. */
export const clampSheetPlacement = (placement: WorksheetPlacement): WorksheetPlacement => {
  const width = Math.min(SHEET_IMAGE_MAX_WIDTH, Math.max(SHEET_IMAGE_MIN_WIDTH, finite(placement.width, 0.5)))
  return {
    width,
    x: Math.min(1 - width, Math.max(0, finite(placement.x, 0))),
    y: Math.min(60, Math.max(0, finite(placement.y, 0))),
  }
}

/** The bottom edge of a placed picture in paper widths. */
export const sheetImageBottom = (placement: WorksheetPlacement, aspect: number) => placement.y + placement.width * clampSheetAspect(aspect)

/** Placement of a new picture centred on a point (paper units), never upscaled past its natural size. */
export const placementAround = (
  centre: { x: number; y: number },
  natural: { width: number; height: number },
  paperWidthPx: number,
): { placement: WorksheetPlacement; aspect: number } => {
  const aspect = clampSheetAspect(natural.height / Math.max(1, natural.width))
  const naturalFraction = natural.width / Math.max(1, paperWidthPx)
  const width = Math.min(SHEET_IMAGE_START_WIDTH, Math.max(SHEET_IMAGE_MIN_WIDTH, naturalFraction))
  const placement = clampSheetPlacement({ width, x: centre.x - width / 2, y: Math.max(0.02, centre.y - (width * aspect) / 2) })
  return { placement, aspect }
}

export type PaperFrame = { left: number; top: number; unit: number; zoom: number }

/**
 * Where the paper's origin sits on screen and how many screen pixels one paper
 * width is. Measured with a throwaway probe that has the same width token as the
 * pictures, so it is right under CSS zoom and under a wider ink plane.
 */
export const measurePaperFrame = (paper: HTMLElement): PaperFrame => {
  const probe = paper.ownerDocument.createElement('div')
  probe.setAttribute('aria-hidden', 'true')
  probe.style.cssText = 'position:absolute;left:0;top:0;width:var(--paper-width,900px);height:0;visibility:hidden;pointer-events:none'
  paper.appendChild(probe)
  const rect = probe.getBoundingClientRect()
  const layout = probe.offsetWidth || rect.width || 1
  probe.remove()
  const unit = rect.width || layout
  return { left: rect.left, top: rect.top, unit, zoom: layout > 0 ? unit / layout : 1 }
}

/** Newly pasted pictures start selected; the layer asks once when it mounts. */
const fresh = new Set<string>()
export const markFreshSheetImage = (id: string) => { fresh.add(id) }
export const takeFreshSheetImage = (id: string) => fresh.delete(id)
