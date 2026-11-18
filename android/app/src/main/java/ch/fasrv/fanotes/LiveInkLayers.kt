package ch.fasrv.fanotes

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RenderNode
import ch.fasrv.fanotes.ink.GrainSegment
import ch.fasrv.fanotes.ink.InkStroke
import ch.fasrv.fanotes.ink.LIVE_INK_CHUNK
import ch.fasrv.fanotes.ink.StrokePoint
import ch.fasrv.fanotes.ink.liveFrozenSegments
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/** Off switch for [LiveInkLayers]; false paints the live stroke whole every frame, as before. */
const val LIVE_INK_LAYERS_ENABLED = true

/**
 * The stroke under the pen, painted incrementally. A pressure brush paints one short path per sample and pass,
 * so redrawing a long stroke from scratch every frame costs hundreds of draw calls on the UI thread and as many
 * path rasterizations on the GPU. Segments whose samples are final are recorded once, [LIVE_INK_CHUNK] at a
 * time, into a [RenderNode] that renders into its own GPU layer; every frame composites those layers and only
 * repaints the open tail. The committed stroke is still painted whole into the tiles, so saved ink and its
 * look after the pen lifts are unchanged.
 *
 * The chunks are recorded in screen pixels at whole-pixel positions, so compositing them does not resample.
 * Anything that moves the samples or the page under them (zoom, pan, page growth, a snapped shape, a new
 * style) drops the chunks and rebuilds them on the next frame. RenderNode needs API 29, the app's minimum.
 */
internal class LiveInkLayers {
    private val chunks = ArrayList<RenderNode>()
    private var frozen = 0
    /** The samples the chunks were built from: 0..frozen+1, compared by identity each frame. */
    private val frozenPoints = ArrayList<StrokePoint>()
    private var key: Key? = null

    private data class Key(
        val scale: Float,
        val originX: Float,
        val originY: Float,
        val sourceWidth: Double,
        val sourceHeight: Double,
        val smoothing: Double,
        val color: Int,
        val baseWidth: Double,
        val brush: String?,
        val colorEffect: String?,
        val opacity: Double?,
        val purpose: String?,
    )

    /** Whether [draw] can paint [stroke] on [canvas]; otherwise the caller paints it whole. */
    fun supports(canvas: Canvas, stroke: InkStroke, rotation: Float): Boolean =
        LIVE_INK_LAYERS_ENABLED &&
            canvas.isHardwareAccelerated &&
            rotation % 360f == 0f &&
            paintsPerSegment(stroke)

    /**
     * Paints [stroke] (the live samples, the first [realPoints] of them real, the rest predicted) with the page
     * origin at ([originX], [originY]) in [canvas] pixels. [canvas] must be unrotated; see [supports].
     */
    fun draw(
        canvas: Canvas,
        paint: Paint,
        stroke: InkStroke,
        realPoints: Int,
        originX: Float,
        originY: Float,
        sourceWidth: Double,
        sourceHeight: Double,
        scale: Float,
        smoothing: Double,
        color: Int,
    ) {
        val points = stroke.points
        val next = Key(scale, originX, originY, sourceWidth, sourceHeight, smoothing, color, stroke.baseWidth, stroke.brush, stroke.colorEffect, stroke.opacity, stroke.purpose)
        if (next != key || !prefixStill(points)) clear()
        key = next
        val target = liveFrozenSegments(realPoints.coerceAtMost(points.size), frozen)
        while (frozen < target) {
            val last = frozen + LIVE_INK_CHUNK
            record(paint, stroke, frozen + 1, last, originX, originY, sourceWidth, sourceHeight, scale, smoothing, color)
            frozen = last
        }
        for (index in frozenPoints.size..min(frozen + 1, points.lastIndex)) frozenPoints += points[index]
        for (chunk in chunks) canvas.drawRenderNode(chunk)
        canvas.save()
        canvas.translate(originX, originY)
        val tail = passSegmentRange(stroke, sourceWidth, sourceHeight, scale, smoothing, frozen + 1, points.lastIndex)
        drawPassSegments(canvas, paint, stroke, sourceWidth, sourceHeight, scale, color, tail)
        canvas.restore()
    }

    /** Releases the recorded chunks and their layers. */
    fun clear() {
        for (chunk in chunks) chunk.discardDisplayList()
        chunks.clear()
        frozenPoints.clear()
        frozen = 0
        key = null
    }

    val isEmpty: Boolean get() = chunks.isEmpty()

    private fun prefixStill(points: List<StrokePoint>): Boolean {
        if (frozenPoints.size > points.size) return false
        for (index in frozenPoints.indices) if (frozenPoints[index] !== points[index]) return false
        return true
    }

    private fun record(
        paint: Paint,
        stroke: InkStroke,
        first: Int,
        last: Int,
        originX: Float,
        originY: Float,
        sourceWidth: Double,
        sourceHeight: Double,
        scale: Float,
        smoothing: Double,
        color: Int,
    ) {
        val passes = passSegmentRange(stroke, sourceWidth, sourceHeight, scale, smoothing, first, last)
        val box = segmentBox(passes) ?: return
        val pixels = scale.toDouble()
        val blur = if (stroke.colorEffect == "neon") 2.0 * max(4.0, stroke.baseWidth * 1.48 * pixels * 0.85) else 0.0
        val pad = box[4] * pixels / 2.0 + blur + 2.0
        val left = floor(originX + box[0] * pixels - pad).toInt()
        val top = floor(originY + box[1] * pixels - pad).toInt()
        val right = ceil(originX + box[2] * pixels + pad).toInt().coerceAtLeast(left + 1)
        val bottom = ceil(originY + box[3] * pixels + pad).toInt().coerceAtLeast(top + 1)
        val node = RenderNode("live-ink")
        node.setPosition(left, top, right, bottom)
        // A layer bigger than the GPU allows would not be cached; the node still draws correctly without one.
        if (right - left <= MAX_LAYER_PX && bottom - top <= MAX_LAYER_PX) node.setUseCompositingLayer(true, null)
        val recording = node.beginRecording(right - left, bottom - top)
        try {
            recording.translate(originX - left, originY - top)
            drawPassSegments(recording, paint, stroke, sourceWidth, sourceHeight, scale, color, passes)
        } finally {
            node.endRecording()
        }
        chunks += node
    }

    /** [minX, minY, maxX, maxY, widest] over every segment, in page px, or null without segments. */
    private fun segmentBox(passes: List<List<GrainSegment>>): DoubleArray? {
        var minX = Double.POSITIVE_INFINITY
        var minY = Double.POSITIVE_INFINITY
        var maxX = Double.NEGATIVE_INFINITY
        var maxY = Double.NEGATIVE_INFINITY
        var widest = 0.0
        var any = false
        for (pass in passes) for (segment in pass) {
            any = true
            minX = min(minX, min(segment.startX, segment.endX))
            maxX = max(maxX, max(segment.startX, segment.endX))
            minY = min(minY, min(segment.startY, segment.endY))
            maxY = max(maxY, max(segment.startY, segment.endY))
            val cx = segment.controlX
            val cy = segment.controlY
            if (cx != null && cy != null) {
                minX = min(minX, cx)
                maxX = max(maxX, cx)
                minY = min(minY, cy)
                maxY = max(maxY, cy)
            }
            widest = max(widest, segment.width)
        }
        return if (any) doubleArrayOf(minX, minY, maxX, maxY, widest) else null
    }

    private companion object {
        const val MAX_LAYER_PX = 4096
    }
}
