package ch.fasrv.fanotes.ink

import kotlin.math.acos
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

/** One stroked layer of a desktop brush, widest first. */
data class InkPaintPass(
    val widthFactor: Double,
    val alpha: Double,
    val jitter: Double = 0.0,
)

data class ArtBrush(
    val id: String,
    val label: String,
    val description: String,
    val defaultWidth: Double,
    val pressure: Boolean,
)

/** Same brushes, labels, and default widths as the desktop art panel. */
val ART_BRUSHES = listOf(
    ArtBrush("fineliner", "Fineliner", "klar & präzise", 3.0, false),
    ArtBrush("pencil", "Bleistift", "weich texturiert", 3.5, true),
    ArtBrush("marker", "Marker", "satt & gleichmässig", 9.0, false),
    ArtBrush("paintbrush", "Pinsel", "dynamischer Druck", 11.0, true),
    ArtBrush("calligraphy", "Kalligrafie", "schräge Breitfeder", 9.0, true),
    ArtBrush("highlighter", "Textmarker", "transparent", 22.0, false),
    ArtBrush("watercolor", "Aquarell", "lasierende Kanten", 20.0, true),
    ArtBrush("spray", "Spray", "feine Partikel", 26.0, false),
)

fun artBrush(id: String?): ArtBrush = ART_BRUSHES.firstOrNull { it.id == id } ?: ART_BRUSHES.first()

/** Passes from `brushPasses` in `inkStrokePaint.ts`. */
fun brushPasses(brush: String?): List<InkPaintPass> = when (brush) {
    "pencil" -> listOf(
        InkPaintPass(0.72, 0.58),
        InkPaintPass(0.22, 0.2, 1.4),
        InkPaintPass(0.18, 0.14, 1.8),
    )
    "paintbrush" -> listOf(InkPaintPass(1.4, 0.16), InkPaintPass(0.92, 0.82))
    "highlighter" -> listOf(InkPaintPass(1.0, 0.34))
    "watercolor" -> listOf(
        InkPaintPass(1.48, 0.11),
        InkPaintPass(1.14, 0.17),
        InkPaintPass(0.78, 0.27),
    )
    "marker" -> listOf(InkPaintPass(1.0, 0.9))
    else -> listOf(InkPaintPass(1.0, 1.0))
}

sealed class MarkerCommand {
    data class Move(val x: Double, val y: Double) : MarkerCommand()
    data class Line(val x: Double, val y: Double) : MarkerCommand()
    data class Quad(val cx: Double, val cy: Double, val x: Double, val y: Double) : MarkerCommand()
}

/**
 * Marker centerline in page pixels. A quadratic fillet sits inside each corner
 * when smoothing is on, matching `paintMarkerStroke` in `inkStrokePaint.ts`.
 */
fun markerCenterline(
    x: List<Double>,
    y: List<Double>,
    lineWidth: Double,
    smoothing: Double,
): List<MarkerCommand> {
    if (x.isEmpty() || y.size != x.size) return emptyList()
    val from = 0
    val to = x.lastIndex
    val commands = ArrayList<MarkerCommand>()
    commands += MarkerCommand.Move(x[from], y[from])
    if (to == from) return commands
    val radius = lineWidth / 2.0
    val smooth = smoothing.coerceIn(0.0, 1.0)
    if (smooth <= 0.0 || to - from < 2) {
        for (index in (from + 1)..to) commands += MarkerCommand.Line(x[index], y[index])
        return commands
    }
    var cursorX = x[from]
    var cursorY = y[from]
    for (index in (from + 1) until to) {
        val ax = x[index - 1]
        val ay = y[index - 1]
        val bx = x[index]
        val by = y[index]
        val cx = x[index + 1]
        val cy = y[index + 1]
        val inX = bx - ax
        val inY = by - ay
        val outX = cx - bx
        val outY = cy - by
        val inLen = hypot(inX, inY)
        val outLen = hypot(outX, outY)
        if (inLen < 0.01 || outLen < 0.01) {
            commands += MarkerCommand.Line(bx, by)
            cursorX = bx
            cursorY = by
            continue
        }
        val dot = ((inX * outX + inY * outY) / (inLen * outLen)).coerceIn(-1.0, 1.0)
        val turn = acos(dot)
        val sinHalf = sin(turn / 2.0)
        var trim = 0.0
        if (sinHalf > 0.02) {
            val maxByNib = (1.7 * radius) / sinHalf
            val maxByLeg = 0.45 * min(inLen, outLen)
            trim = min(maxByNib, maxByLeg) * smooth
        }
        if (trim < 0.75) {
            commands += MarkerCommand.Line(bx, by)
            cursorX = bx
            cursorY = by
            continue
        }
        val startX = bx - (inX / inLen) * trim
        val startY = by - (inY / inLen) * trim
        val endX = bx + (outX / outLen) * trim
        val endY = by + (outY / outLen) * trim
        if (hypot(startX - cursorX, startY - cursorY) > 0.4) commands += MarkerCommand.Line(startX, startY)
        commands += MarkerCommand.Quad(bx, by, endX, endY)
        cursorX = endX
        cursorY = endY
    }
    commands += MarkerCommand.Line(x[to], y[to])
    return commands
}

