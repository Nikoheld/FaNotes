package ch.fasrv.fanotes.ink

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.round
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Ruler, Geodreieck and compass in real millimetres.
 * Poses live in the sheet's 0–1 space. Turns happen in millimetres: the
 * normalised sheet is not square, so rotating there would shear the tool.
 * Ported from `fanotes/src/lib/draftingTools.ts`.
 */

const val A4_WIDTH_MM = 210.0
const val SOURCE_A4_PX = 900.0
const val MM_PER_INCH = 25.4
private const val MM_PER_SOURCE_PX = A4_WIDTH_MM / SOURCE_A4_PX

const val RULER_LENGTH_MM = 160.0
const val RULER_MIN_LENGTH_MM = 50.0
const val RULER_MAX_LENGTH_MM = 500.0
const val RULER_WIDTH_MM = 26.0
const val RULER_MIN_WIDTH_MM = 16.0
const val RULER_MAX_WIDTH_MM = 80.0
const val SET_SQUARE_SIZE_MM = 160.0
const val SET_SQUARE_MIN_SIZE_MM = 80.0
const val SET_SQUARE_MAX_SIZE_MM = 400.0
const val SNAP_MM = 3.2
const val ATTACH_DISTANCE_MM = 7.0
const val ATTACH_ANGLE_RAD = 10.0 * PI / 180.0
const val COMPASS_MIN_RADIUS_MM = 3.0
const val COMPASS_MAX_RADIUS_MM = 200.0
const val COMPASS_DEFAULT_RADIUS_MM = 35.0
const val COMPASS_CENTRE_MARK_MM = 1.6
const val PEN_EDGE_ZONE_MM = 6.0

enum class DraftingKind { RULER, SET_SQUARE, COMPASS }

data class DraftingPose(
    val x: Double,
    val y: Double,
    val rotation: Double,
    val lengthMm: Double = RULER_LENGTH_MM,
    val widthMm: Double = RULER_WIDTH_MM,
    val sizeMm: Double = SET_SQUARE_SIZE_MM,
    val flipped: Boolean = false,
    val radiusMm: Double = COMPASS_DEFAULT_RADIUS_MM,
    val locked: Boolean = false,
    val pinned: Boolean = false,
)

data class DraftingDisplay(val width: Double, val height: Double)

data class DraftingEdge(
    val ax: Double,
    val ay: Double,
    val bx: Double,
    val by: Double,
    val originT: Double = 0.0,
)

data class DraftingSample(val x: Double, val y: Double)

data class DraftingToolState(val kind: DraftingKind, val pose: DraftingPose)

data class DraftingSnapLock(val kind: DraftingKind, val edgeIndex: Int)

data class SnapResult(
    val x: Double,
    val y: Double,
    val kind: DraftingKind,
    val edgeIndex: Int,
    val millimetres: Double,
    val angle: Double,
)

data class ScaleTick(val mm: Double, val level: Int, val label: String?)

fun clampRulerLength(mm: Double) = clampNumber(mm, RULER_MIN_LENGTH_MM, RULER_MAX_LENGTH_MM, RULER_LENGTH_MM)
fun clampRulerWidth(mm: Double) = clampNumber(mm, RULER_MIN_WIDTH_MM, RULER_MAX_WIDTH_MM, RULER_WIDTH_MM)
fun clampSetSquareSize(mm: Double) = clampNumber(mm, SET_SQUARE_MIN_SIZE_MM, SET_SQUARE_MAX_SIZE_MM, SET_SQUARE_SIZE_MM)
fun clampCompassRadius(mm: Double) = min(COMPASS_MAX_RADIUS_MM, max(COMPASS_MIN_RADIUS_MM, if (mm.isFinite()) mm else COMPASS_DEFAULT_RADIUS_MM))

fun rulerLength(pose: DraftingPose) = clampRulerLength(pose.lengthMm)
fun rulerWidth(pose: DraftingPose) = clampRulerWidth(pose.widthMm)
fun setSquareSize(pose: DraftingPose) = clampSetSquareSize(pose.sizeMm)

/** −1: apex above the base, +1: flipped. */
fun setSquareApexSign(pose: DraftingPose) = if (pose.flipped) 1.0 else -1.0

fun defaultRulerPose() = DraftingPose(x = 0.5, y = 0.22, rotation = 0.0)
fun defaultSetSquarePose() = DraftingPose(x = 0.5, y = 0.48, rotation = 0.0)
fun defaultCompassPose() = DraftingPose(x = 0.44, y = 0.36, rotation = -PI / 5.0, radiusMm = COMPASS_DEFAULT_RADIUS_MM)

