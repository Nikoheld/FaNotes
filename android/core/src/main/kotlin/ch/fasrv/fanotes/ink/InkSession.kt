package ch.fasrv.fanotes.ink

import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/** Corridor filter from `inkSampleMap.ts`. A leap is not a real stroke. */
const val INK_JUMP_DY = 0.08
const val INK_JUMP_HYPOT = 0.12
const val INK_FIRST_POINT_RESTART_Y = 0.05

fun isInkCorridorLeap(previous: StrokePoint?, next: StrokePoint): Boolean {
    if (previous == null) return false
    if (previous.y >= INK_FIRST_POINT_RESTART_Y && next.y < INK_FIRST_POINT_RESTART_Y) return true
    if (previous.x >= 0.5 && next.x >= 0.45 && next.y < INK_FIRST_POINT_RESTART_Y && previous.y >= 0.08) return true
    val dy = abs(next.y - previous.y)
    return dy > INK_JUMP_DY || hypot(next.x - previous.x, next.y - previous.y) > INK_JUMP_HYPOT
}

enum class InkTool { PEN, ERASER, SELECT }

data class NormalizedRect(val x: Double, val y: Double, val width: Double, val height: Double) {
    val right get() = x + width
    val bottom get() = y + height
}

/**
 * Editable ink page. Undo stores the stroke list before each gesture.
 * Coordinates stay 0–1 of [InkDocument.sourceWidth] × [InkDocument.sourceHeight].
 */
class InkSession(document: InkDocument) {
    var document: InkDocument = document
        private set
    var livePoints: List<StrokePoint> = emptyList()
        private set
    var selection: Set<Int> = emptySet()
        private set
    private val undo = ArrayDeque<List<InkStroke>>()
    private val redo = ArrayDeque<List<InkStroke>>()
    private var eraseCheckpoint = false
    val canUndo get() = undo.isNotEmpty()
    val canRedo get() = redo.isNotEmpty()

    fun replace(next: InkDocument) {
        document = next
        livePoints = emptyList()
        selection = emptySet()
        undo.clear()
        redo.clear()
        eraseCheckpoint = false
    }

    fun beginStroke() {
        livePoints = emptyList()
    }

    /**
     * Adds a sample in the current 0–1 space. Returns false when the sample
     * is a corridor leap and was dropped.
     */
    fun addSample(point: StrokePoint): Boolean {
        val pageX = point.x * document.sourceWidth
        val pageY = point.y * document.sourceHeight
        val (grown, _) = growDocument(document, pageX, pageY)
        if (grown !== document) {
            val scaleX = document.sourceWidth / grown.sourceWidth
            val scaleY = document.sourceHeight / grown.sourceHeight
            document = grown
            livePoints = rescalePoints(livePoints, scaleX, scaleY)
        }
        val mapped = point.copy(
            x = pageX / document.sourceWidth,
            y = pageY / document.sourceHeight,
            pressure = point.pressure.coerceIn(0.0, 1.0),
        )
        val action = classify(livePoints, mapped)
        livePoints = when (action) {
            "start", "append" -> livePoints + mapped
            "restart" -> listOf(mapped)
            else -> return false
        }
        return true
    }

    fun endStroke(style: StrokeStyle, now: String): InkStroke? {
        val points = livePoints
        livePoints = emptyList()
        if (points.isEmpty()) return null
        val stroke = InkStroke(
            points = points,
            baseWidth = style.baseWidth,
            pressureEnabled = style.pressureEnabled,
            color = style.color,
            purpose = "handwriting",
            brush = style.brush,
            opacity = style.opacity ?: brushOpacity(style.brush) ?: 1.0,
            colorEffect = style.colorEffect,
        )
        pushUndo()
        document = document.copy(strokes = document.strokes + stroke, updatedAt = now)
        return stroke
    }

    fun cancelStroke() {
        livePoints = emptyList()
    }

    /** Marks an eraser gesture so every sample shares one undo step. */
    fun beginErase() {
        eraseCheckpoint = false
    }

    fun endErase() {
        eraseCheckpoint = false
    }

    /** Object eraser: drops or splits strokes the nib passes through. */
    fun erase(samples: List<StrokePoint>, radiusPagePx: Double, now: String): Boolean {
        beginErase()
        val changed = eraseSamples(samples, radiusPagePx, now)
        endErase()
        return changed
    }