/** Slant of the desktop broad nib, −0.22π. */
const val CALLIGRAPHY_ANGLE = -Math.PI * 0.22

data class CalligraphyOffset(val x: Double, val y: Double)

/** Half-nib offset in page pixels. */
fun calligraphyNibOffset(nibWidth: Double): CalligraphyOffset {
    val half = nibWidth / 2.0
    return CalligraphyOffset(cos(CALLIGRAPHY_ANGLE) * half, sin(CALLIGRAPHY_ANGLE) * half)
}

/** Dot radii: full nib across, 16% along the slant, at least half a pixel. */
fun calligraphyDotRadii(nibWidth: Double): Pair<Double, Double> =
    nibWidth / 2.0 to max(0.5, nibWidth * 0.16)

/**
 * One pencil-grain segment in page pixels. Desktop `paintPassSegments` strokes
 * each sample on its own, shifted by `passOffset`.
 */
data class GrainSegment(
    val startX: Double,
    val startY: Double,
    val controlX: Double?,
    val controlY: Double?,
    val endX: Double,
    val endY: Double,
    val width: Double,
)

/**
 * How far an interior segment slides its end toward the next midpoint.
 * Matches `inkInteriorPull` in `inkStrokePaint.ts`. The open tip is a line.
 */
fun interiorSegmentPull(smoothing: Double, legPx: Double, nibPx: Double): Double {
    val wanted = smoothing.coerceIn(0.0, 1.0) * 0.85
    if (legPx <= 0.01 || nibPx <= 0.0) return wanted
    return min(wanted, (nibPx * 0.35) / legPx)
}

/** Full pen width in page pixels, the nib the centerline is allowed to leave. */
private fun pageNib(baseWidth: Double, pressure: Double, pressureEnabled: Boolean, scale: Double): Double {
    if (scale <= 0.0) return 0.0
    return max(1.0, pressureWidth(baseWidth, pressure, pressureEnabled) * scale) / scale
}

/** Per-segment grain shift in page pixels. Seed matches `passOffset` in `inkStrokePaint.ts`. */
fun pencilJitterOffset(textureSeed: Int, segmentIndex: Int, passIndex: Int, jitter: Double): Pair<Double, Double> {
    if (jitter == 0.0) return 0.0 to 0.0
    val seed = textureSeed + segmentIndex * 53 + (passIndex - 1) * 2
    return (seededUnit(seed) - 0.5) * jitter to (seededUnit(seed + 1) - 0.5) * jitter
}

fun pencilGrainSegments(
    points: List<StrokePoint>,
    pageWidth: Double,
    pageHeight: Double,
    smoothing: Double,
    baseWidth: Double,
    pressureEnabled: Boolean,
    widthFactor: Double,
    textureSeed: Int,
    passIndex: Int,
    jitter: Double,
    scale: Double,
): List<GrainSegment> {
    if (points.size < 2 || scale <= 0.0) return emptyList()
    val segments = ArrayList<GrainSegment>(points.size - 1)
    var chainX = points[0].x * pageWidth
    var chainY = points[0].y * pageHeight
    for (index in 1 until points.size) {
        val (offsetX, offsetY) = pencilJitterOffset(textureSeed, index, passIndex, jitter)
        val previous = points[index - 1]
        val point = points[index]
        val pointX = point.x * pageWidth
        val pointY = point.y * pageHeight
        val pressure = ((previous.pressure) + point.pressure) / 2.0
        val width = max(1.0, pressureWidth(baseWidth, pressure, pressureEnabled) * scale) * widthFactor / scale
        val startX = chainX + offsetX
        val startY = chainY + offsetY
        var endX = pointX
        var endY = pointY
        var controlX: Double? = null
        var controlY: Double? = null
        if (smoothing > 0.0 && index < points.lastIndex) {
            val next = points[index + 1]
            val nextX = next.x * pageWidth
            val nextY = next.y * pageHeight
            val leg = hypot(nextX - pointX, nextY - pointY)
            val nib = min(
                pageNib(baseWidth, pressure, pressureEnabled, scale),
                pageNib(baseWidth, (point.pressure + next.pressure) / 2.0, pressureEnabled, scale),
            )
            val pull = interiorSegmentPull(smoothing, leg, nib)
            endX = pointX + (nextX - pointX) * pull * 0.5
            endY = pointY + (nextY - pointY) * pull * 0.5
            if (hypot(endX - pointX, endY - pointY) > 0.15) {
                controlX = pointX + offsetX
                controlY = pointY + offsetY
            } else {
                endX = pointX
                endY = pointY
            }
        }
        segments += GrainSegment(startX, startY, controlX, controlY, endX + offsetX, endY + offsetY, width)
        chainX = endX
        chainY = endY
    }
    return segments
}