fun mmToSourcePx(mm: Double) = mm * SOURCE_A4_PX / A4_WIDTH_MM
fun mmToNorm(mm: Double, sourceSize: Double) = mmToSourcePx(mm) / max(1.0, sourceSize)
fun normToMm(value: Double, sourceSize: Double) = value * max(1.0, sourceSize) * MM_PER_SOURCE_PX

fun snapAngle(radians: Double, stepDegrees: Int): Double {
    if (stepDegrees <= 0) return radians
    val step = stepDegrees * PI / 180.0
    return round(radians / step) * step
}

fun normalizeAngle(radians: Double): Double {
    val turn = PI * 2
    return ((radians % turn) + turn) % turn
}

fun shortestAngleDelta(from: Double, to: Double): Double {
    var delta = to - from
    while (delta > PI) delta -= PI * 2
    while (delta < -PI) delta += PI * 2
    return delta
}

fun mmToNormPoint(localX: Double, localY: Double, pose: DraftingPose, sourceWidth: Double, sourceHeight: Double): DraftingSample {
    val turned = rotateAround(localX, localY, 0.0, 0.0, pose.rotation)
    return DraftingSample(
        pose.x + mmToNorm(turned.x, sourceWidth),
        pose.y + mmToNorm(turned.y, sourceHeight),
    )
}

fun normToLocalMm(x: Double, y: Double, pose: DraftingPose, sourceWidth: Double, sourceHeight: Double): DraftingSample {
    val local = rotateAround(normToMm(x - pose.x, sourceWidth), normToMm(y - pose.y, sourceHeight), 0.0, 0.0, -pose.rotation)
    return DraftingSample(local.x, local.y)
}

fun compassRadiiNorm(radiusMm: Double, sourceWidth: Double, sourceHeight: Double, display: DraftingDisplay? = null): Pair<Double, Double> {
    val rx = mmToNorm(radiusMm, sourceWidth)
    val size = displaySize(sourceWidth, sourceHeight, display)
    return rx to rx * (size.width / size.height)
}

fun compassPencilPoint(pose: DraftingPose, sourceWidth: Double, sourceHeight: Double, display: DraftingDisplay? = null): DraftingSample {
    val (rx, ry) = compassRadiiNorm(pose.radiusMm, sourceWidth, sourceHeight, display)
    return DraftingSample(pose.x + cos(pose.rotation) * rx, pose.y + sin(pose.rotation) * ry)
}

fun radiusMmBetween(
    ax: Double,
    ay: Double,
    bx: Double,
    by: Double,
    sourceWidth: Double,
    sourceHeight: Double,
    display: DraftingDisplay? = null,
): Double {
    val size = displaySize(sourceWidth, sourceHeight, display)
    val pixels = hypot((bx - ax) * size.width, (by - ay) * size.height)
    return pixels / max(1e-6, pxPerMmOnDisplay(sourceWidth, size))
}

fun angleToPoint(
    originX: Double,
    originY: Double,
    x: Double,
    y: Double,
    sourceWidth: Double,
    sourceHeight: Double,
    display: DraftingDisplay? = null,
): Double {
    val size = displaySize(sourceWidth, sourceHeight, display)
    return atan2((y - originY) * size.height, (x - originX) * size.width)
}

fun snapRadiusMm(mm: Double): Double {
    val rounded = round(mm)
    return if (abs(mm - rounded) < 0.35) rounded else mm
}

fun sampleCompassArc(
    pose: DraftingPose,
    fromAngle: Double,
    toAngle: Double,
    sourceWidth: Double,
    sourceHeight: Double,
    stepRad: Double = 0.035,
    display: DraftingDisplay? = null,
): List<DraftingSample> {
    val (rx, ry) = compassRadiiNorm(pose.radiusMm, sourceWidth, sourceHeight, display)
    val delta = toAngle - fromAngle
    if (abs(delta) < 1e-8) {
        return listOf(DraftingSample(pose.x + cos(toAngle) * rx, pose.y + sin(toAngle) * ry))
    }
    val steps = max(1, ceil(abs(delta) / stepRad).toInt())
    return (1..steps).map { index ->
        val angle = fromAngle + delta * (index.toDouble() / steps)
        DraftingSample(pose.x + cos(angle) * rx, pose.y + sin(angle) * ry)
    }
}

