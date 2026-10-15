package ch.fasrv.fanotes.ink

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.acos
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.round
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Geometric figure cleanup from `fanotes/src/lib/shapeSnap.ts`.
 * A clear line, circle, ellipse, triangle, square or rectangle replaces the
 * freehand stroke. Letters and scribbles stay freehand.
 */

const val SHAPE_SNAP_SENSITIVITY_DEFAULT = 50

data class ShapeSnapProfile(
    val minConfidence: Double,
    val dwellMs: Int,
    val hintMs: Int,
    val axisSnapRad: Double,
    val loosen: Double,
    val minPoints: Int,
    val ambiguity: Double,
)

data class ShapeSnap(val kind: String, val confidence: Double, val points: List<StrokePoint>)

fun clampShapeSnapSensitivity(value: Int) = value.coerceIn(0, 100)

fun shapeSnapProfile(sensitivity: Int = SHAPE_SNAP_SENSITIVITY_DEFAULT): ShapeSnapProfile {
    val t = clampShapeSnapSensitivity(sensitivity) / 100.0
    return ShapeSnapProfile(
        minConfidence = lerp(0.88, 0.56, t),
        dwellMs = round(lerp(1100.0, 300.0, t)).toInt(),
        hintMs = round(lerp(400.0, 120.0, t)).toInt(),
        axisSnapRad = lerp(6.0, 18.0, t) * PI / 180.0,
        loosen = lerp(0.76, 1.24, t),
        minPoints = round(lerp(12.0, 8.0, t)).toInt(),
        ambiguity = lerp(0.08, 0.02, t),
    )
}

fun inkStrokeAllowsShapeSnap(purpose: String?, symbolId: String?): Boolean =
    purpose != "art" && symbolId.isNullOrEmpty()

fun shapeSnapAllowsLiveSample(snapped: Boolean) = !snapped

/** German name of a snapped figure, matching the desktop drawing board. */
fun shapeSnapLabel(kind: String): String = when (kind) {
    "line" -> "Linie"
    "circle" -> "Kreis"
    "ellipse" -> "Ellipse"
    "triangle" -> "Dreieck"
    "square" -> "Quadrat"
    "rectangle" -> "Rechteck"
    else -> "Form"
}

fun shapeRecognizedNotice(kind: String): String =
    "${shapeSnapLabel(kind)} erkannt · Stift heben übernimmt die saubere Form."

/** Peek whether a stroke is already a recognizable figure, without rewriting it. */
fun strokeLooksLikeShape(
    points: List<StrokePoint>,
    sourceWidth: Double,
    sourceHeight: Double,
    sensitivity: Int = SHAPE_SNAP_SENSITIVITY_DEFAULT,
): Boolean = snapStrokeToShape(points, sourceWidth, sourceHeight, sensitivity) != null

/**
 * Desktop dwell clock: a real move restarts the hold, a still tip keeps the
 * deadline, and the hint fires before the figure is replaced.
 */
class ShapeSnapWatch {
    var lastMoveAtMs: Long = 0
        private set
    private var dwellDueAtMs: Long? = null
    private var hintDueAtMs: Long? = null
    var snapped: Boolean = false
        private set

    fun begin(nowMs: Long) {
        lastMoveAtMs = nowMs
        dwellDueAtMs = null
        hintDueAtMs = null
        snapped = false
    }

    fun clear() {
        dwellDueAtMs = null
        hintDueAtMs = null
    }

    /** Milliseconds until the next check. Null means nothing is armed. */
    fun onSample(nowMs: Long, distancePx: Double, canArm: Boolean, profile: ShapeSnapProfile): Long? {
        if (snapped) {
            clear()
            return null
        }
        if (distancePx >= 0.35) {
            lastMoveAtMs = nowMs
            clear()
        }
        if (!canArm) return null
        if (dwellDueAtMs == null) dwellDueAtMs = nowMs + profile.dwellMs
        if (hintDueAtMs == null) hintDueAtMs = nowMs + profile.hintMs
        return delayUntil(nowMs)
    }

    data class Due(val showHint: Boolean, val trySnap: Boolean, val waitMs: Long?)