/** One command of a constant-width stroke. Coordinates are page pixels. */
sealed class StrokeCommand {
    data class Move(val x: Double, val y: Double) : StrokeCommand()
    data class Line(val x: Double, val y: Double) : StrokeCommand()
    data class Quad(val cx: Double, val cy: Double, val x: Double, val y: Double) : StrokeCommand()
}

data class ConstantStroke(val width: Double, val commands: List<StrokeCommand>)

/**
 * One joined path for a brush with pressure off. A tiny pen-up stub at the end
 * is left out, matching `paintPassPath` in `inkStrokePaint.ts`.
 */
fun constantWidthStroke(
    points: List<StrokePoint>,
    pageWidth: Double,
    pageHeight: Double,
    smoothing: Double,
    baseWidth: Double,
    pressureEnabled: Boolean,
    widthFactor: Double,
    scale: Double,
): ConstantStroke? {
    if (points.size < 2 || scale <= 0.0) return null
    val width = segmentBitmapWidth(points[0], points[1], baseWidth, pressureEnabled, widthFactor, scale) / scale
    var end = points.size
    if (end - 1 > 1) {
        val last = points[end - 1]
        val before = points[end - 2]
        val stub = hypot((last.x - before.x) * pageWidth, (last.y - before.y) * pageHeight)
        if (stub < width * 0.3) end -= 1
    }
    if (end <= 1) return null
    val commands = ArrayList<StrokeCommand>()
    for (index in 1 until end) {
        val previous = points[index - 1]
        val point = points[index]
        val previousX = previous.x * pageWidth
        val previousY = previous.y * pageHeight
        val pointX = point.x * pageWidth
        val pointY = point.y * pageHeight
        if (index == 1) commands += StrokeCommand.Move(previousX, previousY)
        if (smoothing > 0.0 && index < end - 1) {
            val next = points[index + 1]
            val nextX = next.x * pageWidth
            val nextY = next.y * pageHeight
            val leg = hypot(nextX - pointX, nextY - pointY)
            val nib = min(
                pageNib(baseWidth, (previous.pressure + point.pressure) / 2.0, pressureEnabled, scale),
                pageNib(baseWidth, (point.pressure + next.pressure) / 2.0, pressureEnabled, scale),
            )
            val pull = interiorSegmentPull(smoothing, leg, nib)
            if (pull > 1.0e-4) {
                val midX = (pointX + nextX) / 2.0
                val midY = (pointY + nextY) / 2.0
                commands += StrokeCommand.Quad(pointX, pointY, pointX + (midX - pointX) * pull, pointY + (midY - pointY) * pull)
                continue
            }
        }
        commands += StrokeCommand.Line(pointX, pointY)
    }
    return ConstantStroke(width, commands)
}

/** Filled-dot radius in page pixels for a one-sample stroke. */
fun strokeDotRadius(baseWidth: Double, pressure: Double, pressureEnabled: Boolean, scale: Double): Double {
    if (scale <= 0.0) return 0.0
    return max(1.0, pressureWidth(baseWidth, pressure, pressureEnabled) * scale) / 2.0 / scale
}

private fun segmentBitmapWidth(
    previous: StrokePoint,
    point: StrokePoint,
    baseWidth: Double,
    pressureEnabled: Boolean,
    widthFactor: Double,
    scale: Double,
): Double {
    val pressure = (previous.pressure + point.pressure) / 2.0
    return max(1.0, pressureWidth(baseWidth, pressure, pressureEnabled) * scale) * widthFactor
}
