package ch.fasrv.fanotes.desk

import ch.fasrv.fanotes.text.PaperKind
import ch.fasrv.fanotes.text.paperImageCaption
import ch.fasrv.fanotes.text.paperLines
import ch.fasrv.fanotes.text.tableRows
import kotlin.math.ceil
import kotlin.math.min

/** A4, matching a printed desktop note. */
const val PDF_PAGE_WIDTH_PT = 595.0
const val PDF_PAGE_HEIGHT_PT = 842.0
const val PDF_PAGE_MARGIN_PT = 36.0

const val PDF_EXPORT_FILE_NAME = "FaNotes-Notiz.pdf"
const val PDF_EXPORT_NEEDS_NOTE = "Öffne zuerst eine Notiz."
const val PDF_EXPORT_SAVED = "PDF gespeichert."
const val PDF_EXPORT_FAILED = "PDF-Export fehlgeschlagen."

data class PdfPageSlice(val index: Int, val sourceTop: Double, val sourceHeight: Double)

/**
 * Vertical slices of the paper, each one A4 content-box tall.
 * The last slice ends on the paper, and the page count stays within [maxPages].
 */
fun pdfPageSlices(
    sourceWidth: Double,
    sourceHeight: Double,
    pageWidth: Double = PDF_PAGE_WIDTH_PT,
    pageHeight: Double = PDF_PAGE_HEIGHT_PT,
    margin: Double = PDF_PAGE_MARGIN_PT,
    maxPages: Int = 40,
): List<PdfPageSlice> {
    val width = sourceWidth.coerceAtLeast(1.0)
    val height = sourceHeight.coerceAtLeast(1.0)
    val contentWidth = (pageWidth - margin * 2).coerceAtLeast(1.0)
    val contentHeight = (pageHeight - margin * 2).coerceAtLeast(1.0)
    val slice = contentHeight / (contentWidth / width)
    val count = ceil(height / slice).toInt().coerceIn(1, maxPages)
    return (0 until count).map { index ->
        val top = index * slice
        PdfPageSlice(index, top, min(slice, (height - top).coerceAtLeast(0.0)))
    }
}

private val INLINE_MARK = Regex("""[*_~`]+""")
private val WIKI = Regex("""\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]""")

/** Paper text for a PDF: comments off the page, markers unwrapped, tables as cells. */
fun pdfPaperText(markdown: String): String = paperLines(markdown).joinToString("\n") { line ->
    when (line.kind) {
        PaperKind.TABLE -> tableRows(line.text).joinToString("\n") { row -> row.joinToString("    ") { stripInline(it) } }
        PaperKind.BULLET -> "• ${stripInline(line.text)}"
        PaperKind.TASK -> {
            val done = line.text.startsWith("x|")
            val label = stripInline(line.text.substringAfter('|'))
            if (done) "☑ $label" else "☐ $label"
        }
        PaperKind.QUOTE -> "│ ${stripInline(line.text)}"
        PaperKind.RULE -> "—"
        PaperKind.IMAGE -> paperImageCaption(line.text)
        else -> stripInline(line.text)
    }
}.trimEnd()

private fun stripInline(text: String) = WIKI.replace(text) { match ->
    match.groupValues[2].ifBlank { match.groupValues[1] }
}.replace(INLINE_MARK, "")