    fun onDue(nowMs: Long, profile: ShapeSnapProfile, looksLikeShape: Boolean): Due {
        if (snapped) {
            clear()
            return Due(showHint = false, trySnap = false, waitMs = null)
        }
        var showHint = false
        var trySnap = false
        val hintAt = hintDueAtMs
        if (hintAt != null && nowMs >= hintAt) {
            hintDueAtMs = null
            if (nowMs - lastMoveAtMs >= profile.hintMs && looksLikeShape) showHint = true
        }
        val dwellAt = dwellDueAtMs
        if (dwellAt != null && nowMs >= dwellAt) {
            dwellDueAtMs = null
            val remaining = profile.dwellMs - (nowMs - lastMoveAtMs)
            if (remaining > 16) dwellDueAtMs = nowMs + remaining
            else trySnap = true
        }
        return Due(showHint, trySnap, delayUntil(nowMs))
    }

    /** After a snap attempt. A miss keeps watching; a hit stops the clock. */
    fun noteSnap(success: Boolean, nowMs: Long): Long? {
        if (success) {
            snapped = true
            clear()
            return null
        }
        if (dwellDueAtMs == null) dwellDueAtMs = nowMs + 180
        return delayUntil(nowMs)
    }

    private fun delayUntil(nowMs: Long): Long? {
        val next = listOfNotNull(dwellDueAtMs, hintDueAtMs).minOrNull() ?: return null
        return (next - nowMs).coerceAtLeast(0)
    }
}

fun isStrokeDwelling(points: List<StrokePoint>, sourceWidth: Double, sourceHeight: Double, windowMs: Double = 480.0, maxMovePx: Double = 6.0): Boolean {
    if (points.size < 6) return false
    val last = points.last()
    val cutoff = last.t - windowMs
    var minX = last.x
    var maxX = last.x
    var minY = last.y
    var maxY = last.y
    var found = 0
    for (index in points.lastIndex downTo 0) {
        val point = points[index]
        if (point.t < cutoff) break
        minX = min(minX, point.x)
        maxX = max(maxX, point.x)
        minY = min(minY, point.y)
        maxY = max(maxY, point.y)
        found += 1
    }
    if (found < 3) return false
    return hypot((maxX - minX) * sourceWidth, (maxY - minY) * sourceHeight) <= maxMovePx
}

