package ch.fasrv.fanotes

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PorterDuff
import android.os.Build
import android.os.SystemClock
import android.util.AttributeSet
import android.view.GestureDetector
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.MotionPredictor
import android.view.VelocityTracker
import android.view.View
import ch.fasrv.fanotes.ink.InkSession
import ch.fasrv.fanotes.ink.InkStroke
import ch.fasrv.fanotes.ink.InkTool
import ch.fasrv.fanotes.ink.PAGE_START_WIDTH
import ch.fasrv.fanotes.ink.StrokePoint
import ch.fasrv.fanotes.ink.StrokeStyle
import ch.fasrv.fanotes.ink.brushOpacity
import ch.fasrv.fanotes.ink.ribbonOutline
import ch.fasrv.fanotes.input.POST_PEN_IGNORE_MS
import ch.fasrv.fanotes.input.PalmState
import ch.fasrv.fanotes.input.PointerAction
import ch.fasrv.fanotes.input.PointerSample
import ch.fasrv.fanotes.input.PointerTool
import ch.fasrv.fanotes.input.fingerMayNavigate
import ch.fasrv.fanotes.input.isPenTool
import ch.fasrv.fanotes.input.shouldRejectFinger
import ch.fasrv.fanotes.input.tiltDegrees
import ch.fasrv.fanotes.input.touchPalmState
import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/**
 * Low-latency paper. Stylus (and an optional mouse) writes; fingers scroll,
 * zoom and turn notes. A resting palm is ignored while the pen is down and
 * for [POST_PEN_IGNORE_MS] after it lifts, the same window the desktop uses.
 *
 * Committed ink is cached in page-pixel tiles. The stroke under the nib is
 * drawn on top of that cache, including predicted motion on Android 14+.
 */
class InkSurfaceView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : View(context, attrs) {
    var session: InkSession? = null
    var inkTool: InkTool = InkTool.PEN
    var style: StrokeStyle = StrokeStyle()
    var fingerDraws: Boolean = false
    var backdrop: List<BackdropSlice> = emptyList()
        set(value) {
            field = value
            invalidateTiles()
        }
    var onChanged: () -> Unit = {}
    var onSwipeNote: (Int) -> Unit = {}

