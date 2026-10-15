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
import android.text.style.ForegroundColorSpan
import android.text.style.StyleSpan
import android.text.style.TypefaceSpan
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.AttributeSet
import android.view.GestureDetector
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.MotionPredictor
import android.view.VelocityTracker
import android.view.View
import ch.fasrv.fanotes.ink.A4_WIDTH_MM
import ch.fasrv.fanotes.ink.DraftingDisplay
import ch.fasrv.fanotes.ink.DraftingKind
import ch.fasrv.fanotes.ink.DraftingPose
import ch.fasrv.fanotes.ink.DraftingSnapLock
import ch.fasrv.fanotes.ink.DraftingToolState
import ch.fasrv.fanotes.ink.InkDocument
import ch.fasrv.fanotes.ink.InkSession
import ch.fasrv.fanotes.ink.InkStroke
import ch.fasrv.fanotes.ink.InkTool
import ch.fasrv.fanotes.ink.PAGE_START_WIDTH
import ch.fasrv.fanotes.ink.SOURCE_A4_PX
import ch.fasrv.fanotes.ink.StrokePoint
import ch.fasrv.fanotes.ink.StrokeStyle
import ch.fasrv.fanotes.ink.angleToPoint
import ch.fasrv.fanotes.ink.attachSetSquareToRuler
import ch.fasrv.fanotes.ink.brushOpacity
import ch.fasrv.fanotes.ink.clampCompassRadius
import ch.fasrv.fanotes.ink.compassPencilPoint
import ch.fasrv.fanotes.ink.defaultCompassPose
import ch.fasrv.fanotes.ink.defaultRulerPose
import ch.fasrv.fanotes.ink.defaultSetSquarePose
import ch.fasrv.fanotes.ink.keepPoseOnSheet
import ch.fasrv.fanotes.ink.lassoHits
import ch.fasrv.fanotes.ink.normToLocalMm
import ch.fasrv.fanotes.ink.pointInsideRuler
import ch.fasrv.fanotes.ink.pointInsideSetSquare
import ch.fasrv.fanotes.ink.radiusMmBetween
import ch.fasrv.fanotes.ink.ribbonOutline
import ch.fasrv.fanotes.ink.rulerLength
import ch.fasrv.fanotes.ink.rulerWidth
import ch.fasrv.fanotes.ink.sampleCompassCircle
import ch.fasrv.fanotes.ink.scaleTicks
import ch.fasrv.fanotes.ink.inkStrokeAllowsShapeSnap
import ch.fasrv.fanotes.ink.FORM_DETECT_NOTICE_TEXT
import ch.fasrv.fanotes.ink.FORM_TAKEN_NOTICE_TEXT
import ch.fasrv.fanotes.ink.InkNotice
import ch.fasrv.fanotes.ink.SCRIBBLE_ERASE_NOTICE_TEXT
import ch.fasrv.fanotes.ink.ShapeSnapWatch
import ch.fasrv.fanotes.ink.detectScribbleErase
import ch.fasrv.fanotes.ink.sectionsOf
import ch.fasrv.fanotes.ink.shapeRecognizedNotice
import ch.fasrv.fanotes.ink.shapeSnapProfile
import ch.fasrv.fanotes.ink.snapStrokeToShape
import ch.fasrv.fanotes.ink.strokeLooksLikeShape
import ch.fasrv.fanotes.ink.setSquareApexSign
import ch.fasrv.fanotes.ink.setSquareSize
import ch.fasrv.fanotes.ink.shortestAngleDelta
import ch.fasrv.fanotes.ink.snapAngle
import ch.fasrv.fanotes.ink.snapRadiusMm
import ch.fasrv.fanotes.ink.snapToDraftingTools
import ch.fasrv.fanotes.input.POST_PEN_IGNORE_MS
import ch.fasrv.fanotes.input.parseTabletButtonMap
import ch.fasrv.fanotes.input.pointerButtonFromAndroid
import ch.fasrv.fanotes.input.rejectsUnmappedMouseButton
import ch.fasrv.fanotes.input.shouldInterceptTabletButton
import ch.fasrv.fanotes.input.tabletButtonAction
import ch.fasrv.fanotes.input.tabletButtonIdentityFromPointer
import ch.fasrv.fanotes.input.PalmState
import ch.fasrv.fanotes.input.PointerAction
import ch.fasrv.fanotes.input.PointerSample
import ch.fasrv.fanotes.input.PointerTool
import ch.fasrv.fanotes.input.fingerMayNavigate
import ch.fasrv.fanotes.input.isPenTool
import ch.fasrv.fanotes.input.shouldRejectFinger
import ch.fasrv.fanotes.input.shouldRejectNonPenInk
import ch.fasrv.fanotes.input.tiltDegrees
import ch.fasrv.fanotes.input.touchPalmState
import ch.fasrv.fanotes.text.PaperKind
import ch.fasrv.fanotes.text.PaperLine
import ch.fasrv.fanotes.text.paperImageFrame
import ch.fasrv.fanotes.text.paperImageCaption
import ch.fasrv.fanotes.text.paperImageSource
import ch.fasrv.fanotes.text.paperLines
import ch.fasrv.fanotes.text.tableRows
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

/**
 * Low-latency paper. Stylus (and an optional mouse) writes; fingers scroll,
 * zoom and turn notes. A resting palm is ignored while the pen is down and
 * for [POST_PEN_IGNORE_MS] after it lifts, the same window the desktop uses.
 *
 * Committed ink is cached in page-pixel tiles. The stroke under the nib is
 * drawn on top of that cache, including predicted motion on Android 14+.
 */
