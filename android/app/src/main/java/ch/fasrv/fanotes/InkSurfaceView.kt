package ch.fasrv.fanotes

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PorterDuff
import android.graphics.RectF
import android.graphics.Typeface
import android.text.Layout
import android.text.SpannableStringBuilder
import android.text.StaticLayout
import android.text.TextPaint
import android.text.style.RelativeSizeSpan
import android.text.style.StyleSpan
import android.text.style.TypefaceSpan
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
import ch.fasrv.fanotes.text.PaperKind
import ch.fasrv.fanotes.text.paperLines
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
    var onCamera: (Float, Float, Float) -> Unit = { _, _, _ -> }
    var onPenActive: (Boolean) -> Unit = {}
    /** Styled note text, drawn under the ink at the desktop column. */
    var markdown: String = ""
        set(value) {
            if (field == value) return
            field = value
            textStamp = -1f
            invalidate()
        }
    /** While the on-page editor is open the preview is hidden so the glyphs are not doubled. */
    var showMarkdown: Boolean = true

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
    private val tilePaint = Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG)
    private val tileDest = RectF()
    private val textPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#252630")
        isLinearText = true
        isSubpixelText = true
        typeface = Typeface.create("sans-serif", Typeface.NORMAL)
    }
    private var textLayout: Layout? = null
    private var textStamp = -1f
    private var cacheScale = 0f
    private var nibX = Float.NaN
    private var nibY = Float.NaN
    private val tiles = HashMap<Long, Bitmap>()
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
        cacheScale = 0f
        textStamp = -1f
        invalidateTiles()
        pageLeft = padding()
        pageTop = padding()
        zoom = 1f
        invalidate()
        publishCamera()
    }

    fun refresh() {
        invalidateTiles()
        invalidate()
    }

    fun cameraLeft(): Float = pageLeft
    fun cameraTop(): Float = pageTop
    fun cameraScale(): Float = pixelsPerPageUnit()

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        if (oldw == 0) {
            pageLeft = padding()
            pageTop = padding()
        }
        clipBounds = android.graphics.Rect(0, 0, w, h)
        invalidateTiles()
        publishCamera()
    }

    override fun onHoverEvent(event: MotionEvent): Boolean {
        if (event.getToolType(0) != MotionEvent.TOOL_TYPE_STYLUS) return super.onHoverEvent(event)
        if (event.actionMasked == MotionEvent.ACTION_HOVER_EXIT) {
            hoverX = Float.NaN
            hoverY = Float.NaN
            if (!erasing) {
                nibX = Float.NaN
                nibY = Float.NaN
            }
        } else {
            hoverX = event.x
            hoverY = event.y
            nibX = event.x
            nibY = event.y
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
                    settleZoom()
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
        onPenActive(true)
        trackNib(event, index)
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
        trackNib(event, index)
        predictor?.record(event)
        val history = event.historySize
        if (erasing) {
            val samples = ArrayList<StrokePoint>(history + 1)
            for (h in 0 until history) samples += point(event, index, historical = h)
            samples += point(event, index)
            if (current.eraseSamples(samples, eraserRadius(), nowIso())) {
                dropTilesNear(event, index)
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
        onPenActive(false)
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
        publishCamera()
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
        canvas.save()
        canvas.clipRect(0f, 0f, width.toFloat(), height.toFloat())
        canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), desk)
        val current = session ?: run {
            canvas.restore()
            return
        }
        val scale = pixelsPerPageUnit()
        if (cacheScale == 0f) cacheScale = scale.coerceIn(MIN_CACHE_SCALE, MAX_CACHE_SCALE)
        val pageWidth = (current.document.sourceWidth * scale).toFloat()
        val pageHeight = (current.document.sourceHeight * scale).toFloat()
        canvas.drawRect(pageLeft, pageTop, pageLeft + pageWidth, pageTop + pageHeight, paper)
        drawBackdrop(canvas, scale)
        if (backdrop.isEmpty()) drawRuling(canvas, current.document.paperStyle, pageWidth, pageHeight, scale)
        if (showMarkdown && markdown.isNotBlank()) drawMarkdown(canvas, scale)
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
        if (erasing && !nibX.isNaN()) {
            hoverPaint.style = Paint.Style.STROKE
            hoverPaint.strokeWidth = 1.5f * resources.displayMetrics.density
            canvas.drawCircle(nibX, nibY, eraserRadius().toFloat() * scale, hoverPaint)
        } else if (!hoverX.isNaN()) {
            hoverPaint.style = Paint.Style.STROKE
            canvas.drawCircle(hoverX, hoverY, 8f * resources.displayMetrics.density, hoverPaint)
        }
        canvas.restore()
    }

    private fun drawTiles(canvas: Canvas, current: InkSession, scale: Float) {
        val tile = TILE_PAGE
        val leftPage = ((-pageLeft) / scale).toInt() - tile
        val topPage = ((-pageTop) / scale).toInt() - tile
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
                val bitmap = tileAt(current, x, y, tile)
                val left = pageLeft + x * scale
                val top = pageTop + y * scale
                val side = tile * scale
                tileDest.set(left, top, left + side, top + side)
                canvas.drawBitmap(bitmap, null, tileDest, tilePaint)
                x += tile
            }
            y += tile
        }
        evictDistantTiles(x0, y0, x1, y1, tile)
    }

    /**
     * Tiles are a fixed page-pixel size, rasterized once at [cacheScale].
     * Pinch-zoom only changes the destination rect, so a Galaxy Tab S6 Lite
     * does not allocate a new bitmap on every frame.
     */
    private fun tileAt(current: InkSession, x: Int, y: Int, tile: Int): Bitmap {
        val key = x.toLong() shl 32 or (y.toLong() and 0xffffffffL)
        tiles[key]?.let { return it }
        val raster = cacheScale.coerceIn(MIN_CACHE_SCALE, MAX_CACHE_SCALE)
        val size = (tile * raster).toInt().coerceIn(1, 480)
        val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val tileCanvas = Canvas(bitmap)
        tileCanvas.drawColor(Color.TRANSPARENT, PorterDuff.Mode.CLEAR)
        tileCanvas.translate(-x * raster, -y * raster)
        tileCanvas.scale(raster, raster)
        for (stroke in current.document.strokes) {
            if (!intersectsTile(stroke, current, x, y, tile)) continue
            drawStroke(tileCanvas, stroke, 1f)
        }
        tiles[key] = bitmap
        return bitmap
    }

    private fun evictDistantTiles(x0: Int, y0: Int, x1: Int, y1: Int, tile: Int) {
        if (tiles.size <= MAX_TILES) return
        val stale = tiles.keys.filter { key ->
            val x = (key shr 32).toInt()
            val y = (key and 0xffffffffL).toInt()
            x < x0 - tile || x > x1 + tile || y < y0 - tile || y > y1 + tile
        }
        for (key in stale) tiles.remove(key)?.recycle()
    }

    private fun dropTilesNear(event: MotionEvent, index: Int) {
        val scale = pixelsPerPageUnit().toDouble().coerceAtLeast(0.0001)
        val pageX = (event.getX(index) - pageLeft) / scale
        val pageY = (event.getY(index) - pageTop) / scale
        val radius = eraserRadius() + TILE_PAGE
        val stale = tiles.keys.filter { key ->
            val x = (key shr 32).toInt()
            val y = (key and 0xffffffffL).toInt()
            pageX + radius >= x && pageX - radius <= x + TILE_PAGE && pageY + radius >= y && pageY - radius <= y + TILE_PAGE
        }
        for (key in stale) tiles.remove(key)?.recycle()
    }

    private fun settleZoom() {
        val scale = pixelsPerPageUnit().coerceIn(MIN_CACHE_SCALE, MAX_CACHE_SCALE)
        if (cacheScale == 0f || kotlin.math.abs(scale - cacheScale) / cacheScale > 0.45f) {
            cacheScale = scale
            invalidateTiles()
        }
    }

    private fun trackNib(event: MotionEvent, index: Int) {
        nibX = if (index in 0 until event.pointerCount) event.getX(index) else event.x
        nibY = if (index in 0 until event.pointerCount) event.getY(index) else event.y
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
        smoothOutline(path, outline, scale)
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
        fun firstVisible(origin: Float, step: Float): Float {
            if (origin >= -step) return origin
            val jumps = kotlin.math.floor(((-origin) / step).toDouble()).toInt()
            return origin + jumps * step
        }
        when (style) {
            "dots" -> {
                val step = stepFor(7.5)
                ruling.color = Color.parseColor("#5C6B8E")
                ruling.alpha = 70
                val radius = max(0.8f, scale * 1.05f)
                var y = firstVisible(pageTop + step, step)
                val yLimit = min(pageTop + pageHeight, height + step)
                val xLimit = min(pageLeft + pageWidth, width + step)
                while (y < yLimit) {
                    var x = firstVisible(pageLeft + step, step)
                    while (x < xLimit) {
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
                var x = firstVisible(pageLeft + start, step)
                val xLimit = min(pageLeft + pageWidth, width + step)
                while (x <= xLimit) {
                    canvas.drawLine(x, max(pageTop, 0f), x, min(pageTop + pageHeight, height.toFloat()), ruling)
                    x += step
                }
                var y = firstVisible(pageTop + start, step)
                val yLimit = min(pageTop + pageHeight, height + step)
                while (y <= yLimit) {
                    canvas.drawLine(max(pageLeft, 0f), y, min(pageLeft + pageWidth, width.toFloat()), y, ruling)
                    y += step
                }
            }
            "lines" -> {
                val step = stepFor(7.5)
                ruling.color = Color.parseColor("#677493")
                ruling.alpha = 37
                var y = firstVisible(pageTop + step, step)
                val yLimit = min(pageTop + pageHeight, height + step)
                while (y < yLimit) {
                    canvas.drawLine(max(pageLeft, 0f), y, min(pageLeft + pageWidth, width.toFloat()), y, ruling)
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
                val xLimit = min(pageLeft + pageWidth, width + minor)
                val yLimit = min(pageTop + pageHeight, height + minor)
                var x = firstVisible(pageLeft + minor, minor)
                while (x < xLimit) {
                    canvas.drawLine(x, max(pageTop, 0f), x, min(pageTop + pageHeight, height.toFloat()), ruling)
                    x += minor
                }
                var y = firstVisible(pageTop + minor, minor)
                while (y < yLimit) {
                    canvas.drawLine(max(pageLeft, 0f), y, min(pageLeft + pageWidth, width.toFloat()), y, ruling)
                    y += minor
                }
                ruling.alpha = 56
                x = firstVisible(pageLeft + major, major)
                while (x < xLimit) {
                    canvas.drawLine(x, max(pageTop, 0f), x, min(pageTop + pageHeight, height.toFloat()), ruling)
                    x += major
                }
                y = firstVisible(pageTop + major, major)
                while (y < yLimit) {
                    canvas.drawLine(max(pageLeft, 0f), y, min(pageLeft + pageWidth, width.toFloat()), y, ruling)
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

    private fun publishCamera() {
        onCamera(pageLeft, pageTop, pixelsPerPageUnit())
    }

    private fun drawMarkdown(canvas: Canvas, scale: Float) {
        val layout = markdownLayout(scale) ?: return
        canvas.save()
        canvas.translate(pageLeft + TEXT_PAD_X * scale, pageTop + TEXT_PAD_Y * scale)
        layout.draw(canvas)
        canvas.restore()
    }

    private fun markdownLayout(scale: Float): Layout? {
        if (scale <= 0f || markdown.isBlank()) return null
        if (textLayout != null && kotlin.math.abs(scale - textStamp) < scale * 0.03f) return textLayout
        val width = (TEXT_COLUMN * scale).toInt().coerceAtLeast(1)
        textPaint.textSize = 16f * scale
        val text = styledMarkdown(markdown)
        textLayout = StaticLayout.Builder.obtain(text, 0, text.length, textPaint, width)
            .setAlignment(Layout.Alignment.ALIGN_NORMAL)
            .setIncludePad(false)
            .setLineSpacing(0f, 1.55f)
            .setBreakStrategy(Layout.BREAK_STRATEGY_HIGH_QUALITY)
            .setHyphenationFrequency(Layout.HYPHENATION_FREQUENCY_NONE)
            .build()
        textStamp = scale
        return textLayout
    }

    private fun styledMarkdown(markdown: String): CharSequence {
        val builder = SpannableStringBuilder()
        for (line in paperLines(markdown)) {
            val start = builder.length
            val content: CharSequence = when (line.kind) {
                PaperKind.BULLET -> inline("•  ${line.text}")
                PaperKind.SPACER -> ""
                PaperKind.RULE -> " "
                else -> inline(line.text)
            }
            builder.append(content)
            val end = builder.length
            if (end > start) {
                when (line.kind) {
                    PaperKind.H1 -> {
                        builder.setSpan(RelativeSizeSpan(2f), start, end, 0)
                        builder.setSpan(StyleSpan(Typeface.BOLD), start, end, 0)
                    }
                    PaperKind.H2 -> {
                        builder.setSpan(RelativeSizeSpan(1.55f), start, end, 0)
                        builder.setSpan(StyleSpan(Typeface.BOLD), start, end, 0)
                    }
                    PaperKind.H3, PaperKind.H4 -> {
                        builder.setSpan(RelativeSizeSpan(1.28f), start, end, 0)
                        builder.setSpan(StyleSpan(Typeface.BOLD), start, end, 0)
                    }
                    PaperKind.QUOTE -> builder.setSpan(StyleSpan(Typeface.ITALIC), start, end, 0)
                    PaperKind.CODE -> builder.setSpan(TypefaceSpan("monospace"), start, end, 0)
                    else -> Unit
                }
            }
            builder.append('\n')
        }
        return builder
    }

    private fun inline(text: String): CharSequence {
        val builder = SpannableStringBuilder()
        var index = 0
        while (index < text.length) {
            val bold = text.startsWith("**", index)
            val italic = !bold && text[index] == '*'
            if (bold || italic) {
                val marker = if (bold) "**" else "*"
                val close = text.indexOf(marker, index + marker.length)
                if (close > index) {
                    val start = builder.length
                    builder.append(text.substring(index + marker.length, close))
                    builder.setSpan(
                        if (bold) StyleSpan(Typeface.BOLD) else StyleSpan(Typeface.ITALIC),
                        start,
                        builder.length,
                        0,
                    )
                    index = close + marker.length
                    continue
                }
            }
            builder.append(text[index])
            index += 1
        }
        return builder
    }

    private fun smoothOutline(path: Path, outline: FloatArray, scale: Float) {
        val count = outline.size / 2
        if (count < 2) return
        fun coord(index: Int, axis: Int) = outline[(index % count) * 2 + axis] * scale
        path.moveTo(coord(0, 0), coord(0, 1))
        if (count == 2) {
            path.lineTo(coord(1, 0), coord(1, 1))
            path.close()
            return
        }
        for (index in 0 until count) {
            val next = index + 1
            val midX = (coord(index, 0) + coord(next, 0)) / 2f
            val midY = (coord(index, 1) + coord(next, 1)) / 2f
            path.quadTo(coord(index, 0), coord(index, 1), midX, midY)
        }
        path.close()
    }

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

    private companion object {
        const val TILE_PAGE = 192
        const val MAX_TILES = 36
        const val MIN_CACHE_SCALE = 0.5f
        const val MAX_CACHE_SCALE = 1.75f
        const val TEXT_PAD_X = 72f
        const val TEXT_PAD_Y = 78f
        const val TEXT_COLUMN = 900f - 144f
    }
}

data class BackdropSlice(
    val topPagePx: Float,
    val heightPagePx: Float,
    val widthPagePx: Float,
    val bitmap: Bitmap?,
)
