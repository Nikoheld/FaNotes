// Where the FaNotes desktop showed each PDF page when its ink was drawn. A straight port of
// android/core/src/main/kotlin/ch/fasrv/fanotes/ink/PdfInkLayout.kt (desktop part): keep both in step.

/** One PDF page in the ink document's coordinate space (sheet px): `left`/`top` and size are ink units. */
export interface PdfInkPage { index: number; left: number; top: number; width: number; height: number }

/** The desktop PDF sheet (`.unified-paper.is-pdf-note`): padding above and below the page column. */
export const DESKTOP_PDF_PAPER_TOP = 18
export const DESKTOP_PDF_PAPER_BOTTOM = 36
/** Gap between two pages. */
export const PDF_PAGE_GAP = 16
/** Each `.pdf-note-page` has a 1 px border inside its box; the page itself is drawn inside it. */
export const DESKTOP_PDF_PAGE_BORDER = 1
/** The desktop column is `min(900px, contentWidth)`; contentWidth is 560-1200 in steps of 20 and 820 by default. */
export const DESKTOP_PDF_COLUMN_DEFAULT = 820
const COLUMN_MAX = 900
const COLUMN_MIN = 560
const COLUMN_STEP = 20
const COLUMN_TOLERANCE = 1.5

const finitePositive = (value: number) => Number.isFinite(value) && value > 0
// Kotlin's roundToInt rounds half up; Math.round does the same for the positive and negative halves we care about.
const roundHalfUp = (value: number) => Math.floor(value + 0.5)

/**
 * The width of the desktop's page column when the ink was saved. The sheet is exactly as tall as its pages when no
 * write room was added below them, so the height gives the column back; it counts only when it lands on a width the
 * desktop setting can produce. Otherwise the default column, never wider than the sheet.
 */
export const desktopPdfColumnWidth = (sourceWidth: number, sourceHeight: number, heightOverWidth: number[]): number => {
  const paper = finitePositive(sourceWidth) ? sourceWidth : DESKTOP_PDF_COLUMN_DEFAULT
  const fallback = Math.min(DESKTOP_PDF_COLUMN_DEFAULT, paper)
  const ratios = heightOverWidth.reduce((sum, ratio) => sum + Math.max(ratio, 0.1), 0)
  if (!(ratios > 0) || !Number.isFinite(sourceHeight)) return fallback
  const solved = (sourceHeight - DESKTOP_PDF_PAPER_TOP - DESKTOP_PDF_PAPER_BOTTOM - PDF_PAGE_GAP * (heightOverWidth.length - 1)) / ratios
  const step = roundHalfUp((solved - COLUMN_MIN) / COLUMN_STEP)
  const candidate = COLUMN_MIN + step * COLUMN_STEP
  const valid = candidate >= COLUMN_MIN && candidate <= COLUMN_MAX && candidate <= paper + 0.5
  return valid && Math.abs(solved - candidate) <= COLUMN_TOLERANCE ? candidate : fallback
}

/**
 * Desktop ink is stored in sheet pixels: `sourceWidth` and `sourceHeight` are the sheet's size, the page column is
 * centred in it, starts DESKTOP_PDF_PAPER_TOP below its top edge, and the pages follow each other PDF_PAGE_GAP apart.
 */
export const desktopPdfInkPages = (sourceWidth: number, sourceHeight: number, heightOverWidth: number[]): PdfInkPage[] => {
  if (!heightOverWidth.length) return []
  const column = desktopPdfColumnWidth(sourceWidth, sourceHeight, heightOverWidth)
  const paper = finitePositive(sourceWidth) ? sourceWidth : column
  const left = Math.max((paper - column) / 2, 0)
  const inner = Math.max(column - 2 * DESKTOP_PDF_PAGE_BORDER, 1)
  let top = DESKTOP_PDF_PAPER_TOP
  return heightOverWidth.map((ratio, index) => {
    const height = column * Math.max(ratio, 0.1)
    const page: PdfInkPage = { index, left: left + DESKTOP_PDF_PAGE_BORDER, top: top + DESKTOP_PDF_PAGE_BORDER, width: inner, height: Math.max(height - 2 * DESKTOP_PDF_PAGE_BORDER, 1) }
    top += height + PDF_PAGE_GAP
    return page
  })
}
