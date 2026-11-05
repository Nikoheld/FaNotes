package ch.fasrv.fanotes.companion

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.view.GestureDetector
import android.view.MotionEvent
import android.widget.OverScroller
import android.view.VelocityTracker
import android.view.View
import android.view.ViewConfiguration
import ch.fasrv.fanotes.famd.isoNow
import ch.fasrv.fanotes.ink.*
import ch.fasrv.fanotes.input.PalmState
import ch.fasrv.fanotes.input.PointerAction
import ch.fasrv.fanotes.input.PointerSample
import ch.fasrv.fanotes.input.PointerTool
import ch.fasrv.fanotes.input.fingerMayNavigate
import ch.fasrv.fanotes.input.tiltDegrees
import ch.fasrv.fanotes.input.touchPalmState
import kotlin.math.hypot
import kotlin.math.max

/** Native phone paper; all stored points use the shared 0–1 contract. */
class CompanionInkView(context: Context, val session: InkSession, private val onChange: () -> Unit) : View(context) {
    var eraser = false
    var panning = false
    var readOnly = false
    var penColor = DEFAULT_PEN_COLOR
    var penWidth = DEFAULT_PEN_WIDTH
    private var camera = InkCamera()
    private val fingers = LinkedHashMap<Int, Pair<Float, Float>>()
    private var pinchCamera = InkCamera()
    private var pinchSpan = 1f
    private var pinchCx = 0f
    private var pinchCy = 0f
    private var lastX = 0f
    private var lastY = 0f
    private var palm = PalmState()
    private var sawStylus = false
    private var drawing = false
    private var erasing = false
    private var navigating = false
    private var penPointer = -1
    private var committed: List<InkStroke> = session.document.strokes
    private var cache: Bitmap? = null
    private var cacheCamera = InkCamera()
    private var cacheStrokes: List<InkStroke>? = null
    private var cacheW = 0
    private var cacheH = 0
    private val scroller = OverScroller(context)
    private var velocity: VelocityTracker? = null
    private val paperPaint = Paint().apply { color = 0xFFFCFBF7.toInt() }
    private val blitPaint = Paint(Paint.FILTER_BITMAP_FLAG)
    private val strokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
    private val rulingPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFD8DDD9.toInt(); strokeWidth = 1f }
    private val detector = GestureDetector(context, object : GestureDetector.SimpleOnGestureListener() {
        override fun onDown(e: MotionEvent): Boolean = true
        override fun onDoubleTap(e: MotionEvent): Boolean {
            if (!readOnly && !panning) return false
            abortFling()
            camera = doubleTapZoom(camera, e.x, e.y, width.toFloat(), height.toFloat(), session.document.sourceWidth, session.document.sourceHeight)
            dropCache()
            invalidate()
            return true
        }
    })
    private val settleCache = Runnable {
        if (!navigating && fingers.size < 2) {
            dropCache()
            invalidate()
        }
    }

    init {
        isFocusable = true
        isClickable = true
        contentDescription = t(R.string.handwriting_page_use_the_pen_to_draw_or_two_fing)
    }

    fun bindDocument(document: InkDocument) {
        if (session.document === document) return
        if (session.document.strokes === document.strokes &&
            session.document.sourceWidth == document.sourceWidth &&
            session.document.sourceHeight == document.sourceHeight &&
            session.document.updatedAt == document.updatedAt
        ) return
        session.replace(document)
        committed = document.strokes
        camera = clampInkCamera(camera, width.toFloat().coerceAtLeast(1f), height.toFloat().coerceAtLeast(1f), document.sourceWidth, document.sourceHeight)
        dropCache()
        invalidate()
    }

    fun syncFromSession() {
        val strokes = session.document.strokes
        if (drawing || erasing) return
        if (strokes !== committed) {
            committed = strokes
            dropCache()
            invalidate()
        }
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        camera = clampInkCamera(camera, w.toFloat().coerceAtLeast(1f), h.toFloat().coerceAtLeast(1f), session.document.sourceWidth, session.document.sourceHeight)
        dropCache()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val w = width.toFloat().coerceAtLeast(1f)
        val h = height.toFloat().coerceAtLeast(1f)
        canvas.drawRect(0f, 0f, w, h, paperPaint)
        val doc = session.document
        val scale = displayedScale(w, doc.sourceWidth, camera.zoom)
        canvas.save()
        canvas.translate(-camera.pageX * scale, -camera.pageY * scale)
        canvas.scale(scale, scale)
        drawRuling(canvas, doc, scale)
        canvas.restore()
        val live = drawing && !erasing
        val canBlit = !erasing && cacheStrokes === committed && cache != null && !liveRebuildNeeded()
        if (canBlit) blitCommitted(canvas, scale) else drawCommitted(canvas, scale, w, h)
        if (live) {
            canvas.save()
            canvas.translate(-camera.pageX * scale, -camera.pageY * scale)
            canvas.scale(scale, scale)
            drawStroke(canvas, InkStroke(session.livePoints, penWidth, penPointer >= 0, penColor, "handwriting", "fineliner"), doc)
            canvas.restore()
        }
    }

    override fun computeScroll() {
        if (!scroller.computeScrollOffset()) return
        val w = width.toFloat().coerceAtLeast(1f)
        val h = height.toFloat().coerceAtLeast(1f)
        val doc = session.document
        val flingScale = displayedScale(w, doc.sourceWidth, camera.zoom).coerceAtLeast(1e-6f)
        camera = clampInkCamera(
            InkCamera(camera.zoom, scroller.currX / flingScale, scroller.currY / flingScale),
            w, h, doc.sourceWidth, doc.sourceHeight,
        )
        postInvalidateOnAnimation()
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        detector.onTouchEvent(event)
        val stylusIndex = stylusIndex(event)
        val stylus = stylusIndex != null
        val now = event.eventTime
        if (stylus) {
            sawStylus = true
            palm = touchPalmState(palm, pointerSample(event, stylusIndex!!, if (event.actionMasked == MotionEvent.ACTION_MOVE) PointerAction.MOVE else actionOf(event)))
        } else if (event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL) {
            if (palm.stylusDown) palm = palm.copy(stylusDown = false, lastStylusAt = now)
        }
        val allowNav = fingerMayNavigate(palm, now)
        val twoFingers = event.pointerCount >= 2 && !stylus
        val blockParent = !readOnly || camera.zoom > 1.05f || twoFingers
        parent?.requestDisallowInterceptTouchEvent(blockParent)
        if (stylus && event.actionMasked == MotionEvent.ACTION_DOWN) requestUnbufferedDispatch(event)
        if (!stylus && !allowNav) {
            cancelInk()
            return true
        }
        if (twoFingers) {
            cancelInk()
            return handleNav(event)
        }
        if (!readOnly) {
            val stylusDraw = stylusIndex != null
            val fingerDraw = !sawStylus && !panning && allowNav
            val toolPan = panning || (sawStylus && !stylus && camera.zoom > 1.05f)
            if ((stylusDraw || fingerDraw) && !toolPan) return handleInk(event, stylusIndex ?: 0, stylusDraw)
            cancelInk()
            return handleNav(event)
        }
        if (camera.zoom > 1.05f) return handleNav(event)
        if (event.actionMasked == MotionEvent.ACTION_UP) performClick()
        return true
    }

    private fun handleNav(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN, MotionEvent.ACTION_POINTER_DOWN -> {
                abortFling()
                trackFingers(event)
                navigating = true
                if (fingers.size >= 2) beginPinch() else {
                    val remaining = fingers.values.firstOrNull()
                    lastX = remaining?.first ?: event.x
                    lastY = remaining?.second ?: event.y
                    velocity()?.addMovement(event)
                }
            }
            MotionEvent.ACTION_MOVE -> {
                trackFingers(event)
                if (fingers.size >= 2) {
                    val points = fingers.values.toList()
                    val centroid = fingerCentroid(points)
                    camera = pinchPan(
                        pinchCamera, pinchCx, pinchCy, pinchSpan,
                        centroid.first, centroid.second, fingerSpan(points).coerceAtLeast(1f),
                        width.toFloat(), height.toFloat(), session.document.sourceWidth, session.document.sourceHeight,
                    )
                } else if (fingers.size == 1) {
                    val point = fingers.values.first()
                    velocity()?.addMovement(event)
                    camera = panInkCamera(camera, point.first - lastX, point.second - lastY, width.toFloat(), height.toFloat(), session.document.sourceWidth, session.document.sourceHeight)
                    lastX = point.first
                    lastY = point.second
                }
                invalidate()
            }
            MotionEvent.ACTION_POINTER_UP -> {
                val lifted = event.getPointerId(event.actionIndex)
                fingers.remove(lifted)
                var index = 0
                while (index < event.pointerCount) {
                    val id = event.getPointerId(index)
                    if (id != lifted) fingers[id] = event.getX(index) to event.getY(index)
                    index += 1
                }
                if (fingers.size >= 2) beginPinch()
                else {
                    val remaining = fingers.values.firstOrNull()
                    lastX = remaining?.first ?: event.x
                    lastY = remaining?.second ?: event.y
                }
            }
            MotionEvent.ACTION_UP -> {
                trackFingers(event)
                if (fingers.size <= 1) fling(event)
                fingers.clear()
                navigating = false
                scheduleSettle()
                recycleVelocity()
                performClick()
                invalidate()
            }
            MotionEvent.ACTION_CANCEL -> {
                fingers.clear()
                navigating = false
                recycleVelocity()
                scheduleSettle()
                invalidate()
            }
        }
        return true
    }

    private fun handleInk(event: MotionEvent, index: Int, stylus: Boolean): Boolean {
        abortFling()
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN, MotionEvent.ACTION_POINTER_DOWN -> {
                if (event.actionIndex != index) return true
                drawing = true
                penPointer = if (stylus) event.getPointerId(index) else -1
                erasing = eraser || event.getToolType(index) == MotionEvent.TOOL_TYPE_ERASER ||
                    (stylus && event.buttonState and (MotionEvent.BUTTON_STYLUS_PRIMARY or MotionEvent.BUTTON_STYLUS_SECONDARY) != 0)
                if (erasing) session.beginErase() else session.beginStroke()
                sample(event, index)
            }
            MotionEvent.ACTION_MOVE -> if (drawing) {
                val drawIndex = if (penPointer >= 0) event.findPointerIndex(penPointer).takeIf { it >= 0 } ?: index else index
                for (history in 0 until event.historySize) sample(event, drawIndex, history)
                sample(event, drawIndex)
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_POINTER_UP -> if (drawing && (penPointer < 0 || event.getPointerId(event.actionIndex) == penPointer || event.actionIndex == index)) {
                sample(event, index)
                if (erasing) session.endErase() else session.endStroke(StrokeStyle(color = penColor, baseWidth = penWidth, pressureEnabled = stylus), isoNow())
                drawing = false
                erasing = false
                committed = session.document.strokes
                dropCache()
                onChange()
                performClick()
            }
            MotionEvent.ACTION_CANCEL -> cancelInk()
        }
        invalidate()
        return true
    }

    private fun sample(event: MotionEvent, index: Int, history: Int = -1) {
        val doc = session.document
        val x = if (history < 0) event.getX(index) else event.getHistoricalX(index, history)
        val y = if (history < 0) event.getY(index) else event.getHistoricalY(index, history)
        val pressure = if (history < 0) event.getPressure(index) else event.getHistoricalPressure(index, history)
        val tilt = tiltDegrees(event.getAxisValue(MotionEvent.AXIS_TILT, index), event.getAxisValue(MotionEvent.AXIS_ORIENTATION, index))
        val mapped = screenToNormalized(x, y, camera, width.toFloat(), doc.sourceWidth, doc.sourceHeight)
        val point = StrokePoint(
            mapped.first, mapped.second,
            (if (history < 0) event.eventTime else event.getHistoricalEventTime(history)).toDouble(),
            pressure.toDouble().coerceIn(0.0, 1.0), tilt.first.toDouble(), tilt.second.toDouble(),
            if (penPointer >= 0) "pen" else if (event.getToolType(index) == MotionEvent.TOOL_TYPE_MOUSE) "mouse" else "touch",
        )
        if (erasing) { if (session.eraseSamples(listOf(point), 22.0, isoNow())) onChange() } else session.addSample(point)
    }

    private fun drawCommitted(canvas: Canvas, scale: Float, viewW: Float, viewH: Float) {
        val bmp = ensureCache(viewW, viewH, scale) ?: return
        canvas.drawBitmap(bmp, 0f, 0f, null)
    }

    private fun blitCommitted(canvas: Canvas, scale: Float) {
        val bmp = cache ?: return
        val oldScale = displayedScale(width.toFloat(), session.document.sourceWidth, cacheCamera.zoom).coerceAtLeast(1e-6f)
        val ratio = scale / oldScale
        canvas.save()
        canvas.translate((cacheCamera.pageX - camera.pageX) * scale, (cacheCamera.pageY - camera.pageY) * scale)
        canvas.scale(ratio, ratio)
        canvas.drawBitmap(bmp, 0f, 0f, blitPaint)
        canvas.restore()
    }

    private fun ensureCache(viewW: Float, viewH: Float, scale: Float): Bitmap? {
        val w = viewW.toInt().coerceAtLeast(1)
        val h = viewH.toInt().coerceAtLeast(1)
        if (cache != null && cacheStrokes === committed && cacheW == w && cacheH == h &&
            cacheCamera.zoom == camera.zoom && cacheCamera.pageX == camera.pageX && cacheCamera.pageY == camera.pageY
        ) return cache
        val bmp = cache?.takeIf { it.width == w && it.height == h } ?: Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        if (bmp !== cache) {
            cache?.recycle()
            cache = bmp
        }
        bmp.eraseColor(0)
        val page = Canvas(bmp)
        page.translate(-camera.pageX * scale, -camera.pageY * scale)
        page.scale(scale, scale)
        val doc = session.document
        committed.forEach { drawStroke(page, it, doc) }
        cacheCamera = camera
        cacheStrokes = committed
        cacheW = w
        cacheH = h
        return bmp
    }

    private fun liveRebuildNeeded(): Boolean {
        if (navigating || fingers.size >= 2) return false
        return cacheCamera.zoom != camera.zoom || hypot(cacheCamera.pageX - camera.pageX, cacheCamera.pageY - camera.pageY) > 0.4f
    }

    private fun drawRuling(canvas: Canvas, doc: InkDocument, scale: Float) {
        val top = camera.pageY.coerceAtLeast(0f)
        val bottom = (camera.pageY + height / scale.coerceAtLeast(1e-6f)).coerceAtMost(doc.sourceHeight.toFloat())
        val left = camera.pageX.coerceAtLeast(0f)
        val right = (camera.pageX + width / scale.coerceAtLeast(1e-6f)).coerceAtMost(doc.sourceWidth.toFloat())
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
    }

    private fun drawStroke(canvas: Canvas, stroke: InkStroke, doc: InkDocument) {
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

    private fun beginPinch() {
        val points = fingers.values.toList()
        val centroid = fingerCentroid(points)
        pinchCamera = camera
        pinchSpan = fingerSpan(points).coerceAtLeast(1f)
        pinchCx = centroid.first
        pinchCy = centroid.second
    }

    private fun trackFingers(event: MotionEvent) {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN, MotionEvent.ACTION_POINTER_DOWN -> {
                val index = event.actionIndex
                if (event.getToolType(index) == MotionEvent.TOOL_TYPE_STYLUS || event.getToolType(index) == MotionEvent.TOOL_TYPE_ERASER) return
                fingers[event.getPointerId(index)] = event.getX(index) to event.getY(index)
            }
            MotionEvent.ACTION_MOVE -> {
                var index = 0
                while (index < event.pointerCount) {
                    val id = event.getPointerId(index)
                    if (id in fingers) fingers[id] = event.getX(index) to event.getY(index)
                    index += 1
                }
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> fingers.clear()
        }
    }

    private fun fling(event: MotionEvent) {
        val tracker = velocity() ?: return
        tracker.addMovement(event)
        tracker.computeCurrentVelocity(1000, ViewConfiguration.get(context).scaledMaximumFlingVelocity.toFloat())
        val vx = tracker.xVelocity
        val vy = tracker.yVelocity
        if (hypot(vx, vy) < ViewConfiguration.get(context).scaledMinimumFlingVelocity) return
        val w = width.toFloat().coerceAtLeast(1f)
        val h = height.toFloat().coerceAtLeast(1f)
        val doc = session.document
        val scale = displayedScale(w, doc.sourceWidth, camera.zoom).coerceAtLeast(1e-6f)
        val maxX = ((doc.sourceWidth.toFloat() - w / scale).coerceAtLeast(0f) * scale).toInt()
        val maxY = ((doc.sourceHeight.toFloat() - h / scale).coerceAtLeast(0f) * scale).toInt()
        scroller.fling((camera.pageX * scale).toInt(), (camera.pageY * scale).toInt(), -vx.toInt(), -vy.toInt(), 0, maxX, 0, maxY)
        postInvalidateOnAnimation()
    }

    private fun abortFling() {
        if (!scroller.isFinished) scroller.abortAnimation()
    }

    private fun velocity(): VelocityTracker? {
        if (velocity == null) velocity = VelocityTracker.obtain()
        return velocity
    }

    private fun recycleVelocity() {
        velocity?.recycle()
        velocity = null
    }

    private fun cancelInk() {
        if (!drawing && !erasing) return
        session.cancelStroke()
        session.endErase()
        drawing = false
        erasing = false
        committed = session.document.strokes
    }

    private fun dropCache() {
        cacheStrokes = null
    }

    private fun scheduleSettle() {
        removeCallbacks(settleCache)
        postDelayed(settleCache, 80)
    }

    private fun stylusIndex(event: MotionEvent): Int? =
        (0 until event.pointerCount).firstOrNull { event.getToolType(it) == MotionEvent.TOOL_TYPE_STYLUS || event.getToolType(it) == MotionEvent.TOOL_TYPE_ERASER }

    private fun actionOf(event: MotionEvent) = when (event.actionMasked) {
        MotionEvent.ACTION_DOWN, MotionEvent.ACTION_POINTER_DOWN -> PointerAction.DOWN
        MotionEvent.ACTION_MOVE -> PointerAction.MOVE
        MotionEvent.ACTION_UP, MotionEvent.ACTION_POINTER_UP -> PointerAction.UP
        else -> PointerAction.CANCEL
    }

    private fun pointerSample(event: MotionEvent, index: Int, action: PointerAction): PointerSample {
        val tool = when (event.getToolType(index)) {
            MotionEvent.TOOL_TYPE_STYLUS -> PointerTool.STYLUS
            MotionEvent.TOOL_TYPE_ERASER -> PointerTool.ERASER
            MotionEvent.TOOL_TYPE_FINGER -> PointerTool.FINGER
            MotionEvent.TOOL_TYPE_MOUSE -> PointerTool.MOUSE
            else -> PointerTool.UNKNOWN
        }
        return PointerSample(event.getPointerId(index), tool, action, event.getX(index), event.getY(index), event.getPressure(index), 0f, 0f, event.eventTime)
    }

    override fun performClick(): Boolean { super.performClick(); return true }

    override fun onDetachedFromWindow() {
        super.onDetachedFromWindow()
        removeCallbacks(settleCache)
        cache?.recycle()
        cache = null
        recycleVelocity()
    }
}
