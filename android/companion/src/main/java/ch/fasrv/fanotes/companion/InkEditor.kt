package ch.fasrv.fanotes.companion

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import ch.fasrv.fanotes.famd.isoNow
import ch.fasrv.fanotes.ink.*
import ch.fasrv.fanotes.input.POST_PEN_IGNORE_MS
import ch.fasrv.fanotes.input.tiltDegrees
import kotlin.math.max

/** Native phone paper; all stored points use the shared 0–1 contract. */
class CompanionInkView(context: Context, val session: InkSession, private val onChange: () -> Unit) : View(context) {
    var eraser = false
    var panning = false
    var readOnly = false
    var penColor = DEFAULT_PEN_COLOR
    var penWidth = DEFAULT_PEN_WIDTH
    private var scrollYPage = 0f
    private var scrollXPage = 0f
    private var zoom = 1f
    private var lastX = 0f
    private var lastY = 0f
    private var lastStylusAt = 0L
    private var drawing = false
    private var erasing = false
    private var navigating = false
    private var penPointer = -1
    private val paperPaint = Paint().apply { color = 0xFFFCFBF7.toInt() }
    private val strokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
    private val rulingPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFD8DDD9.toInt(); strokeWidth = 1f }
    private val scaleDetector = ScaleGestureDetector(context, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
        override fun onScale(detector: ScaleGestureDetector): Boolean {
            val oldScale = scale()
            val x = (detector.focusX + scrollXPage) / oldScale
            val y = (detector.focusY + scrollYPage) / oldScale
            zoom = (zoom * detector.scaleFactor).coerceIn(1f, 4f)
            scrollXPage = x * scale() - detector.focusX
            scrollYPage = y * scale() - detector.focusY
            clampScroll(); invalidate(); return true
        }
    })
    init { isFocusable = true; contentDescription = "Handwriting page. Use the pen to draw, or two fingers to move and zoom." }
    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), paperPaint)
        val doc = session.document
        val factor = scale()
        canvas.save(); canvas.translate(-scrollXPage, -scrollYPage); canvas.scale(factor, factor)
        val top = (scrollYPage / factor).coerceAtLeast(0f)
        val bottom = ((scrollYPage + height) / factor).coerceAtMost(doc.sourceHeight.toFloat())
        val left = (scrollXPage / factor).coerceAtLeast(0f)
        val right = ((scrollXPage + width) / factor).coerceAtMost(doc.sourceWidth.toFloat())
        val step = if (doc.paperStyle == "millimeter") 9f else 24f
        var y = (top / step).toInt() * step
        while (y <= bottom) {
            when (doc.paperStyle) {
                "dots", "" -> {
                    var x = (left / step).toInt() * step
                    while (x <= right) { canvas.drawCircle(x, y, 1.3f, rulingPaint); x += step }
                }
                "lines", "squares", "grid", "millimeter" -> canvas.drawLine(left, y, right, y, rulingPaint)
            }
            y += step
        }
        if (doc.paperStyle in listOf("squares", "grid", "millimeter")) {
            var x = (left / step).toInt() * step
            while (x <= right) { canvas.drawLine(x, top, x, bottom, rulingPaint); x += step }
        }
        doc.strokes.forEach { drawStroke(canvas, it) }
        if (drawing && !erasing) drawStroke(canvas, InkStroke(session.livePoints, penWidth, penPointer >= 0, penColor, "handwriting", "fineliner"))
        canvas.restore()
    }
    override fun onTouchEvent(event: MotionEvent): Boolean {
        val stylusIndex = (0 until event.pointerCount).firstOrNull { event.getToolType(it) in listOf(MotionEvent.TOOL_TYPE_STYLUS, MotionEvent.TOOL_TYPE_ERASER) }
        val index = stylusIndex ?: 0
        val stylus = stylusIndex != null
        if (!stylus && event.eventTime - lastStylusAt < POST_PEN_IGNORE_MS) return true
        if (stylus) lastStylusAt = event.eventTime
        parent?.requestDisallowInterceptTouchEvent(true)
        if (!stylus) scaleDetector.onTouchEvent(event)
        val pan = readOnly || panning || (!stylus && event.pointerCount > 1) || navigating
        if (pan) {
            if (drawing) { session.beginStroke(); session.endErase(); drawing = false }
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN, MotionEvent.ACTION_POINTER_DOWN -> { lastX = event.x; lastY = event.y; navigating = true }
                MotionEvent.ACTION_MOVE -> if (!scaleDetector.isInProgress) {
                    scrollXPage -= event.x - lastX; scrollYPage -= event.y - lastY
                    lastX = event.x; lastY = event.y; clampScroll(); invalidate()
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> { navigating = false; performClick() }
            }
            return true
        }
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN, MotionEvent.ACTION_POINTER_DOWN -> {
                if (event.actionIndex != index) return true
                drawing = true
                penPointer = if (stylus) event.getPointerId(index) else -1
                erasing = eraser || event.getToolType(index) == MotionEvent.TOOL_TYPE_ERASER || (stylus && event.buttonState and (MotionEvent.BUTTON_STYLUS_PRIMARY or MotionEvent.BUTTON_STYLUS_SECONDARY) != 0)
                if (erasing) session.beginErase() else session.beginStroke()
                sample(event, index)
            }
            MotionEvent.ACTION_MOVE -> if (drawing) {
                for (history in 0 until event.historySize) sample(event, index, history)
                sample(event, index)
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_POINTER_UP -> if (drawing && event.actionIndex == index) {
                sample(event, index)
                if (erasing) session.endErase() else session.endStroke(StrokeStyle(color = penColor, baseWidth = penWidth, pressureEnabled = stylus), isoNow())
                drawing = false; onChange(); performClick()
            }
            MotionEvent.ACTION_CANCEL -> { session.beginStroke(); session.endErase(); drawing = false }
        }
        invalidate(); return true
    }
    private fun sample(event: MotionEvent, index: Int, history: Int = -1) {
        val doc = session.document
        val x = if (history < 0) event.getX(index) else event.getHistoricalX(index, history)
        val y = if (history < 0) event.getY(index) else event.getHistoricalY(index, history)
        val pressure = if (history < 0) event.getPressure(index) else event.getHistoricalPressure(index, history)
        val tilt = tiltDegrees(event.getAxisValue(MotionEvent.AXIS_TILT, index), event.getAxisValue(MotionEvent.AXIS_ORIENTATION, index))
        val point = StrokePoint(((x + scrollXPage) / scale() / doc.sourceWidth).coerceIn(0.0, 1.0), ((y + scrollYPage) / scale() / doc.sourceHeight).coerceIn(0.0, 1.0),
            (if (history < 0) event.eventTime else event.getHistoricalEventTime(history)).toDouble(), pressure.toDouble().coerceIn(0.0, 1.0), tilt.first.toDouble(), tilt.second.toDouble(),
            if (penPointer >= 0) "pen" else if (event.getToolType(index) == MotionEvent.TOOL_TYPE_MOUSE) "mouse" else "touch")
        if (erasing) { if (session.eraseSamples(listOf(point), 22.0, isoNow())) onChange() } else session.addSample(point)
    }
    private fun drawStroke(canvas: Canvas, stroke: InkStroke) {
        val doc = session.document
        val points = stroke.points
        if (points.isEmpty()) return
        strokePaint.color = runCatching { android.graphics.Color.parseColor(stroke.color) }.getOrDefault(0xFF202333.toInt())
        strokePaint.alpha = ((stroke.opacity ?: 1.0) * 255).toInt().coerceIn(0, 255)
        for (i in 1 until points.size) {
            val a = points[i - 1]; val b = points[i]
            strokePaint.strokeWidth = pressureWidth(stroke.baseWidth, b.pressure, stroke.pressureEnabled).toFloat()
            canvas.drawLine((a.x * doc.sourceWidth).toFloat(), (a.y * doc.sourceHeight).toFloat(), (b.x * doc.sourceWidth).toFloat(), (b.y * doc.sourceHeight).toFloat(), strokePaint)
        }
        if (points.size == 1) {
            val point = points.first()
            strokePaint.style = Paint.Style.FILL
            canvas.drawCircle((point.x * doc.sourceWidth).toFloat(), (point.y * doc.sourceHeight).toFloat(), max(1f, stroke.baseWidth.toFloat() / 2), strokePaint)
            strokePaint.style = Paint.Style.STROKE
        }
    }
    private fun scale() = width.coerceAtLeast(1).toFloat() / session.document.sourceWidth.toFloat().coerceAtLeast(1f) * zoom
    private fun clampScroll() {
        scrollXPage = scrollXPage.coerceIn(0f, (session.document.sourceWidth * scale() - width).toFloat().coerceAtLeast(0f))
        scrollYPage = scrollYPage.coerceIn(0f, (session.document.sourceHeight * scale() - height).toFloat().coerceAtLeast(0f))
    }
    override fun performClick(): Boolean { super.performClick(); return true }
}