fun sampleCompassCircle(
    pose: DraftingPose,
    sourceWidth: Double,
    sourceHeight: Double,
    display: DraftingDisplay? = null,
): List<DraftingSample> {
    val points = sampleCompassArc(pose, pose.rotation, pose.rotation + PI * 2, sourceWidth, sourceHeight, 0.028, display).toMutableList()
    val first = points.firstOrNull() ?: return points
    points += first
    return points
}

fun pointInsideRuler(x: Double, y: Double, pose: DraftingPose, sourceWidth: Double, sourceHeight: Double): Boolean {
    val local = normToLocalMm(x, y, pose, sourceWidth, sourceHeight)
    val half = rulerLength(pose) / 2
    val across = rulerWidth(pose) / 2
    return local.x in -half..half && local.y >= -across - 0.6 && local.y <= across + 0.6
}

fun pointInsideSetSquare(x: Double, y: Double, pose: DraftingPose, sourceWidth: Double, sourceHeight: Double): Boolean {
    val local = normToLocalMm(x, y, pose, sourceWidth, sourceHeight)
    val half = setSquareSize(pose) / 2
    val towardApex = local.y * setSquareApexSign(pose)
    return towardApex >= -0.8 && abs(local.x) + abs(local.y) <= half + 0.8
}

fun rulerDrawingEdges(pose: DraftingPose, sourceWidth: Double, sourceHeight: Double) =
    rulerLocalLines(pose).map { localLineToEdge(it, pose, sourceWidth, sourceHeight) }

fun setSquareDrawingEdges(pose: DraftingPose, sourceWidth: Double, sourceHeight: Double) =
    setSquareLocalLines(pose).map { localLineToEdge(it, pose, sourceWidth, sourceHeight) }

fun draftingEdges(kind: DraftingKind, pose: DraftingPose, sourceWidth: Double, sourceHeight: Double): List<DraftingEdge> = when (kind) {
    DraftingKind.COMPASS -> emptyList()
    DraftingKind.RULER -> rulerDrawingEdges(pose, sourceWidth, sourceHeight)
    DraftingKind.SET_SQUARE -> setSquareDrawingEdges(pose, sourceWidth, sourceHeight)
}

/**
 * Pulls a pen sample onto the nearest drawing edge or compass circle.
 * A pen inside a ruler or set square always lands on that body's nearest edge.
 */
fun snapToDraftingTools(
    x: Double,
    y: Double,
    tools: List<DraftingToolState>,
    sourceWidth: Double,
    sourceHeight: Double,
    locked: DraftingSnapLock? = null,
    display: DraftingDisplay? = null,
    thresholdMm: Double = SNAP_MM,
): SnapResult? {
    if (locked != null) {
        val tool = tools.find { it.kind == locked.kind }
        if (tool != null) {
            if (tool.kind == DraftingKind.COMPASS) {
                return projectOnCompass(x, y, tool.pose, sourceWidth, sourceHeight, Double.POSITIVE_INFINITY, display)
            }
            val edges = draftingEdges(tool.kind, tool.pose, sourceWidth, sourceHeight)
            val edge = edges.getOrNull(locked.edgeIndex) ?: return null
            return edgeSnap(x, y, tool.kind, edge, locked.edgeIndex, sourceWidth, sourceHeight).toSnap()
        }
    }
    if (thresholdMm <= 0) return null
    var best: SnapResult? = null
    var bestDistance = Double.POSITIVE_INFINITY
    for (tool in tools) {
        if (tool.kind == DraftingKind.COMPASS) {
            val candidate = projectOnCompass(x, y, tool.pose, sourceWidth, sourceHeight, thresholdMm, display) ?: continue
            val distance = distanceMm(x, y, candidate.x, candidate.y, sourceWidth, sourceHeight)
            if (distance < bestDistance) {
                best = candidate
                bestDistance = distance
            }
            continue
        }
        val edges = draftingEdges(tool.kind, tool.pose, sourceWidth, sourceHeight)
        val inside = if (tool.kind == DraftingKind.RULER) {
            pointInsideRuler(x, y, tool.pose, sourceWidth, sourceHeight)
        } else {
            pointInsideSetSquare(x, y, tool.pose, sourceWidth, sourceHeight)
        }
        val candidate = nearestOnEdges(x, y, tool.kind, edges, sourceWidth, sourceHeight, if (inside) Double.POSITIVE_INFINITY else thresholdMm)
            ?: continue
        val distance = if (inside) -1.0 else candidate.distanceMm
        if (distance < bestDistance) {
            best = candidate.toSnap()
            bestDistance = distance
        }
    }
    return best
}