    private val desk = Paint().apply { color = Color.parseColor("#E6E1D6") }
    private val paper = Paint().apply { color = Color.parseColor("#FBFCFC") }
    private val ruling = Paint().apply { color = Color.parseColor("#5C6B8E"); alpha = 70 }
    private val inkPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
        strokeCap = Paint.Cap.ROUND
    }
    private val hoverPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 2f
        color = Color.parseColor("#2A6F97")
    }
    private val selectPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 3f
        color = Color.parseColor("#2A6F97")
    }
    private val tilePaint = Paint(Paint.FILTER_BITMAP_FLAG)
    private val tiles = HashMap<Long, Bitmap>()
    private var tileScale = 1f
    private var palm = PalmState()
    private var inkPointer = MotionEvent.INVALID_POINTER_ID
    private var erasing = false
    private var selecting = false
    private var movingSelection = false
    private var anchorX = 0.0
    private var anchorY = 0.0
    private var selectRect: FloatArray? = null
    private var predicted: List<StrokePoint> = emptyList()
    private var hoverX = Float.NaN
    private var hoverY = Float.NaN
    private val fingers = LinkedHashMap<Int, Pair<Float, Float>>()
    private var pinchStart = 0f
    private var pinchZoom = 1f
    private var zoom = 1f
    private var pageLeft = 0f
    private var pageTop = 0f
    private var velocity: VelocityTracker? = null
    private val gestures = GestureDetector(context, object : GestureDetector.SimpleOnGestureListener() {
        override fun onLongPress(event: MotionEvent) {
            if (!fingerMayNavigate(palm, SystemClock.uptimeMillis())) return
            val (x, y) = screenToNorm(event.x, event.y)
            session?.selectAt(x, y, 0.02)
            performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
            invalidateTiles()
            invalidate()
        }
    })
    private val predictor = if (Build.VERSION.SDK_INT >= 34) MotionPredictor(context) else null

    init {
        setBackgroundColor(Color.parseColor("#E6E1D6"))
        if (Build.VERSION.SDK_INT >= 35) {
            requestedFrameRate = 120f
        }
    }

    fun reload() {
        invalidateTiles()
        pageLeft = padding()
        pageTop = padding()
        zoom = 1f
        invalidate()
    }

    fun refresh() {
        invalidateTiles()
        invalidate()
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        if (oldw == 0) {
            pageLeft = padding()
            pageTop = padding()
        }
        invalidateTiles()
    }

    override fun onHoverEvent(event: MotionEvent): Boolean {
        if (event.getToolType(0) != MotionEvent.TOOL_TYPE_STYLUS) return super.onHoverEvent(event)
        if (event.actionMasked == MotionEvent.ACTION_HOVER_EXIT) {
            hoverX = Float.NaN
            hoverY = Float.NaN
        } else {
            hoverX = event.x
            hoverY = event.y
            palm = touchPalmState(palm, sample(event, 0, PointerAction.HOVER))
        }
        invalidate()
        return true
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(event: MotionEvent): Boolean {
        velocity?.addMovement(event)
        val action = event.actionMasked
        val index = event.actionIndex
        val id = event.getPointerId(index)
        val tool = toolOf(event, index)
        val now = SystemClock.uptimeMillis()
        when (action) {
            MotionEvent.ACTION_DOWN, MotionEvent.ACTION_POINTER_DOWN -> {
                val sample = sample(event, index, PointerAction.DOWN)
                palm = touchPalmState(palm, sample)
                if (isPenTool(tool) || tool == PointerTool.MOUSE || (tool == PointerTool.FINGER && fingerDraws)) {
                    if (shouldRejectFinger(tool, palm, now, fingerDraws)) return true
                    if (inkPointer != MotionEvent.INVALID_POINTER_ID) return true
                    inkPointer = id
                    if (isPenTool(tool)) requestUnbufferedDispatch(event)
                    beginInk(event, index, tool)
                } else if (fingerMayNavigate(palm, now)) {
                    fingers[id] = event.getX(index) to event.getY(index)
                    if (fingers.size == 1) {
                        velocity?.recycle()
                        velocity = VelocityTracker.obtain()
                        velocity?.addMovement(event)
                        gestures.onTouchEvent(event)
                    } else {
                        pinchStart = fingerSpan()
                        pinchZoom = zoom
                    }
                }
            }
            MotionEvent.ACTION_MOVE -> {
                if (inkPointer != MotionEvent.INVALID_POINTER_ID) {
                    val inkIndex = event.findPointerIndex(inkPointer)
                    if (inkIndex >= 0) moveInk(event, inkIndex)
                } else if (fingerMayNavigate(palm, now)) {
                    moveFingers(event)
                    if (fingers.size == 1) gestures.onTouchEvent(event)
                }
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_POINTER_UP, MotionEvent.ACTION_CANCEL -> {
                val endingInk = id == inkPointer || action == MotionEvent.ACTION_CANCEL
                if (endingInk && inkPointer != MotionEvent.INVALID_POINTER_ID) {
                    val inkIndex = event.findPointerIndex(inkPointer).coerceAtLeast(0)
                    if (action != MotionEvent.ACTION_CANCEL && inkIndex < event.pointerCount) {
                        moveInk(event, inkIndex)
                    }
                    finishInk(action == MotionEvent.ACTION_CANCEL)
                    palm = touchPalmState(palm, sample(event, inkIndex.coerceAtMost(event.pointerCount - 1), PointerAction.UP))
                    inkPointer = MotionEvent.INVALID_POINTER_ID
                }
                if (fingers.remove(id) != null && fingers.size < 2 && action != MotionEvent.ACTION_CANCEL) {
                    maybeSwipe(event)
                }
                if (fingers.isEmpty()) {
                    velocity?.recycle()
                    velocity = null
                }
                if (action != MotionEvent.ACTION_CANCEL && fingers.size == 1) gestures.onTouchEvent(event)
            }
        }
        return true
    }

    private fun beginInk(event: MotionEvent, index: Int, tool: PointerTool) {
        val current = session ?: return
        val eraser = tool == PointerTool.ERASER || inkTool == InkTool.ERASER
        val (x, y) = screenToNorm(event.getX(index), event.getY(index))
        when {
            eraser -> {
                erasing = true
                current.beginErase()
                current.eraseSamples(listOf(point(event, index, x, y)), eraserRadius(), nowIso())
                onChanged()
            }
            inkTool == InkTool.SELECT -> {
                selecting = true
                movingSelection = hitSelection(x, y)
                anchorX = x
                anchorY = y
                selectRect = floatArrayOf(x.toFloat(), y.toFloat(), x.toFloat(), y.toFloat())
            }
            else -> {
                current.beginStroke()
                current.addSample(point(event, index, x, y))
            }
        }
        predictor?.record(event)
        invalidate()
    }

    private fun moveInk(event: MotionEvent, index: Int) {
        val current = session ?: return
        predictor?.record(event)
        val history = event.historySize
        if (erasing) {
            val samples = ArrayList<StrokePoint>(history + 1)
            for (h in 0 until history) samples += point(event, index, historical = h)
            samples += point(event, index)
            if (current.eraseSamples(samples, eraserRadius(), nowIso())) {
                invalidateTiles()
                onChanged()
            }
        } else if (selecting) {
            val (x, y) = screenToNorm(event.getX(index), event.getY(index))
            if (movingSelection) {
                current.moveSelection(x - anchorX, y - anchorY, nowIso())
                anchorX = x
                anchorY = y
                invalidateTiles()
                onChanged()
            } else {
                selectRect = floatArrayOf(anchorX.toFloat(), anchorY.toFloat(), x.toFloat(), y.toFloat())
            }
        } else {
            for (h in 0 until history) {
                current.addSample(point(event, index, historical = h))
            }
            val (x, y) = screenToNorm(event.getX(index), event.getY(index))
            current.addSample(point(event, index, x, y))
            predicted = predict(event)
        }
        invalidate()
    }

    private fun finishInk(cancel: Boolean) {
        val current = session ?: return
        predicted = emptyList()
        when {
            erasing -> {
                erasing = false
                current.endErase()
            }
            selecting -> {
                selecting = false
                if (!movingSelection) {
                    val rect = selectRect
                    if (rect != null) {
                        val left = min(rect[0], rect[2]).toDouble()
                        val top = min(rect[1], rect[3]).toDouble()
                        current.selectRect(
                            ch.fasrv.fanotes.ink.NormalizedRect(
                                left,
                                top,
                                abs(rect[2] - rect[0]).toDouble(),
                                abs(rect[3] - rect[1]).toDouble(),
                            ),
                        )
                    }
                }
                movingSelection = false
                selectRect = null
                invalidateTiles()
            }
            cancel -> current.cancelStroke()
            else -> {
                val stroke = current.endStroke(style, nowIso())
                if (stroke != null) {
                    invalidateTiles(stroke)
                    onChanged()
                }
            }
        }
        invalidate()
    }

    private fun moveFingers(event: MotionEvent) {
        if (fingers.size >= 2) {
            var index = 0
            while (index < event.pointerCount) {
                val id = event.getPointerId(index)
                if (id in fingers) fingers[id] = event.getX(index) to event.getY(index)
                index += 1
            }
            val span = fingerSpan().coerceAtLeast(1f)
            val next = (pinchZoom * span / pinchStart.coerceAtLeast(1f)).coerceIn(0.5f, 4f)
            val (cx, cy) = fingerCentroid()
            val before = screenToNorm(cx, cy)
            zoom = next
            val afterScale = pixelsPerPageUnit()
            pageLeft = cx - (before.first * sessionWidth() * afterScale).toFloat()
            pageTop = cy - (before.second * sessionHeight() * afterScale).toFloat()
            invalidateTiles()
        } else if (fingers.size == 1) {
            val id = fingers.keys.first()
            val index = event.findPointerIndex(id)
            val old = fingers[id]
            if (old != null && index >= 0) {
                pageLeft += event.getX(index) - old.first
                pageTop += event.getY(index) - old.second
                fingers[id] = event.getX(index) to event.getY(index)
            }
        }
        invalidate()
    }

    private fun maybeSwipe(event: MotionEvent) {
        val tracker = velocity ?: return
        tracker.computeCurrentVelocity(1000)
        val vx = tracker.xVelocity
        val vy = tracker.yVelocity
        if (zoom > 1.15f) return
        if (abs(vx) < 900f || abs(vx) < abs(vy) * 1.3f) return
        onSwipeNote(if (vx < 0) 1 else -1)
    }

    private fun predict(event: MotionEvent): List<StrokePoint> {
        // MotionPredictor wants an absolute uptime in nanoseconds, a frame ahead of this sample.
        val futureNanos = event.eventTime * 1_000_000L + 16_000_000L
        val predictedEvent = predictor?.predict(futureNanos) ?: return emptyList()
        predictedEvent.use { motion ->
            if (motion.pointerCount == 0) return emptyList()
            val (x, y) = screenToNorm(motion.x, motion.y)
            return listOf(point(motion, 0, x, y, predicted = true))
        }
    }

    override fun onDraw(canvas: Canvas) {
        canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), desk)
        val current = session ?: return
        val scale = pixelsPerPageUnit()
        if (scale != tileScale) invalidateTiles()
        tileScale = scale
        val pageWidth = (current.document.sourceWidth * scale).toFloat()
        val pageHeight = (current.document.sourceHeight * scale).toFloat()
        canvas.drawRect(pageLeft, pageTop, pageLeft + pageWidth, pageTop + pageHeight, paper)
        drawBackdrop(canvas, scale)
        if (backdrop.isEmpty()) drawRuling(canvas, current.document.paperStyle, pageWidth, pageHeight, scale)
        drawTiles(canvas, current, scale)
        val live = current.livePoints
        if (live.isNotEmpty()) {
            canvas.save()
            canvas.translate(pageLeft, pageTop)
            drawStroke(
                canvas,
                InkStroke(live + predicted, style.baseWidth, style.pressureEnabled, style.color, brush = style.brush, opacity = brushOpacity(style.brush)),
                scale,
            )
            canvas.restore()
        }
        current.selection.forEach { index -> current.document.strokes.getOrNull(index)?.let { drawSelection(canvas, it, scale) } }
        selectRect?.let { rect ->
            val (x1, y1) = normToScreen(rect[0].toDouble(), rect[1].toDouble())
            val (x2, y2) = normToScreen(rect[2].toDouble(), rect[3].toDouble())
            canvas.drawRect(min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2), selectPaint)
        }
        if (!hoverX.isNaN()) canvas.drawCircle(hoverX, hoverY, 10f * zoom, hoverPaint)
        if (erasing && inkPointer != MotionEvent.INVALID_POINTER_ID) {
            // The hover ring doubles as the eraser cursor while the nib is down.
        }
    }

    private fun drawTiles(canvas: Canvas, current: InkSession, scale: Float) {
        val tile = 512
        val leftPage = ((-pageLeft) / scale).toInt()
        val topPage = ((-pageTop) / scale).toInt()
        val rightPage = ((width - pageLeft) / scale).toInt() + tile
        val bottomPage = ((height - pageTop) / scale).toInt() + tile
        val x0 = floorTo(leftPage, tile)
        val y0 = floorTo(topPage, tile)
        val x1 = floorTo(rightPage, tile)
        val y1 = floorTo(bottomPage, tile)
        var y = y0
        while (y <= y1) {
            var x = x0
            while (x <= x1) {
                val bitmap = tileAt(current, x, y, tile, scale)
                canvas.drawBitmap(bitmap, pageLeft + x * scale, pageTop + y * scale, tilePaint)
                x += tile
            }
            y += tile
        }
    }

    private fun tileAt(current: InkSession, x: Int, y: Int, tile: Int, scale: Float): Bitmap {
        val key = x.toLong() shl 32 or (y.toLong() and 0xffffffffL)
        tiles[key]?.let { return it }
        val size = (tile * scale).toInt().coerceAtLeast(1)
        val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val tileCanvas = Canvas(bitmap)
        tileCanvas.drawColor(Color.TRANSPARENT, PorterDuff.Mode.CLEAR)
        tileCanvas.translate(-x * scale, -y * scale)
        tileCanvas.scale(scale, scale)
        for (stroke in current.document.strokes) {
            if (!intersectsTile(stroke, current, x, y, tile)) continue
            drawStroke(tileCanvas, stroke, 1f)
        }
        tiles[key] = bitmap
        return bitmap
    }

    private fun intersectsTile(stroke: InkStroke, current: InkSession, x: Int, y: Int, tile: Int): Boolean {
        val width = current.document.sourceWidth
        val height = current.document.sourceHeight
        return stroke.points.any { point ->
            val px = point.x * width
            val py = point.y * height
            px >= x - 40 && px <= x + tile + 40 && py >= y - 40 && py <= y + tile + 40
        }
    }

    private fun drawStroke(canvas: Canvas, stroke: InkStroke, scale: Float) {
        if (stroke.points.isEmpty()) return
        val outline = ribbonOutline(stroke, sessionWidth(), sessionHeight())
        if (outline.size < 4) return
        val path = Path()
        path.moveTo(outline[0] * scale, outline[1] * scale)
        var index = 2
        while (index < outline.size) {
            path.lineTo(outline[index] * scale, outline[index + 1] * scale)
            index += 2
        }
        path.close()
        inkPaint.color = parseColor(stroke.color)
        inkPaint.alpha = ((stroke.opacity ?: brushOpacity(stroke.brush) ?: 1.0) * 255).toInt().coerceIn(20, 255)
        canvas.drawPath(path, inkPaint)
    }

    private fun drawSelection(canvas: Canvas, stroke: InkStroke, scale: Float) {
        var left = Double.POSITIVE_INFINITY
        var top = Double.POSITIVE_INFINITY
        var right = Double.NEGATIVE_INFINITY
        var bottom = Double.NEGATIVE_INFINITY
        for (point in stroke.points) {
            left = min(left, point.x)
            top = min(top, point.y)
            right = max(right, point.x)
            bottom = max(bottom, point.y)
        }
        val (x1, y1) = normToScreen(left, top)
        val (x2, y2) = normToScreen(right, bottom)
        canvas.drawRect(x1 - 8f, y1 - 8f, x2 + 8f, y2 + 8f, selectPaint)
    }

    private fun drawRuling(canvas: Canvas, style: String, pageWidth: Float, pageHeight: Float, scale: Float) {
        if (style == "blank") return
        ruling.strokeWidth = max(1f, scale * 0.7f)
        fun stepFor(millimeters: Double) = max(2f, (pageWidth * millimeters / 210.0).toFloat())
        when (style) {
            "dots" -> {
                val step = stepFor(7.5)
                ruling.color = Color.parseColor("#5C6B8E")
                ruling.alpha = 70
                val radius = max(0.8f, scale * 1.05f)
                var y = pageTop + step
                while (y < pageTop + pageHeight) {
                    var x = pageLeft + step
                    while (x < pageLeft + pageWidth) {
                        canvas.drawCircle(x, y, radius, ruling)
                        x += step
                    }
                    y += step
                }
            }
            "squares", "grid" -> {
                val step = stepFor(if (style == "squares") 5.0 else 7.5)
                ruling.color = Color.parseColor(if (style == "squares") "#5C76A8" else "#677493")
                ruling.alpha = if (style == "squares") 56 else 37
                val start = if (style == "squares") 0f else step
                var x = pageLeft + start
                while (x <= pageLeft + pageWidth) {
                    canvas.drawLine(x, pageTop, x, pageTop + pageHeight, ruling)
                    x += step
                }
                var y = pageTop + start
                while (y <= pageTop + pageHeight) {
                    canvas.drawLine(pageLeft, y, pageLeft + pageWidth, y, ruling)
                    y += step
                }
            }
            "lines" -> {
                val step = stepFor(7.5)
                ruling.color = Color.parseColor("#677493")
                ruling.alpha = 37
                var y = pageTop + step
                while (y < pageTop + pageHeight) {
                    canvas.drawLine(pageLeft, y, pageLeft + pageWidth, y, ruling)
                    y += step
                }
                ruling.color = Color.parseColor("#D25269")
                ruling.alpha = 40
                val margin = pageLeft + step * 1.65f
                canvas.drawLine(margin, pageTop, margin, pageTop + pageHeight, ruling)
            }
            "millimeter" -> {
                val minor = stepFor(1.0)
                val major = stepFor(5.0)
                ruling.color = Color.parseColor("#5C76A8")
                ruling.alpha = 26
                var x = pageLeft + minor
                while (x < pageLeft + pageWidth) {
                    canvas.drawLine(x, pageTop, x, pageTop + pageHeight, ruling)
                    x += minor
                }
                var y = pageTop + minor
                while (y < pageTop + pageHeight) {
                    canvas.drawLine(pageLeft, y, pageLeft + pageWidth, y, ruling)
                    y += minor
                }
                ruling.alpha = 56
                x = pageLeft + major
                while (x < pageLeft + pageWidth) {
                    canvas.drawLine(x, pageTop, x, pageTop + pageHeight, ruling)
                    x += major
                }
                y = pageTop + major
                while (y < pageTop + pageHeight) {
                    canvas.drawLine(pageLeft, y, pageLeft + pageWidth, y, ruling)
                    y += major
                }
            }
        }
    }

    private fun drawBackdrop(canvas: Canvas, scale: Float) {
        for (slice in backdrop) {
            val bitmap = slice.bitmap ?: continue
            val top = pageTop + slice.topPagePx * scale
            val destHeight = slice.heightPagePx * scale
            val destWidth = slice.widthPagePx * scale
            canvas.drawBitmap(bitmap, null, android.graphics.RectF(pageLeft, top, pageLeft + destWidth, top + destHeight), tilePaint)
        }
    }

    private fun invalidateTiles(stroke: InkStroke? = null) {
        if (stroke == null) {
            tiles.values.forEach { it.recycle() }
            tiles.clear()
            return
        }
        tiles.values.forEach { it.recycle() }
        tiles.clear()
    }

    private fun toolOf(event: MotionEvent, index: Int): PointerTool {
        val buttons = event.buttonState
        val barrel = buttons and MotionEvent.BUTTON_STYLUS_PRIMARY != 0 || buttons and MotionEvent.BUTTON_STYLUS_SECONDARY != 0
        return when (event.getToolType(index)) {
            MotionEvent.TOOL_TYPE_ERASER -> PointerTool.ERASER
            MotionEvent.TOOL_TYPE_STYLUS -> if (barrel) PointerTool.ERASER else PointerTool.STYLUS
            MotionEvent.TOOL_TYPE_MOUSE -> PointerTool.MOUSE
            MotionEvent.TOOL_TYPE_FINGER -> PointerTool.FINGER
            else -> PointerTool.UNKNOWN
        }
    }

    private fun sample(event: MotionEvent, index: Int, action: PointerAction) = PointerSample(
        pointerId = event.getPointerId(index),
        tool = toolOf(event, index),
        action = action,
        x = event.getX(index),
        y = event.getY(index),
        pressure = event.getPressure(index),
        tiltX = 0f,
        tiltY = 0f,
        timeMs = event.eventTime,
    )

    private fun point(event: MotionEvent, index: Int, x: Double? = null, y: Double? = null, historical: Int = -1, predicted: Boolean = false): StrokePoint {
        val sx = if (historical >= 0) event.getHistoricalX(index, historical) else event.getX(index)
        val sy = if (historical >= 0) event.getHistoricalY(index, historical) else event.getY(index)
        val mapped = if (x != null && y != null && historical < 0) x to y else screenToNorm(sx, sy)
        val pressure = if (historical >= 0) event.getHistoricalPressure(index, historical) else event.getPressure(index)
        val tilt = event.getAxisValue(MotionEvent.AXIS_TILT, index)
        val orientation = event.getAxisValue(MotionEvent.AXIS_ORIENTATION, index)
        val (tiltX, tiltY) = tiltDegrees(tilt, orientation)
        val time = if (historical >= 0) event.getHistoricalEventTime(historical) else event.eventTime
        return StrokePoint(
            x = mapped.first,
            y = mapped.second,
            t = time.toDouble(),
            pressure = if (pressure > 0f) pressure.toDouble() else if (toolOf(event, index) == PointerTool.MOUSE) 0.55 else 0.35,
            tiltX = tiltX.toDouble(),
            tiltY = tiltY.toDouble(),
            pointerType = if (isPenTool(toolOf(event, index))) "pen" else if (toolOf(event, index) == PointerTool.FINGER) "touch" else "mouse",
        ).also { if (predicted) Unit }
    }

    private fun screenToNorm(x: Float, y: Float): Pair<Double, Double> {
        val scale = pixelsPerPageUnit().toDouble().coerceAtLeast(0.0001)
        val pageX = (x - pageLeft) / scale
        val pageY = (y - pageTop) / scale
        return pageX / sessionWidth() to pageY / sessionHeight()
    }

    private fun normToScreen(x: Double, y: Double): Pair<Float, Float> {
        val scale = pixelsPerPageUnit()
        return pageLeft + (x * sessionWidth() * scale).toFloat() to pageTop + (y * sessionHeight() * scale).toFloat()
    }

    private fun pixelsPerPageUnit(): Float {
        val available = (width - padding() * 2).coerceAtLeast(1f)
        return available / PAGE_START_WIDTH.toFloat() * zoom
    }

    private fun sessionWidth() = session?.document?.sourceWidth ?: PAGE_START_WIDTH
    private fun sessionHeight() = session?.document?.sourceHeight ?: ch.fasrv.fanotes.ink.PAGE_START_HEIGHT
    private fun padding() = 24f * resources.displayMetrics.density
    private fun eraserRadius() = (18.0 + style.baseWidth) * (if (style.brush == "highlighter") 2.2 else 1.0)
    private fun nowIso() = ch.fasrv.fanotes.famd.isoNow()

    private fun fingerSpan(): Float {
        val points = fingers.values.toList()
        if (points.size < 2) return 0f
        return hypot(points[0].first - points[1].first, points[0].second - points[1].second)
    }

    private fun fingerCentroid(): Pair<Float, Float> {
        val points = fingers.values
        return points.sumOf { it.first.toDouble() }.toFloat() / points.size to points.sumOf { it.second.toDouble() }.toFloat() / points.size
    }

    private fun hitSelection(x: Double, y: Double): Boolean {
        val current = session ?: return false
        return current.selection.any { index ->
            current.document.strokes.getOrNull(index)?.points?.any { point ->
                hypot(point.x - x, point.y - y) < 0.03
            } == true
        }
    }

    private fun floorTo(value: Int, tile: Int): Int = Math.floorDiv(value, tile) * tile

    private fun parseColor(value: String): Int = try {
        Color.parseColor(value)
    } catch (_: IllegalArgumentException) {
        Color.BLACK
    }

    private inline fun <T> MotionEvent.use(block: (MotionEvent) -> T): T = try {
        block(this)
    } finally {
        recycle()
    }
}

data class BackdropSlice(
    val topPagePx: Float,
    val heightPagePx: Float,
    val widthPagePx: Float,
    val bitmap: Bitmap?,
)