    fun eraseSamples(samples: List<StrokePoint>, radiusPagePx: Double, now: String): Boolean {
        if (samples.isEmpty() || radiusPagePx <= 0) return false
        val width = document.sourceWidth
        val height = document.sourceHeight
        var changed = false
        val next = mutableListOf<InkStroke>()
        for (stroke in document.strokes) {
            val pieces = splitStroke(stroke, samples, radiusPagePx, width, height)
            if (pieces == null) next += stroke
            else {
                changed = true
                next += pieces
            }
        }
        if (!changed) return false
        if (!eraseCheckpoint) {
            pushUndo()
            eraseCheckpoint = true
        }
        selection = emptySet()
        document = document.copy(strokes = next, updatedAt = now)
        return true
    }

    fun selectRect(rect: NormalizedRect) {
        if (rect.width <= 0 || rect.height <= 0) {
            selection = emptySet()
            return
        }
        selection = document.strokes.mapIndexedNotNull { index, stroke ->
            if (strokeHitsRect(stroke, rect)) index else null
        }.toSet()
    }

    fun selectAt(x: Double, y: Double, slop: Double) {
        val hit = document.strokes.indexOfLast { stroke ->
            stroke.points.any { point -> hypot(point.x - x, point.y - y) <= slop }
        }
        selection = if (hit >= 0) setOf(hit) else emptySet()
    }

    fun moveSelection(dx: Double, dy: Double, now: String) {
        if (selection.isEmpty() || (dx == 0.0 && dy == 0.0)) return
        pushUndo()
        document = document.copy(
            strokes = document.strokes.mapIndexed { index, stroke ->
                if (index !in selection) stroke
                else stroke.copy(points = stroke.points.map { it.copy(x = it.x + dx, y = it.y + dy) })
            },
            updatedAt = now,
        )
    }

    fun deleteSelection(now: String) {
        if (selection.isEmpty()) return
        pushUndo()
        document = document.copy(
            strokes = document.strokes.filterIndexed { index, _ -> index !in selection },
            updatedAt = now,
        )
        selection = emptySet()
    }

    fun clearSelection() {
        selection = emptySet()
    }

    fun setPaperStyle(style: String, now: String) {
        document = document.copy(paperStyle = style, updatedAt = now)
    }

    fun undo(): Boolean {
        val previous = undo.removeLastOrNull() ?: return false
        redo.addLast(document.strokes)
        document = document.copy(strokes = previous)
        selection = emptySet()
        return true
    }

    fun redo(): Boolean {
        val next = redo.removeLastOrNull() ?: return false
        undo.addLast(document.strokes)
        document = document.copy(strokes = next)
        selection = emptySet()
        return true
    }

    private fun pushUndo() {
        undo.addLast(document.strokes)
        if (undo.size > 100) undo.removeFirst()
        redo.clear()
    }

    private fun classify(points: List<StrokePoint>, next: StrokePoint): String {
        val previous = points.lastOrNull() ?: return "start"
        if (!isInkCorridorLeap(previous, next)) return "append"
        if (points.size == 1 && previous.y < INK_FIRST_POINT_RESTART_Y) return "restart"
        return "skip"
    }
}

data class StrokeStyle(
    val color: String = DEFAULT_PEN_COLOR,
    val baseWidth: Double = DEFAULT_PEN_WIDTH,
    val pressureEnabled: Boolean = true,
    val brush: String = "fineliner",
    val opacity: Double? = null,
    val colorEffect: String = "solid",
)

fun brushOpacity(brush: String?): Double? = when (brush) {
    "pencil" -> 0.85
    "marker" -> 0.55
    "highlighter" -> 0.35
    "watercolor" -> 0.45
    else -> null
}

fun brushWidthScale(brush: String?): Double = when (brush) {
    "pencil" -> 0.85
    "marker" -> 1.7
    "highlighter" -> 3.4
    "calligraphy" -> 1.15
    "paintbrush" -> 1.35
    else -> 1.0
}

private fun strokeHitsRect(stroke: InkStroke, rect: NormalizedRect): Boolean =
    stroke.points.any { it.x >= rect.x && it.x <= rect.right && it.y >= rect.y && it.y <= rect.bottom }

/**
 * Returns null when the stroke is untouched, or the remaining pieces
 * (possibly empty) when the eraser crossed it.
 */
