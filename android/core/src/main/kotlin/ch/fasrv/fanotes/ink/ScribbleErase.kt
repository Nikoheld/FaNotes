package ch.fasrv.fanotes.ink

import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.round
import kotlin.math.sign

/**
 * Scribble-over-ink erase, ported from `fanotes/src/lib/scribbleErase.ts`.
 * A dense horizontal zigzag that crosses handwriting deletes that ink.
 * A straight strike, a letter, or a scribble on empty paper stays ink.
 */
data class ScribbleEraseMatch(
    val indexes: List<Int>,
    val intersectionCount: Int,
    val reversalCount: Int,
    val pathRatio: Double,
)

private data class PixelPoint(val x: Double, val y: Double)

private data class PixelBounds(
    val left: Double,
    val top: Double,
    val right: Double,
    val bottom: Double,
    val width: Double,
    val height: Double,
)

fun detectScribbleErase(
    gesture: InkStroke,
    existing: List<InkStroke>,
    pageWidth: Double,
    pageHeight: Double,
    sensitivity: Int = 50,
): ScribbleEraseMatch? {
    val normalized = if (sensitivity.isFinite()) sensitivity.coerceIn(0, 100) / 100.0 else 0.5
    val minimumLength = 110 - normalized * 48
    val minimumLengthRatio = 3.05 - normalized * 1.2
    val minimumPathRatio = 3 - normalized * 1.2
    val minimumReversals = round(4 - normalized * 2).toInt()
    val minimumIntersections = round(4 - normalized * 2).toInt()
    if (pageWidth <= 0 || pageHeight <= 0 || gesture.points.size < 8 || existing.isEmpty()) return null
    val gesturePoints = simplifyPoints(pixelPoints(gesture.points, pageWidth, pageHeight))
    if (gesturePoints.size < 7) return null
    val gestureBounds = boundsForPoints(gesturePoints) ?: return null
    if (gestureBounds.width < 32 || gestureBounds.height < 3) return null
    if (gestureBounds.width < gestureBounds.height * 1.18 || gestureBounds.height > max(82.0, gestureBounds.width * 0.82)) return null
    val length = pathLength(gesturePoints)
    val diagonal = hypot(gestureBounds.width, gestureBounds.height)
    val pathRatio = if (diagonal == 0.0) 0.0 else length / diagonal
    val reversalCount = horizontalReversals(gesturePoints, gestureBounds.width)
    val selfIntersections = selfIntersectionCount(gesturePoints)
    if (
        length < max(minimumLength, gestureBounds.width * minimumLengthRatio) ||
        pathRatio < minimumPathRatio ||
        reversalCount < minimumReversals
    ) {
        return null
    }
    if (
        selfIntersections < 1 &&
        (reversalCount < minimumReversals + 1 || pathRatio < minimumPathRatio + 0.5)
    ) {
        return null
    }
    val collisionPadding = max(5.0, gesture.baseWidth / 2 + 3)
    val collisionBounds = PixelBounds(
        left = gestureBounds.left - collisionPadding,
        top = gestureBounds.top - collisionPadding,
        right = gestureBounds.right + collisionPadding,
        bottom = gestureBounds.bottom + collisionPadding,
        width = gestureBounds.width + collisionPadding * 2,
        height = gestureBounds.height + collisionPadding * 2,
    )
    val existingBounds = existing.map { strokeBounds(it, pageWidth, pageHeight) }
    val touched = linkedMapOf<Int, Int>()
    existing.forEachIndexed { index, stroke ->
        val bounds = existingBounds[index] ?: return@forEachIndexed
        if (!boundsOverlap(bounds, collisionBounds)) return@forEachIndexed
        val runs = collisionRuns(
            gesturePoints,
            simplifyPoints(pixelPoints(stroke.points, pageWidth, pageHeight)),
            collisionPadding + stroke.baseWidth / 2,
        )
        if (runs > 0) touched[index] = runs
    }
    val intersectionCount = touched.values.sum()
    if (touched.isEmpty() || intersectionCount < minimumIntersections && touched.size < 2) return null
    val touchedBounds = touched.keys.mapNotNull { existingBounds[it] }
    val seedTop = min(gestureBounds.top, touchedBounds.minOf { it.top })
    val seedBottom = max(gestureBounds.bottom, touchedBounds.maxOf { it.bottom })
    val verticalPadding = max(14.0, min(30.0, gestureBounds.height * 0.85))
    val horizontalPadding = max(5.0, min(14.0, gestureBounds.height * 0.35))
    val deletionBounds = PixelBounds(
        left = gestureBounds.left - horizontalPadding,
        right = gestureBounds.right + horizontalPadding,
        top = seedTop - verticalPadding,
        bottom = seedBottom + verticalPadding,
        width = gestureBounds.width + horizontalPadding * 2,
        height = seedBottom - seedTop + verticalPadding * 2,
    )
    val indexes = existingBounds.mapIndexedNotNull { index, bounds ->
        if (bounds == null || !boundsOverlap(bounds, deletionBounds)) return@mapIndexedNotNull null
        val horizontalOverlap = min(bounds.right, gestureBounds.right + horizontalPadding) -
            max(bounds.left, gestureBounds.left - horizontalPadding)
        if (horizontalOverlap < 0) null else index
    }
    if (indexes.isEmpty()) return null
    return ScribbleEraseMatch(indexes, intersectionCount, reversalCount, pathRatio)
}

private fun Int.isFinite() = true