fun attachSetSquareToRuler(
    square: DraftingPose,
    ruler: DraftingPose,
    sourceWidth: Double,
    sourceHeight: Double,
    maxDistance: Double = ATTACH_DISTANCE_MM,
    maxAngle: Double = ATTACH_ANGLE_RAD,
): DraftingPose? {
    val origin = toMm(square.x, square.y, sourceWidth, sourceHeight)
    val candidates = setSquareLocalLines(square) + setSquareMidline(square)
    var bestRotation = 0.0
    var bestShiftX = 0.0
    var bestShiftY = 0.0
    var bestScore = Double.POSITIVE_INFINITY
    var found = false
    for (rulerLine in rulerLocalLines(ruler)) {
        val outwardLocal = rulerLine.outward ?: continue
        val edge = localLineToEdge(rulerLine, ruler, sourceWidth, sourceHeight)
        val a = toMm(edge.ax, edge.ay, sourceWidth, sourceHeight)
        val b = toMm(edge.bx, edge.by, sourceWidth, sourceHeight)
        val edgeLength = hypot(b.x - a.x, b.y - a.y)
        if (edgeLength < 1e-6) continue
        val edgeDirection = atan2(b.y - a.y, b.x - a.x)
        val outward = rotateAround(outwardLocal.x, outwardLocal.y, 0.0, 0.0, ruler.rotation)
        for (line in candidates) {
            val localDirection = atan2(line.by - line.ay, line.bx - line.ax)
            val worldDirection = square.rotation + localDirection
            var delta = edgeDirection - worldDirection
            delta = ((delta + PI / 2) % PI + PI) % PI - PI / 2
            if (abs(delta) > maxAngle) continue
            val rotation = square.rotation + delta
            val midLocalX = (line.ax + line.bx) / 2
            val midLocalY = (line.ay + line.by) / 2
            val midRotated = rotateAround(midLocalX, midLocalY, 0.0, 0.0, rotation)
            val midX = origin.x + midRotated.x
            val midY = origin.y + midRotated.y
            val signedDistance = (midX - a.x) * outward.x + (midY - a.y) * outward.y
            if (abs(signedDistance) > maxDistance) continue
            val along = ((midX - a.x) * (b.x - a.x) + (midY - a.y) * (b.y - a.y)) / (edgeLength * edgeLength)
            if (along < -0.15 || along > 1.15) continue
            if (line.outward != null) {
                val squareOutward = rotateAround(line.outward.x, line.outward.y, 0.0, 0.0, rotation)
                if (squareOutward.x * outward.x + squareOutward.y * outward.y > -0.5) continue
            }
            val score = abs(signedDistance) + abs(delta) * 25
            if (score < bestScore) {
                found = true
                bestScore = score
                bestRotation = rotation
                bestShiftX = -signedDistance * outward.x
                bestShiftY = -signedDistance * outward.y
            }
        }
    }
    if (!found) return null
    return square.copy(
        rotation = bestRotation,
        x = square.x + mmToNorm(bestShiftX, sourceWidth),
        y = square.y + mmToNorm(bestShiftY, sourceHeight),
    )
}

fun keepPoseOnSheet(kind: DraftingKind, pose: DraftingPose, sourceWidth: Double, sourceHeight: Double, marginMm: Double = 2.0): DraftingPose {
    val extent = toolExtentMm(kind, pose)
    val x = fitOnAxis(normToMm(pose.x, sourceWidth), extent.minX, extent.maxX, normToMm(1.0, sourceWidth), marginMm)
    val y = fitOnAxis(normToMm(pose.y, sourceHeight), extent.minY, extent.maxY, normToMm(1.0, sourceHeight), marginMm)
    return pose.copy(x = mmToNorm(x, sourceWidth), y = mmToNorm(y, sourceHeight))
}

fun scaleTicks(lengthMm: Double): List<ScaleTick> {
    val count = floor(lengthMm + 1e-6).toInt()
    return (0..count).map { index ->
        val level = when {
            index % 10 == 0 -> 2
            index % 5 == 0 -> 1
            else -> 0
        }
        ScaleTick(index.toDouble(), level, if (level == 2) (index / 10).toString() else null)
    }
}

fun formatMillimetres(mm: Double): String {
    if (abs(mm) >= 10) {
        val cm = round(mm) / 10.0
        val text = if (abs(cm - round(cm)) < 1e-6) round(cm).toInt().toString() else ((round(cm * 10) / 10.0).toString())
        return "${text.replace('.', ',')} cm"
    }
    return "${round(mm).toInt()} mm"
}

