package ch.fasrv.fanotes.desk

import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

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

const val WORKSHEET_TEXT_HINT = "Klicke an die Stelle des Arbeitsblatts, an der du tippen möchtest."
const val WORKSHEET_HIGHLIGHT_HINT = "Ziehe einen Rahmen über den Text, den du markieren möchtest."

/** Hint shown while a worksheet tool is armed. Highlight wins if both are on. */
fun worksheetPlaceHint(placingText: Boolean, placingHighlight: Boolean): String? = when {
    placingHighlight -> WORKSHEET_HIGHLIGHT_HINT
    placingText -> WORKSHEET_TEXT_HINT
    else -> null
}

/** Arbeitsblatt import after the later chrome pass: 12px card, min(620px, 92vw), options stack at 560px. */
const val SHEET_IMPORT_MAX_DP = 620
const val SHEET_IMPORT_WIDTH_FRACTION = 0.92f
const val SHEET_IMPORT_RADIUS_DP = 12
const val SHEET_IMPORT_STACK_DP = 560
const val SHEET_IMPORT_HEADER_DP = 68
const val SHEET_IMPORT_HEADER_PAD_DP = 17
const val SHEET_IMPORT_HEADER_GAP_DP = 11
const val SHEET_IMPORT_MARK_DP = 37
const val SHEET_IMPORT_MARK_RADIUS_DP = 11
const val SHEET_IMPORT_MARK_ICON_DP = 19
const val SHEET_IMPORT_EYEBROW = "Bild oder PDF"
const val SHEET_IMPORT_TITLE = "Arbeitsblatt importieren"
const val SHEET_IMPORT_BODY = "Das Arbeitsblatt bleibt Teil deines Vaults. Anschließend kannst du direkt darauf Textfelder platzieren oder mit dem Grafiktablett schreiben."
const val SHEET_IMPORT_BODY_PAD_TOP_DP = 17
const val SHEET_IMPORT_BODY_PAD_X_DP = 19
const val SHEET_IMPORT_BODY_PAD_BOTTOM_DP = 12
const val SHEET_IMPORT_OPTION_MIN_DP = 118
const val SHEET_IMPORT_OPTION_RADIUS_DP = 12
const val SHEET_IMPORT_OPTION_PAD_DP = 14
const val SHEET_IMPORT_OPTION_GAP_DP = 10
const val SHEET_IMPORT_OPTION_ICON_DP = 38
const val SHEET_IMPORT_OPTION_ICON_RADIUS_DP = 11
const val SHEET_IMPORT_OPTION_ICON_SIZE_DP = 22
const val SHEET_IMPORT_GLYPH_ALPHA = 0.13f
const val SHEET_IMPORT_HOVER_BORDER = 0.42f
const val SHEET_IMPORT_DISABLED_ALPHA = 0.45f
const val SHEET_IMPORT_FOOTER_DP = 51
const val SHEET_IMPORT_FOOTER_PAD_X_DP = 19
const val SHEET_IMPORT_CLOSE_DP = 31
const val SHEET_IMPORT_CLOSE_RADIUS_DP = 8
const val SHEET_IMPORT_CLOSE_ICON_DP = 17
const val SHEET_IMPORT_BUTTON_DP = 31
const val SHEET_IMPORT_BUTTON_RADIUS_DP = 6
const val SHEET_IMPORT_BUTTON_PAD_DP = 12
const val SHEET_IMPORT_ONENOTE_MIN_DP = 86
const val SHEET_IMPORT_ONENOTE_GAP_DP = 11
const val SHEET_IMPORT_CURRENT = "In aktuelle Notiz"
const val SHEET_IMPORT_NONE = "Keine Notiz geöffnet"
const val SHEET_IMPORT_NEW = "Als neue Notiz"
const val SHEET_IMPORT_NEW_DETAIL = "Dateiname wird zum Notiztitel"
const val SHEET_IMPORT_ONENOTE = "Microsoft OneNote"
const val SHEET_IMPORT_ONENOTE_DETAIL = "In der Linux- oder Windows-App"
const val SHEET_IMPORT_FORMATS = "PDF · Bilder · ONE · ONETOC2 · ONEPKG · ZIP"
const val SHEET_IMPORT_CANCEL = "Abbrechen"

fun sheetImportWidthDp(windowWidthDp: Int): Int {
    val fraction = (windowWidthDp.coerceAtLeast(0) * SHEET_IMPORT_WIDTH_FRACTION).roundToInt()
    return min(SHEET_IMPORT_MAX_DP, fraction)
}

/** The option grid becomes one column at the desktop 560px breakpoint. */
fun sheetImportColumns(windowWidthDp: Int): Int = if (windowWidthDp <= SHEET_IMPORT_STACK_DP) 1 else 2

data class SheetImportShadow(val yDp: Int, val blurDp: Int, val alpha: Float)

/** Theme `--shadow` on the import card. */
fun sheetImportShadow(dark: Boolean): SheetImportShadow = if (dark) {
    SheetImportShadow(16, 48, 0.32f)
} else {
    SheetImportShadow(12, 40, 0.08f)
}