private fun pixelPoints(points: List<StrokePoint>, width: Double, height: Double) =
    points.map { PixelPoint(it.x * width, it.y * height) }

private fun boundsForPoints(points: List<PixelPoint>, padding: Double = 0.0): PixelBounds? {
    if (points.isEmpty()) return null
    val left = points.minOf { it.x } - padding
    val top = points.minOf { it.y } - padding
    val right = points.maxOf { it.x } + padding
    val bottom = points.maxOf { it.y } + padding
    return PixelBounds(left, top, right, bottom, max(0.0, right - left), max(0.0, bottom - top))
}

private fun strokeBounds(stroke: InkStroke, width: Double, height: Double) =
    boundsForPoints(pixelPoints(stroke.points, width, height), max(1.0, stroke.baseWidth / 2))

private fun boundsOverlap(left: PixelBounds, right: PixelBounds) =
    left.right >= right.left && left.left <= right.right && left.bottom >= right.top && left.top <= right.bottom

private fun pointToSegmentDistance(point: PixelPoint, start: PixelPoint, end: PixelPoint): Double {
    val dx = end.x - start.x
    val dy = end.y - start.y
    val lengthSquared = dx * dx + dy * dy
    if (lengthSquared == 0.0) return hypot(point.x - start.x, point.y - start.y)
    val amount = (((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared).coerceIn(0.0, 1.0)
    return hypot(point.x - (start.x + amount * dx), point.y - (start.y + amount * dy))
}

private fun direction(a: PixelPoint, b: PixelPoint, c: PixelPoint) =
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)

private fun segmentsIntersect(a: PixelPoint, b: PixelPoint, c: PixelPoint, d: PixelPoint): Boolean {
    val first = direction(a, b, c)
    val second = direction(a, b, d)
    val third = direction(c, d, a)
    val fourth = direction(c, d, b)
    return ((first > 0 && second < 0) || (first < 0 && second > 0)) &&
        ((third > 0 && fourth < 0) || (third < 0 && fourth > 0))
}

private fun segmentDistance(a: PixelPoint, b: PixelPoint, c: PixelPoint, d: PixelPoint): Double = if (segmentsIntersect(a, b, c, d)) {
    0.0
} else {
    min(
        min(pointToSegmentDistance(a, c, d), pointToSegmentDistance(b, c, d)),
        min(pointToSegmentDistance(c, a, b), pointToSegmentDistance(d, a, b)),
    )
}

private fun simplifyPoints(points: List<PixelPoint>, minimumDistance: Double = 1.6): List<PixelPoint> {
    if (points.size <= 2) return points
    val simplified = mutableListOf(points.first())
    for (index in 1 until points.lastIndex) {
        val previous = simplified.last()
        if (hypot(points[index].x - previous.x, points[index].y - previous.y) >= minimumDistance) simplified += points[index]
    }
    val last = points.last()
    if (last != simplified.last()) simplified += last
    return simplified
}

private fun pathLength(points: List<PixelPoint>): Double {
    var sum = 0.0
    for (index in 1 until points.size) {
        sum += hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y)
    }
    return sum
}

private fun horizontalReversals(points: List<PixelPoint>, span: Double): Int {
    if (points.size < 4) return 0
    val minimumExcursion = max(7.0, span * 0.105)
    var directionSign = 0.0
    var anchorX = points[0].x
    var extremeX = anchorX
    var reversals = 0
    for (index in 1 until points.size) {
        val delta = points[index].x - points[index - 1].x
        if (abs(delta) < 0.7) continue
        val nextSign = sign(delta)
        if (directionSign == 0.0) {
            directionSign = nextSign
            extremeX = points[index].x
            continue
        }
        if (nextSign == directionSign) {
            extremeX = if (directionSign > 0) max(extremeX, points[index].x) else min(extremeX, points[index].x)
            continue
        }
        if (abs(extremeX - anchorX) >= minimumExcursion) {
            reversals += 1
            anchorX = extremeX
            directionSign = nextSign
            extremeX = points[index].x
        }
    }
    return reversals
}

private fun selfIntersectionCount(points: List<PixelPoint>): Int {
    var intersections = 0
    for (first in 1 until points.size) {
        for (second in first + 3 until points.size) {
            if (first == 1 && second == points.lastIndex) continue
            if (segmentsIntersect(points[first - 1], points[first], points[second - 1], points[second])) {
                intersections += 1
                if (intersections >= 12) return intersections
            }
        }
    }
    return intersections
}

private fun collisionRuns(gesture: List<PixelPoint>, target: List<PixelPoint>, threshold: Double): Int {
    if (gesture.isEmpty() || target.isEmpty()) return 0
    if (target.size == 1) {
        val hit = gesture.drop(1).withIndex().any { (index, point) ->
            pointToSegmentDistance(target[0], gesture[index], point) <= threshold
        }
        return if (hit) 1 else 0
    }
    var runs = 0
    var exactCrossings = 0
    var colliding = false
    for (gestureIndex in 1 until gesture.size) {
        var crossing = false
        val hit = target.drop(1).withIndex().any { (targetIndex, point) ->
            if (segmentsIntersect(gesture[gestureIndex - 1], gesture[gestureIndex], target[targetIndex], point)) {
                crossing = true
                return@any true
            }
            segmentDistance(gesture[gestureIndex - 1], gesture[gestureIndex], target[targetIndex], point) <= threshold
        }
        if (crossing) exactCrossings += 1
        if (hit && !colliding) runs += 1
        colliding = hit
    }
    return max(runs, exactCrossings)
}