private data class LocalMm(val x: Double, val y: Double)
private data class Extent(val minX: Double, val maxX: Double, val minY: Double, val maxY: Double)
private data class LocalLine(
    val ax: Double,
    val ay: Double,
    val bx: Double,
    val by: Double,
    val originT: Double,
    val outward: LocalMm?,
)
private data class EdgeHit(
    val x: Double,
    val y: Double,
    val kind: DraftingKind,
    val edgeIndex: Int,
    val millimetres: Double,
    val angle: Double,
    val distanceMm: Double,
) {
    fun toSnap() = SnapResult(x, y, kind, edgeIndex, millimetres, angle)
}

private fun clampNumber(value: Double, minValue: Double, maxValue: Double, fallback: Double): Double {
    if (!value.isFinite()) return fallback
    return min(maxValue, max(minValue, value))
}

private fun displaySize(sourceWidth: Double, sourceHeight: Double, display: DraftingDisplay?) = DraftingDisplay(
    max(1.0, display?.width ?: sourceWidth),
    max(1.0, display?.height ?: sourceHeight),
)

private fun pxPerMmOnDisplay(sourceWidth: Double, display: DraftingDisplay) =
    display.width / max(1.0, sourceWidth) * SOURCE_A4_PX / A4_WIDTH_MM

private fun rotateAround(x: Double, y: Double, cx: Double, cy: Double, rotation: Double): LocalMm {
    val dx = x - cx
    val dy = y - cy
    val cosine = cos(rotation)
    val sine = sin(rotation)
    return LocalMm(cx + dx * cosine - dy * sine, cy + dx * sine + dy * cosine)
}

private fun toMm(x: Double, y: Double, sourceWidth: Double, sourceHeight: Double) =
    LocalMm(normToMm(x, sourceWidth), normToMm(y, sourceHeight))

private fun rulerLocalLines(pose: DraftingPose): List<LocalLine> {
    val half = rulerLength(pose) / 2
    val across = rulerWidth(pose) / 2
    return listOf(
        LocalLine(-half, -across, half, -across, 0.0, LocalMm(0.0, -1.0)),
        LocalLine(-half, across, half, across, 0.0, LocalMm(0.0, 1.0)),
    )
}

private fun setSquareLocalLines(pose: DraftingPose): List<LocalLine> {
    val half = setSquareSize(pose) / 2
    val sign = setSquareApexSign(pose)
    val diagonal = 1 / sqrt(2.0)
    return listOf(
        LocalLine(-half, 0.0, half, 0.0, 0.5, LocalMm(0.0, -sign)),
        LocalLine(-half, 0.0, 0.0, sign * half, 0.0, LocalMm(-diagonal, sign * diagonal)),
        LocalLine(half, 0.0, 0.0, sign * half, 0.0, LocalMm(diagonal, sign * diagonal)),
    )
}

private fun setSquareMidline(pose: DraftingPose): LocalLine {
    val half = setSquareSize(pose) / 2
    return LocalLine(0.0, 0.0, 0.0, setSquareApexSign(pose) * half, 0.0, null)
}

private fun localLineToEdge(line: LocalLine, pose: DraftingPose, sourceWidth: Double, sourceHeight: Double): DraftingEdge {
    val a = mmToNormPoint(line.ax, line.ay, pose, sourceWidth, sourceHeight)
    val b = mmToNormPoint(line.bx, line.by, pose, sourceWidth, sourceHeight)
    return DraftingEdge(a.x, a.y, b.x, b.y, line.originT)
}

private fun projectOnEdge(x: Double, y: Double, edge: DraftingEdge): DraftingSample {
    val vx = edge.bx - edge.ax
    val vy = edge.by - edge.ay
    val length2 = vx * vx + vy * vy
    if (length2 < 1e-12) return DraftingSample(edge.ax, edge.ay)
    val t = ((x - edge.ax) * vx + (y - edge.ay) * vy) / length2
    val clamped = min(1.0, max(0.0, t))
    return DraftingSample(edge.ax + clamped * vx, edge.ay + clamped * vy)
}

private fun projectionT(x: Double, y: Double, edge: DraftingEdge): Double {
    val vx = edge.bx - edge.ax
    val vy = edge.by - edge.ay
    val length2 = vx * vx + vy * vy
    if (length2 < 1e-12) return 0.0
    return min(1.0, max(0.0, ((x - edge.ax) * vx + (y - edge.ay) * vy) / length2))
}