fun snapStrokeToShape(
    points: List<StrokePoint>,
    sourceWidth: Double,
    sourceHeight: Double,
    sensitivity: Int = SHAPE_SNAP_SENSITIVITY_DEFAULT,
    symbolId: String? = null,
): ShapeSnap? {
    val profile = shapeSnapProfile(sensitivity)
    val loose = profile.loosen
    if (!symbolId.isNullOrEmpty() || points.size < profile.minPoints) return null
    val pts = points.map { point ->
        Phys(point.x * sourceWidth, point.y * sourceHeight, point.t, point.pressure, point.tiltX, point.tiltY, point.pointerType)
    }
    val length = pathLength(pts)
    if (length < 40 / loose) return null
    val box = bboxOf(pts)
    val diagonal = hypot(box.width, box.height)
    if (diagonal < 32 / loose) return null
    val start = pts.first()
    val end = pts.last()
    val chord = hypot(end.x - start.x, end.y - start.y)
    val closed = chord <= max(18 * loose, diagonal * 0.2 * loose)
    val template = templateFrom(pts)

    var lineScore = 0.0
    if (!closed && chord >= 56 / loose) {
        var maxDev = 0.0
        var sumDev = 0.0
        val nx = (end.x - start.x) / chord
        val ny = (end.y - start.y) / chord
        for (point in pts) {
            val along = (point.x - start.x) * nx + (point.y - start.y) * ny
            val px = start.x + nx * along
            val py = start.y + ny * along
            val dev = hypot(point.x - px, point.y - py)
            maxDev = max(maxDev, dev)
            sumDev += dev
        }
        val meanDev = sumDev / pts.size
        val straight = chord / max(1.0, length)
        val minStraight = 0.9 - (loose - 1) * 0.08
        if (straight >= minStraight && maxDev <= max(6 * loose, chord * 0.055 * loose) && meanDev <= max(3.5 * loose, chord * 0.03 * loose)) {
            lineScore = clamp01((straight - (minStraight - 0.02)) / 0.12) * clamp01(1 - meanDev / max(4 * loose, chord * 0.045 * loose))
        }
    }

    val ellipse = fitEllipse(pts)
    val coverage = angularCoverage(pts, ellipse.cx, ellipse.cy)
    val radiusMean = (ellipse.rx + ellipse.ry) / 2
    val aspect = ellipse.rx / max(1.0, ellipse.ry)
    val circular = aspect > 0.82 && aspect < 1.22
    val elliptical = aspect >= 0.38 && aspect <= 2.65
    var circleScore = 0.0
    var ellipseScore = 0.0
    if (closed && coverage >= 0.68 / loose && radiusMean >= 18 / loose && length >= radiusMean * PI * (1.05 / loose) && length <= radiusMean * PI * 3.6 * loose) {
        if (circular && ellipse.residual <= 0.18 * loose) {
            circleScore = clamp01(1 - ellipse.residual / (0.18 * loose)) * clamp01(0.55 + coverage * 0.45)
        } else if (elliptical && ellipse.residual <= 0.2 * loose && (aspect <= 0.86 || aspect >= 1.16)) {
            ellipseScore = clamp01(1 - ellipse.residual / (0.2 * loose)) * clamp01(0.5 + coverage * 0.5)
        }
    }

    val epsilon = max(5.0, diagonal * 0.055)
    var corners = rdp(pts, epsilon).toMutableList()
    if (closed && corners.size >= 3) {
        val first = corners.first()
        val last = corners.last()
        if (hypot(last.x - first.x, last.y - first.y) <= max(12.0, diagonal * 0.1)) corners = corners.dropLast(1).toMutableList()
    }
    val unique = ArrayList<Phys>()
    for (corner in corners) {
        val previous = unique.lastOrNull()
        if (previous == null || hypot(corner.x - previous.x, corner.y - previous.y) > max(10.0, diagonal * 0.06)) unique += corner
    }
    if (unique.size >= 3 && hypot(unique.first().x - unique.last().x, unique.first().y - unique.last().y) <= max(10.0, diagonal * 0.06)) {
        unique.removeAt(unique.lastIndex)
    }

    var triangleScore = 0.0
    var squareScore = 0.0
    var rectangleScore = 0.0
    var triangleVertices: List<Phys>? = null
    var quadVertices: List<Phys>? = null
    if (closed && unique.size == 3) {
        val sides = sideLengths(unique, true)
        val angles = interiorAngles(unique)
        val residual = meanResidualToPolygon(pts, unique, true)
        val minSide = sides.min()
        val sharp = angles.all { it > 28 && it < 142 }
        if (minSide >= 22 / loose && sharp && residual <= max(5 * loose, diagonal * 0.055 * loose)) {
            triangleScore = clamp01(1 - residual / max(6.0, diagonal * 0.07))
            triangleVertices = unique.toList()
            val similar = sides.max() / max(1.0, sides.min())
            if (similar < 1.22 && angles.all { abs(it - 60) < 18 }) triangleScore = min(1.0, triangleScore + 0.06)
        }
    }
    if (closed && unique.size == 4) {
        val sides = sideLengths(unique, true)
        val angles = interiorAngles(unique)
        val residual = meanResidualToPolygon(pts, unique, true)
        val minSide = sides.min()
        val right = angles.all { abs(it - 90) <= 18 }
        val oppositeSimilar = abs(sides[0] - sides[2]) / max(1.0, (sides[0] + sides[2]) / 2) <= 0.22 &&
            abs(sides[1] - sides[3]) / max(1.0, (sides[1] + sides[3]) / 2) <= 0.22
        if (minSide >= 20 / loose && right && oppositeSimilar && residual <= max(5.5 * loose, diagonal * 0.055 * loose)) {
            val sideRatio = max(sides[0], sides[1]) / max(1.0, min(sides[0], sides[1]))
            val score = clamp01(1 - residual / max(6.0, diagonal * 0.07)) * clamp01(1 - angles.maxOf { abs(it - 90) } / 22)
            quadVertices = unique.toList()
            if (sideRatio <= 1.2) squareScore = min(1.0, score + 0.04) else rectangleScore = score
        }
    }
    if (!closed && unique.size >= 5) lineScore = 0.0
    if (closed && unique.size >= 6 && circleScore < 0.86 && ellipseScore < 0.86) {
        triangleScore = 0.0
        squareScore = 0.0
        rectangleScore = 0.0
    }

    val minConfidence = profile.minConfidence
    val line = if (lineScore >= minConfidence) {
        ShapeSnap("line", lineScore, samplePolyline(snapLineToAxis(start, end, pts, profile.axisSnapRad), false, template, sourceWidth, sourceHeight))
    } else null
    val circle = if (circleScore >= minConfidence) {
        ShapeSnap("circle", circleScore, sampleEllipse(ellipse.cx, ellipse.cy, radiusMean, radiusMean, 0.0, template, sourceWidth, sourceHeight))
    } else null
    val oval = if (ellipseScore >= minConfidence) {
        ShapeSnap("ellipse", ellipseScore, sampleEllipse(ellipse.cx, ellipse.cy, ellipse.rx, ellipse.ry, ellipse.rotation, template, sourceWidth, sourceHeight))
    } else null
    val triangle = if (triangleScore >= minConfidence && triangleVertices != null) {
        ShapeSnap("triangle", triangleScore, samplePolyline(triangleVertices, true, template, sourceWidth, sourceHeight))
    } else null
    val square = if (squareScore >= minConfidence && quadVertices != null) {
        ShapeSnap("square", squareScore, samplePolyline(regularizeRectangle(quadVertices, true), true, template, sourceWidth, sourceHeight))
    } else null
    val rectangle = if (rectangleScore >= minConfidence && quadVertices != null) {
        ShapeSnap("rectangle", rectangleScore, samplePolyline(regularizeRectangle(quadVertices, false), true, template, sourceWidth, sourceHeight))
    } else null
    return pickBest(listOf(line, circle, oval, triangle, square, rectangle), minConfidence, profile.ambiguity)
}

