package ch.fasrv.fanotes.companion

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.view.MotionEvent
import android.view.View
import ch.fasrv.fanotes.famd.isoNow
import ch.fasrv.fanotes.ink.DEFAULT_PEN_COLOR
import ch.fasrv.fanotes.ink.DEFAULT_PEN_WIDTH
import ch.fasrv.fanotes.ink.InkDocument
import ch.fasrv.fanotes.ink.InkStroke
import ch.fasrv.fanotes.ink.StrokePoint
import ch.fasrv.fanotes.ink.pressureWidth
import kotlin.math.hypot

/** Finger and stylus page that writes the same stroke JSON as the tablet. */
class CompanionInkView(
    context: Context,
    initial: InkDocument,
    private val onChange: (InkDocument) -> Unit,
) : View(context) {
    var document: InkDocument = initial
    var eraser: Boolean = false
    var panning: Boolean = false
    var penColor: String = DEFAULT_PEN_COLOR
    private var scroll = 0f
    private val active = mutableListOf<StrokePoint>()
    private var stylus = false
    private var lastPan = 0f

    override fun onDraw(canvas: Canvas) {
        canvas.drawColor(android.graphics.Color.parseColor("#F7F6F3"))
        val scale = scale()
        canvas.save()
        canvas.translate(0f, -scroll)
        canvas.scale(scale, scale)
        if (document.paperStyle == "dots" || document.paperStyle.isBlank()) drawDots(canvas)
        document.strokes.forEach { drawStroke(canvas, it) }
        if (active.size > 1) {
            drawStroke(canvas, InkStroke(active.toList(), DEFAULT_PEN_WIDTH, stylus, penColor, "handwriting", "fineliner"))
        }
        canvas.restore()
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        val scale = scale()
        stylus = event.getToolType(0) == MotionEvent.TOOL_TYPE_STYLUS
        if (panning || event.pointerCount > 1) {
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN, MotionEvent.ACTION_POINTER_DOWN -> lastPan = event.y
                MotionEvent.ACTION_MOVE -> {
                    scroll = (scroll - (event.y - lastPan)).coerceIn(0f, maxScroll(scale))
                    lastPan = event.y
                    invalidate()
                }
            }
            return true
        }
        val pageX = (event.x / scale).toDouble()
        val pageY = ((event.y + scroll) / scale).toDouble()
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                if (eraser) erase(pageX, pageY) else {
                    active.clear()
                    active += point(event, pageX, pageY)
                }
            }
            MotionEvent.ACTION_MOVE -> {
                if (eraser) erase(pageX, pageY) else {
                    val history = event.historySize
                    for (index in 0 until history) {
                        val x = (event.getHistoricalX(index) / scale).toDouble()
                        val y = ((event.getHistoricalY(index) + scroll) / scale).toDouble()
                        active += point(event, x, y, event.getHistoricalEventTime(index).toDouble(), event.getHistoricalPressure(index))
                    }
                    active += point(event, pageX, pageY)
                }
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                if (!eraser && active.size > 1) {
                    val stroke = InkStroke(
                        points = active.toList(),
                        baseWidth = DEFAULT_PEN_WIDTH,
                        pressureEnabled = stylus,
                        color = penColor,
                        purpose = "handwriting",
                        brush = "fineliner",
                    )
                    document = document.copy(strokes = document.strokes + stroke, updatedAt = isoNow())
                    onChange(document)
                }
                active.clear()
            }
        }
        invalidate()
        return true
    }

    private fun erase(x: Double, y: Double) {
        val kept = document.strokes.filterNot { stroke ->
            stroke.points.any { hypot(it.x - x, it.y - y) < 28.0 }
        }
        if (kept.size != document.strokes.size) {
            document = document.copy(strokes = kept, updatedAt = isoNow())
            onChange(document)
        }
    }

    private fun point(event: MotionEvent, x: Double, y: Double, time: Double = event.eventTime.toDouble(), pressure: Float = event.pressure): StrokePoint =
        StrokePoint(
            x = x,
            y = y,
            t = time,
            pressure = if (stylus) pressure.toDouble().coerceIn(0.05, 1.0) else 0.5,
            tiltX = event.getAxisValue(MotionEvent.AXIS_TILT).toDouble(),
            tiltY = 0.0,
            pointerType = if (stylus) "pen" else "touch",
        )

    private fun drawStroke(canvas: Canvas, stroke: InkStroke) {
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE
            strokeCap = Paint.Cap.ROUND
            strokeJoin = Paint.Join.ROUND
            color = runCatching { android.graphics.Color.parseColor(stroke.color) }.getOrDefault(android.graphics.Color.BLACK)
            alpha = ((stroke.opacity ?: 1.0) * 255).toInt().coerceIn(0, 255)
        }
        val points = stroke.points
        for (index in 1 until points.size) {
            paint.strokeWidth = pressureWidth(stroke.baseWidth, points[index].pressure, stroke.pressureEnabled).toFloat()
            canvas.drawLine(points[index - 1].x.toFloat(), points[index - 1].y.toFloat(), points[index].x.toFloat(), points[index].y.toFloat(), paint)
        }
    }

    private fun drawDots(canvas: Canvas) {
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = android.graphics.Color.parseColor("#D5D3CC") }
        var y = 36.0
        while (y < document.sourceHeight) {
            var x = 36.0
            while (x < document.sourceWidth) {
                canvas.drawCircle(x.toFloat(), y.toFloat(), 1.4f, paint)
                x += 24.0
            }
            y += 24.0
        }
    }

    private fun scale(): Float = width.coerceAtLeast(1).toFloat() / document.sourceWidth.toFloat().coerceAtLeast(1f)
    private fun maxScroll(scale: Float): Float = (document.sourceHeight.toFloat() * scale - height).coerceAtLeast(0f)
}
