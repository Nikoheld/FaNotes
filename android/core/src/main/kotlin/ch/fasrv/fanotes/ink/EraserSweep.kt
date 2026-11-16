package ch.fasrv.fanotes.ink

import kotlin.math.hypot
import kotlin.math.max

/**
 * The part of the eraser that runs around [splitStroke]: which samples one call walks, and which strokes
 * it can skip. The intersection maths (where a stroke is cut) stays in [splitStroke].
 *
 * Android delivers an eraser gesture in frames, and every [InkSession.eraseSamples] call only saw the
 * samples of its own frame. The stretch between the last sample of one frame and the first of the next was
 * never tested, so a fast sweep left a dotted trail of ink, and a frame with a single sample was only a
 * disk. [eraserSweep] prepends where the previous call ended, so the nib always covers a capsule from
 * where it was. [strokeMayBeTouched] is the cheap reject desktop `toolErase.ts` already has: a stroke whose
 * box cannot reach the swept box is not densified, not copied and not even looked at again.
 */

/** Samples nearer than this (page px) to the previous kept one add no coverage; desktop `eraserPath` uses the same. */
const val ERASER_MIN_STEP_PX = 0.4

/** Slack (page px) on the reject, so a stroke exactly at the edge of the reach is never skipped by rounding. */
private const val REJECT_SLACK_PX = 1.0

/** Where the previous call ended, with the page size its coordinates are normalised against. */
class EraserCarry(val point: StrokePoint, val sourceWidth: Double, val sourceHeight: Double)

private fun finite(point: StrokePoint) = !point.x.isNaN() && !point.y.isNaN() && !point.x.isInfinite() && !point.y.isInfinite()

/**
 * The samples one call walks: the [carry] (when the page has not changed size since, otherwise its
 * coordinates mean another spot) followed by [samples], without non-finite points and without samples
 * under [ERASER_MIN_STEP_PX] from the previous kept one. Never empty when [samples] has a finite point.
 */
fun eraserSweep(carry: EraserCarry?, samples: List<StrokePoint>, sourceWidth: Double, sourceHeight: Double): List<StrokePoint> {
    val path = ArrayList<StrokePoint>(samples.size + 1)
    var lastX = Double.NaN
    var lastY = Double.NaN
    fun add(point: StrokePoint) {
        if (!finite(point)) return
        val x = point.x * sourceWidth
        val y = point.y * sourceHeight
        if (path.isNotEmpty() && hypot(x - lastX, y - lastY) < ERASER_MIN_STEP_PX) return
        path += point
        lastX = x
        lastY = y
    }
    if (carry != null && carry.sourceWidth == sourceWidth && carry.sourceHeight == sourceHeight) add(carry.point)
    for (sample in samples) add(sample)
    return path
}

/** The last finite sample of a call, which the next call continues from; null when there is none. */
fun eraserCarryOf(samples: List<StrokePoint>, sourceWidth: Double, sourceHeight: Double): EraserCarry? {
    val last = samples.lastOrNull { finite(it) } ?: return null
    return EraserCarry(last, sourceWidth, sourceHeight)
}

/** Box [left, top, right, bottom] in page px of [path]; null for an empty path. */
fun sweepBounds(path: List<StrokePoint>, sourceWidth: Double, sourceHeight: Double): DoubleArray? {
    if (path.isEmpty()) return null
    var left = Double.POSITIVE_INFINITY
    var top = Double.POSITIVE_INFINITY
    var right = Double.NEGATIVE_INFINITY
    var bottom = Double.NEGATIVE_INFINITY
    for (point in path) {
        val x = point.x * sourceWidth
        val y = point.y * sourceHeight
        if (x < left) left = x
        if (x > right) right = x
        if (y < top) top = y
        if (y > bottom) bottom = y
    }
    return doubleArrayOf(left, top, right, bottom)
}

/**
 * The widest half-width a stroke's ribbon can be drawn with: full pressure on the widest brush. It only pads
 * the reject, so it errs large, and it never drops below the half base width [splitStroke] reaches with.
 */
fun maxRibbonHalfWidth(stroke: InkStroke): Double {
    val pressure = if (stroke.pressureEnabled) 0.4 + 1.5 * 1.12 else 1.0
    return stroke.baseWidth * pressure * max(1.0, brushWidthScale(stroke.brush)) / 2.0
}

/**
 * False when [stroke] cannot come within the eraser's reach of the swept box [sweep] (from [sweepBounds]), so
 * [splitStroke] would leave it alone. True means "look closer", never "it is hit".
 */
fun strokeMayBeTouched(stroke: InkStroke, sweep: DoubleArray, radiusPagePx: Double, sourceWidth: Double, sourceHeight: Double): Boolean {
    val points = stroke.points
    if (points.isEmpty()) return false
    var left = Double.POSITIVE_INFINITY
    var top = Double.POSITIVE_INFINITY
    var right = Double.NEGATIVE_INFINITY
    var bottom = Double.NEGATIVE_INFINITY
    for (point in points) {
        val x = point.x
        val y = point.y
        // A NaN coordinate fails every comparison and never widens the box, like the probe walk it replaces.
        if (x < left) left = x
        if (x > right) right = x
        if (y < top) top = y
        if (y > bottom) bottom = y
    }
    val pad = radiusPagePx + maxRibbonHalfWidth(stroke) + REJECT_SLACK_PX
    return right * sourceWidth >= sweep[0] - pad && left * sourceWidth <= sweep[2] + pad &&
        bottom * sourceHeight >= sweep[1] - pad && top * sourceHeight <= sweep[3] + pad
}

/**
 * The box the ink changed by one call lies in: the swept box grown by the reach, by the widest ribbon that was
 * cut and by one probe step, because [splitStroke] ends a surviving piece at the last probe outside the reach.
 */
fun erasedBox(sweep: DoubleArray, radiusPagePx: Double, widestHalfWidth: Double): DoubleArray {
    val probeStep = max(1.0, radiusPagePx / 3.0)
    val pad = radiusPagePx + probeStep + widestHalfWidth + REJECT_SLACK_PX
    return doubleArrayOf(sweep[0] - pad, sweep[1] - pad, sweep[2] + pad, sweep[3] + pad)
}