private data class Phys(val x: Double, val y: Double, val t: Double, val pressure: Double, val tiltX: Double, val tiltY: Double, val pointerType: String)
private data class EllipseFit(val cx: Double, val cy: Double, val rx: Double, val ry: Double, val rotation: Double, val residual: Double)
private data class Box(val width: Double, val height: Double)

private fun lerp(from: Double, to: Double, amount: Double) = from + (to - from) * amount
private fun clamp01(value: Double) = min(1.0, max(0.0, value))

private fun pathLength(pts: List<Phys>): Double {
    var length = 0.0
    for (index in 1 until pts.size) length += hypot(pts[index].x - pts[index - 1].x, pts[index].y - pts[index - 1].y)
    return length
}

private fun bboxOf(pts: List<Phys>): Box {
    var minX = Double.POSITIVE_INFINITY
    var maxX = Double.NEGATIVE_INFINITY
    var minY = Double.POSITIVE_INFINITY
    var maxY = Double.NEGATIVE_INFINITY
    for (point in pts) {
        minX = min(minX, point.x)
        maxX = max(maxX, point.x)
        minY = min(minY, point.y)
        maxY = max(maxY, point.y)
    }
    return Box(maxX - minX, maxY - minY)
}

private fun centroidOf(pts: List<Phys>): Phys {
    val count = max(1, pts.size)
    return Phys(pts.sumOf { it.x } / count, pts.sumOf { it.y } / count, 0.0, 0.0, 0.0, 0.0, "pen")
}

private fun distToSegment(px: Double, py: Double, ax: Double, ay: Double, bx: Double, by: Double): Double {
    val dx = bx - ax
    val dy = by - ay
    val length2 = dx * dx + dy * dy
    if (length2 < 1e-8) return hypot(px - ax, py - ay)
    val t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / length2))
    return hypot(px - (ax + t * dx), py - (ay + t * dy))
}

private fun rdp(pts: List<Phys>, epsilon: Double): List<Phys> {
    if (pts.size < 3) return pts
    var maxDist = 0.0
    var maxIndex = 0
    val first = pts.first()
    val last = pts.last()
    for (index in 1 until pts.lastIndex) {
        val dist = distToSegment(pts[index].x, pts[index].y, first.x, first.y, last.x, last.y)
        if (dist > maxDist) {
            maxDist = dist
            maxIndex = index
        }
    }
    if (maxDist <= epsilon) return listOf(first, last)
    val left = rdp(pts.subList(0, maxIndex + 1), epsilon)
    val right = rdp(pts.subList(maxIndex, pts.size), epsilon)
    return left.dropLast(1) + right
}

