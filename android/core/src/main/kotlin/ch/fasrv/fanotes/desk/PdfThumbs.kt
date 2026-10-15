package ch.fasrv.fanotes.desk

import kotlin.math.max
import kotlin.math.min

/** Full PDF pages drawn on the note. Thumbnails stay inside this stack. */
const val PDF_NOTE_PAGE_CAP = 40

/** Desktop thumbnail sidebar: at most 80 pages, 76px wide, at least 48px tall. */
const val PDF_THUMB_MAX = 80
const val PDF_THUMB_WIDTH = 76
const val PDF_THUMB_MIN_HEIGHT = 48

fun pdfThumbPages(pageCount: Int, renderedPages: Int = pageCount): Int {
    if (pageCount <= 0 || renderedPages <= 0) return 0
    return min(pageCount, min(renderedPages, PDF_THUMB_MAX))
}

/** CSS height of a 76px-wide thumbnail. Matches `Math.round` in the desktop viewer. */
fun pdfThumbHeight(pageWidth: Int, pageHeight: Int): Int {
    val width = pageWidth.coerceAtLeast(1)
    val ratio = pageHeight.coerceAtLeast(1).toDouble() / width.toDouble()
    val rounded = kotlin.math.floor(PDF_THUMB_WIDTH * ratio + 0.5).toInt()
    return max(PDF_THUMB_MIN_HEIGHT, rounded)
}

/**
 * 1-based page under [centerPagePx]. A point in the gap uses the nearer page centre.
 */
fun pdfPageAt(centerPagePx: Double, frames: List<Pair<Double, Double>>): Int {
    if (frames.isEmpty() || !centerPagePx.isFinite()) return 1
    val inside = frames.indexOfFirst { (top, height) ->
        height > 0.0 && centerPagePx >= top && centerPagePx < top + height
    }
    if (inside >= 0) return inside + 1
    val nearest = frames.indices.minBy { index ->
        val (top, height) = frames[index]
        kotlin.math.abs(top + height / 2.0 - centerPagePx)
    }
    return nearest + 1
}