private fun millimetresAlongEdge(edge: DraftingEdge, t: Double, sourceWidth: Double, sourceHeight: Double): Double {
    val dxPx = (edge.bx - edge.ax) * sourceWidth
    val dyPx = (edge.by - edge.ay) * sourceHeight
    return (t - edge.originT) * hypot(dxPx, dyPx) * MM_PER_SOURCE_PX
}

private fun edgeAngle(edge: DraftingEdge, sourceWidth: Double, sourceHeight: Double) =
    atan2((edge.by - edge.ay) * sourceHeight, (edge.bx - edge.ax) * sourceWidth)

private fun distanceMm(ax: Double, ay: Double, bx: Double, by: Double, sourceWidth: Double, sourceHeight: Double) =
    hypot(normToMm(bx - ax, sourceWidth), normToMm(by - ay, sourceHeight))

private fun edgeSnap(
    x: Double,
    y: Double,
    kind: DraftingKind,
    edge: DraftingEdge,
    edgeIndex: Int,
    sourceWidth: Double,
    sourceHeight: Double,
): EdgeHit {
    val projected = projectOnEdge(x, y, edge)
    val t = projectionT(x, y, edge)
    return EdgeHit(
        projected.x,
        projected.y,
        kind,
        edgeIndex,
        millimetresAlongEdge(edge, t, sourceWidth, sourceHeight),
        edgeAngle(edge, sourceWidth, sourceHeight),
        distanceMm(x, y, projected.x, projected.y, sourceWidth, sourceHeight),
    )
}

private fun nearestOnEdges(
    x: Double,
    y: Double,
    kind: DraftingKind,
    edges: List<DraftingEdge>,
    sourceWidth: Double,
    sourceHeight: Double,
    thresholdMm: Double,
): EdgeHit? {
    var best: EdgeHit? = null
    edges.forEachIndexed { index, edge ->
        val candidate = edgeSnap(x, y, kind, edge, index, sourceWidth, sourceHeight)
        if (candidate.distanceMm > thresholdMm) return@forEachIndexed
        if (best == null || candidate.distanceMm < best!!.distanceMm) best = candidate
    }
    return best
}

private fun projectOnCompass(
    x: Double,
    y: Double,
    pose: DraftingPose,
    sourceWidth: Double,
    sourceHeight: Double,
    thresholdMm: Double,
    display: DraftingDisplay?,
): SnapResult? {
    val radius = clampCompassRadius(pose.radiusMm)
    val (rx, ry) = compassRadiiNorm(radius, sourceWidth, sourceHeight, display)
    if (rx < 1e-6 || ry < 1e-6) return null
    val distMm = radiusMmBetween(pose.x, pose.y, x, y, sourceWidth, sourceHeight, display)
    if (thresholdMm.isFinite() && abs(distMm - radius) > thresholdMm) return null
    val angle = angleToPoint(pose.x, pose.y, x, y, sourceWidth, sourceHeight, display)
    return SnapResult(
        pose.x + cos(angle) * rx,
        pose.y + sin(angle) * ry,
        DraftingKind.COMPASS,
        0,
        radius,
        angle,
    )
}

private fun toolExtentMm(kind: DraftingKind, pose: DraftingPose): Extent {
    if (kind == DraftingKind.COMPASS) {
        val radius = clampCompassRadius(pose.radiusMm)
        return Extent(-radius, radius, -radius, radius)
    }
    val corners = if (kind == DraftingKind.RULER) {
        val half = rulerLength(pose) / 2
        val across = rulerWidth(pose) / 2
        listOf(LocalMm(-half, -across), LocalMm(half, -across), LocalMm(half, across), LocalMm(-half, across))
    } else {
        val half = setSquareSize(pose) / 2
        listOf(LocalMm(-half, 0.0), LocalMm(half, 0.0), LocalMm(0.0, setSquareApexSign(pose) * half))
    }
    val turned = corners.map { rotateAround(it.x, it.y, 0.0, 0.0, pose.rotation) }
    return Extent(
        turned.minOf { it.x },
        turned.maxOf { it.x },
        turned.minOf { it.y },
        turned.maxOf { it.y },
    )
}

private fun fitOnAxis(centre: Double, minEdge: Double, maxEdge: Double, size: Double, marginMm: Double): Double {
    val low = marginMm - minEdge
    val high = size - marginMm - maxEdge
    return if (low <= high) min(high, max(low, centre)) else min(size - marginMm, max(marginMm, centre))
}