private fun meanResidualToPolygon(pts: List<Phys>, vertices: List<Phys>, closed: Boolean): Double {
    if (vertices.size < 2 || pts.isEmpty()) return Double.POSITIVE_INFINITY
    var sum = 0.0
    val last = if (closed) vertices.size else vertices.size - 1
    for (point in pts) {
        var best = Double.POSITIVE_INFINITY
        for (index in 0 until last) {
            val a = vertices[index]
            val b = vertices[(index + 1) % vertices.size]
            best = min(best, distToSegment(point.x, point.y, a.x, a.y, b.x, b.y))
        }
        sum += best
    }
    return sum / pts.size
}

private fun interiorAngles(vertices: List<Phys>): List<Double> {
    val count = vertices.size
    return List(count) { index ->
        val prev = vertices[(index - 1 + count) % count]
        val curr = vertices[index]
        val next = vertices[(index + 1) % count]
        val ax = prev.x - curr.x
        val ay = prev.y - curr.y
        val bx = next.x - curr.x
        val by = next.y - curr.y
        val denom = hypot(ax, ay) * hypot(bx, by)
        if (denom < 1e-6) 180.0 else acos(max(-1.0, min(1.0, (ax * bx + ay * by) / denom))) * 180 / PI
    }
}

private fun sideLengths(vertices: List<Phys>, closed: Boolean): List<Double> {
    val last = if (closed) vertices.size else vertices.size - 1
    return List(last) { index ->
        val a = vertices[index]
        val b = vertices[(index + 1) % vertices.size]
        hypot(b.x - a.x, b.y - a.y)
    }
}

private fun toStrokePoints(pts: List<Phys>, template: Phys, sourceWidth: Double, sourceHeight: Double) = pts.mapIndexed { index, point ->
    StrokePoint(
        x = point.x / sourceWidth,
        y = point.y / sourceHeight,
        t = template.t + index,
        pressure = template.pressure,
        tiltX = template.tiltX,
        tiltY = template.tiltY,
        pointerType = template.pointerType.ifBlank { "pen" },
    )
}

private fun samplePolyline(vertices: List<Phys>, closed: Boolean, template: Phys, sourceWidth: Double, sourceHeight: Double): List<StrokePoint> {
    val ring = if (closed) vertices + vertices.first() else vertices
    val points = ArrayList<Phys>()
    for (index in 1 until ring.size) {
        val a = ring[index - 1]
        val b = ring[index]
        val length = hypot(b.x - a.x, b.y - a.y)
        val steps = max(2, round(length / 10).toInt())
        val start = if (index == 1) 0 else 1
        for (step in start..steps) {
            val t = step.toDouble() / steps
            points += a.copy(x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t)
        }
    }
    return toStrokePoints(points, template, sourceWidth, sourceHeight)
}

private fun sampleEllipse(cx: Double, cy: Double, rx: Double, ry: Double, rotation: Double, template: Phys, sourceWidth: Double, sourceHeight: Double, samples: Int = 56): List<StrokePoint> {
    val cosine = cos(rotation)
    val sine = sin(rotation)
    val points = (0..samples).map { index ->
        val angle = index.toDouble() / samples * PI * 2
        val lx = cos(angle) * rx
        val ly = sin(angle) * ry
        Phys(cx + lx * cosine - ly * sine, cy + lx * sine + ly * cosine, 0.0, 0.0, 0.0, 0.0, "pen")
    }
    return toStrokePoints(points, template, sourceWidth, sourceHeight)
}