fun splitStroke(
    stroke: InkStroke,
    samples: List<StrokePoint>,
    radiusPagePx: Double,
    sourceWidth: Double,
    sourceHeight: Double,
): List<InkStroke>? {
    val hit = stroke.points.map { point ->
        val px = point.x * sourceWidth
        val py = point.y * sourceHeight
        samples.any { sample ->
            hypot(px - sample.x * sourceWidth, py - sample.y * sourceHeight) <= radiusPagePx
        }
    }
    if (hit.none { it }) return null
    val pieces = mutableListOf<InkStroke>()
    val current = mutableListOf<StrokePoint>()
    stroke.points.forEachIndexed { index, point ->
        if (hit[index]) {
            if (current.size >= 1) pieces += stroke.copy(points = current.toList())
            current.clear()
        } else {
            current += point
        }
    }
    if (current.isNotEmpty()) pieces += stroke.copy(points = current.toList())
    return pieces
}

/**
 * Closed outline of a pressure-sensitive ribbon, in page pixels.
 * A one-point stroke is a circle. Calligraphy widens across the stroke direction.
 */
fun ribbonOutline(
    stroke: InkStroke,
    sourceWidth: Double,
    sourceHeight: Double,
): FloatArray {
    val scale = brushWidthScale(stroke.brush)
    val widths = stroke.points.map { point ->
        var width = pressureWidth(stroke.baseWidth, point.pressure, stroke.pressureEnabled) * scale
        if (stroke.brush == "calligraphy" && stroke.points.size > 1) {
            width *= 0.45 + abs(kotlin.math.sin(directionOf(stroke.points, point)))
        }
        width.toFloat()
    }
    if (stroke.points.size == 1) {
        return circle(stroke.points[0], widths[0], sourceWidth, sourceHeight)
    }
    val leftX = FloatArray(stroke.points.size)
    val leftY = FloatArray(stroke.points.size)
    val rightX = FloatArray(stroke.points.size)
    val rightY = FloatArray(stroke.points.size)
    for (index in stroke.points.indices) {
        val point = stroke.points[index]
        val (rawDx, rawDy) = tangent(stroke.points, index)
        val dx = rawDx.toFloat()
        val dy = rawDy.toFloat()
        val length = hypot(dx, dy).coerceAtLeast(0.0001f)
        val nx = -dy / length
        val ny = dx / length
        val half = widths[index] / 2f
        val x = (point.x * sourceWidth).toFloat()
        val y = (point.y * sourceHeight).toFloat()
        leftX[index] = x + nx * half
        leftY[index] = y + ny * half
        rightX[index] = x - nx * half
        rightY[index] = y - ny * half
    }
    val count = stroke.points.size * 2
    val outline = FloatArray(count * 2)
    var cursor = 0
    for (index in stroke.points.indices) {
        outline[cursor++] = leftX[index]
        outline[cursor++] = leftY[index]
    }
    for (index in stroke.points.indices.reversed()) {
        outline[cursor++] = rightX[index]
        outline[cursor++] = rightY[index]
    }
    return outline
}

private fun directionOf(points: List<StrokePoint>, point: StrokePoint): Double {
    val index = points.indexOf(point).coerceAtLeast(0)
    val (dx, dy) = tangent(points, index)
    return kotlin.math.atan2(dy, dx)
}

private fun tangent(points: List<StrokePoint>, index: Int): Pair<Double, Double> {
    val previous = points[max(0, index - 1)]
    val next = points[min(points.lastIndex, index + 1)]
    return (next.x - previous.x) to (next.y - previous.y)
}

private fun circle(point: StrokePoint, width: Float, sourceWidth: Double, sourceHeight: Double): FloatArray {
    val cx = (point.x * sourceWidth).toFloat()
    val cy = (point.y * sourceHeight).toFloat()
    val radius = width / 2f
    val steps = 12
    val outline = FloatArray(steps * 2)
    for (step in 0 until steps) {
        val angle = (Math.PI * 2 * step / steps).toFloat()
        outline[step * 2] = cx + kotlin.math.cos(angle) * radius
        outline[step * 2 + 1] = cy + kotlin.math.sin(angle) * radius
    }
    return outline
}

/** Bounds of an outline in page pixels: left, top, right, bottom. */
fun outlineBounds(outline: FloatArray): FloatArray {
    var left = Float.POSITIVE_INFINITY
    var top = Float.POSITIVE_INFINITY
    var right = Float.NEGATIVE_INFINITY
    var bottom = Float.NEGATIVE_INFINITY
    var index = 0
    while (index < outline.size) {
        val x = outline[index]
        val y = outline[index + 1]
        if (x < left) left = x
        if (y < top) top = y
        if (x > right) right = x
        if (y > bottom) bottom = y
        index += 2
    }
    return floatArrayOf(left, top, right, bottom)
}
