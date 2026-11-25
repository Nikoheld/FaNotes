package ch.fasrv.fanotes.ink

import kotlin.math.abs
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Where one PDF page sits in the ink document's coordinate space: ink units run from [left] to [left] + [width]
 * horizontally and from [top] to [top] + [height] vertically. A stroke point at normalized (`x`, `y`) lies at
 * (`x * sourceWidth`, `y * sourceHeight`) ink units.
 */
data class PdfInkPage(val index: Int, val top: Double, val width: Double, val height: Double, val left: Double = 0.0)

/**
 * The mapping the FaNotes tablet app uses to lay its handwriting over a PDF: the pages are stacked at
 * [PAGE_START_WIDTH] from the top-left corner, and the ink document's `sourceHeight` is stretched over that stack.
 * Without strokes the pages keep their own scale. Desktop ink needs [desktopPdfInkPages] instead.
 */
fun pdfInkPages(sourceHeight: Double, hasStrokes: Boolean, heightOverWidth: List<Double>): List<PdfInkPage> {
    val boxes = layoutPdfStack(PAGE_START_WIDTH, heightOverWidth)
    val stack = pdfStackHeight(boxes)
    val scaleY = if (hasStrokes && stack > 0) sourceHeight / stack else 1.0
    return boxes.map { PdfInkPage(it.index, it.top * scaleY, PAGE_START_WIDTH, it.height * scaleY) }
}

/** The desktop PDF sheet (`.unified-paper.is-pdf-note`): padding above and below the page column. */
const val DESKTOP_PDF_PAPER_TOP = 18.0
const val DESKTOP_PDF_PAPER_BOTTOM = 36.0
/** Each `.pdf-note-page` has a 1 px border inside its box; the page itself is drawn inside it. */
const val DESKTOP_PDF_PAGE_BORDER = 1.0
/** The desktop column is `min(900px, contentWidth)`; contentWidth is 560–1200 in steps of 20 and 820 by default. */
const val DESKTOP_PDF_COLUMN_DEFAULT = 820.0
private const val DESKTOP_PDF_COLUMN_MAX = 900.0
private const val DESKTOP_PDF_COLUMN_MIN = 560.0
private const val DESKTOP_PDF_COLUMN_STEP = 20.0
private const val DESKTOP_PDF_COLUMN_TOLERANCE = 1.5

/**
 * The width of the desktop's page column when the ink was saved. The sheet is exactly as tall as its pages when no
 * write room was added below them, so the height gives the column back; it counts only when it lands on a width the
 * desktop setting can produce. Otherwise the default column, never wider than the sheet.
 */
fun desktopPdfColumnWidth(sourceWidth: Double, sourceHeight: Double, heightOverWidth: List<Double>): Double {
    val paper = sourceWidth.takeIf { it.isFinite() && it > 0 } ?: DESKTOP_PDF_COLUMN_DEFAULT
    val fallback = min(DESKTOP_PDF_COLUMN_DEFAULT, paper)
    val ratios = heightOverWidth.sumOf { it.coerceAtLeast(0.1) }
    if (ratios <= 0 || !sourceHeight.isFinite()) return fallback
    val solved = (sourceHeight - DESKTOP_PDF_PAPER_TOP - DESKTOP_PDF_PAPER_BOTTOM - PDF_PAGE_GAP * (heightOverWidth.size - 1)) / ratios
    val step = ((solved - DESKTOP_PDF_COLUMN_MIN) / DESKTOP_PDF_COLUMN_STEP).roundToInt()
    val candidate = DESKTOP_PDF_COLUMN_MIN + step * DESKTOP_PDF_COLUMN_STEP
    val valid = candidate in DESKTOP_PDF_COLUMN_MIN..DESKTOP_PDF_COLUMN_MAX && candidate <= paper + 0.5
    return if (valid && abs(solved - candidate) <= DESKTOP_PDF_COLUMN_TOLERANCE) candidate else fallback
}

/**
 * Where the FaNotes desktop showed each PDF page when the ink was drawn. Desktop ink is stored in sheet pixels:
 * `sourceWidth` and `sourceHeight` are the sheet's size, the page column is centred in it, starts
 * [DESKTOP_PDF_PAPER_TOP] below its top edge, and the pages follow each other [PDF_PAGE_GAP] apart.
 * Measured in the desktop UI (window widths 1000, 1400 and 1900 px).
 */
fun desktopPdfInkPages(sourceWidth: Double, sourceHeight: Double, heightOverWidth: List<Double>): List<PdfInkPage> {
    if (heightOverWidth.isEmpty()) return emptyList()
    val column = desktopPdfColumnWidth(sourceWidth, sourceHeight, heightOverWidth)
    val paper = sourceWidth.takeIf { it.isFinite() && it > 0 } ?: column
    val left = ((paper - column) / 2).coerceAtLeast(0.0)
    val inner = (column - 2 * DESKTOP_PDF_PAGE_BORDER).coerceAtLeast(1.0)
    var top = DESKTOP_PDF_PAPER_TOP
    return heightOverWidth.mapIndexed { index, ratio ->
        val height = column * ratio.coerceAtLeast(0.1)
        val page = PdfInkPage(index, top + DESKTOP_PDF_PAGE_BORDER, inner, (height - 2 * DESKTOP_PDF_PAGE_BORDER).coerceAtLeast(1.0), left + DESKTOP_PDF_PAGE_BORDER)
        top += height + PDF_PAGE_GAP
        page
    }
}
