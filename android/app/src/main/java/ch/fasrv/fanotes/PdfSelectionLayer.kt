package ch.fasrv.fanotes

import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Point
import android.graphics.PointF
import android.graphics.Rect
import android.graphics.RectF
import android.view.ActionMode
import android.view.Menu
import android.view.MenuItem
import android.view.MotionEvent
import android.view.View
import ch.fasrv.fanotes.desk.PageFrame
import ch.fasrv.fanotes.desk.PdfMarkRange
import ch.fasrv.fanotes.desk.PdfTextMark
import ch.fasrv.fanotes.study.PdfTextApi
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/**
 * On-page text selection and painted text marks of a PDF note (desktop: the pdf.js text layer of `PdfNoteView`,
 * "Auswahl markieren", the eraser on highlights).
 *
 * - A finger long press on text selects the word; dragging on extends it. With "Text markieren" armed, the pen drags
 *   a selection directly (a finger still pans). Handles at both ends adjust it, with pen or finger.
 * - The selection opens the system's floating text toolbar: Markieren, Unterstreichen, Markierung entfernen (when the
 *   selection lies on marks) and Kopieren. Marks are written to the note's `fanotes-pdf-marks-v1` block, the same
 *   one the desktop reads.
 * - Marks are painted under the ink, quote-anchored through the page text, so they follow zoom and rotation.
 * - The eraser takes the highlight off the words it touches, the way the desktop eraser does.
 *
 * Geometry is in PDF points of each page; [Host] maps it to the sheet.
 */
internal class PdfSelectionLayer(private val host: Host, private val pages: PdfTextPages) {
    interface Host {
        fun pdfFrames(): List<PageFrame>
        /** Sheet point (page units) to canvas pixels, before the sheet rotation. */
        fun unitToCanvas(x: Double, y: Double): PointF
        /** Only the vertical part of [unitToCanvas], without an allocation (runs per page and frame). */
        fun unitToCanvasY(y: Double): Float
        /** Screen pixels of the view to sheet page units, the sheet rotation undone. */
        fun screenToUnit(x: Float, y: Float): PointF
        fun selectionView(): View
        fun density(): Float
        fun accent(): Int
        fun redraw()
        /** The layer took over a finger gesture; the view drops its pan state for it. */
        fun releaseFingerGesture()
    }

    var onMark: (page: Int, quote: String, kind: String, nth: Int?) -> Unit = { _, _, _, _ -> }
    var onUnmark: (page: Int, pageText: String, ranges: List<IntRange>) -> Unit = { _, _, _ -> }
    var onCopy: (String) -> Unit = {}
    var onNotice: (String) -> Unit = {}

    /** "Text markieren": the pen (and a finger) select text instead of writing. */
    var armed = false
        private set

    var marks: List<PdfTextMark> = emptyList()
        set(value) {
            if (field == value) return
            field = value
            host.redraw()
        }

    private class PageGeometry(
        val key: String,
        val text: String,
        val width: Float,
        val height: Float,
        val paints: List<Pair<PdfMarkRange, List<RectF>>>,
        val words: List<Pair<IntRange, RectF>>,
    )

    private val geometry = HashMap<Int, PageGeometry>()
    private val pending = HashSet<Int>()
    private val pageSizes = HashMap<Int, Pair<Float, Float>>()
    private var documentKey: String? = null

    private var pick: PdfTextPick? = null
    private var anchorFrom: PointF? = null
    private var anchorTo: PointF? = null
    private var dragPointer = MotionEvent.INVALID_POINTER_ID
    private var dragMode = Drag.NONE
    private var actionMode: ActionMode? = null
    private val erasedThisGesture = HashSet<Long>()

    private enum class Drag { NONE, NEW, START, END }

