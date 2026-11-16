package ch.fasrv.fanotes.study

import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Shared maths of the study reference images: the "PDF-Ausschnitt" crop rectangle, the pixel
 * budgets used for crops, camera photos and picked images, and the compare-view split.
 * Mirrors `StudyAnnotationLayer.tsx` (crop box, `encodeImage` budget) so both apps store the same.
 */
const val CROP_MIN = 0.02

/** Page width in pixels a crop is rendered against (about twice the on-screen backdrop). */
const val CROP_PAGE_BASE_PX = 2400

/**
 * Longest edge of a freshly rendered crop. Kept at the stored-image edge: rendering larger would
 * only be thrown away by the encoder, and a figure that needs more detail would not fit the 300 KB cap anyway.
 */
const val CROP_RENDER_MAX_EDGE = STUDY_IMAGE_MAX_EDGE

/** [w] x [h] scaled down (never up) so the long edge is at most [edge]; at least 1 px each. */
fun fitWithin(w: Int, h: Int, edge: Double): Pair<Int, Int> {
    val scale = min(1.0, edge / max(max(w, h), 1))
    return max(1, (w * scale).roundToInt()) to max(1, (h * scale).roundToInt())
}

/** Normalised crop from two corner points (any order), clamped to the page. */
fun cropFromCorners(x0: Double, y0: Double, x1: Double, y1: Double): SRect = SRect(
    min(x0, x1).coerceIn(0.0, 1.0), min(y0, y1).coerceIn(0.0, 1.0),
    max(x0, x1).coerceIn(0.0, 1.0), max(y0, y1).coerceIn(0.0, 1.0),
)

fun cropIsUsable(r: SRect): Boolean = r.r - r.l >= CROP_MIN && r.b - r.t >= CROP_MIN

enum class CropGrip { NONE, MOVE, TL, TR, BL, BR }

/** Which part of [r] a point at (x, y) grabs; corners win over the body. Tolerances are page fractions. */
fun cropGripAt(r: SRect, x: Double, y: Double, tolX: Double, tolY: Double): CropGrip {
    fun near(px: Double, py: Double) = kotlin.math.abs(x - px) <= tolX && kotlin.math.abs(y - py) <= tolY
    return when {
        near(r.l, r.t) -> CropGrip.TL
        near(r.r, r.t) -> CropGrip.TR
        near(r.l, r.b) -> CropGrip.BL
        near(r.r, r.b) -> CropGrip.BR
        x >= r.l && x <= r.r && y >= r.t && y <= r.b -> CropGrip.MOVE
        else -> CropGrip.NONE
    }
}

/** [r] after dragging [grip] by (dx, dy) page fractions: a move keeps its size, a corner keeps [CROP_MIN]. */
fun cropDragged(r: SRect, grip: CropGrip, dx: Double, dy: Double): SRect = when (grip) {
    CropGrip.NONE -> r
    CropGrip.MOVE -> {
        val w = r.r - r.l
        val h = r.b - r.t
        val l = (r.l + dx).coerceIn(0.0, 1.0 - w)
        val t = (r.t + dy).coerceIn(0.0, 1.0 - h)
        SRect(l, t, l + w, t + h)
    }
    else -> {
        val left = grip == CropGrip.TL || grip == CropGrip.BL
        val top = grip == CropGrip.TL || grip == CropGrip.TR
        var l = r.l; var t = r.t; var rr = r.r; var b = r.b
        if (left) l = (r.l + dx).coerceIn(0.0, r.r - CROP_MIN) else rr = (r.r + dx).coerceIn(r.l + CROP_MIN, 1.0)
        if (top) t = (r.t + dy).coerceIn(0.0, r.b - CROP_MIN) else b = (r.b + dy).coerceIn(r.t + CROP_MIN, 1.0)
        SRect(l, t, rr, b)
    }
}

/**
 * Pixel size to render crop [r] of a page whose height/width ratio is [pageAspect]: the page is
 * assumed [CROP_PAGE_BASE_PX] wide, the result is capped at [CROP_RENDER_MAX_EDGE] on its long edge.
 */
fun cropRenderSize(r: SRect, pageAspect: Double): Pair<Int, Int> {
    val w = (r.r - r.l) * CROP_PAGE_BASE_PX
    val h = (r.b - r.t) * CROP_PAGE_BASE_PX * pageAspect
    return fitWithin(max(1, w.roundToInt()), max(1, h.roundToInt()), CROP_RENDER_MAX_EDGE.toDouble())
}

/** Where the cut-out lands on the page, as on desktop: beside the crop if there is room, else the right edge. */
data class CropPlacement(val x: Double, val y: Double, val w: Double)

fun cropPlacement(r: SRect): CropPlacement {
    val w = r.r - r.l
    val target = min(0.5, max(0.2, w))
    val x = if (r.l + w + target + 0.02 <= 1.0) r.l + w + 0.02 else max(0.0, 1.0 - target - 0.02)
    // The image keeps the crop's shape, so its height in page fractions is target * (h / w); keep it on the page.
    val height = if (w > 0.0) target * (r.b - r.t) / w else 0.0
    return CropPlacement(x, min(r.t, max(0.0, 1.0 - height)), target)
}

enum class CompareDock { LEFT, BOTTOM }

data class CompareLayout(val dock: CompareDock, val panelPx: Int)

/** Landscape: reference panel on the left (40 %); portrait: on the bottom (38 %). The sketch keeps at least [minSketchPx]. */
fun compareLayout(viewW: Int, viewH: Int, minSketchPx: Int = 240): CompareLayout {
    if (viewW > viewH) {
        val panel = (viewW * 0.4).toInt().coerceAtMost(max(0, viewW - minSketchPx))
        return CompareLayout(CompareDock.LEFT, panel)
    }
    val panel = (viewH * 0.38).toInt().coerceAtMost(max(0, viewH - minSketchPx))
    return CompareLayout(CompareDock.BOTTOM, panel)
}
