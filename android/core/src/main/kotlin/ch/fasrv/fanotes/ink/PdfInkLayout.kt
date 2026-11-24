package ch.fasrv.fanotes.ink

/**
 * Where one PDF page sits in the ink document's coordinate space: ink units run from [top] to [top] + [height]
 * vertically and cover [width] horizontally. A stroke point at normalized `y` lies at `y * sourceHeight` ink units.
 */
data class PdfInkPage(val index: Int, val top: Double, val width: Double, val height: Double)

/**
 * The mapping the FaNotes Android app uses to lay the desktop's handwriting over a PDF: the pages are stacked the way
 * the desktop stacks them ([layoutPdfStack] at [PAGE_START_WIDTH]), and the ink document, which holds the stack's
 * height as `sourceHeight`, is stretched over that stack. Without strokes the pages keep their own scale.
 */
fun pdfInkPages(sourceHeight: Double, hasStrokes: Boolean, heightOverWidth: List<Double>): List<PdfInkPage> {
    val boxes = layoutPdfStack(PAGE_START_WIDTH, heightOverWidth)
    val stack = pdfStackHeight(boxes)
    val scaleY = if (hasStrokes && stack > 0) sourceHeight / stack else 1.0
    return boxes.map { PdfInkPage(it.index, it.top * scaleY, PAGE_START_WIDTH, it.height * scaleY) }
}