    private val markFill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(140, 255, 214, 90) }
    private val markLine = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.parseColor("#C48A12") }
    private val selectFill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val handlePaint = Paint(Paint.ANTI_ALIAS_FLAG)

    val available: Boolean get() = pages.api != PdfTextApi.NONE

    val hasSelection: Boolean get() = pick != null

    init {
        pages.onOpened = { host.redraw() }
    }

    /** The open PDF; [bytes] runs on the text thread. A null [path] closes it. */
    fun setDocument(path: String?, password: String, bytes: () -> ByteArray?) {
        val key = path?.let { "$it|${password.hashCode()}" }
        if (key == documentKey) return
        documentKey = key
        geometry.clear()
        pending.clear()
        pageSizes.clear()
        clearSelection()
        if (key == null) pages.close() else pages.open(key, password, bytes)
    }

    fun release() {
        clearSelection()
        pages.release()
        documentKey = null
    }

    fun arm(enabled: Boolean) {
        if (enabled && !available) {
            onNotice(NO_TEXT_NOTICE)
            armed = false
            return
        }
        armed = enabled
        if (!enabled) clearSelection()
        if (enabled) onNotice(ARMED_NOTICE)
        host.redraw()
    }

    fun clearSelection() {
        pick = null
        anchorFrom = null
        anchorTo = null
        dragMode = Drag.NONE
        dragPointer = MotionEvent.INVALID_POINTER_ID
        actionMode?.finish()
        actionMode = null
        host.redraw()
    }

    /** The camera moved: the floating toolbar follows the selection. */
    fun cameraMoved() {
        actionMode?.invalidateContentRect()
    }

    // ---- geometry --------------------------------------------------------------------------

    private fun frame(page: Int): PageFrame? = host.pdfFrames().firstOrNull { it.page == page }

    private fun pageKey(page: Int): String = marks.filter { it.page == page }.joinToString("\u0001") { "${it.id}|${it.quote}|${it.kind}|${it.nth}" }

    private fun ptToCanvas(frame: PageFrame, size: Pair<Float, Float>, x: Float, y: Float): PointF =
        host.unitToCanvas(
            x / size.first.coerceAtLeast(1f) * frame.width,
            frame.top + y / size.second.coerceAtLeast(1f) * frame.height,
        )

    private fun canvasRect(frame: PageFrame, size: Pair<Float, Float>, rect: RectF): RectF {
        val a = ptToCanvas(frame, size, rect.left, rect.top)
        val b = ptToCanvas(frame, size, rect.right, rect.bottom)
        return RectF(min(a.x, b.x), min(a.y, b.y), max(a.x, b.x), max(a.y, b.y))
    }

    /** Page and PDF point under a screen point, or null off the PDF pages. */
    private fun pagePoint(x: Float, y: Float, clampTo: Int? = null): Pair<Int, PointF>? {
        val unit = host.screenToUnit(x, y)
        val frames = host.pdfFrames()
        val frame = if (clampTo != null) frames.firstOrNull { it.page == clampTo } else frames.firstOrNull { unit.y >= it.top && unit.y <= it.top + it.height && unit.x >= 0 && unit.x <= it.width }
        frame ?: return null
        val size = pageSizes[frame.page] ?: geometry[frame.page]?.let { it.width to it.height } ?: return frame.page to PointF(Float.NaN, Float.NaN)
        val px = ((unit.x / frame.width) * size.first).toFloat().coerceIn(0f, size.first)
        val py = (((unit.y - frame.top) / frame.height) * size.second).toFloat().coerceIn(0f, size.second)
        return frame.page to PointF(px, py)
    }

    private fun requestGeometry(page: Int) {
        if (page in pending || documentKey == null) return
        val key = pageKey(page)
        pending += page
        val snapshot = marks
        var painted: List<PdfMarkRange> = emptyList()
        var wordRanges: Set<IntRange> = emptySet()
        pages.boxes(
            page,
            rangesFor = { text ->
                painted = ch.fasrv.fanotes.desk.pdfMarkRanges(text, snapshot, page)
                val words = painted.flatMap { ch.fasrv.fanotes.desk.pdfWordRanges(text, it.start, it.end) }.distinct().take(WORD_BOX_LIMIT)
                wordRanges = words.toSet()
                (painted.map { it.start until it.end } + words).distinct()
            },
            failed = { pending -= page },
        ) { text, width, height, boxes ->
            pending -= page
            pageSizes[page] = width to height
            val byRange = boxes.associateBy { it.start until it.end }
            val paints = painted.mapNotNull { range -> byRange[range.start until range.end]?.let { range to it.rects } }
            // The eraser tests word by word, like the desktop tests the highlighted spans.
            val words = boxes.filter { (it.start until it.end) in wordRanges }.flatMap { box -> box.rects.map { (box.start until box.end) to it } }
            geometry[page] = PageGeometry(key, text, width, height, paints, words)
            host.redraw()
        }
    }

    /** Text size of a page known so far, asked for once so a later pointer can be placed. */
    private fun ensureSize(page: Int) {
        if (pageSizes.containsKey(page) || page in pending) return
        requestGeometry(page)
    }

    // ---- drawing ---------------------------------------------------------------------------

    /** Marks under the ink. [visibleTop]/[visibleBottom] are canvas pixels. */
    fun drawMarks(canvas: Canvas, visibleTop: Float, visibleBottom: Float) {
        if (documentKey == null || !available) return
        val frames = host.pdfFrames()
        // Nothing to paint and every page size known: no work per frame.
        if (marks.isEmpty() && pageSizes.size >= frames.size) return
        val withMarks = if (marks.isEmpty()) emptySet() else marks.mapTo(HashSet()) { it.page }
        for (frame in frames) {
            val top = host.unitToCanvasY(frame.top)
            val bottom = host.unitToCanvasY(frame.top + frame.height)
            if (bottom < visibleTop || top > visibleBottom) continue
            if (frame.page !in withMarks) {
                // Sizes of visible pages are read ahead, so a long press can be placed at once.
                ensureSize(frame.page)
                continue
            }
            val geo = geometry[frame.page]
            if (geo == null || geo.key != pageKey(frame.page)) requestGeometry(frame.page)
            geo ?: continue
            val size = geo.width to geo.height
            val stroke = max(1f, host.density())
            for ((range, rects) in geo.paints) {
                for (rect in rects) {
                    val box = canvasRect(frame, size, rect)
                    if (range.kind == "underline") {
                        canvas.drawRect(box.left, box.bottom - stroke * 2f, box.right, box.bottom, markLine)
                    } else {
                        canvas.drawRect(box, markFill)
                        canvas.drawRect(box.left, box.bottom - stroke, box.right, box.bottom, markLine)
                    }
                }
            }
        }
    }

    /** Selection and handles above the ink. */
    fun drawSelection(canvas: Canvas) {
        val current = pick ?: return
        val frame = frame(current.page) ?: return
        val size = pageSizes[current.page] ?: return
        val accent = host.accent()
        selectFill.color = Color.argb(84, Color.red(accent), Color.green(accent), Color.blue(accent))
        current.rects.forEach { canvas.drawRect(canvasRect(frame, size, it), selectFill) }
        handlePaint.color = accent
        val (start, end) = handlePoints(current, frame, size) ?: return
        val radius = HANDLE_DP * host.density()
        for (point in listOf(start, end)) {
            canvas.drawRect(point.x - host.density(), point.y - radius * 1.6f, point.x + host.density(), point.y, handlePaint)
            canvas.drawCircle(point.x, point.y + radius * 0.9f, radius, handlePaint)
        }
    }

    /** Canvas points of the start handle (bottom-left of the first line) and the end handle (bottom-right of the last). */
    private fun handlePoints(current: PdfTextPick, frame: PageFrame, size: Pair<Float, Float>): Pair<PointF, PointF>? {
        val first = current.rects.firstOrNull() ?: return null
        val last = current.rects.lastOrNull() ?: return null
        val a = canvasRect(frame, size, first)
        val b = canvasRect(frame, size, last)
        return PointF(a.left, a.bottom) to PointF(b.right, b.bottom)
    }

    // ---- input -----------------------------------------------------------------------------

    /**
     * Pointer events, before ink and pan. True when the layer used the event; a tap off the selection clears it and
     * lets the event through.
     */
    fun onTouch(event: MotionEvent, unrotate: (Float, Float) -> PointF): Boolean {
        val action = event.actionMasked
        val index = event.actionIndex
        when (action) {
            MotionEvent.ACTION_DOWN, MotionEvent.ACTION_POINTER_DOWN -> {
                if (dragPointer != MotionEvent.INVALID_POINTER_ID) {
                    // A second finger while selecting: leave the selection as it is and let it pinch.
                    finishDrag(show = true)
                    return false
                }
                if (action == MotionEvent.ACTION_POINTER_DOWN) return false
                if (event.getToolType(index) == MotionEvent.TOOL_TYPE_ERASER) return false
                val x = event.getX(index)
                val y = event.getY(index)
                val current = pick
                if (current != null) {
                    val frame = frame(current.page)
                    val size = pageSizes[current.page]
                    val points = if (frame != null && size != null) handlePoints(current, frame, size) else null
                    if (points != null) {
                        val local = unrotate(x, y)
                        val reach = HANDLE_HIT_DP * host.density()
                        val radius = HANDLE_DP * host.density()
                        val startHit = hypot(local.x - points.first.x, local.y - (points.first.y + radius)) <= reach
                        val endHit = hypot(local.x - points.second.x, local.y - (points.second.y + radius)) <= reach
                        if (startHit || endHit) {
                            dragMode = if (endHit) Drag.END else Drag.START
                            dragPointer = event.getPointerId(index)
                            actionMode?.finish()
                            actionMode = null
                            return true
                        }
                    }
                }
                // Armed, the pen (or a mouse) drags a selection; a finger keeps panning and selects by a long press.
                if (armed && event.getToolType(index) != MotionEvent.TOOL_TYPE_FINGER) {
                    val hit = pagePoint(x, y) ?: run {
                        clearSelection()
                        return true
                    }
                    if (hit.second.x.isNaN()) {
                        ensureSize(hit.first)
                        return true
                    }
                    clearSelection()
                    anchorFrom = hit.second
                    anchorTo = hit.second
                    pickPage = hit.first
                    dragMode = Drag.NEW
                    dragPointer = event.getPointerId(index)
                    return true
                }
                if (current != null) clearSelection()
                return false
            }
            MotionEvent.ACTION_MOVE -> {
                if (dragPointer == MotionEvent.INVALID_POINTER_ID) return false
                val pointer = event.findPointerIndex(dragPointer)
                if (pointer < 0) return true
                extendTo(event.getX(pointer), event.getY(pointer))
                return true
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_POINTER_UP, MotionEvent.ACTION_CANCEL -> {
                if (dragPointer == MotionEvent.INVALID_POINTER_ID) return false
                if (action != MotionEvent.ACTION_CANCEL && event.getPointerId(index) != dragPointer) return true
                if (action != MotionEvent.ACTION_CANCEL) extendTo(event.getX(index), event.getY(index))
                finishDrag(show = action != MotionEvent.ACTION_CANCEL)
                return true
            }
        }
        return false
    }

    private var pickPage = 0

    /** A finger long press: select the word there and follow the finger. False when there is no text there. */
    fun beginLongPress(event: MotionEvent): Boolean {
        if (!available || documentKey == null) return false
        val hit = pagePoint(event.x, event.y) ?: return false
        if (hit.second.x.isNaN()) {
            ensureSize(hit.first)
            return false
        }
        val page = hit.first
        clearSelection()
        pickPage = page
        dragMode = Drag.NEW
        dragPointer = event.getPointerId(event.actionIndex)
        host.releaseFingerGesture()
        pages.pickWord(page, Point(hit.second.x.toInt(), hit.second.y.toInt())) { found ->
            if (found == null) {
                // No text under the finger: the gesture ends here.
                if (pick == null) {
                    dragPointer = MotionEvent.INVALID_POINTER_ID
                    dragMode = Drag.NONE
                }
                return@pickWord
            }
            if (documentKey == null) return@pickWord
            acceptPick(found)
            val first = found.rects.first()
            val last = found.rects.last()
            anchorFrom = PointF(first.left + 0.5f, first.centerY())
            anchorTo = PointF(last.right - 0.5f, last.centerY())
            if (dragPointer == MotionEvent.INVALID_POINTER_ID) showActions()
        }
        return true
    }

    private fun extendTo(x: Float, y: Float) {
        val page = pick?.page ?: pickPage
        val hit = pagePoint(x, y, clampTo = page) ?: return
        if (hit.second.x.isNaN()) return
        when (dragMode) {
            Drag.NEW, Drag.END -> anchorTo = hit.second
            Drag.START -> anchorFrom = hit.second
            Drag.NONE -> return
        }
        val from = anchorFrom ?: return
        val to = anchorTo ?: return
        pages.pick(page, Point(from.x.toInt(), from.y.toInt()), Point(to.x.toInt(), to.y.toInt())) { found ->
            if (found != null && documentKey != null) acceptPick(found)
        }
    }

    private fun acceptPick(found: PdfTextPick) {
        pick = found
        host.redraw()
        actionMode?.invalidate()
        actionMode?.invalidateContentRect()
    }

    private fun finishDrag(show: Boolean) {
        dragPointer = MotionEvent.INVALID_POINTER_ID
        dragMode = Drag.NONE
        if (show && pick != null) showActions() else if (pick == null) host.redraw()
    }

    // ---- actions ---------------------------------------------------------------------------

    private fun showActions() {
        if (actionMode != null) {
            actionMode?.invalidate()
            return
        }
        actionMode = host.selectionView().startActionMode(actionCallback, ActionMode.TYPE_FLOATING)
    }

    private fun touchesMarks(current: PdfTextPick): Boolean {
        val ranges = ch.fasrv.fanotes.desk.pdfMarkRanges(current.pageText, marks, current.page)
        return ch.fasrv.fanotes.desk.pdfRangeTouchesMarks(current.pageText, ranges, current.start, current.end)
    }

    private val actionCallback = object : ActionMode.Callback2() {
        override fun onCreateActionMode(mode: ActionMode, menu: Menu): Boolean = fill(menu)

        override fun onPrepareActionMode(mode: ActionMode, menu: Menu): Boolean {
            menu.clear()
            return fill(menu)
        }

        private fun fill(menu: Menu): Boolean {
            val current = pick ?: return false
            menu.add(Menu.NONE, ACTION_MARK, 0, ch.fasrv.fanotes.desk.ChromeText.ui("Markieren"))
            menu.add(Menu.NONE, ACTION_UNDERLINE, 1, ch.fasrv.fanotes.desk.ChromeText.ui("Unterstreichen"))
            if (touchesMarks(current)) menu.add(Menu.NONE, ACTION_UNMARK, 2, ch.fasrv.fanotes.desk.ChromeText.ui("Markierung entfernen"))
            menu.add(Menu.NONE, ACTION_COPY, 3, ch.fasrv.fanotes.desk.ChromeText.ui("Kopieren"))
            return true
        }

        override fun onActionItemClicked(mode: ActionMode, item: MenuItem): Boolean {
            val current = pick ?: return false
            when (item.itemId) {
                ACTION_MARK, ACTION_UNDERLINE -> {
                    val quote = current.text.replace(Regex("\\s+"), " ").trim()
                    if (quote.length >= 2) {
                        val nth = ch.fasrv.fanotes.desk.pdfSelectionOccurrence(current.pageText, current.start, current.end)
                        onMark(current.page, quote, if (item.itemId == ACTION_UNDERLINE) "underline" else "highlight", nth)
                    }
                }
                ACTION_UNMARK -> {
                    val range = ch.fasrv.fanotes.desk.pdfWordAlignedRange(current.pageText, current.start, current.end)
                    if (range != null) onUnmark(current.page, current.pageText, listOf(range))
                }
                ACTION_COPY -> onCopy(current.text.replace(Regex("[ \\t]*\\r?\\n[ \\t]*"), "\n").trim())
                else -> return false
            }
            mode.finish()
            return true
        }

        override fun onDestroyActionMode(mode: ActionMode) {
            if (actionMode === mode) {
                actionMode = null
                if (dragPointer == MotionEvent.INVALID_POINTER_ID) {
                    pick = null
                    anchorFrom = null
                    anchorTo = null
                    host.redraw()
                }
            }
        }

        override fun onGetContentRect(mode: ActionMode, view: View, outRect: Rect) {
            val current = pick
            val frame = current?.let { frame(it.page) }
            val size = current?.let { pageSizes[it.page] }
            if (current == null || frame == null || size == null) {
                outRect.set(0, 0, view.width, view.height / 3)
                return
            }
            val bounds = RectF()
            current.rects.forEachIndexed { index, rect ->
                val box = canvasRect(frame, size, rect)
                if (index == 0) bounds.set(box) else bounds.union(box)
            }
            outRect.set(bounds.left.toInt(), bounds.top.toInt(), bounds.right.toInt(), bounds.bottom.toInt())
        }
    }

    // ---- eraser ----------------------------------------------------------------------------

    /** The eraser at canvas point ([x], [y]) with [radius] px: takes the highlight off the words it touches. */
    fun eraseAt(x: Float, y: Float, radius: Float): Boolean {
        if (marks.isEmpty() || documentKey == null) return false
        var any = false
        // Geometry being refreshed after the last erase still has the right character ranges.
        for ((page, geo) in geometry) {
            val frame = frame(page) ?: continue
            val size = geo.width to geo.height
            val hits = ArrayList<IntRange>()
            for ((range, rect) in geo.words) {
                val id = (page.toLong() shl 32) or range.first.toLong()
                if (id in erasedThisGesture) continue
                val box = canvasRect(frame, size, rect)
                val dx = max(max(box.left - x, 0f), x - box.right)
                val dy = max(max(box.top - y, 0f), y - box.bottom)
                if (hypot(dx, dy) <= radius) {
                    erasedThisGesture += id
                    hits += range
                }
            }
            if (hits.isNotEmpty()) {
                onUnmark(page, geo.text, hits)
                any = true
            }
        }
        return any
    }

    fun endErase() {
        erasedThisGesture.clear()
    }

    companion object {
        private const val ACTION_MARK = 1
        private const val ACTION_UNDERLINE = 2
        private const val ACTION_UNMARK = 3
        private const val ACTION_COPY = 4
        private const val HANDLE_DP = 9f
        private const val HANDLE_HIT_DP = 28f
        private const val WORD_BOX_LIMIT = 600
        const val ARMED_NOTICE = "Mit dem Stift über den PDF-Text ziehen. Mit dem Finger: lange auf den Text drücken."
        const val NO_TEXT_NOTICE = "Auf diesem Gerät fehlt die PDF-Textfunktion (Android 15 oder das Systemupdate mit der PDF-Erweiterung). Markiere mit dem Textmarker."
    }
}
