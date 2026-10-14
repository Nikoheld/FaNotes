package ch.fasrv.fanotes.ink

/** PDF page stack used by the desktop note view: column width, 16px gap, no gap after the last page. */
const val PDF_PAGE_GAP = 16.0

data class PdfPageBox(val index: Int, val top: Double, val width: Double, val height: Double)

fun layoutPdfStack(sourceWidth: Double, heightOverWidth: List<Double>, gap: Double = PDF_PAGE_GAP): List<PdfPageBox> {
    var top = 0.0
    return heightOverWidth.mapIndexed { index, ratio ->
        val height = sourceWidth * ratio.coerceAtLeast(0.1)
        val box = PdfPageBox(index, top, sourceWidth, height)
        top += height + if (index == heightOverWidth.lastIndex) 0.0 else gap
        box
    }
}

fun pdfStackHeight(pages: List<PdfPageBox>): Double =
    if (pages.isEmpty()) 0.0 else pages.last().top + pages.last().height
