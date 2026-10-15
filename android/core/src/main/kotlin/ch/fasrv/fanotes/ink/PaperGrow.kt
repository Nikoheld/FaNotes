package ch.fasrv.fanotes.ink

import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min

/** Same tolerance the desktop stay-put reducer uses. */
const val STAY_PUT_PAD_EPSILON = 1e-6

data class GrownPage(
    val width: Double,
    val height: Double,
    val padX: Double,
    val padY: Double,
)

data class GrownInk(
    val document: InkDocument,
    val padX: Double,
    val padY: Double,
)

/**
 * Grow the far edge so a 0–1 mark plus the write margin still fits.
 * Matches `grow_write_extent` in `crates/fanotes-paper`.
 */
fun growWriteExtent(normalized: Double?, current: Double, margin: Double, step: Double): Double {
    if (normalized == null || !normalized.isFinite()) return current
    if (!current.isFinite() || current < 1.0) return current
    if (!margin.isFinite() || !step.isFinite() || step < 1.0) return current
    val needed = normalized * current + margin
    if (!(needed > current)) return current
    return max(current, ceil(needed / step) * step)
}

/** Extra origin pad when the pen is inside the near margin. */
fun growWriteOrigin(normalized: Double?, current: Double, margin: Double, step: Double): Double {
    if (normalized == null || !normalized.isFinite()) return 0.0
    if (!current.isFinite() || current < 1.0) return 0.0
    if (!margin.isFinite() || !step.isFinite() || step < 1.0) return 0.0
    val pixel = normalized * current
    if (pixel >= margin) return 0.0
    return ceil((margin - pixel) / step) * step
}

/**
 * Grow around a mark. [originX] and [originY] are pads already applied, so a
 * stroke that stays inside that slack does not insert the margin again.
 */
fun growPageFromMark(
    width: Double,
    height: Double,
    originX: Double,
    originY: Double,
    markX: Double?,
    markY: Double?,
): GrownPage {
    val haveX = max(0.0, if (originX.isFinite()) originX else 0.0)
    val haveY = max(0.0, if (originY.isFinite()) originY else 0.0)
    val wantX = growWriteOrigin(markX, width, WRITE_MARGIN_X, GROW_STEP_X)
    val wantY = growWriteOrigin(markY, height, WRITE_MARGIN_Y, GROW_STEP_Y)
    val padX = max(0.0, wantX - haveX)
    val padY = max(0.0, wantY - haveY)
    val nextWidth = max(
        growWriteExtent(markX, width, WRITE_MARGIN_X, GROW_STEP_X),
        max(width + padX, width + padX),
    )
    val nextHeight = max(
        growWriteExtent(markY, height, WRITE_MARGIN_Y, GROW_STEP_Y),
        max(height + padY, height + padY),
    )
    return GrownPage(
        width = min(WRITE_CAP_WIDTH, max(width, nextWidth)),
        height = min(WRITE_CAP_HEIGHT, max(height, nextHeight)),
        padX = padX,
        padY = padY,
    )
}

/** Keep a 0–1 mark on the same page pixel after the page grows. */
fun keepMarkOnPage(value: Double, prevExtent: Double, nextExtent: Double, minPad: Double = 0.0): Double {
    if (!value.isFinite() || !(prevExtent > 0.0) || !(nextExtent > 0.0)) return value
    val pad = max(0.0, if (minPad.isFinite()) minPad else 0.0)
    if (abs(nextExtent - prevExtent) < STAY_PUT_PAD_EPSILON && pad == 0.0) return value
    return (value * prevExtent + pad) / nextExtent
}

/** Unzoomed pan that keeps old paper pixels under the same screen point. */
fun paperOriginScrollDelta(pad: Double): Double = max(0.0, if (pad.isFinite()) pad else 0.0)
