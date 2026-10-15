package ch.fasrv.fanotes.desk

import kotlin.math.max
import kotlin.math.min
import kotlin.math.round

/**
 * PDF toolbar camera from `pdfCamera.ts`.
 * Breite, Ganze Seite and the ± buttons move the sheet camera. The page
 * column keeps its layout width so ink stays 0–1 of the paper.
 */
const val PDF_FIT_GUTTER = 18.0
const val PDF_CAMERA_STEP = 1.2

data class PdfFitInput(
    val viewWidth: Double,
    val viewHeight: Double,
    val columnWidth: Double,
    val pageHeight: Double,
    val min: Double,
    val max: Double,
    val gutter: Double = PDF_FIT_GUTTER,
)

data class PdfFitZoom(val width: Double, val page: Double)

fun clampPdfZoom(zoom: Double, min: Double, max: Double): Double {
    val lo = max(0.01, if (min.isFinite()) min else 0.01)
    val hi = max(lo, if (max.isFinite()) max else lo)
    val value = if (zoom.isFinite()) zoom else 1.0
    val rounded = round(value * 1000.0) / 1000.0
    return min(hi, max(lo, rounded))
}

fun pdfFitWidthZoom(input: PdfFitInput): Double {
    val gutter = max(0.0, if (input.gutter.isFinite()) input.gutter else PDF_FIT_GUTTER)
    if (input.columnWidth <= 0.0 || input.viewWidth <= 0.0) return clampPdfZoom(1.0, input.min, input.max)
    val usable = max(1.0, input.viewWidth - gutter * 2.0)
    return clampPdfZoom(usable / input.columnWidth, input.min, input.max)
}

/** Whole page visible: the tighter of fit-height and fit-width. */
fun pdfFitPageZoom(input: PdfFitInput): Double {
    val gutter = max(0.0, if (input.gutter.isFinite()) input.gutter else PDF_FIT_GUTTER)
    val width = pdfFitWidthZoom(input)
    if (input.pageHeight <= 0.0 || input.viewHeight <= 0.0) return width
    val usable = max(1.0, input.viewHeight - gutter * 2.0)
    return clampPdfZoom(min(width, usable / input.pageHeight), input.min, input.max)
}

fun pdfFitZoom(input: PdfFitInput): PdfFitZoom = PdfFitZoom(pdfFitWidthZoom(input), pdfFitPageZoom(input))

/** Which toolbar mode the current camera zoom corresponds to. */
fun pdfZoomModeForZoom(zoom: Double, fit: PdfFitZoom, tolerance: Double = 0.006): String {
    if (kotlin.math.abs(zoom - fit.width) <= tolerance) return "fit-width"
    if (kotlin.math.abs(zoom - fit.page) <= tolerance) return "fit-page"
    return "custom"
}

/** Next zoom for the ± buttons: multiplicative steps, rounded so labels read cleanly. */
fun pdfZoomStep(zoom: Double, direction: Int, min: Double, max: Double, factor: Double = PDF_CAMERA_STEP): Double {
    val base = max(0.01, if (zoom.isFinite()) zoom else 1.0)
    val next = if (direction > 0) base * factor else base / factor
    return clampPdfZoom(round(next * 100.0) / 100.0, min, max)
}

fun pdfZoomPercentLabel(zoom: Double): String = "${round(zoom * 100.0).toInt()} %"

/** 1-based page inside the rendered stack. */
fun pdfPageTarget(page: Double, count: Int): Int {
    val limit = if (count > 0) count else 1
    val rounded = round(if (page.isFinite()) page else 1.0).toInt()
    return rounded.coerceIn(1, limit)
}

/**
 * Keys the desktop PDF viewer handles when focus is not in a text field.
 * Page Up, Page Down, arrows, Home and End move between pages. Ctrl+F opens search.
 */
fun pdfViewerKey(key: String, ctrl: Boolean, meta: Boolean, alt: Boolean, shift: Boolean): String? {
    if (alt) return null
    if ((ctrl || meta) && !shift && key == "f") return "search"
    if (ctrl || meta) return null
    return when (key) {
        "down", "page-down" -> "next"
        "up", "page-up" -> "previous"
        "home" -> "first"
        "end" -> "last"
        else -> null
    }
}

fun pdfPageCountLabel(count: Int): String = when {
    count <= 0 -> "…"
    count == 1 -> "1 Seite"
    else -> "$count Seiten"
}