data class PaperCameraSample(
    val zoom: Double,
    val rotation: Double,
    val centreX: Double,
    val centreY: Double,
    val pageWidth: Double,
    val pageHeight: Double,
)

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
    var onStroke: (ch.fasrv.fanotes.ink.InkStroke) -> Unit = {}
    var onErased: (Int) -> Unit = {}
    var onInkNotice: (InkNotice) -> Unit = {}
    var onSelection: (Int) -> Unit = {}
    var onPageGrew: (Double, Double, Double, Double, Double, Double) -> Unit = { _, _, _, _, _, _ -> }
    var onPenSample: (Double, Double) -> Unit = { _, _ -> }
    var onSwipeNote: (Int) -> Unit = {}
    var onEdgeHistory: (Int) -> Unit = {}
    var onTogglePaperTask: (Int) -> Unit = {}
    var onCamera: (Float, Float, Float) -> Unit = { _, _, _ -> }
    var onPenActive: (Boolean) -> Unit = {}
    var placingSection = false
    var placingLink = false
    var onLinkChrome: (Boolean, Boolean) -> Unit = { _, _ -> }

    fun publishLinkChrome() = onLinkChrome(placingLink, selectedLinkId != null)
    var linkMarks: List<ch.fasrv.fanotes.desk.NoteLinkMark> = emptyList()
    var worksheetBoxes: List<ch.fasrv.fanotes.desk.AnchoredBox> = emptyList()
    var worksheetHighlights: List<ch.fasrv.fanotes.desk.AnchoredHighlight> = emptyList()
    private var reportedPdfPage = 0
    private var reportedSheet = false
    var onSheetActive: (Boolean) -> Unit = {}
    var onPdfPage: (Int) -> Unit = {}
    var onPdfZoom: (Float, String) -> Unit = { _, _ -> }
    var onPageFocus: () -> Unit = {}
    var pageFrames: List<ch.fasrv.fanotes.desk.PageFrame> = emptyList()
        set(value) {
            field = value
            reportedPdfPage = 0
        }
    var placingHighlight = false
    var placingText = false
    var onPlaceBox: (String, Int, Double, Double) -> Unit = { _, _, _, _ -> }
    var onPlaceHighlight: (String, ch.fasrv.fanotes.desk.WorksheetHighlight) -> Unit = { _, _ -> }
    var onRemoveHighlight: (String) -> Unit = {}
    var onPlaceSection: (Double) -> String = { "" }
    var onSectionChrome: (Boolean) -> Unit = {}
    var sectionGuideY: Float = Float.NaN
    var noteLinkStyle: String = "symbol"
    var selectedLinkId: String? = null
    var onPlaceLink: (Int, Double, Double) -> Unit = { _, _, _ -> }
    var onOpenLink: (String) -> Unit = {}
    var onRemoveLink: (String) -> Unit = {}
    var onToggleSection: (String) -> Unit = { _ -> }
    var onEditBox: (String) -> Unit = { _ -> }
    private val lassoPoints = mutableListOf<StrokePoint>()
    private var lassoing = false
    /** Styled note text, drawn under the ink at the desktop column. */
    var markdown: String = ""
    var editorFontPx: Float = 16f
        set(value) { if (field != value) { field = value; paperBlocks = emptyList(); invalidate() } }
    var editorLineHeight: Float = 1.72f
        set(value) { if (field != value) { field = value; paperBlocks = emptyList(); invalidate() } }
    var contentWidthPx: Float = 820f
        set(value) { if (field != value) { field = value; paperBlocks = emptyList(); invalidate() } }
    var readableLineLength: Boolean = true
        set(value) { if (field != value) { field = value; paperBlocks = emptyList(); invalidate() } }
    var showLineNumbers: Boolean = false
        set(value) {
            if (field == value) return
            field = value
            paperBlocks = emptyList()
            invalidate()
        }
    var workspaceKind: String = "clean"

    fun applyWorkspaceKind(kind: String) {
        val next = ch.fasrv.fanotes.desk.workspaceBackground(kind)
        if (workspaceKind == next) return
        workspaceKind = next
        setBackgroundColor(android.graphics.Color.TRANSPARENT)
        invalidate()
    }
    var editorFontId: String = "jetbrains"
    var editorTypeface: Typeface = Typeface.MONOSPACE
        private set
    var accentSecondary: Int = Color.parseColor("#6B7280")
        set(value) {
            if (field == value) return
            field = value
            if (isAttachedToWindow) {
                paperBlocks = emptyList()
                invalidate()
            }
        }

    fun setEditorFont(id: String) {
        val next = ch.fasrv.fanotes.desk.editorFontId(id)
        if (editorFontId == next && editorTypeface != Typeface.MONOSPACE) return
        editorFontId = next
        editorTypeface = loadEditorTypeface(context, next)
        paperBlocks = emptyList()
        invalidate()
    }
    var zoomMax: Float = 3.25f
    var zoomSpeed: Int = 5
    /** Desk setting `tablet-buttons`, empty until the factory map is read. */
    var tabletButtons: String = ""
    /** When set, only a real stylus lays ink. Fingers still pan and zoom. */
    var penOnly: Boolean = false
    /** When set, the next pen tap stamps this desktop art symbol. */
    var placingSymbol: String? = null
    var symbolSize: Double = ch.fasrv.fanotes.ink.ART_SYMBOL_SIZE
    var symbolRotation: Double = 0.0
    var symbolOpacity: Double = 1.0
    var symbolCategory: String = "all"
    var shapeSnapSensitivity: Int = 50
    var scribbleSensitivity: Int = 50
    /** Selection rings, hover, and placed links follow the desktop accent. */
    var accentColor: Int = Color.parseColor("#2A6F97")
    var strokeSmoothing: Float = 0.68f
        set(value) {
            if (field == value) return
            field = value
            if (isAttachedToWindow) {
                invalidateTiles()
                invalidate()
            }
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
    private var cachedMarkdown = ""
    private var paperBlocks: List<PaperBlock> = emptyList()
    private var cachedImageEpoch = 0
    private var imageEpoch = 0
    var onPaperImages: () -> Unit = {}
    var paperImages: Map<String, android.graphics.Bitmap> = emptyMap()
        set(value) {
            if (field == value) return
            field = value
            imageEpoch += 1
            paperBlocks = emptyList()
            invalidate()
            onPaperImages()
        }
    private val tableLine = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        color = Color.parseColor("#D5D0C8")
    }
    private val tableHead = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
        color = Color.parseColor("#F3F0EA")
    }
    private var cacheScale = 0f
    private var nibX = Float.NaN
    private var nibY = Float.NaN
    private var rotation = 0f
    var rulerPose: DraftingPose? = null
    var setSquarePose: DraftingPose? = null
    var compassPose: DraftingPose? = null
    private var guideDrag: GuideDrag? = null
    private var snapLock: DraftingSnapLock? = null
    private var shapeSnapped = false
    private var didShapeSnap = false
    private var scribbleHintShown = false
    private val shapeWatch = ShapeSnapWatch()
    private val shapeHandler = Handler(Looper.getMainLooper())
    private val shapeDue = Runnable { onShapeDue() }
    private val guideFill = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL; color = Color.parseColor("#D7E4F2") }
    private val guideEdge = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        color = Color.parseColor("#1B4F82")
    }
    private val guideTick = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.parseColor("#1B4F82") }
    private var highlighting = false
    private var highlightStartX = 0.0
    private var highlightStartY = 0.0
    private var highlightEndX = 0.0
    private var highlightEndY = 0.0
    private val highlightPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.parseColor("#FFE566") }
    private val captionPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.parseColor("#282A34") }
    private val cardFill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; style = Paint.Style.FILL }
    private val cardEdge = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#2E3848")
        style = Paint.Style.STROKE
        alpha = 46
    }
    private var worksheetPlacements: List<ch.fasrv.fanotes.desk.WorksheetPlacement> = emptyList()
    private val guideLabel = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#1B4F82")
        textAlign = Paint.Align.CENTER
    }
    private val tiles = HashMap<Long, Bitmap>()
    private var palm = PalmState()
    private var inkPointer = MotionEvent.INVALID_POINTER_ID
    private var erasing = false
    private var tabletPanId = MotionEvent.INVALID_POINTER_ID
    private var tabletPanX = 0f
    private var tabletPanY = 0f
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
    private var navTap = false
    private var navTapX = 0f
    private var navTapY = 0f
    private var zoom = 1f
    private var pageLeft = 0f
    private var pageTop = 0f
    private var pendingCamera: PendingCamera? = null

    private data class PendingCamera(val zoom: Float, val rotation: Float, val centreX: Double, val centreY: Double)
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
        cachedMarkdown = ""
        paperBlocks = emptyList()
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

    fun revealY(y: Double) {
        val scale = pixelsPerPageUnit()
        pageTop = height / 2f - (y.coerceIn(0.0, 1.0) * sessionHeight() * scale).toFloat()
        invalidate()
        publishCamera()
    }

    fun zoomBy(multiplier: Float) {
        zoom = clampZoom(zoom * multiplier)
        settleZoom()
        invalidate()
        publishCamera()
    }

    /** Desktop zoom buttons add or subtract `zoomStepFromSpeed`, they do not multiply. */
    fun zoomByStep(direction: Int) {
        val step = ch.fasrv.fanotes.desk.zoomStepFromSpeed(zoomSpeed)
        zoom = clampZoom((zoom + direction * step).toFloat())
        settleZoom()
        invalidate()
        publishCamera()
    }

    /** Desktop PDF toolbar: Breite, Ganze Seite, and the multiplicative ± steps. */
    fun applyPdfCamera(command: String) {
        val fit = measurePdfFit()
        when (command) {
            "fit-width" -> setCameraZoom(fit.width.toFloat())
            "fit-page" -> setCameraZoom(fit.page.toFloat())
            "in" -> setCameraZoom(ch.fasrv.fanotes.desk.pdfZoomStep(zoom.toDouble(), 1, 0.5, zoomMax.toDouble()).toFloat())
            "out" -> setCameraZoom(ch.fasrv.fanotes.desk.pdfZoomStep(zoom.toDouble(), -1, 0.5, zoomMax.toDouble()).toFloat())
            "rotate" -> {
                rotatePage()
                publishCamera()
            }
        }
    }

    fun setCameraZoom(value: Float) {
        zoom = clampZoom(value)
        settleZoom()
        invalidate()
        publishCamera()
    }

    private fun measurePdfFit(): ch.fasrv.fanotes.desk.PdfFitZoom {
        val base = (width - padding() * 2).coerceAtLeast(1f) / ch.fasrv.fanotes.ink.PAGE_START_WIDTH.toFloat()
        val column = sessionWidth() * base
        val frameHeight = pageFrames.firstOrNull()?.height ?: sessionHeight()
        val pageHeight = frameHeight * base
        return ch.fasrv.fanotes.desk.pdfFitZoom(
            ch.fasrv.fanotes.desk.PdfFitInput(
                viewWidth = width.toDouble().coerceAtLeast(1.0),
                viewHeight = height.toDouble().coerceAtLeast(1.0),
                columnWidth = column.toDouble(),
                pageHeight = pageHeight,
                min = 0.5,
                max = zoomMax.toDouble(),
            ),
        )
    }

    fun rotatePage() {
        rotation = ch.fasrv.fanotes.desk.rotateViewBy(rotation.toDouble(), 1, 90).toFloat()
        invalidate()
        publishCamera()
    }

    /** Desktop sheet HUD: 15 degrees, either direction. */
    fun rotateBy(direction: Int) {
        rotation = ch.fasrv.fanotes.desk.rotateViewBy(rotation.toDouble(), direction).toFloat()
        invalidate()
        publishCamera()
    }

    fun resetView() {
        zoom = 1f
        rotation = 0f
        pageLeft = padding()
        pageTop = padding()
        settleZoom()
        invalidate()
        publishCamera()
    }

    /** Page point under the middle of the screen, in source pixels. */
    fun cameraSample(): PaperCameraSample? {
        if (width <= 0 || height <= 0) return null
        val scale = pixelsPerPageUnit().toDouble().coerceAtLeast(0.0001)
        return PaperCameraSample(
            zoom = zoom.toDouble(),
            rotation = rotation.toDouble(),
            centreX = ((width / 2f - pageLeft) / scale).coerceAtLeast(0.0),
            centreY = ((height / 2f - pageTop) / scale).coerceAtLeast(0.0),
            pageWidth = sessionWidth(),
            pageHeight = sessionHeight(),
        )
    }

    fun restoreCamera(zoom: Double, rotation: Double, centreX: Double, centreY: Double, savedPageWidth: Double?, proportional: Boolean) {
        val scaled = ch.fasrv.fanotes.desk.scaledPaperCentre(centreX, centreY, savedPageWidth, sessionWidth(), proportional)
        pendingCamera = PendingCamera(zoom.toFloat(), rotation.toFloat(), scaled.centreX, scaled.centreY)
        if (width > 0 && height > 0) applyPendingCamera()
    }

    private fun applyPendingCamera() {
        val request = pendingCamera ?: return
        if (width <= 0 || height <= 0) return
        pendingCamera = null
        zoom = clampZoom(request.zoom)
        rotation = request.rotation
        val scale = pixelsPerPageUnit()
        pageLeft = width / 2f - (request.centreX * scale).toFloat()
        pageTop = height / 2f - (request.centreY * scale).toFloat()
        settleZoom()
        invalidate()
        publishCamera()
    }

    fun guideOn(kind: DraftingKind) = when (kind) {
        DraftingKind.RULER -> rulerPose != null
        DraftingKind.SET_SQUARE -> setSquarePose != null
        DraftingKind.COMPASS -> compassPose != null
    }

    fun toggleGuide(kind: DraftingKind) {
        when (kind) {
            DraftingKind.RULER -> rulerPose = if (rulerPose == null) defaultRulerPose() else null
            DraftingKind.SET_SQUARE -> setSquarePose = if (setSquarePose == null) defaultSetSquarePose() else null
            DraftingKind.COMPASS -> compassPose = if (compassPose == null) defaultCompassPose() else null
        }
        invalidate()
    }

    /** Drops a full circle at the compass radius, the same construction the desktop commits. */
    fun drawCompassCircle() {
        val pose = compassPose ?: defaultCompassPose().also { compassPose = it }
        val current = session ?: return
        val samples = sampleCompassCircle(pose, sessionWidth(), sessionHeight(), sheetDisplay())
        val points = samples.map { sample -> StrokePoint(sample.x, sample.y, 0.0, 0.45, 0.0, 0.0, "pen") }
        val before = current.document
        val stroke = current.commitShape(points, style, nowIso()) ?: return
        settleGrownPage(before)
        invalidateTiles(stroke)
        onChanged()
        invalidate()
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        if (oldw == 0) {
            pageLeft = padding()
            pageTop = padding()
        }
        clipBounds = android.graphics.Rect(0, 0, w, h)
        invalidateTiles()
        if (w > 0 && h > 0 && pendingCamera != null) applyPendingCamera() else publishCamera()
    }

    override fun onHoverEvent(event: MotionEvent): Boolean {
        if (placingSection) {
            sectionGuideY = screenToNorm(event.x, event.y).second.toFloat()
            invalidate()
        }
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
        if (placingSection) {
            sectionGuideY = screenToNorm(event.x, event.y).second.toFloat()
            invalidate()
        }
        velocity?.addMovement(event)
        val action = event.actionMasked
        val index = event.actionIndex
        val id = event.getPointerId(index)
        val tool = toolOf(event, index)
        val now = SystemClock.uptimeMillis()
        when (action) {
            MotionEvent.ACTION_DOWN, MotionEvent.ACTION_POINTER_DOWN -> {
                if (action == MotionEvent.ACTION_DOWN) onPageFocus()
                pendingCamera = null
                val sample = sample(event, index, PointerAction.DOWN)
                palm = touchPalmState(palm, sample)
                val asStylus = isPenTool(tool) || (palm.lastStylusAt > 0L && now - palm.lastStylusAt < POST_PEN_IGNORE_MS)
                val identity = tabletButtonIdentityFromPointer(
                    pointerButtonFromAndroid(event.getToolType(index), event.buttonState),
                    asStylus,
                )
                val buttonAction = tabletButtonAction(parseTabletButtonMap(tabletButtons), identity)
                if (identity != null && !shouldInterceptTabletButton(buttonAction)) return true
                if (identity != null && buttonAction in setOf("none", "undo", "redo", "pan")) {
                    when (buttonAction) {
                        "undo" -> if (session?.undo() == true) {
                            invalidateTiles()
                            onChanged()
                        }
                        "redo" -> if (session?.redo() == true) {
                            invalidateTiles()
                            onChanged()
                        }
                        "pan" -> {
                            tabletPanId = id
                            tabletPanX = event.getX(index)
                            tabletPanY = event.getY(index)
                            if (isPenTool(tool)) requestUnbufferedDispatch(event)
                        }
                    }
                    invalidate()
                    return true
                }
                if (rejectsUnmappedMouseButton(identity, event.getToolType(index), event.buttonState)) return true
                val pointerType = when {
                    isPenTool(tool) -> "pen"
                    tool == PointerTool.FINGER -> "touch"
                    tool == PointerTool.MOUSE -> "mouse"
                    else -> "unknown"
                }
                val rejectInk = identity == null && shouldRejectNonPenInk(pointerType, penOnly)
                if (!rejectInk && (isPenTool(tool) || tool == PointerTool.MOUSE || (tool == PointerTool.FINGER && fingerDraws))) {
                    if (shouldRejectFinger(tool, palm, now, fingerDraws)) return true
                    if (inkPointer != MotionEvent.INVALID_POINTER_ID) return true
                    inkPointer = id
                    if (isPenTool(tool)) requestUnbufferedDispatch(event)
                    beginInk(event, index, tool, identity, buttonAction)
                } else if (guideDrag != null) {
                    // A tool already owns this gesture. A second finger does not pan it away.
                } else if (fingerMayNavigate(palm, now)) {
                    if (fingers.isEmpty() && tryBeginGuideDrag(id, event, index)) {
                        navTap = false
                    } else {
                        if (fingers.isEmpty()) {
                            navTapX = event.getX(index)
                            navTapY = event.getY(index)
                            navTap = true
                        } else {
                            navTap = false
                        }
                        fingers[id] = event.getX(index) to event.getY(index)
                    }
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
                if (tabletPanId != MotionEvent.INVALID_POINTER_ID) {
                    val panIndex = event.findPointerIndex(tabletPanId)
                    if (panIndex >= 0) {
                        val x = event.getX(panIndex)
                        val y = event.getY(panIndex)
                        pageLeft += x - tabletPanX
                        pageTop += y - tabletPanY
                        tabletPanX = x
                        tabletPanY = y
                        invalidate()
                        publishCamera()
                    }
                    return true
                }
                if (inkPointer != MotionEvent.INVALID_POINTER_ID) {
                    val inkIndex = event.findPointerIndex(inkPointer)
                    if (inkIndex >= 0) moveInk(event, inkIndex)
                } else if (guideDrag != null) {
                    moveGuide(event)
                } else if (fingerMayNavigate(palm, now)) {
                    if (navTap) {
                        val dx = event.x - navTapX
                        val dy = event.y - navTapY
                        if (dx * dx + dy * dy > 24f * 24f) navTap = false
                    }
                    moveFingers(event)
                    if (fingers.size == 1) gestures.onTouchEvent(event)
                }
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_POINTER_UP, MotionEvent.ACTION_CANCEL -> {
                if (id == tabletPanId || action == MotionEvent.ACTION_CANCEL) tabletPanId = MotionEvent.INVALID_POINTER_ID
                if (guideDrag?.pointerId == id || action == MotionEvent.ACTION_CANCEL) guideDrag = null
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
                val taskTap = navTap && fingers.size == 1 && fingers.containsKey(id) && action != MotionEvent.ACTION_CANCEL
                if (fingers.remove(id) != null && fingers.size < 2 && action != MotionEvent.ACTION_CANCEL) {
                    if (taskTap && tryTogglePaperTask(event.getX(index), event.getY(index))) navTap = false
                    else maybeSwipe(event)
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

    private fun beginInk(event: MotionEvent, index: Int, tool: PointerTool, identity: String?, action: String) {
        val current = session ?: return
        onPenActive(true)
        trackNib(event, index)
        val eraser = when {
            identity != null && action == "eraser" -> true
            identity != null -> inkTool == InkTool.ERASER
            else -> tool == PointerTool.ERASER || inkTool == InkTool.ERASER
        }
        val (x, y) = screenToNorm(event.getX(index), event.getY(index))
        val sectionHit = sectionsOf(current.document).firstOrNull { y >= it.top && y < it.bodyTop && x < 0.08 }
        when {
            !eraser && placingSymbol != null -> {
                val symbolId = placingSymbol!!
                val stamped = current.placeSymbol(x, y, style, symbolId, nowIso(), symbolSize, symbolRotation, symbolOpacity)
                invalidateTiles()
                if (stamped != null) {
                    onStroke(stamped)
                    val label = ch.fasrv.fanotes.ink.artSymbol(symbolId)?.label ?: symbolId
                    onInkNotice(ch.fasrv.fanotes.ink.InkNotice("success", ch.fasrv.fanotes.ink.symbolPlacedNotice(label)))
                }
                onChanged()
                onPenActive(false)
                inkPointer = MotionEvent.INVALID_POINTER_ID
            }
            sectionHit != null && !eraser -> {
                onToggleSection(sectionHit.id)
                refresh()
                onPenActive(false)
                inkPointer = MotionEvent.INVALID_POINTER_ID
            }
            placingSection -> {
                placingSection = false
                sectionGuideY = Float.NaN
                val notice = onPlaceSection(y)
                onSectionChrome(false)
                if (notice.isNotEmpty()) {
                    onInkNotice(ch.fasrv.fanotes.ink.InkNotice(if (notice == ch.fasrv.fanotes.ink.SECTION_PLACE_DONE) "success" else "info", notice))
                }
                onPenActive(false)
                inkPointer = MotionEvent.INVALID_POINTER_ID
            }
            placingLink -> {
                val point = ch.fasrv.fanotes.desk.noteLinkPointOnSheet(x, y, pageFrames, sessionWidth().toDouble(), sessionHeight().toDouble())
                onPlaceLink(point.page, point.x, point.y)
                placingLink = false
                publishLinkChrome()
                onPenActive(false)
                inkPointer = MotionEvent.INVALID_POINTER_ID
            }
            linkHit(x, y) != null && !eraser -> {
                linkHit(x, y)?.let { link ->
                    selectedLinkId = link.id
                    publishLinkChrome()
                    onOpenLink(link.targetPath)
                    onPenActive(false)
                    inkPointer = MotionEvent.INVALID_POINTER_ID
                }
            }
            worksheetBoxes.firstOrNull { anchored -> hitWorksheetBox(anchored, x, y) } != null && !eraser -> {
                onEditBox(worksheetBoxes.first { anchored -> hitWorksheetBox(anchored, x, y) }.box.id)
                onPenActive(false)
                inkPointer = MotionEvent.INVALID_POINTER_ID
            }
            placingText && !eraser -> {
                val placements = currentPlacements(pixelsPerPageUnit())
                worksheetPlacements = placements
                val width = sessionWidth()
                val height = sessionHeight()
                val frame = placements.firstOrNull { pointOnFrame(x, y, it, width, height) != null }
                if (frame != null) {
                    val local = pointOnFrame(x, y, frame, width, height)
                    if (local != null) {
                        onPlaceBox(frame.id, frame.page, local.first, local.second)
                        placingText = false
                    }
                }
                onPenActive(false)
                inkPointer = MotionEvent.INVALID_POINTER_ID
            }
            inkTool == InkTool.LASSO -> {
                lassoing = true
                lassoPoints.clear()
                lassoPoints += StrokePoint(x, y, 0.0, 0.0, 0.0, 0.0, "pen")
            }
            eraser -> {
                erasing = true
                current.beginErase()
                current.eraseSamples(listOf(point(event, index, x, y)), eraserRadius(), nowIso())
                onChanged()
            }
            placingHighlight -> {
                highlighting = true
                highlightStartX = x
                highlightStartY = y
                highlightEndX = x
                highlightEndY = y
            }
            inkTool == InkTool.SELECT -> {
                selecting = true
                movingSelection = hitSelection(x, y)
                anchorX = x
                anchorY = y
                selectRect = floatArrayOf(x.toFloat(), y.toFloat(), x.toFloat(), y.toFloat())
            }
            else -> {
                shapeSnapped = false
                didShapeSnap = false
                shapeWatch.begin(SystemClock.uptimeMillis())
                clearShapeWatch()
                val raw = pageNorm(event.getX(index), event.getY(index))
                val hit = snapToDraftingTools(raw.first, raw.second, visibleTools(), sessionWidth(), sessionHeight(), null, sheetDisplay())
                snapLock = hit?.let { DraftingSnapLock(it.kind, it.edgeIndex) }
                current.beginStroke()
                addGrownSample(current, penSample(event, index))
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
        if (highlighting) {
            val (x, y) = screenToNorm(event.getX(index), event.getY(index))
            highlightEndX = x
            highlightEndY = y
        } else if (lassoing) {
            val (x, y) = screenToNorm(event.getX(index), event.getY(index))
            lassoPoints += StrokePoint(x, y, 0.0, 0.0, 0.0, 0.0, "pen")
        } else if (erasing) {
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
            if (!shapeSnapped) {
                for (h in 0 until history) addGrownSample(current, penSample(event, index, h))
                val samplePoint = penSample(event, index)
                val previous = current.livePoints.lastOrNull()
                if (addGrownSample(current, samplePoint)) onPenSample(samplePoint.x, samplePoint.y)
                val distance = if (previous == null) 1.0 else {
                    hypot(
                        (samplePoint.x - previous.x) * sessionWidth(),
                        (samplePoint.y - previous.y) * sessionHeight(),
                    )
                }
                armShapeWatch(distance)
                predicted = if (shapeSnapped) emptyList() else predict(event)
            }
        }
        invalidate()
    }

    private fun finishInk(cancel: Boolean) {
        val current = session ?: return
        predicted = emptyList()
        snapLock = null
        onPenActive(false)
        if (highlighting) {
            highlighting = false
            placingHighlight = false
            if (!cancel) commitHighlight()
            invalidate()
            return
        }
        if (lassoing) {
            lassoing = false
            current.selectIndices(lassoHits(current.document.strokes, lassoPoints.toList()))
            lassoPoints.clear()
            val found = current.selection.isNotEmpty()
            onInkNotice(
                ch.fasrv.fanotes.ink.InkNotice(
                    "info",
                    if (found) ch.fasrv.fanotes.ink.SELECT_DRAG_NOTICE else ch.fasrv.fanotes.ink.SELECT_EMPTY_NOTICE,
                ),
            )
            onSelection(current.selection.size)
            invalidateTiles()
            invalidate()
            return
        }
        when {
            erasing -> {
                erasing = false
                val before = current.document.strokes.size
                current.endErase()
                val removed = before - current.document.strokes.size
                if (removed > 0) onErased(removed)
            }
            selecting -> {
                selecting = false
                if (!movingSelection) {
                    val rect = selectRect
                    if (rect != null) {
                        val left = min(rect[0], rect[2]).toDouble()
                        val top = min(rect[1], rect[3]).toDouble()
                        val width = abs(rect[2] - rect[0]).toDouble()
                        val height = abs(rect[3] - rect[1]).toDouble()
                        if (width < 0.012 || height < 0.012) {
                            current.clearSelection()
                            onInkNotice(ch.fasrv.fanotes.ink.InkNotice("info", ch.fasrv.fanotes.ink.SELECT_HINT_NOTICE))
                        } else {
                            current.selectRect(ch.fasrv.fanotes.ink.NormalizedRect(left, top, width, height))
                            onInkNotice(
                                ch.fasrv.fanotes.ink.InkNotice(
                                    "info",
                                    if (current.selection.isEmpty()) ch.fasrv.fanotes.ink.SELECT_EMPTY_NOTICE else ch.fasrv.fanotes.ink.SELECT_DRAG_NOTICE,
                                ),
                            )
                        }
                    }
                }
                movingSelection = false
                selectRect = null
                onSelection(current.selection.size)
                invalidateTiles()
            }
            cancel -> {
                shapeSnapped = false
                didShapeSnap = false
                clearShapeWatch()
                current.cancelStroke()
            }
            else -> {
                val profile = shapeSnapProfile(shapeSnapSensitivity)
                val heldLongEnough = SystemClock.uptimeMillis() - shapeWatch.lastMoveAtMs >= profile.dwellMs
                clearShapeWatch()
                if (heldLongEnough && !shapeSnapped) trySnapLive()
                val tookShape = didShapeSnap
                shapeSnapped = false
                val live = current.livePoints
                val scribble = if (inkTool == InkTool.PEN && live.size >= 8) {
                    detectScribbleErase(
                        InkStroke(live, style.baseWidth, style.pressureEnabled, style.color),
                        current.document.strokes,
                        sessionWidth(),
                        sessionHeight(),
                        scribbleSensitivity,
                    )
                } else {
                    null
                }
                if (scribble != null && current.dropStrokes(scribble.indexes.toSet(), nowIso())) {
                    current.cancelStroke()
                    invalidateTiles()
                    onErased(scribble.indexes.size)
                    onChanged()
                    if (!scribbleHintShown) {
                        scribbleHintShown = true
                        onInkNotice(InkNotice("success", SCRIBBLE_ERASE_NOTICE_TEXT))
                    }
                } else {
                    val stroke = current.endStroke(style, nowIso())
                    if (stroke != null) {
                        invalidateTiles(stroke)
                        onStroke(stroke)
                        onChanged()
                        if (tookShape) onInkNotice(InkNotice("success", FORM_TAKEN_NOTICE_TEXT))
                    }
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
            val ratio = span / pinchStart.coerceAtLeast(1f)
            val next = clampZoom(ch.fasrv.fanotes.desk.pinchZoom(pinchZoom.toDouble(), ratio.toDouble(), zoomSpeed).toFloat())
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
        val direction = ch.fasrv.fanotes.desk.swipeDirection(event.x - navTapX, event.y - navTapY)
        val history = direction?.let { ch.fasrv.fanotes.desk.paperEdgeHistory(navTapX, width.toFloat(), it) }
        if (history != null) {
            onEdgeHistory(history)
            return
        }
        val tracker = velocity ?: return
        tracker.computeCurrentVelocity(1000)
        val vx = tracker.xVelocity
        val vy = tracker.yVelocity
        if (zoom > 1.15f) return
        if (abs(vx) < 900f || abs(vx) < abs(vy) * 1.3f) return
        onSwipeNote(if (vx < 0) 1 else -1)
    }

    /** A stationary finger tap on a paper task box checks that source line. */
    private fun tryTogglePaperTask(x: Float, y: Float): Boolean {
        if (!showMarkdown || markdown.isBlank()) return false
        val scale = pixelsPerPageUnit()
        if (scale <= 0f) return false
        val point = unrotated(x, y)
        val originX = (session?.document?.originX ?: 0.0).toFloat()
        val originY = (session?.document?.originY ?: 0.0).toFloat()
        val textX = point.first - pageLeft - (TEXT_PAD_X + originX) * scale
        val textY = point.second - pageTop - (TEXT_PAD_Y + originY) * scale
        if (textX < -8f || textY < 0f) return false
        textPaint.textSize = editorFontPx * scale
        textPaint.typeface = editorTypeface
        val taskBox = ch.fasrv.fanotes.desk.paperTaskBox(editorFontPx * scale)
        val boxWidth = taskBox.size + taskBox.gap
        var top = 0f
        for (block in paperBlocks(scale)) {
            when (block) {
                is PaperBlock.Text -> {
                    val bottom = top + block.layout.height
                    if (textY >= top && textY < bottom) {
                        val visual = block.layout.getLineForVertical((textY - top).toInt().coerceAtLeast(0))
                        val offset = block.layout.getLineStart(visual)
                        var paragraph = -1
                        for (index in block.paragraphStarts.indices) {
                            if (block.paragraphStarts[index] <= offset) paragraph = index
                        }
                        val source = block.taskSources.getOrNull(paragraph) ?: -1
                        if (paragraph >= 0 && source >= 0 && block.layout.getLineStart(visual) == block.paragraphStarts[paragraph]) {
                            val boxLeft = block.layout.getPrimaryHorizontal(block.paragraphStarts[paragraph])
                            if (textX >= boxLeft - 8f && textX <= boxLeft + boxWidth) {
                                onTogglePaperTask(source)
                                return true
                            }
                        }
                        return false
                    }
                    top = bottom
                }
                is PaperBlock.Table -> {
                    var height = 10f * scale
                    block.rowHeights.forEach { height += it }
                    top += height
                }
                is PaperBlock.Image -> top += block.frameHeight + 24f * scale
            }
        }
        return false
    }

    private fun unrotated(x: Float, y: Float): Pair<Float, Float> {
        if (rotation == 0f) return x to y
        val cx = width / 2f
        val cy = height / 2f
        val radians = Math.toRadians(-rotation.toDouble())
        val cosine = cos(radians)
        val sine = sin(radians)
        val dx = x - cx
        val dy = y - cy
        return (cx + (dx * cosine - dy * sine)).toFloat() to (cy + (dx * sine + dy * cosine)).toFloat()
    }

    private fun predict(event: MotionEvent): List<StrokePoint> {
        // MotionPredictor wants an absolute uptime in nanoseconds, a frame ahead of this sample.
        val futureNanos = event.eventTime * 1_000_000L + 16_000_000L
        val predictedEvent = predictor?.predict(futureNanos) ?: return emptyList()
        predictedEvent.use { motion ->
            if (motion.pointerCount == 0) return emptyList()
            val raw = pageNorm(motion.x, motion.y)
            val snapped = snapPen(raw.first, raw.second)
            return listOf(point(motion, 0, snapped.first, snapped.second, predicted = true))
        }
    }

    override fun onDraw(canvas: Canvas) {
        canvas.save()
        canvas.clipRect(0f, 0f, width.toFloat(), height.toFloat())
        if (workspaceKind == "clean") canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), desk)
        canvas.save()
        if (rotation != 0f) canvas.rotate(rotation, width / 2f, height / 2f)
        val current = session ?: run {
            canvas.restore()
            canvas.restore()
            return
        }
        val scale = pixelsPerPageUnit()
        if (cacheScale == 0f) cacheScale = scale.coerceIn(MIN_CACHE_SCALE, MAX_CACHE_SCALE)
        val placements = currentPlacements(scale)
        worksheetPlacements = placements
        val cover = placements.maxOfOrNull { it.top + it.height + 36.0 } ?: 0.0
        val pageWidth = (current.document.sourceWidth * scale).toFloat()
        val pageHeight = (max(current.document.sourceHeight, cover) * scale).toFloat()
        canvas.drawRect(pageLeft, pageTop, pageLeft + pageWidth, pageTop + pageHeight, paper)
        val worksheets = backdrop.any { it.worksheetId.isNotEmpty() }
        if (backdrop.isEmpty() || worksheets) drawRuling(canvas, current.document.paperStyle, (current.document.sourceWidth * scale).toFloat(), (current.document.sourceHeight * scale).toFloat(), scale)
        drawBackdrop(canvas, scale, placements)
        if (showMarkdown && markdown.isNotBlank()) drawMarkdown(canvas, scale)
        drawTiles(canvas, current, scale)
        val live = current.livePoints
        if (live.isNotEmpty()) {
            canvas.save()
            canvas.translate(pageLeft, pageTop)
            drawStroke(
                canvas,
                InkStroke(live + predicted, style.baseWidth, style.pressureEnabled, style.color, brush = style.brush, opacity = brushOpacity(style.brush), colorEffect = style.colorEffect),
                scale,
            )
            canvas.restore()
        }
        hoverPaint.color = accentColor
        selectPaint.color = accentColor
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
        sectionsOf(current.document).forEach { section ->
            val top = pageTop + (section.top * current.document.sourceHeight * scale).toFloat()
            val bottom = pageTop + (section.bodyTop * current.document.sourceHeight * scale).toFloat()
            ruling.color = accentColor
            ruling.alpha = 40
            canvas.drawRect(pageLeft, top, pageLeft + pageWidth, bottom, ruling)
            textPaint.color = accentColor
            textPaint.textSize = 18f * resources.displayMetrics.density
            canvas.drawText(if (section.collapsed) "▸" else "▾", pageLeft + 8f, bottom - 8f, textPaint)
            textPaint.color = Color.parseColor("#252630")
        }
        if (placingSection && !sectionGuideY.isNaN()) {
            val guide = pageTop + (sectionGuideY * current.document.sourceHeight * scale).toFloat()
            ruling.color = accentColor
            ruling.alpha = 180
            canvas.drawLine(pageLeft, guide, pageLeft + pageWidth, guide, ruling)
            textPaint.color = accentColor
            textPaint.textSize = 14f * resources.displayMetrics.density
            canvas.drawText(ch.fasrv.fanotes.ink.SECTION_GUIDE_LABEL, pageLeft + 12f, guide - 6f, textPaint)
            textPaint.color = Color.parseColor("#252630")
        }
        linkMarks.forEach { link ->
            val sheet = ch.fasrv.fanotes.desk.noteLinkToSheet(link, pageFrames, sessionWidth().toDouble(), sessionHeight().toDouble())
            val (sx, sy) = normToScreen(sheet.first, sheet.second)
            val appearance = ch.fasrv.fanotes.desk.noteLinkAppearanceToken(link.style)
            if (appearance != "text") {
                canvas.drawCircle(sx, sy, 10f * resources.displayMetrics.density, hoverPaint)
            }
            if (appearance != "symbol") {
                textPaint.color = accentColor
                textPaint.textSize = 14f * resources.displayMetrics.density
                canvas.drawText(link.label.ifBlank { "Notiz" }, sx + if (appearance == "text") 0f else 14f, sy + 6f, textPaint)
                textPaint.color = Color.parseColor("#252630")
            }
        }
        drawHighlights(canvas)
        worksheetBoxes.forEach { anchored ->
            val place = worksheetPlacements.firstOrNull { it.id == anchored.worksheetId && it.page == anchored.box.page.coerceAtLeast(1) } ?: return@forEach
            val sheet = ch.fasrv.fanotes.desk.boxOnFrame(anchored.box, place, sessionWidth(), sessionHeight())
            val (sx, sy) = normToScreen(sheet.first, sheet.second)
            val boxWidth = (anchored.box.width * place.width * scale).toFloat().coerceAtLeast(48f * scale)
            val fontSize = (anchored.box.fontSize * scale).toFloat().coerceAtLeast(12f)
            val chars = ch.fasrv.fanotes.desk.worksheetCharsPerLine(boxWidth, fontSize, scale)
            val lines = ch.fasrv.fanotes.desk.wrapBoxLines(anchored.box.text.ifEmpty { "Text" }, chars)
            val lineHeight = fontSize * 1.35f
            val boxHeight = ch.fasrv.fanotes.desk.worksheetCardHeightPx(anchored.box.text, boxWidth, fontSize, scale)
            val top = sy - boxHeight + 8f * scale
            cardFill.color = Color.argb(184, 255, 255, 255)
            canvas.drawRect(sx, top, sx + boxWidth, sy + 8f * scale, cardFill)
            cardEdge.strokeWidth = max(1f, scale * 0.6f)
            canvas.drawRect(sx, top, sx + boxWidth, sy + 8f * scale, cardEdge)
            cardFill.color = Color.WHITE
            textPaint.color = if (anchored.box.text.isEmpty()) Color.parseColor("#747887") else Color.parseColor("#202333")
            textPaint.textSize = fontSize
            var baseline = top + 6f * scale + fontSize
            for (line in lines) {
                canvas.drawText(line, sx + 6f * scale, baseline, textPaint)
                baseline += lineHeight
            }
            textPaint.color = Color.parseColor("#252630")
        }
        if (lassoPoints.size > 1) {
            val path = Path()
            val first = lassoPoints.first()
            val (sx, sy) = normToScreen(first.x, first.y)
            path.moveTo(sx, sy)
            lassoPoints.drop(1).forEach { point ->
                val (px, py) = normToScreen(point.x, point.y)
                path.lineTo(px, py)
            }
            canvas.drawPath(path, selectPaint)
        }
        drawGuides(canvas)
        canvas.restore()
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
            val pad = if (stroke.symbolId != null) stroke.baseWidth else 40.0
            px >= x - pad && px <= x + tile + pad && py >= y - pad && py <= y + tile + pad
        }
    }

    private fun drawStroke(canvas: Canvas, stroke: InkStroke, scale: Float) {
        if (stroke.points.isEmpty()) return
        inkPaint.color = parseColor(stroke.color)
        inkPaint.alpha = 255
        if (stroke.symbolId != null) {
            drawArtSymbol(canvas, inkPaint, stroke, scale, sessionWidth(), sessionHeight())
            return
        }
        if (stroke.brush == "spray") {
            drawSpray(canvas, inkPaint, stroke, scale, sessionWidth(), sessionHeight())
            return
        }
        if (stroke.brush == "marker") {
            drawMarkerStroke(canvas, inkPaint, stroke, scale, sessionWidth(), sessionHeight(), strokeSmoothing.toDouble(), parseColor(stroke.color))
            return
        }
        if (stroke.brush == "calligraphy") {
            drawCalligraphyStroke(canvas, inkPaint, stroke, scale, sessionWidth(), sessionHeight(), parseColor(stroke.color))
            return
        }
        drawBrushPasses(
            canvas,
            inkPaint,
            stroke,
            sessionWidth(),
            sessionHeight(),
            scale,
            strokeSmoothing.toDouble(),
            parseColor(stroke.color),
        )
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

    private fun drawBackdrop(canvas: Canvas, scale: Float, placements: List<ch.fasrv.fanotes.desk.WorksheetPlacement>) {
        if (placements.isEmpty()) {
            for (slice in backdrop) {
                val bitmap = slice.bitmap ?: continue
                val top = pageTop + slice.topPagePx * scale
                val destHeight = slice.heightPagePx * scale
                val destWidth = slice.widthPagePx * scale
                canvas.drawBitmap(bitmap, null, android.graphics.RectF(pageLeft, top, pageLeft + destWidth, top + destHeight), tilePaint)
            }
            return
        }
        cardEdge.strokeWidth = max(1f, scale)
        for (place in placements) {
            val slice = backdrop.firstOrNull { it.worksheetId == place.id && it.page == place.page } ?: continue
            val bitmap = slice.bitmap ?: continue
            val left = pageLeft + place.left.toFloat() * scale
            val top = pageTop + place.top.toFloat() * scale
            val right = left + place.width.toFloat() * scale
            val bottom = top + place.height.toFloat() * scale
            val card = android.graphics.RectF(left, top, right, bottom)
            canvas.drawRect(card, cardFill)
            canvas.drawBitmap(bitmap, null, card, tilePaint)
            canvas.drawRect(card, cardEdge)
            if (place.captionTop >= 0.0 && slice.label.isNotEmpty()) {
                captionPaint.textSize = 13f * scale
                canvas.drawText(slice.label, left, pageTop + (place.captionTop + 18.0).toFloat() * scale, captionPaint)
            }
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
        return when (event.getToolType(index)) {
            MotionEvent.TOOL_TYPE_ERASER -> PointerTool.ERASER
            MotionEvent.TOOL_TYPE_STYLUS -> PointerTool.STYLUS
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
        val mapped = if (x != null && y != null) x to y else screenToNorm(sx, sy)
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

    private fun screenToNorm(x: Float, y: Float) = pageNorm(x, y)

    private fun pageNorm(x: Float, y: Float): Pair<Double, Double> {
        val (ux, uy) = unrotate(x, y)
        val scale = pixelsPerPageUnit().toDouble().coerceAtLeast(0.0001)
        return (ux - pageLeft) / scale / sessionWidth() to (uy - pageTop) / scale / sessionHeight()
    }

    private fun unrotate(x: Float, y: Float): Pair<Float, Float> {
        if (rotation == 0f) return x to y
        val cx = width / 2f
        val cy = height / 2f
        val radians = Math.toRadians(-rotation.toDouble())
        val dx = (x - cx).toDouble()
        val dy = (y - cy).toDouble()
        val cosine = kotlin.math.cos(radians)
        val sine = kotlin.math.sin(radians)
        return (dx * cosine - dy * sine).toFloat() + cx to (dx * sine + dy * cosine).toFloat() + cy
    }

    private fun normToScreen(x: Double, y: Double): Pair<Float, Float> {
        val scale = pixelsPerPageUnit()
        return pageLeft + (x * sessionWidth() * scale).toFloat() to pageTop + (y * sessionHeight() * scale).toFloat()
    }

    fun textColumnPx(): Float = ch.fasrv.fanotes.desk.effectiveContentWidth(
        contentWidthPx.toInt(),
        sessionWidth().toFloat(),
        readableLineLength,
        TEXT_PAD_X,
    )

    private fun clampZoom(value: Float) = value.coerceIn(0.5f, zoomMax.coerceIn(0.5f, 6f))

    private fun pixelsPerPageUnit(): Float {
        val available = (width - padding() * 2).coerceAtLeast(1f)
        return available / PAGE_START_WIDTH.toFloat() * zoom
    }

    private fun linkHit(x: Double, y: Double): ch.fasrv.fanotes.desk.NoteLinkMark? {
        val width = sessionWidth().toDouble()
        val height = sessionHeight().toDouble()
        return linkMarks.firstOrNull { link ->
            val sheet = ch.fasrv.fanotes.desk.noteLinkToSheet(link, pageFrames, width, height)
            kotlin.math.hypot(sheet.first - x, sheet.second - y) < 0.04
        }
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
        publishSheetActive()
        if (pageFrames.isEmpty()) return
        val scale = pixelsPerPageUnit().toDouble().coerceAtLeast(0.0001)
        val center = (height / 2.0 - pageTop) / scale
        val page = ch.fasrv.fanotes.desk.pdfPageAt(center, pageFrames.map { it.top to it.height })
        if (page != reportedPdfPage) {
            reportedPdfPage = page
            onPdfPage(page)
        }
        val fit = measurePdfFit()
        onPdfZoom(zoom, ch.fasrv.fanotes.desk.pdfZoomModeForZoom(zoom.toDouble(), fit))
    }

    private fun publishSheetActive() {
        val active = ch.fasrv.fanotes.desk.sheetViewAdjusted(
            zoom.toDouble(),
            rotation.toDouble(),
            (pageLeft - padding()).toDouble(),
            (pageTop - padding()).toDouble(),
        )
        if (active == reportedSheet) return
        reportedSheet = active
        onSheetActive(active)
    }

    private fun addGrownSample(current: InkSession, sample: StrokePoint): Boolean {
        val before = current.document
        val accepted = current.addSample(sample)
        settleGrownPage(before)
        return accepted
    }

    /** Pan by a new left or top pad so the marks already on the page stay put. */
    private fun settleGrownPage(before: InkDocument) {
        val document = session?.document ?: return
        val padX = document.originX - before.originX
        val padY = document.originY - before.originY
        if (padX == 0.0 && padY == 0.0 && document.sourceWidth == before.sourceWidth && document.sourceHeight == before.sourceHeight) return
        val scale = pixelsPerPageUnit()
        if (padX != 0.0) pageLeft -= (ch.fasrv.fanotes.ink.paperOriginScrollDelta(padX) * scale).toFloat()
        if (padY != 0.0) pageTop -= (ch.fasrv.fanotes.ink.paperOriginScrollDelta(padY) * scale).toFloat()
        invalidateTiles()
        onPageGrew(before.sourceWidth, before.sourceHeight, document.sourceWidth, document.sourceHeight, padX, padY)
    }

    private fun drawMarkdown(canvas: Canvas, scale: Float) {
        val blocks = paperBlocks(scale)
        if (blocks.isEmpty()) return
        canvas.save()
        val originX = (session?.document?.originX ?: 0.0).toFloat()
        val originY = (session?.document?.originY ?: 0.0).toFloat()
        canvas.translate(pageLeft + (TEXT_PAD_X + originX) * scale, pageTop + (TEXT_PAD_Y + originY) * scale)
        var number = 1
        for (block in blocks) {
            when (block) {
                is PaperBlock.Text -> {
                    if (showLineNumbers) drawLineNumbers(canvas, block, number, scale)
                    number += block.paragraphStarts.size
                    block.layout.draw(canvas)
                    canvas.translate(0f, block.layout.height.toFloat())
                }
                is PaperBlock.Table -> {
                    if (showLineNumbers) drawNumber(canvas, number.toString(), editorFontPx * scale, scale)
                    number += 1
                    drawTable(canvas, block, scale)
                }
                is PaperBlock.Image -> {
                    if (showLineNumbers) drawNumber(canvas, number.toString(), editorFontPx * scale, scale)
                    number += 1
                    drawImageCard(canvas, block, scale)
                }
            }
        }
        canvas.restore()
    }

    private fun paperBlocks(scale: Float): List<PaperBlock> {
        if (scale <= 0f || markdown.isBlank()) return emptyList()
        if (paperBlocks.isNotEmpty() && markdown == cachedMarkdown && imageEpoch == cachedImageEpoch && kotlin.math.abs(scale - textStamp) < scale * 0.03f) return paperBlocks
        val built = ArrayList<PaperBlock>()
        val textLines = ArrayList<PaperLine>()
        fun flush() {
            if (textLines.isEmpty()) return
            val (styled, starts, tasks) = styledLines(textLines, scale)
            built += PaperBlock.Text(textLayoutFor(styled, scale), starts, tasks)
            textLines.clear()
        }
        for (line in paperLines(markdown)) {
            if (line.kind == PaperKind.TABLE) {
                flush()
                built += tableBlock(line.text, scale)
            } else if (line.kind == PaperKind.IMAGE) {
                flush()
                val source = paperImageSource(line.text)
                val bitmap = paperImages[source]?.takeIf { !it.isRecycled }
                val frame = if (bitmap == null) 96f * scale else paperImageFrame(bitmap.width, bitmap.height, TEXT_COLUMN * scale).second
                built += PaperBlock.Image(paperImageCaption(line.text), source, frame, bitmap)
            } else {
                textLines += line
            }
        }
        flush()
        paperBlocks = built
        cachedMarkdown = markdown
        cachedImageEpoch = imageEpoch
        textStamp = scale
        return built
    }

    private fun textLayoutFor(text: CharSequence, scale: Float): StaticLayout {
        val width = (textColumnPx() * scale).toInt().coerceAtLeast(1)
        textPaint.textSize = editorFontPx * scale
        textPaint.typeface = editorTypeface
        return StaticLayout.Builder.obtain(text, 0, text.length, textPaint, width)
            .setAlignment(Layout.Alignment.ALIGN_NORMAL)
            .setIncludePad(false)
            .setLineSpacing(0f, editorLineHeight)
            .setBreakStrategy(Layout.BREAK_STRATEGY_HIGH_QUALITY)
            .setHyphenationFrequency(Layout.HYPHENATION_FREQUENCY_NONE)
            .build()
    }

    private fun tableBlock(text: String, scale: Float): PaperBlock.Table {
        val rows = tableRows(text)
        val columns = rows.maxOf { it.size }.coerceAtLeast(1)
        val colWidth = TEXT_COLUMN * scale / columns
        val inner = (colWidth - 12f * scale).toInt().coerceAtLeast(1)
        val layouts = rows.mapIndexed { rowIndex, row ->
            val face = if (rowIndex == 0) Typeface.BOLD else Typeface.NORMAL
            textPaint.typeface = Typeface.create(editorTypeface, face)
            textPaint.textSize = editorFontPx * scale
            List(columns) { column ->
                val cell = row.getOrElse(column) { "" }
                StaticLayout.Builder.obtain(cell, 0, cell.length, textPaint, inner)
                    .setIncludePad(false)
                    .setBreakStrategy(Layout.BREAK_STRATEGY_HIGH_QUALITY)
                    .build()
            }
        }
        textPaint.typeface = editorTypeface
        val heights = FloatArray(rows.size) { row ->
            val content = layouts[row].maxOf { it.height }.toFloat()
            max(content + 10f * scale, 28f * scale)
        }
        return PaperBlock.Table(rows, heights, layouts)
    }

    private fun drawTable(canvas: Canvas, block: PaperBlock.Table, scale: Float) {
        val columns = block.rows.maxOf { it.size }.coerceAtLeast(1)
        val width = TEXT_COLUMN * scale
        val colWidth = width / columns
        tableLine.strokeWidth = max(1f, scale * 0.6f)
        var y = 0f
        block.rows.forEachIndexed { rowIndex, _ ->
            val height = block.rowHeights[rowIndex]
            if (rowIndex == 0) canvas.drawRect(0f, y, width, y + height, tableHead)
            canvas.drawRect(0f, y, width, y + height, tableLine)
            for (column in 0 until columns) {
                val x = column * colWidth
                if (column > 0) canvas.drawLine(x, y, x, y + height, tableLine)
                val layout = block.cellLayouts[rowIndex][column]
                canvas.save()
                canvas.translate(x + 6f * scale, y + 4f * scale)
                layout.draw(canvas)
                canvas.restore()
            }
            y += height
        }
        canvas.translate(0f, y + 10f * scale)
    }

    private fun drawImageCard(canvas: Canvas, block: PaperBlock.Image, scale: Float) {
        val width = TEXT_COLUMN * scale
        val height = block.frameHeight
        val radius = 12f * scale
        val top = 8f * scale
        val rect = RectF(0f, top, width, top + height)
        cardFill.color = Color.WHITE
        canvas.drawRoundRect(rect, radius, radius, cardFill)
        val bitmap = block.bitmap?.takeIf { !it.isRecycled }
        if (bitmap != null) {
            val pad = 8f * scale
            val dest = RectF(rect.left + pad, rect.top + pad, rect.right - pad, rect.bottom - pad)
            canvas.save()
            canvas.clipPath(android.graphics.Path().apply { addRoundRect(rect, radius, radius, android.graphics.Path.Direction.CW) })
            canvas.drawBitmap(bitmap, null, dest, tilePaint)
            canvas.restore()
        } else {
            textPaint.color = Color.parseColor("#252630")
            textPaint.textSize = 15f * scale
            textPaint.typeface = Typeface.create(editorTypeface, Typeface.BOLD)
            canvas.drawText(block.caption, 16f * scale, rect.centerY() - 4f * scale, textPaint)
            textPaint.typeface = editorTypeface
            textPaint.textSize = 11f * scale
            textPaint.color = Color.parseColor("#5C6B8E")
            val file = block.source.substringAfterLast('/').substringBefore('?')
            if (file.isNotEmpty() && file != block.caption) {
                canvas.drawText(file, 16f * scale, rect.centerY() + 16f * scale, textPaint)
            }
            textPaint.color = Color.parseColor("#252630")
        }
        tableLine.strokeWidth = max(1f, scale)
        canvas.drawRoundRect(rect, radius, radius, tableLine)
        canvas.translate(0f, height + 24f * scale)
    }

    private fun styledLines(lines: List<PaperLine>, scale: Float): Triple<CharSequence, IntArray, IntArray> {
        val textSize = editorFontPx * scale
        val readable = ch.fasrv.fanotes.desk.paperAccentReadableArgb(accentColor)
        val builder = SpannableStringBuilder()
        val starts = IntArray(lines.size)
        for ((index, line) in lines.withIndex()) {
            val start = builder.length
            starts[index] = start
            val content: CharSequence = when (line.kind) {
                PaperKind.BULLET -> inline("•  ${line.text}")
                PaperKind.TASK -> taskLine(line.text, readable, textSize)
                PaperKind.MATH -> inline(line.text)
                PaperKind.SPACER -> ""
                PaperKind.RULE -> " "
                else -> inline(line.text)
            }
            builder.append(content)
            val end = builder.length
            if (end > start) {
                when (line.kind) {
                    PaperKind.H1 -> builder.setSpan(HeadingSpan(1, textSize), start, end, 0)
                    PaperKind.H2 -> builder.setSpan(HeadingSpan(2, textSize), start, end, 0)
                    PaperKind.H3 -> builder.setSpan(HeadingSpan(3, textSize), start, end, 0)
                    PaperKind.H4 -> builder.setSpan(HeadingSpan(4, textSize), start, end, 0)
                    PaperKind.H5 -> builder.setSpan(HeadingSpan(5, textSize), start, end, 0)
                    PaperKind.H6 -> builder.setSpan(HeadingSpan(6, textSize), start, end, 0)
                    PaperKind.BULLET -> {
                        val marker = (start + 2).coerceAtMost(end)
                        builder.setSpan(ForegroundColorSpan(readable), start, marker, 0)
                        builder.setSpan(StyleSpan(Typeface.BOLD), start, marker, 0)
                    }
                    PaperKind.QUOTE -> builder.setSpan(
                        PaperQuoteSpan(readable, ch.fasrv.fanotes.desk.quoteWashArgb(accentColor), textSize),
                        start,
                        end,
                        0,
                    )
                    PaperKind.RULE -> builder.setSpan(PaperThematicRuleSpan(textSize), start, end, 0)
                    PaperKind.CODE -> builder.setSpan(CodeFenceSpan(), start, end, 0)
                    PaperKind.MATH -> builder.setSpan(
                        PaperMathBlockSpan(
                            null,
                            ch.fasrv.fanotes.desk.paperMathFillArgb(accentColor),
                            ch.fasrv.fanotes.desk.paperMathBorderArgb(accentColor),
                            textSize,
                        ),
                        start,
                        end,
                        0,
                    )
                    else -> Unit
                }
            }
            builder.append('\n')
        }
        val sources = IntArray(lines.size) { index ->
            val line = lines[index]
            if (line.kind == PaperKind.TASK) line.sourceLine else -1
        }
        return Triple(builder, starts, sources)
    }

    private val numberPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#8A8D98")
        textAlign = Paint.Align.RIGHT
    }

    private fun drawLineNumbers(canvas: Canvas, block: PaperBlock.Text, first: Int, scale: Float) {
        block.paragraphStarts.forEachIndexed { index, offset ->
            val safe = offset.coerceIn(0, block.layout.text.length)
            val visual = block.layout.getLineForOffset(safe)
            drawNumber(canvas, (first + index).toString(), block.layout.getLineBaseline(visual).toFloat(), scale)
        }
    }

    private fun drawNumber(canvas: Canvas, label: String, baseline: Float, scale: Float) {
        numberPaint.textSize = editorFontPx * scale * 0.82f
        numberPaint.typeface = editorTypeface
        canvas.drawText(label, -8f * scale, baseline, numberPaint)
    }

    private fun taskLine(raw: String, readable: Int, textSize: Float): CharSequence {
        val done = raw.startsWith("x|")
        val label = raw.removePrefix("x|").removePrefix(" |").removePrefix("|")
        val builder = SpannableStringBuilder(" ")
        builder.setSpan(TaskSpan(done, readable, textSize), 0, 1, 0)
        if (label.isNotEmpty()) builder.append(label)
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
                        if (bold) StrongSpan() else StyleSpan(Typeface.ITALIC),
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

    private fun trySnapLive(): Boolean {
        val current = session ?: return false
        if (!shapeCanArm()) return false
        val snapped = snapStrokeToShape(current.livePoints, sessionWidth(), sessionHeight(), shapeSnapSensitivity) ?: return false
        current.replaceLive(snapped.points)
        shapeSnapped = true
        didShapeSnap = true
        onInkNotice(InkNotice("success", shapeRecognizedNotice(snapped.kind)))
        return true
    }

    private fun shapeCanArm(): Boolean {
        if (inkTool != InkTool.PEN) return false
        if (!inkStrokeAllowsShapeSnap("handwriting", null)) return false
        if (style.brush in setOf("marker", "highlighter", "watercolor", "spray", "paintbrush")) return false
        val points = session?.livePoints.orEmpty()
        return points.size >= shapeSnapProfile(shapeSnapSensitivity).minPoints
    }

    private fun armShapeWatch(distancePx: Double) {
        val profile = shapeSnapProfile(shapeSnapSensitivity)
        val wait = shapeWatch.onSample(SystemClock.uptimeMillis(), distancePx, shapeCanArm(), profile)
        scheduleShapeWatch(wait)
    }

    private fun scheduleShapeWatch(waitMs: Long?) {
        shapeHandler.removeCallbacks(shapeDue)
        if (waitMs != null) shapeHandler.postDelayed(shapeDue, waitMs)
    }

    private fun clearShapeWatch() {
        shapeHandler.removeCallbacks(shapeDue)
        shapeWatch.clear()
    }

    private fun onShapeDue() {
        val current = session ?: return
        if (shapeSnapped) return
        val now = SystemClock.uptimeMillis()
        val profile = shapeSnapProfile(shapeSnapSensitivity)
        val looks = strokeLooksLikeShape(current.livePoints, sessionWidth(), sessionHeight(), shapeSnapSensitivity)
        val due = shapeWatch.onDue(now, profile, looks)
        if (due.showHint) onInkNotice(InkNotice("info", FORM_DETECT_NOTICE_TEXT))
        val wait = if (due.trySnap) {
            val snapped = trySnapLive()
            shapeWatch.noteSnap(snapped, SystemClock.uptimeMillis())
        } else {
            due.waitMs
        }
        scheduleShapeWatch(wait)
        if (due.trySnap || due.showHint) invalidate()
    }

    override fun onDetachedFromWindow() {
        clearShapeWatch()
        super.onDetachedFromWindow()
    }

    private fun penSample(event: MotionEvent, index: Int, historical: Int = -1): StrokePoint {
        val sx = if (historical >= 0) event.getHistoricalX(index, historical) else event.getX(index)
        val sy = if (historical >= 0) event.getHistoricalY(index, historical) else event.getY(index)
        val raw = pageNorm(sx, sy)
        val snapped = snapPen(raw.first, raw.second)
        return point(event, index, snapped.first, snapped.second, historical)
    }

    private fun snapPen(x: Double, y: Double): Pair<Double, Double> {
        val tools = visibleTools()
        if (tools.isEmpty()) return x to y
        val hit = snapToDraftingTools(x, y, tools, sessionWidth(), sessionHeight(), snapLock, sheetDisplay())
        return if (hit == null) x to y else hit.x to hit.y
    }

    private fun visibleTools(): List<DraftingToolState> = buildList {
        rulerPose?.let { add(DraftingToolState(DraftingKind.RULER, it)) }
        setSquarePose?.let { add(DraftingToolState(DraftingKind.SET_SQUARE, it)) }
        compassPose?.let { add(DraftingToolState(DraftingKind.COMPASS, it)) }
    }

    private fun poseOf(kind: DraftingKind) = when (kind) {
        DraftingKind.RULER -> rulerPose
        DraftingKind.SET_SQUARE -> setSquarePose
        DraftingKind.COMPASS -> compassPose
    }

    private fun tryBeginGuideDrag(pointerId: Int, event: MotionEvent, index: Int): Boolean {
        val (nx, ny) = pageNorm(event.getX(index), event.getY(index))
        val kind = hitGuide(nx, ny) ?: return false
        val pose = poseOf(kind) ?: return false
        val local = normToLocalMm(nx, ny, pose, sessionWidth(), sessionHeight())
        val mode = when (kind) {
            DraftingKind.RULER -> if (abs(abs(local.x) - rulerLength(pose) / 2) < 14 && abs(local.y) <= rulerWidth(pose) / 2 + 1) "rotate" else "move"
            DraftingKind.SET_SQUARE -> {
                val apexY = setSquareApexSign(pose) * setSquareSize(pose) / 2
                if (hypot(local.x, local.y - apexY) < 14) "rotate" else "move"
            }
            DraftingKind.COMPASS -> {
                val pencil = compassPencilPoint(pose, sessionWidth(), sessionHeight(), sheetDisplay())
                if (radiusMmBetween(pencil.x, pencil.y, nx, ny, sessionWidth(), sessionHeight(), sheetDisplay()) < 12) "radius" else "move"
            }
        }
        val startAngle = angleToPoint(pose.x, pose.y, nx, ny, sessionWidth(), sessionHeight(), sheetDisplay())
        guideDrag = GuideDrag(pointerId, kind, mode, nx, ny, pose, startAngle)
        return true
    }

    private fun hitGuide(x: Double, y: Double): DraftingKind? {
        val sheetWidth = sessionWidth()
        val sheetHeight = sessionHeight()
        compassPose?.let { pose ->
            val centre = radiusMmBetween(pose.x, pose.y, x, y, sheetWidth, sheetHeight, sheetDisplay())
            val pencil = compassPencilPoint(pose, sheetWidth, sheetHeight, sheetDisplay())
            val nearPencil = radiusMmBetween(pencil.x, pencil.y, x, y, sheetWidth, sheetHeight, sheetDisplay()) < 12
            if (centre < 18 || nearPencil) return DraftingKind.COMPASS
        }
        setSquarePose?.let { if (pointInsideSetSquare(x, y, it, sheetWidth, sheetHeight)) return DraftingKind.SET_SQUARE }
        rulerPose?.let { if (pointInsideRuler(x, y, it, sheetWidth, sheetHeight)) return DraftingKind.RULER }
        return null
    }

    private fun moveGuide(event: MotionEvent) {
        val drag = guideDrag ?: return
        val index = event.findPointerIndex(drag.pointerId)
        if (index < 0) return
        val (nx, ny) = pageNorm(event.getX(index), event.getY(index))
        val origin = drag.origin
        val next = when (drag.mode) {
            "rotate" -> {
                val angle = angleToPoint(origin.x, origin.y, nx, ny, sessionWidth(), sessionHeight(), sheetDisplay())
                origin.copy(rotation = snapAngle(origin.rotation + shortestAngleDelta(drag.startAngle, angle), 1))
            }
            "radius" -> origin.copy(
                radiusMm = snapRadiusMm(
                    clampCompassRadius(radiusMmBetween(origin.x, origin.y, nx, ny, sessionWidth(), sessionHeight(), sheetDisplay())),
                ),
            )
            else -> origin.copy(x = origin.x + (nx - drag.grabX), y = origin.y + (ny - drag.grabY))
        }
        placeGuide(drag.kind, next)
        invalidate()
    }

    private fun placeGuide(kind: DraftingKind, pose: DraftingPose) {
        var next = keepPoseOnSheet(kind, pose, sessionWidth(), sessionHeight())
        if (kind == DraftingKind.SET_SQUARE) {
            rulerPose?.let { ruler ->
                attachSetSquareToRuler(next, ruler, sessionWidth(), sessionHeight())?.let { next = it }
            }
        }
        when (kind) {
            DraftingKind.RULER -> rulerPose = next
            DraftingKind.SET_SQUARE -> setSquarePose = next
            DraftingKind.COMPASS -> compassPose = next
        }
    }

    private fun drawGuides(canvas: Canvas) {
        val px = pxPerMm()
        if (px <= 0f) return
        rulerPose?.let { drawRuler(canvas, it, px) }
        setSquarePose?.let { drawSetSquare(canvas, it, px) }
        compassPose?.let { drawCompass(canvas, it, px) }
    }

    private fun drawRuler(canvas: Canvas, pose: DraftingPose, px: Float) {
        val half = (rulerLength(pose) / 2.0 * px).toFloat()
        val across = (rulerWidth(pose) / 2.0 * px).toFloat()
        val corner = 5f * resources.displayMetrics.density
        withPose(canvas, pose) {
            guideFill.color = Color.parseColor("#D7E4F2")
            guideFill.alpha = 176
            guideEdge.color = Color.parseColor("#1B4F82")
            guideEdge.strokeWidth = max(1.5f, px * 0.35f)
            guideTick.color = Color.parseColor("#1B4F82")
            guideTick.strokeWidth = max(1f, px * 0.18f)
            guideLabel.textSize = 9f * resources.displayMetrics.density
            canvas.drawRoundRect(-half, -across, half, across, corner, corner, guideFill)
            canvas.drawRoundRect(-half, -across, half, across, corner, corner, guideEdge)
            for (tick in scaleTicks(rulerLength(pose))) {
                val x = ((-rulerLength(pose) / 2.0 + tick.mm) * px).toFloat()
                val mark = when (tick.level) {
                    2 -> 4.2f
                    1 -> 2.6f
                    else -> 1.5f
                } * px
                canvas.drawLine(x, -across, x, -across + mark, guideTick)
                canvas.drawLine(x, across, x, across - mark, guideTick)
                val label = tick.label
                if (label != null) {
                    canvas.drawText(label, x, -across + mark + guideLabel.textSize * 0.85f, guideLabel)
                }
            }
        }
    }

    private fun drawSetSquare(canvas: Canvas, pose: DraftingPose, px: Float) {
        val half = (setSquareSize(pose) / 2.0 * px).toFloat()
        val sign = setSquareApexSign(pose).toFloat()
        withPose(canvas, pose) {
            val path = Path()
            path.moveTo(-half, 0f)
            path.lineTo(half, 0f)
            path.lineTo(0f, sign * half)
            path.close()
            guideFill.color = Color.parseColor("#D7E4F2")
            guideFill.alpha = 150
            guideEdge.color = Color.parseColor("#1B4F82")
            guideEdge.strokeWidth = max(1.6f, px * 0.4f)
            guideTick.strokeWidth = max(1f, px * 0.18f)
            canvas.drawPath(path, guideFill)
            canvas.drawPath(path, guideEdge)
            canvas.drawLine(0f, 0f, 0f, sign * half * 0.92f, guideTick)
            val radius = half * 0.62f
            for (deg in 0..180 step 10) {
                val rad = Math.toRadians(deg.toDouble())
                val cosine = cos(rad).toFloat()
                val sine = sin(rad).toFloat()
                val inner = radius - (if (deg % 90 == 0) 3.4f else if (deg % 30 == 0) 2.4f else 1.4f) * px
                canvas.drawLine(cosine * inner, sign * sine * inner, cosine * radius, sign * sine * radius, guideTick)
            }
            guideLabel.textSize = 9f * resources.displayMetrics.density
            val halfMm = setSquareSize(pose) / 2.0
            var mark = -kotlin.math.floor(halfMm / 10.0) * 10.0
            while (mark <= halfMm + 0.1) {
                val x = (mark * px).toFloat()
                canvas.drawLine(x, 0f, x, -sign * 3.2f * px, guideTick)
                if (abs(mark) > 0.1 && abs(mark) < halfMm - 4) {
                    canvas.drawText((mark / 10.0).toInt().toString(), x, -sign * 3.2f * px - 2f, guideLabel)
                }
                mark += 10.0
            }
        }
    }

    private fun drawCompass(canvas: Canvas, pose: DraftingPose, px: Float) {
        val radius = clampCompassRadius(pose.radiusMm).toFloat() * px
        val density = resources.displayMetrics.density
        withPose(canvas, pose) {
            guideEdge.color = Color.parseColor("#1B4F82")
            guideEdge.strokeWidth = max(1.5f, px * 0.35f)
            canvas.drawCircle(0f, 0f, radius, guideEdge)
            guideEdge.color = Color.parseColor("#9A3412")
            canvas.drawLine(0f, 0f, radius, 0f, guideEdge)
            guideFill.color = Color.parseColor("#1B4F82")
            guideFill.alpha = 255
            canvas.drawCircle(0f, 0f, 3.5f * density, guideFill)
            guideFill.color = Color.parseColor("#9A3412")
            canvas.drawCircle(radius, 0f, 4.2f * density, guideFill)
        }
    }

    private inline fun withPose(canvas: Canvas, pose: DraftingPose, draw: () -> Unit) {
        val (ox, oy) = normToScreen(pose.x, pose.y)
        canvas.save()
        canvas.translate(ox, oy)
        canvas.rotate(Math.toDegrees(pose.rotation).toFloat())
        draw()
        canvas.restore()
    }

    private fun markdownBottomPagePx(scale: Float): Double {
        if (!showMarkdown || markdown.isBlank() || scale <= 0f) return 0.0
        var height = 0f
        for (block in paperBlocks(scale)) {
            height += when (block) {
                is PaperBlock.Text -> block.layout.height.toFloat()
                is PaperBlock.Table -> block.rowHeights.sum() + 10f * scale
                is PaperBlock.Image -> block.frameHeight + 24f * scale
            }
        }
        val originY = session?.document?.originY ?: 0.0
        return TEXT_PAD_Y.toDouble() + originY + (height / scale).toDouble()
    }

    private fun currentPlacements(scale: Float): List<ch.fasrv.fanotes.desk.WorksheetPlacement> {
        val sheets = backdrop.filter { slice ->
            val bitmap = slice.bitmap
            slice.worksheetId.isNotEmpty() && bitmap != null && !bitmap.isRecycled && bitmap.width > 0 && bitmap.height > 0
        }
        if (sheets.isEmpty()) return emptyList()
        val pages = sheets.map { slice ->
            val bitmap = slice.bitmap!!
            ch.fasrv.fanotes.desk.WorksheetPageSpec(
                slice.worksheetId,
                slice.page,
                bitmap.height.toDouble() / bitmap.width.toDouble(),
            )
        }
        return ch.fasrv.fanotes.desk.layoutWorksheetPages(sessionWidth(), markdownBottomPagePx(scale), pages)
    }

    private fun openWorksheetId(): String? = backdrop.firstOrNull { it.worksheetId.isNotEmpty() }?.worksheetId

    private fun pointOnFrame(
        x: Double,
        y: Double,
        frame: ch.fasrv.fanotes.desk.WorksheetPlacement,
        width: Double,
        height: Double,
    ) = ch.fasrv.fanotes.desk.pointOnWorksheet(x, y, frame, width, height)

    private fun hitWorksheetBox(anchored: ch.fasrv.fanotes.desk.AnchoredBox, x: Double, y: Double): Boolean {
        val place = worksheetPlacements.firstOrNull { it.id == anchored.worksheetId && it.page == anchored.box.page.coerceAtLeast(1) } ?: return false
        val width = sessionWidth()
        if (width <= 0.0) return false
        val sheet = ch.fasrv.fanotes.desk.boxOnFrame(anchored.box, place, width, sessionHeight())
        val scale = pixelsPerPageUnit()
        val boxWidth = (anchored.box.width * place.width * scale).toFloat().coerceAtLeast(48f * scale)
        val fontSize = (anchored.box.fontSize * scale).toFloat().coerceAtLeast(12f)
        val card = ch.fasrv.fanotes.desk.worksheetCardHeightPx(anchored.box.text, boxWidth, fontSize, scale)
        val normHeight = if (sessionHeight() > 0.0) card / (sessionHeight() * scale) else 0.04
        val boxSpan = anchored.box.width * place.width / width
        return x >= sheet.first && x <= sheet.first + boxSpan && y >= sheet.second - normHeight && y <= sheet.second + 0.02
    }

    private fun commitHighlight() {
        val left = min(highlightStartX, highlightEndX)
        val top = min(highlightStartY, highlightEndY)
        val width = abs(highlightEndX - highlightStartX)
        val height = abs(highlightEndY - highlightStartY)
        val placements = currentPlacements(pixelsPerPageUnit())
        worksheetPlacements = placements
        val sheetWidth = sessionWidth()
        val sheetHeight = sessionHeight()
        if (placements.isEmpty()) {
            val frames = pageFrames
            val existing = worksheetHighlights.firstOrNull { anchored ->
                val rect = ch.fasrv.fanotes.desk.highlightToSheet(anchored.mark, frames, sheetWidth, sheetHeight)
                left >= rect.x && left <= rect.x + rect.width && top >= rect.y && top <= rect.y + rect.height && width < 0.02 && height < 0.02
            }
            if (existing != null) {
                onRemoveHighlight(existing.mark.id)
                return
            }
            val mark = ch.fasrv.fanotes.desk.highlightFromDrag(
                left, top, width, height, frames, sheetWidth, sheetHeight,
                "hl-${System.currentTimeMillis().toString(36)}",
            ) ?: return
            val worksheetId = openWorksheetId() ?: return
            onPlaceHighlight(worksheetId, mark)
            return
        }
        val existing = worksheetHighlights.firstOrNull { anchored ->
            val frame = placements.firstOrNull { it.id == anchored.worksheetId && it.page == anchored.mark.page.coerceAtLeast(1) } ?: return@firstOrNull false
            val rect = ch.fasrv.fanotes.desk.highlightFrameToSheet(anchored.mark, frame, sheetWidth, sheetHeight)
            left >= rect.x && left <= rect.x + rect.width && top >= rect.y && top <= rect.y + rect.height && width < 0.02 && height < 0.02
        }
        if (existing != null) {
            onRemoveHighlight(existing.mark.id)
            return
        }
        val id = "hl-${System.currentTimeMillis().toString(36)}"
        for (frame in placements) {
            val mark = ch.fasrv.fanotes.desk.highlightOnFrame(left, top, width, height, frame, sheetWidth, sheetHeight, id) ?: continue
            onPlaceHighlight(frame.id, mark)
            return
        }
    }

    private fun drawHighlights(canvas: Canvas) {
        highlightPaint.style = Paint.Style.FILL
        val sheetWidth = sessionWidth()
        val sheetHeight = sessionHeight()
        worksheetHighlights.forEach { anchored ->
            val rect = if (worksheetPlacements.isEmpty()) {
                ch.fasrv.fanotes.desk.highlightToSheet(anchored.mark, pageFrames, sheetWidth, sheetHeight)
            } else {
                val frame = worksheetPlacements.firstOrNull { it.id == anchored.worksheetId && it.page == anchored.mark.page.coerceAtLeast(1) } ?: return@forEach
                ch.fasrv.fanotes.desk.highlightFrameToSheet(anchored.mark, frame, sheetWidth, sheetHeight)
            }
            val (x1, y1) = normToScreen(rect.x, rect.y)
            val (x2, y2) = normToScreen(rect.x + rect.width, rect.y + rect.height)
            highlightPaint.color = parseColor(anchored.mark.color)
            highlightPaint.alpha = 96
            canvas.drawRect(x1, y1, x2, y2, highlightPaint)
        }
        if (highlighting) {
            val (x1, y1) = normToScreen(min(highlightStartX, highlightEndX), min(highlightStartY, highlightEndY))
            val (x2, y2) = normToScreen(max(highlightStartX, highlightEndX), max(highlightStartY, highlightEndY))
            highlightPaint.color = Color.parseColor("#FFE566")
            highlightPaint.alpha = 70
            canvas.drawRect(x1, y1, x2, y2, highlightPaint)
        }
    }

    private fun sheetDisplay() = DraftingDisplay(
        sessionWidth() * pixelsPerPageUnit().toDouble(),
        sessionHeight() * pixelsPerPageUnit().toDouble(),
    )

    private fun pxPerMm() = pixelsPerPageUnit() * (SOURCE_A4_PX / A4_WIDTH_MM).toFloat()

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

private sealed class PaperBlock {
    class Text(val layout: StaticLayout, val paragraphStarts: IntArray, val taskSources: IntArray) : PaperBlock()
    class Table(val rows: List<List<String>>, val rowHeights: FloatArray, val cellLayouts: List<List<StaticLayout>>) : PaperBlock()
    class Image(val caption: String, val source: String, val frameHeight: Float, val bitmap: android.graphics.Bitmap?) : PaperBlock()
}

private data class GuideDrag(
    val pointerId: Int,
    val kind: DraftingKind,
    val mode: String,
    val grabX: Double,
    val grabY: Double,
    val origin: DraftingPose,
    val startAngle: Double,
)

data class BackdropSlice(
    val topPagePx: Float,
    val heightPagePx: Float,
    val widthPagePx: Float,
    val bitmap: Bitmap?,
    val worksheetId: String = "",
    val label: String = "",
    val page: Int = 1,
)
