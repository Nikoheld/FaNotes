package ch.fasrv.fanotes.desk

import kotlin.math.max
import kotlin.math.min

/** The desktop worksheet column sits in the text inset, under the markdown. */
const val WORKSHEET_COLUMN_INSET = 72.0
const val WORKSHEET_PAGE_GAP = 24.0
const val WORKSHEET_AFTER_TEXT = 18.0
const val WORKSHEET_CAPTION = 28.0

data class WorksheetPlacement(
    val id: String,
    val left: Double,
    val captionTop: Double,
    val top: Double,
    val width: Double,
    val height: Double,
    /** 1-based page inside this worksheet. Images are always page 1. */
    val page: Int = 1,
)

data class WorksheetPageSpec(val id: String, val page: Int, val aspect: Double)

data class AnchoredHighlight(val worksheetId: String, val mark: WorksheetHighlight)

data class AnchoredBox(val worksheetId: String, val box: WorksheetBox)

/**
 * Stacks image worksheets the way the desktop paper does: content-column width,
 * natural aspect, a caption, then 24px before the next sheet.
 * [aspects] is worksheet id to image height / width. Each image is page 1.
 */
fun layoutWorksheetColumn(
    pageWidth: Double,
    textBottom: Double,
    aspects: List<Pair<String, Double>>,
): List<WorksheetPlacement> = layoutWorksheetPages(
    pageWidth,
    textBottom,
    aspects.map { (id, aspect) -> WorksheetPageSpec(id, 1, aspect) },
)

/**
 * Same column as [layoutWorksheetColumn]. Later pages of one worksheet sit under
 * the first page with only the 24px gap, the way a desktop PDF worksheet does.
 * [WorksheetPlacement.captionTop] is negative when that page has no caption.
 */
fun layoutWorksheetPages(
    pageWidth: Double,
    textBottom: Double,
    pages: List<WorksheetPageSpec>,
): List<WorksheetPlacement> {
    if (!pageWidth.isFinite() || pageWidth < 1.0) return emptyList()
    val inset = min(WORKSHEET_COLUMN_INSET, max(0.0, (pageWidth - 120.0) / 2.0))
    val width = (pageWidth - inset * 2.0).coerceAtLeast(1.0)
    var cursor = max(0.0, if (textBottom.isFinite()) textBottom else 0.0) + WORKSHEET_AFTER_TEXT
    val placed = ArrayList<WorksheetPlacement>(pages.size)
    var previousId = ""
    for (spec in pages) {
        if (spec.id.isBlank()) continue
        val aspect = if (spec.aspect.isFinite()) spec.aspect.coerceIn(0.05, 8.0) else 1.0
        val height = width * aspect
        val showCaption = spec.id != previousId
        val caption = if (showCaption) cursor else -1.0
        val top = if (showCaption) cursor + WORKSHEET_CAPTION else cursor
        placed += WorksheetPlacement(spec.id, inset, caption, top, width, height, spec.page.coerceAtLeast(1))
        cursor = top + height + WORKSHEET_PAGE_GAP
        previousId = spec.id
    }
    return placed
}

/** A page-local highlight drawn on one worksheet image, in 0–1 of the whole sheet. */
fun highlightFrameToSheet(
    mark: WorksheetHighlight,
    frame: WorksheetPlacement,
    sourceWidth: Double,
    sourceHeight: Double,
): SheetRect {
    if (sourceWidth <= 0.0 || sourceHeight <= 0.0 || frame.width <= 0.0 || frame.height <= 0.0) {
        return SheetRect(mark.x, mark.y, mark.width, mark.height)
    }
    return SheetRect(
        x = (frame.left + mark.x * frame.width) / sourceWidth,
        y = (frame.top + mark.y * frame.height) / sourceHeight,
        width = (mark.width * frame.width) / sourceWidth,
        height = (mark.height * frame.height) / sourceHeight,
    )
}

/** A drag on the sheet becomes a highlight on this worksheet page, or null when the centre misses it. */
fun highlightOnFrame(
    sheetX: Double,
    sheetY: Double,
    sheetWidth: Double,
    sheetHeight: Double,
    frame: WorksheetPlacement,
    sourceWidth: Double,
    sourceHeight: Double,
    id: String,
): WorksheetHighlight? {
    if (sheetWidth < 0.012 || sheetHeight < 0.008 || sourceWidth <= 0.0 || sourceHeight <= 0.0) return null
    if (frame.width <= 0.0 || frame.height <= 0.0) return null
    val centerX = (sheetX + sheetWidth / 2.0) * sourceWidth
    val centerY = (sheetY + sheetHeight / 2.0) * sourceHeight
    if (centerX < frame.left || centerX > frame.left + frame.width || centerY < frame.top || centerY > frame.top + frame.height) {
        return null
    }
    val localX = ((sheetX * sourceWidth - frame.left) / frame.width).coerceIn(0.0, 1.0)
    val localY = ((sheetY * sourceHeight - frame.top) / frame.height).coerceIn(0.0, 1.0)
    val localW = ((sheetWidth * sourceWidth) / frame.width).coerceIn(0.008, 1.0)
    val localH = ((sheetHeight * sourceHeight) / frame.height).coerceIn(0.008, 1.0)
    if (localW < 0.012 || localH < 0.008) return null
    return WorksheetHighlight(id, frame.page.coerceAtLeast(1), localX, localY, localW, localH)
}

/**
 * A tap on the sheet, in 0–1 of this worksheet page.
 * Null when the point is outside the image.
 */
fun pointOnWorksheet(
    sheetX: Double,
    sheetY: Double,
    frame: WorksheetPlacement,
    sourceWidth: Double,
    sourceHeight: Double,
): Pair<Double, Double>? {
    if (sourceWidth <= 0.0 || sourceHeight <= 0.0 || frame.width <= 0.0 || frame.height <= 0.0) return null
    if (!sheetX.isFinite() || !sheetY.isFinite()) return null
    val pageX = sheetX * sourceWidth
    val pageY = sheetY * sourceHeight
    if (pageX < frame.left || pageX > frame.left + frame.width || pageY < frame.top || pageY > frame.top + frame.height) {
        return null
    }
    return (pageX - frame.left) / frame.width to (pageY - frame.top) / frame.height
}

/** Text-box anchor on its own worksheet image, as 0–1 of the sheet. */
fun boxOnFrame(
    box: WorksheetBox,
    frame: WorksheetPlacement,
    sourceWidth: Double,
    sourceHeight: Double,
): Pair<Double, Double> {
    if (sourceWidth <= 0.0 || sourceHeight <= 0.0 || frame.width <= 0.0 || frame.height <= 0.0) return box.x to box.y
    return (frame.left + box.x * frame.width) / sourceWidth to (frame.top + box.y * frame.height) / sourceHeight
}