private fun fitEllipse(pts: List<Phys>): EllipseFit {
    val center = centroidOf(pts)
    var xx = 0.0
    var yy = 0.0
    var xy = 0.0
    for (point in pts) {
        val dx = point.x - center.x
        val dy = point.y - center.y
        xx += dx * dx
        yy += dy * dy
        xy += dx * dy
    }
    val count = max(1, pts.size).toDouble()
    xx /= count
    yy /= count
    xy /= count
    val trace = xx + yy
    val det = xx * yy - xy * xy
    val disc = sqrt(max(0.0, trace * trace / 4 - det))
    val ev1 = trace / 2 + disc
    val ev2 = trace / 2 - disc
    val rotation = if (abs(xy) < 1e-8 && xx >= yy) 0.0 else atan2(ev1 - xx, xy)
    val rx = sqrt(max(1.0, ev1 * 2))
    val ry = sqrt(max(1.0, ev2 * 2))
    var residual = 0.0
    val cosine = cos(rotation)
    val sine = sin(rotation)
    for (point in pts) {
        val dx = point.x - center.x
        val dy = point.y - center.y
        val lx = dx * cosine + dy * sine
        val ly = -dx * sine + dy * cosine
        val nx = if (rx < 1e-3) 0.0 else lx / rx
        val ny = if (ry < 1e-3) 0.0 else ly / ry
        residual += abs(hypot(nx, ny) - 1)
    }
    return EllipseFit(center.x, center.y, rx, ry, rotation, residual / count)
}

private fun angularCoverage(pts: List<Phys>, cx: Double, cy: Double): Double {
    if (pts.size < 4) return 0.0
    val angles = pts.map { atan2(it.y - cy, it.x - cx) }.sorted()
    var maxGap = 0.0
    for (index in 1 until angles.size) maxGap = max(maxGap, angles[index] - angles[index - 1])
    maxGap = max(maxGap, angles.first() + PI * 2 - angles.last())
    return max(0.0, 1 - maxGap / (PI * 2))
}

private fun templateFrom(pts: List<Phys>): Phys {
    val start = pts.first()
    return start.copy(pressure = pts.sumOf { it.pressure } / pts.size, pointerType = pts.last().pointerType.ifBlank { start.pointerType })
}

private fun pickBest(candidates: List<ShapeSnap?>, minConfidence: Double, ambiguity: Double): ShapeSnap? {
    val valid = candidates.filterNotNull().filter { it.confidence >= minConfidence }.sortedByDescending { it.confidence }
    val best = valid.firstOrNull() ?: return null
    val second = valid.getOrNull(1)
    if (second != null && best.confidence - second.confidence < ambiguity && second.kind != best.kind) return null
    return best
}

private fun snapLineToAxis(start: Phys, end: Phys, pts: List<Phys>, axisSnapRad: Double): List<Phys> {
    val dx = end.x - start.x
    val dy = end.y - start.y
    val tilt = atan2(abs(dy), abs(dx))
    if (tilt <= axisSnapRad) {
        val y = pts.sumOf { it.y } / max(1, pts.size)
        return listOf(start.copy(y = y), end.copy(y = y))
    }
    if (tilt >= PI / 2 - axisSnapRad) {
        val x = pts.sumOf { it.x } / max(1, pts.size)
        return listOf(start.copy(x = x), end.copy(x = x))
    }
    return listOf(start, end)
}

private fun regularizeRectangle(vertices: List<Phys>, forceSquare: Boolean): List<Phys> {
    val center = centroidOf(vertices)
    var rotation = atan2(vertices[1].y - vertices[0].y, vertices[1].x - vertices[0].x)
    val snapped = round(rotation / (PI / 2)) * (PI / 2)
    if (abs(rotation - snapped) < 10 * PI / 180) rotation = snapped
    val cosine = cos(-rotation)
    val sine = sin(-rotation)
    var maxX = 0.0
    var maxY = 0.0
    for (vertex in vertices) {
        val dx = vertex.x - center.x
        val dy = vertex.y - center.y
        maxX = max(maxX, abs(dx * cosine - dy * sine))
        maxY = max(maxY, abs(dx * sine + dy * cosine))
    }
    if (forceSquare) {
        val size = (maxX + maxY) / 2
        maxX = size
        maxY = size
    }
    val rc = cos(rotation)
    val rs = sin(rotation)
    return listOf(
        Phys(-maxX, -maxY, 0.0, 0.0, 0.0, 0.0, "pen"),
        Phys(maxX, -maxY, 0.0, 0.0, 0.0, 0.0, "pen"),
        Phys(maxX, maxY, 0.0, 0.0, 0.0, 0.0, "pen"),
        Phys(-maxX, maxY, 0.0, 0.0, 0.0, 0.0, "pen"),
    ).map { point ->
        Phys(center.x + point.x * rc - point.y * rs, center.y + point.x * rs + point.y * rc, 0.0, 0.0, 0.0, 0.0, "pen")
    }
}
