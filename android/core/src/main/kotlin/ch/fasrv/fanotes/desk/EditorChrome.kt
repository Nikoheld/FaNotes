package ch.fasrv.fanotes.desk

import kotlin.math.max
import kotlin.math.min

/**
 * Note-open chrome. Permanent rows above the canvas are the desktop stack:
 * ribbon, tabs, and one toolbar. Tags, paper style, and search are toolbar
 * controls, not extra rows.
 */

const val TAB_STRIP_DP = 36

fun noteOpenChromeRows(): List<String> = listOf("ribbon", "tabs", "toolbar")

fun permanentRowsAboveCanvas(): List<String> = noteOpenChromeRows()

fun chromeRowHeightDp(id: String): Int = when (id) {
    "ribbon" -> RIBBON_HEIGHT_DP
    "tabs" -> TAB_STRIP_DP
    "toolbar" -> EDITOR_TOOLBAR_DP
    "status" -> STATUS_BAR_DP
    else -> 0
}

/** Rows that used to sit above the page and are no longer part of the stack. */
fun retiredEditorRows(): Set<String> = setOf(
    "tags",
    "paper",
    "search",
    "export",
    "worksheet",
    "pdf",
    "relations",
    "transcript",
)

fun statusLabelCenterDp(): Float = STATUS_BAR_DP / 2f

fun statusItemTopDp(itemHeightDp: Int = STATUS_BUTTON_DP): Float =
    (STATUS_BAR_DP - itemHeightDp) / 2f

fun canvasHeightPx(frameWidthPx: Int, frameHeightPx: Int, dpi: Int): Int {
    if (frameHeightPx <= 0 || dpi <= 0) return 0
    val density = dpi / 160f
    val above = permanentRowsAboveCanvas().sumOf { chromeRowHeightDp(it) }
    val chromePx = (above + STATUS_BAR_DP) * density
    return (frameHeightPx - chromePx).toInt().coerceAtLeast(0)
}

fun isTabletFrame(widthPx: Int, heightPx: Int, dpi: Int): Boolean {
    if (dpi <= 0) return false
    val density = dpi / 160f
    val widthDp = widthPx / density
    val heightDp = heightPx / density
    return min(widthDp, heightDp) >= 600f || max(widthDp, heightDp) >= 960f
}

/** Side padding for chrome on a wide tablet. The page itself stays full width. */
fun editorSideInsetDp(widthPx: Int, heightPx: Int, dpi: Int): Int =
    if (isTabletFrame(widthPx, heightPx, dpi)) 16 else 0

fun galaxyTabS6LiteFrame(widthPx: Int = 2000, heightPx: Int = 1200, dpi: Int = 224): Triple<Int, Int, Int> =
    Triple(widthPx, heightPx, dpi)

/**
 * One toolbar: mode switch, the active mode's tools, then the desktop end cluster.
 * PDF replaces the text/ink slot. Paper is only offered while typing on a note.
 */
fun editorToolbarSlots(textMode: Boolean, pdfNote: Boolean): List<String> {
    val context = when {
        pdfNote -> "pdf"
        textMode -> "text"
        else -> "ink"
    }
    return listOf("mode", context, "end")
}

fun toolbarEndSlots(textMode: Boolean, pdfNote: Boolean): List<String> {
    val slots = ArrayList<String>(6)
    if (textMode && !pdfNote) slots += "paper"
    slots += listOf("tags", "search", "backup", "links", "more")
    return slots
}
