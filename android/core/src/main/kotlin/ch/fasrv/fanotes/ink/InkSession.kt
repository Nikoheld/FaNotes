package ch.fasrv.fanotes.ink

import ch.fasrv.fanotes.desk.formatTranscriptLine
import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.deepCopy
import ch.fasrv.fanotes.json.jsonString
import ch.fasrv.fanotes.recognition.recognizeSchoolScript
import java.util.Locale
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.round
import kotlin.math.sqrt

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

/** [LASER] points without inking (desktop `laser` tool). */
enum class InkTool { PEN, ERASER, SELECT, LASSO, LASER }

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
    /**
     * The stroke under the pen. Appending a sample adds to one buffer instead of copying every sample before it.
     * A list read from [livePoints] keeps growing while the stroke goes on (copy it for a snapshot); a restart,
     * snap, regrow or the end of the stroke starts a fresh buffer, so the committed stroke's list never changes.
     */
    private var liveBuffer = ArrayList<StrokePoint>()
    val livePoints: List<StrokePoint> get() = liveBuffer
    var selection: Set<Int> = emptySet()
        private set
    private val undo = ArrayDeque<List<InkStroke>>()
    private val redo = ArrayDeque<List<InkStroke>>()
    private var eraseCheckpoint = false
    /** Where the previous [eraseSamples] call of this gesture ended; see [eraserSweep]. */
    private var eraseCarry: EraserCarry? = null
    /**
     * Box [left, top, right, bottom] in page px that the ink changed by the latest [eraseSamples] call lies in,
     * for repainting the tiles under it. Only meaningful right after a call that returned true; null before the first.
     */
    var erasedBounds: DoubleArray? = null
        private set
    val canUndo get() = undo.isNotEmpty()
    val canRedo get() = redo.isNotEmpty()

    fun replace(next: InkDocument) {
        document = next
        liveBuffer = ArrayList()
        selection = emptySet()
        undo.clear()
        redo.clear()
        eraseCheckpoint = false
        eraseCarry = null
    }

    fun beginStroke() {
        liveBuffer = ArrayList()
    }

    /** Replaces the stroke still under the pen, used when a figure snaps clean. */
    fun replaceLive(points: List<StrokePoint>) {
        liveBuffer = ArrayList(points)
    }

    /**
     * Adds a sample in the current 0–1 space. Returns false when the sample
     * is a corridor leap and was dropped.
     */
    fun addSample(point: StrokePoint): Boolean {
        val prevWidth = document.sourceWidth
        val prevHeight = document.sourceHeight
        val pageX = point.x * prevWidth
        val pageY = point.y * prevHeight
        val grown = growDocument(document, pageX, pageY)
        if (grown.document !== document) {
            remapHistory(prevWidth, prevHeight, grown.document.sourceWidth, grown.document.sourceHeight, grown.padX, grown.padY)
            liveBuffer = liveBuffer.mapTo(ArrayList(liveBuffer.size + 64)) { sample ->
                sample.copy(
                    x = keepMarkOnPage(sample.x, prevWidth, grown.document.sourceWidth, grown.padX),
                    y = keepMarkOnPage(sample.y, prevHeight, grown.document.sourceHeight, grown.padY),
                )
            }
            document = grown.document
        }
        val mapped = point.copy(
            x = keepMarkOnPage(point.x, prevWidth, document.sourceWidth, grown.padX),
            y = keepMarkOnPage(point.y, prevHeight, document.sourceHeight, grown.padY),
            pressure = point.pressure.coerceIn(0.0, 1.0),
        )
        val action = classify(livePoints, mapped)
        when (action) {
            "start", "append" -> liveBuffer.add(mapped)
            "restart" -> liveBuffer = arrayListOf(mapped)
            else -> return false
        }
        return true
    }

    /**
     * Places synthesized handwriting in one undo step. Existing ink stays on
     * the same page pixels when the sheet has to grow.
     */
    fun insertSynthesized(result: HandwritingSynthesisResult, now: String): Boolean {
        if (result.strokes.isEmpty()) return false
        val prevWidth = document.sourceWidth
        val prevHeight = document.sourceHeight
        val extended = extendPage(document, result.pageWidth, result.pageHeight)
        remapHistory(prevWidth, prevHeight, extended.sourceWidth, extended.sourceHeight, 0.0, 0.0)
        document = extended
        val scaleX = if (extended.sourceWidth > 0.0) result.pageWidth / extended.sourceWidth else 1.0
        val scaleY = if (extended.sourceHeight > 0.0) result.pageHeight / extended.sourceHeight else 1.0
        val placed = result.strokes.map { stroke ->
            stroke.copy(points = stroke.points.map { point ->
                point.copy(
                    x = (point.x * scaleX).coerceIn(0.0, 1.0),
                    y = (point.y * scaleY).coerceIn(0.0, 1.0),
                )
            })
        }
        val anchorY = placed.flatMap { it.points }.minOfOrNull { it.y } ?: 0.0
        val extras = extended.extras.deepCopy() as JsonValue.Obj
        val previous = extras.string("searchTranscript").orEmpty().trim()
        val line = formatTranscriptLine(anchorY, result.normalizedText)
        val transcript = listOf(previous, line).filter { it.isNotEmpty() }.joinToString("\n")
        extras.put("searchTranscript", jsonString(transcript))
        pushUndo()
        document = extended.copy(strokes = extended.strokes + placed, extras = extras, updatedAt = now)
        return true
    }

    /** A constructed shape (compass circle, arc) bypasses the pointer corridor filter. */
    fun commitShape(points: List<StrokePoint>, style: StrokeStyle, now: String): InkStroke? {
        if (points.size < 2) return null
        val width0 = document.sourceWidth
        val height0 = document.sourceHeight
        val originX0 = document.originX
        val originY0 = document.originY
        var doc = document
        for (point in points) {
            val normX = keepMarkOnPage(point.x, width0, doc.sourceWidth, doc.originX - originX0)
            val normY = keepMarkOnPage(point.y, height0, doc.sourceHeight, doc.originY - originY0)
            doc = growDocument(doc, normX * doc.sourceWidth, normY * doc.sourceHeight).document
        }
        val mapped = points.map { point ->
            point.copy(
                x = keepMarkOnPage(point.x, width0, doc.sourceWidth, doc.originX - originX0),
                y = keepMarkOnPage(point.y, height0, doc.sourceHeight, doc.originY - originY0),
                pressure = point.pressure.coerceIn(0.0, 1.0),
            )
        }
        val stroke = InkStroke(
            points = mapped,
            baseWidth = style.baseWidth,
            pressureEnabled = style.pressureEnabled,
            color = style.color,
            purpose = style.purpose,
            brush = style.brush,
            opacity = style.opacity ?: brushOpacity(style.brush) ?: 1.0,
            colorEffect = style.colorEffect,
        )
        remapHistory(width0, height0, doc.sourceWidth, doc.sourceHeight, doc.originX - originX0, doc.originY - originY0)
        document = doc
        pushUndo()
        document = doc.copy(strokes = doc.strokes + stroke, updatedAt = now)
        return stroke
    }

    fun placeSymbol(
        x: Double,
        y: Double,
        style: StrokeStyle,
        symbolId: String,
        now: String,
        size: Double = ART_SYMBOL_SIZE,
        rotation: Double = 0.0,
        opacity: Double = 1.0,
    ): InkStroke? {
        if (artSymbol(symbolId) == null) return null
        val stroke = InkStroke(
            points = listOf(StrokePoint(x, y, 0.0, 0.5, 0.0, 0.0, "pen")),
            baseWidth = snapArtSymbolSize(size),
            pressureEnabled = false,
            color = style.color,
            purpose = "art",
            brush = "fineliner",
            opacity = snapArtSymbolOpacity(opacity),
            colorEffect = style.colorEffect,
            symbolId = symbolId,
            symbolRotation = snapArtSymbolRotation(rotation),
        )
        pushUndo()
        document = document.copy(strokes = document.strokes + stroke, updatedAt = now)
        return stroke
    }

    /** Adds a finished stamp (math figure, function graph) as one undo step. */
    fun placeStamp(stroke: InkStroke, now: String): InkStroke {
        pushUndo()
        document = document.copy(strokes = document.strokes + stroke, updatedAt = now)
        return stroke
    }

    fun endStroke(style: StrokeStyle, now: String): InkStroke? {
        val points = liveBuffer
        liveBuffer = ArrayList()
        if (points.isEmpty()) return null
        points.trimToSize()
        val stroke = InkStroke(
            points = points,
            baseWidth = style.baseWidth,
            pressureEnabled = style.pressureEnabled,
            color = style.color,
            purpose = style.purpose,
            brush = style.brush,
            opacity = style.opacity ?: brushOpacity(style.brush) ?: 1.0,
            colorEffect = style.colorEffect,
        )
        pushUndo()
        document = document.copy(strokes = document.strokes + stroke, updatedAt = now)
        appendRecognizedTranscript(document.strokes, recognizeSchoolScript(document.strokes))
        return stroke
    }

    /** Commits one handwriting gesture. Readable school-script words join the search transcript. */
    fun commitHandwriting(strokes: List<InkStroke>, now: String): String {
        if (strokes.isEmpty()) return ""
        val recognized = recognizeSchoolScript(strokes)
        pushUndo()
        document = document.copy(strokes = document.strokes + strokes, updatedAt = now)
        appendRecognizedTranscript(strokes, recognized)
        return recognized
    }

    fun cancelStroke() {
        liveBuffer = ArrayList()
    }

    /** Marks an eraser gesture so every sample shares one undo step. */
    fun beginErase() {
        eraseCheckpoint = false
        eraseCarry = null
    }

    fun endErase() {
        eraseCheckpoint = false
        eraseCarry = null
    }

    /** Object eraser: drops or splits strokes the nib passes through. */
    /** Drops the strokes a scribble covered. One undo step restores them. */
    fun dropStrokes(indexes: Set<Int>, now: String): Boolean {
        if (indexes.isEmpty() || indexes.none { it in document.strokes.indices }) return false
        pushUndo()
        document = document.copy(
            strokes = document.strokes.filterIndexed { index, _ -> index !in indexes },
            updatedAt = now,
        )
        selection = emptySet()
        return true
    }

    fun erase(samples: List<StrokePoint>, radiusPagePx: Double, now: String): Boolean {
        beginErase()
        val changed = eraseSamples(samples, radiusPagePx, now)
        endErase()
        return changed
    }

    /**
     * One frame of an eraser gesture. The nib is swept from where the previous call of the gesture ended
     * through [samples], so the stretch between two frames is erased too. Strokes whose box cannot reach the
     * swept box are skipped without being walked; [splitStroke] decides where the others are cut.
     */
    fun eraseSamples(samples: List<StrokePoint>, radiusPagePx: Double, now: String): Boolean {
        if (samples.isEmpty() || radiusPagePx <= 0) return false
        val width = document.sourceWidth
        val height = document.sourceHeight
        val path = eraserSweep(eraseCarry, samples, width, height)
        eraseCarry = eraserCarryOf(samples, width, height) ?: eraseCarry
        val sweep = sweepBounds(path, width, height) ?: return false
        val strokes = document.strokes
        // The new list is only built once a stroke is actually cut; a frame that touches nothing allocates nothing.
        var next: MutableList<InkStroke>? = null
        var widest = 0.0
        for (index in strokes.indices) {
            val stroke = strokes[index]
            val pieces = if (strokeMayBeTouched(stroke, sweep, radiusPagePx, width, height)) {
                splitStroke(stroke, path, radiusPagePx, width, height)
            } else {
                null
            }
            if (pieces == null) {
                next?.add(stroke)
                continue
            }
            if (next == null) next = ArrayList<InkStroke>(strokes.size + pieces.size).also { it.addAll(strokes.subList(0, index)) }
            widest = max(widest, maxRibbonHalfWidth(stroke))
            next.addAll(pieces)
        }
        if (next == null) return false
        if (!eraseCheckpoint) {
            pushUndo()
            eraseCheckpoint = true
        }
        selection = emptySet()
        document = document.copy(strokes = next, updatedAt = now)
        erasedBounds = erasedBox(sweep, radiusPagePx, widest)
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

    fun selectIndices(indices: Set<Int>) {
        selection = indices
    }

    /** Delete, nudge, copy, or recolor the current selection as one undo step. */
    fun commitLasso(action: String, now: String, color: String): Boolean {
        if (selection.isEmpty() || action !in setOf("delete", "move", "copy", "recolor")) return false
        pushUndo()
        document = document.copy(
            strokes = applyLasso(document.strokes, selection, action, color = color),
            updatedAt = now,
        )
        if (action == "delete" || action == "copy") selection = emptySet()
        return true
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

    fun duplicateSelection(now: String) {
        if (selection.isEmpty()) return
        pushUndo()
        val copies = document.strokes.mapIndexedNotNull { index, stroke ->
            if (index !in selection) null
            else stroke.copy(points = stroke.points.map { it.copy(x = (it.x + 0.03).coerceAtMost(0.98), y = (it.y + 0.03).coerceAtMost(0.98)) })
        }
        document = document.copy(strokes = document.strokes + copies, updatedAt = now)
    }

    fun clearInk(now: String) {
        if (document.strokes.isEmpty()) return
        pushUndo()
        document = document.copy(strokes = emptyList(), updatedAt = now)
        selection = emptySet()
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
        eraseCarry = null
        return true
    }

    fun redo(): Boolean {
        val next = redo.removeLastOrNull() ?: return false
        undo.addLast(document.strokes)
        document = document.copy(strokes = next)
        selection = emptySet()
        eraseCarry = null
        return true
    }

    private fun pushUndo() {
        undo.addLast(document.strokes)
        if (undo.size > 100) undo.removeFirst()
        redo.clear()
    }

    /**
     * Replaces the invisible search transcript (model recognition after a save). Strokes, undo and
     * redo stay as they are; returns false when nothing changed.
     */
    fun setSearchTranscript(transcript: String): Boolean {
        if (document.extras.string("searchTranscript").orEmpty() == transcript) return false
        val extras = document.extras.deepCopy() as JsonValue.Obj
        extras.put("searchTranscript", jsonString(transcript))
        document = document.copy(extras = extras)
        return true
    }

    /** Keeps an unreadable stroke, and does not repeat a line already stored. */
    private fun appendRecognizedTranscript(strokes: List<InkStroke>, recognized: String) {
        if (recognized.count { it.isLetterOrDigit() } < 2) return
        val extras = document.extras.deepCopy() as JsonValue.Obj
        val previous = extras.string("searchTranscript").orEmpty()
        val folded = recognized.lowercase(Locale.GERMAN)
        val bodies = previous.split('\n').map { line ->
            line.substringAfter('\t', line).trim().lowercase(Locale.GERMAN)
        }
        if (bodies.any { it == folded }) return
        val anchorY = strokes.flatMap { it.points }.minOfOrNull { it.y } ?: 0.0
        val line = formatTranscriptLine(anchorY, recognized)
        val transcript = listOf(previous.trim(), line).filter { it.isNotEmpty() }.joinToString("\n")
        extras.put("searchTranscript", jsonString(transcript))
        document = document.copy(extras = extras)
    }

    /** Older undo snapshots use the page size from when they were stored. */
    private fun remapHistory(prevWidth: Double, prevHeight: Double, nextWidth: Double, nextHeight: Double, padX: Double, padY: Double) {
        if (abs(nextWidth - prevWidth) < STAY_PUT_PAD_EPSILON && abs(nextHeight - prevHeight) < STAY_PUT_PAD_EPSILON && padX == 0.0 && padY == 0.0) return
        fun remap(strokes: List<InkStroke>) = strokes.map { stroke ->
            stroke.copy(points = stroke.points.map { point ->
                point.copy(
                    x = keepMarkOnPage(point.x, prevWidth, nextWidth, padX),
                    y = keepMarkOnPage(point.y, prevHeight, nextHeight, padY),
                )
            })
        }
        val nextUndo = undo.map { remap(it) }
        val nextRedo = redo.map { remap(it) }
        undo.clear()
        undo.addAll(nextUndo)
        redo.clear()
        redo.addAll(nextRedo)
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
    /** "art" for the drawing mode (Zeichnen), so recognition and search skip it like on the desktop. */
    val purpose: String = "handwriting",
)

fun brushOpacity(brush: String?): Double? = when (brush) {
    "pencil" -> 0.85
    "marker" -> 0.55
    "highlighter" -> 0.35
    "watercolor" -> 0.45
    "spray" -> 0.7
    else -> null
}

fun brushWidthScale(brush: String?): Double = when (brush) {
    "pencil" -> 0.85
    "marker" -> 1.7
    "highlighter" -> 3.4
    "calligraphy" -> 1.15
    "paintbrush" -> 1.35
    "watercolor" -> 1.2
    "spray" -> 1.6
    else -> 1.0
}

private fun strokeHitsRect(stroke: InkStroke, rect: NormalizedRect): Boolean =
    stroke.points.any { it.x >= rect.x && it.x <= rect.right && it.y >= rect.y && it.y <= rect.bottom }

/*
 * Erasing. The eraser is a disk swept along the samples of one gesture, and a
 * stroke's ink is its centre line thickened by half the stroke width. So a
 * point of a stroke is erased when it lies within `reach` (eraser radius plus
 * half the stroke width) of the eraser path. The cut is closed-form geometry,
 * the same as `cutPageStroke` in `inkPieces.ts` on the desktop: the circle and
 * slab intersections are solved on each stroke segment, so cut points sit
 * exactly on the rim of the eraser however sparse the stroke is, and a sweep
 * that crosses a long segment between two vertices still cuts it.
 */

/** Rounding level: squared px for a segment length, px for a change along an axis. */
private const val ERASE_EPSILON = 1e-12

/** A stretch shorter than this many px is the rim of an earlier cut met again through rounding. */
private const val ERASE_MIN_CUT_LENGTH = 1e-3

/** A cut this close (in "vertex index + fraction") to a vertex is that vertex. */
private const val ERASE_VERTEX_SNAP = 1e-9

/**
 * Shortest piece worth keeping after a cut, in px. A shorter remainder is a
 * crumb: a dot as wide as the stroke that nobody drew and nobody can erase.
 */
private fun eraseCrumbLength(baseWidth: Double) = max(0.5, (if (baseWidth.isFinite()) baseWidth else 0.0) / 4.0)

/** Narrows [span] (from, to as t along a segment) to where `start + rate * t` lies between [low] and [high]. */
private fun eraseClipSpan(span: DoubleArray, start: Double, rate: Double, low: Double, high: Double): Boolean {
    if (rate > -ERASE_EPSILON && rate < ERASE_EPSILON) return start >= low && start <= high
    var enter = (low - start) / rate
    var leave = (high - start) / rate
    if (enter > leave) {
        val swap = enter
        enter = leave
        leave = swap
    }
    if (enter > span[0]) span[0] = enter
    if (leave < span[1]) span[1] = leave
    return span[0] <= span[1]
}

/** Where the segment a + t * d (t in 0..1) is inside the disk of radius [reach] around (cx, cy). */
private fun eraseDiskSpan(
    ax: Double,
    ay: Double,
    dx: Double,
    dy: Double,
    cx: Double,
    cy: Double,
    reach: Double,
    span: DoubleArray,
): Boolean {
    val fx = ax - cx
    val fy = ay - cy
    val squared = dx * dx + dy * dy
    if (squared < ERASE_EPSILON) {
        // The segment is a point (a repeated sample).
        if (!(fx * fx + fy * fy <= reach * reach)) return false
        span[0] = 0.0
        span[1] = 1.0
        return true
    }
    val length = sqrt(squared)
    // The closest approach to the centre, and how far the line passes from it.
    val closest = -(fx * dx + fy * dy) / squared
    val offset = (fx * dy - fy * dx) / length
    val rest = reach * reach - offset * offset
    if (!(rest >= 0.0)) return false
    val half = sqrt(rest) / length
    val enter = max(0.0, closest - half)
    val leave = min(1.0, closest + half)
    if (!(enter <= leave)) return false
    span[0] = enter
    span[1] = leave
    return true
}

/**
 * Where the segment a + t * d (t in 0..1) is inside the straight part of a
 * swept disk: the rectangle [reach] to either side of the line from q to e.
 */
private fun eraseSlabSpan(
    ax: Double,
    ay: Double,
    dx: Double,
    dy: Double,
    qx: Double,
    qy: Double,
    ex: Double,
    ey: Double,
    reach: Double,
    span: DoubleArray,
): Boolean {
    val length = hypot(ex - qx, ey - qy)
    if (!(length > ERASE_EPSILON)) return false
    val ux = (ex - qx) / length
    val uy = (ey - qy) / length
    val rx = ax - qx
    val ry = ay - qy
    span[0] = 0.0
    span[1] = 1.0
    return eraseClipSpan(span, rx * ux + ry * uy, dx * ux + dy * uy, 0.0, length) &&
        eraseClipSpan(span, ux * ry - uy * rx, ux * dy - uy * dx, -reach, reach)
}

/** Sorts the first [used] numbers of [spans] (from, to pairs) by `from` and joins the pairs that touch. */
private fun eraseMergeSpans(spans: DoubleArray, used: Int): DoubleArray {
    if (used <= 2) return spans.copyOf(used)
    var index = 2
    while (index < used) {
        val from = spans[index]
        val to = spans[index + 1]
        var before = index - 2
        while (before >= 0 && spans[before] > from) {
            spans[before + 2] = spans[before]
            spans[before + 3] = spans[before + 1]
            before -= 2
        }
        spans[before + 2] = from
        spans[before + 3] = to
        index += 2
    }
    var merged = 2
    index = 2
    while (index < used) {
        if (spans[index] <= spans[merged - 1] + ERASE_EPSILON) {
            if (spans[index + 1] > spans[merged - 1]) spans[merged - 1] = spans[index + 1]
        } else {
            spans[merged] = spans[index]
            spans[merged + 1] = spans[index + 1]
            merged += 2
        }
        index += 2
    }
    return spans.copyOf(merged)
}

/**
 * The parts of the stroke segment (ax, ay) to (bx, by) that lie within [reach]
 * of the eraser path, as ascending, disjoint (from, to) pairs of t in 0..1; null
 * when the segment stays clear. The swept disk is the union of one disk per path
 * vertex and one rectangle per path segment.
 */
private fun eraseSegmentSpans(
    ax: Double,
    ay: Double,
    bx: Double,
    by: Double,
    pathX: DoubleArray,
    pathY: DoubleArray,
    reach: Double,
): DoubleArray? {
    val dx = bx - ax
    val dy = by - ay
    val left = min(ax, bx)
    val right = max(ax, bx)
    val top = min(ay, by)
    val bottom = max(ay, by)
    val span = DoubleArray(2)
    var found: DoubleArray? = null
    var used = 0
    for (index in pathX.indices) {
        val fromX = pathX[index]
        val fromY = pathY[index]
        if (fromX + reach >= left && fromX - reach <= right && fromY + reach >= top && fromY - reach <= bottom &&
            eraseDiskSpan(ax, ay, dx, dy, fromX, fromY, reach, span)
        ) {
            val spans = found ?: DoubleArray(4 * pathX.size).also { found = it }
            spans[used++] = span[0]
            spans[used++] = span[1]
        }
        if (index + 1 >= pathX.size) continue
        val toX = pathX[index + 1]
        val toY = pathY[index + 1]
        if (max(fromX, toX) + reach >= left && min(fromX, toX) - reach <= right &&
            max(fromY, toY) + reach >= top && min(fromY, toY) - reach <= bottom &&
            eraseSlabSpan(ax, ay, dx, dy, fromX, fromY, toX, toY, reach, span)
        ) {
            val spans = found ?: DoubleArray(4 * pathX.size).also { found = it }
            spans[used++] = span[0]
            spans[used++] = span[1]
        }
    }
    return found?.let { eraseMergeSpans(it, used) }
}

private class EraseStretch(
    /** First and last erased position, as "vertex index + fraction of the next segment". */
    var from: Double,
    var to: Double,
    /** Length of ink the stretch covers, in px. */
    var ink: Double,
)

/** Every stretch of the stroke the eraser path reaches, in order and apart. */
private fun erasedStretches(
    points: List<StrokePoint>,
    sourceWidth: Double,
    sourceHeight: Double,
    pathX: DoubleArray,
    pathY: DoubleArray,
    reach: Double,
): List<EraseStretch> {
    var pathLeft = Double.POSITIVE_INFINITY
    var pathTop = Double.POSITIVE_INFINITY
    var pathRight = Double.NEGATIVE_INFINITY
    var pathBottom = Double.NEGATIVE_INFINITY
    for (index in pathX.indices) {
        if (pathX[index] < pathLeft) pathLeft = pathX[index]
        if (pathX[index] > pathRight) pathRight = pathX[index]
        if (pathY[index] < pathTop) pathTop = pathY[index]
        if (pathY[index] > pathBottom) pathBottom = pathY[index]
    }
    pathLeft -= reach
    pathTop -= reach
    pathRight += reach
    pathBottom += reach

    val stretches = ArrayList<EraseStretch>()
    var ax = points[0].x * sourceWidth
    var ay = points[0].y * sourceHeight
    for (index in 1 until points.size) {
        val bx = points[index].x * sourceWidth
        val by = points[index].y * sourceHeight
        // Comparisons are written so that a NaN coordinate never passes.
        val spans = if (
            max(ax, bx) >= pathLeft && min(ax, bx) <= pathRight &&
            max(ay, by) >= pathTop && min(ay, by) <= pathBottom
        ) {
            eraseSegmentSpans(ax, ay, bx, by, pathX, pathY, reach)
        } else {
            null
        }
        if (spans != null) {
            val length = hypot(bx - ax, by - ay)
            var at = 0
            while (at < spans.size) {
                val from = index - 1 + spans[at]
                val to = index - 1 + spans[at + 1]
                // A segment covered end to end counts even when it is a repeated sample.
                val ink = if (spans[at] <= 0.0 && spans[at + 1] >= 1.0) {
                    max(length, ERASE_MIN_CUT_LENGTH)
                } else {
                    (spans[at + 1] - spans[at]) * length
                }
                val previous = stretches.lastOrNull()
                if (previous != null && from <= previous.to + ERASE_VERTEX_SNAP) {
                    if (to > previous.to) previous.to = to
                    previous.ink += ink
                } else {
                    stretches += EraseStretch(from, to, ink)
                }
                at += 2
            }
        }
        ax = bx
        ay = by
    }
    return stretches.filter { it.ink >= ERASE_MIN_CUT_LENGTH }
}

/** The ink between the stretches, with new end points exactly where the cuts are. */
private fun keptPieces(
    stroke: InkStroke,
    sourceWidth: Double,
    sourceHeight: Double,
    stretches: List<EraseStretch>,
): List<InkStroke> {
    val points = stroke.points
    val minLength = eraseCrumbLength(stroke.baseWidth)
    val pieces = ArrayList<InkStroke>()
    fun vertexAt(position: Double): Int {
        val nearest = round(position)
        return if (abs(position - nearest) <= ERASE_VERTEX_SNAP) nearest.toInt() else -1
    }
    fun pointAt(position: Double): StrokePoint {
        val index = floor(position).toInt()
        return lerpPoint(points[index], points[index + 1], position - index)
    }
    fun keep(from: Double, to: Double) {
        if (!(to - from > ERASE_VERTEX_SNAP)) return
        val firstVertex = vertexAt(from)
        val lastVertex = vertexAt(to)
        val kept = ArrayList<StrokePoint>()
        if (firstVertex < 0) kept += pointAt(from)
        val inner = if (lastVertex < 0) floor(to).toInt() else lastVertex
        var index = if (firstVertex < 0) ceil(from).toInt() else firstVertex
        while (index <= inner) {
            kept += points[index]
            index += 1
        }
        if (lastVertex < 0) kept += pointAt(to)
        if (kept.size < 2) return
        var length = 0.0
        for (at in 1 until kept.size) {
            length += hypot((kept[at].x - kept[at - 1].x) * sourceWidth, (kept[at].y - kept[at - 1].y) * sourceHeight)
        }
        if (length < minLength) return
        pieces += stroke.copy(points = kept)
    }
    var start = 0.0
    for (stretch in stretches) {
        keep(start, stretch.from)
        start = stretch.to
    }
    keep(start, points.lastIndex.toDouble())
    return pieces
}

/**
 * Cuts out the ink of [stroke] that lies within the eraser's reach (radius plus
 * half the stroke width) of the path through [samples]. Returns null when the
 * stroke is untouched, or the remaining pieces (possibly none) when the eraser
 * crossed it. A remainder shorter than a crumb (a quarter of the stroke width,
 * at least half a pixel) is dropped.
 */
fun splitStroke(
    stroke: InkStroke,
    samples: List<StrokePoint>,
    radiusPagePx: Double,
    sourceWidth: Double,
    sourceHeight: Double,
): List<InkStroke>? {
    val points = stroke.points
    if (points.isEmpty() || samples.isEmpty()) return null
    val reach = radiusPagePx + stroke.baseWidth / 2.0
    val pathX = DoubleArray(samples.size) { samples[it].x * sourceWidth }
    val pathY = DoubleArray(samples.size) { samples[it].y * sourceHeight }
    if (points.size == 1) {
        val x = points[0].x * sourceWidth
        val y = points[0].y * sourceHeight
        var nearest = hypot(x - pathX[0], y - pathY[0])
        for (index in 1 until pathX.size) {
            nearest = min(nearest, pointToSegment(x, y, pathX[index - 1], pathY[index - 1], pathX[index], pathY[index]))
        }
        return if (nearest <= reach) emptyList() else null
    }
    val stretches = erasedStretches(points, sourceWidth, sourceHeight, pathX, pathY, reach)
    if (stretches.isEmpty()) return null
    return keptPieces(stroke, sourceWidth, sourceHeight, stretches)
}

private fun pointToSegment(px: Double, py: Double, ax: Double, ay: Double, bx: Double, by: Double): Double {
    val dx = bx - ax
    val dy = by - ay
    val lengthSq = dx * dx + dy * dy
    if (lengthSq <= 1e-12) return hypot(px - ax, py - ay)
    val t = (((px - ax) * dx + (py - ay) * dy) / lengthSq).coerceIn(0.0, 1.0)
    return hypot(px - (ax + dx * t), py - (ay + dy * t))
}

private fun lerpPoint(a: StrokePoint, b: StrokePoint, t: Double) = a.copy(
    x = a.x + (b.x - a.x) * t,
    y = a.y + (b.y - a.y) * t,
    t = a.t + (b.t - a.t) * t,
    pressure = a.pressure + (b.pressure - a.pressure) * t,
    tiltX = a.tiltX + (b.tiltX - a.tiltX) * t,
    tiltY = a.tiltY + (b.tiltY - a.tiltY) * t,
)

/**
 * Closed outline of a pressure-sensitive ribbon, in page pixels.
 * A one-point stroke is a circle. Calligraphy widens across the stroke direction.
 */
/** How far an interior sample is pulled toward the next point. Matches the desktop paint blend. */
fun strokeSmoothFactor(smoothing: Double): Double = smoothing.coerceIn(0.0, 0.92) * 0.35

fun smoothedPagePoint(points: List<StrokePoint>, index: Int, axis: (StrokePoint) -> Double, smoothing: Double): Double {
    val point = axis(points[index])
    if (smoothing <= 0.0 || index <= 0 || index >= points.lastIndex) return point
    val next = axis(points[index + 1])
    val mid = (point + next) / 2.0
    val factor = strokeSmoothFactor(smoothing)
    return point * (1.0 - factor) + mid * factor
}

fun ribbonOutline(
    stroke: InkStroke,
    sourceWidth: Double,
    sourceHeight: Double,
    smoothing: Double = 0.0,
    widthFactor: Double? = null,
): FloatArray {
    val scale = widthFactor ?: brushWidthScale(stroke.brush)
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
        val x = smoothedPagePoint(stroke.points, index, { it.x * sourceWidth }, smoothing).toFloat()
        val y = smoothedPagePoint(stroke.points, index, { it.y * sourceHeight }, smoothing).toFloat()
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
