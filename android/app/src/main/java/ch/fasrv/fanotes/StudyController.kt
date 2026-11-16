package ch.fasrv.fanotes

import android.graphics.Canvas
import ch.fasrv.fanotes.study.CropGrip
import ch.fasrv.fanotes.study.PageBox
import ch.fasrv.fanotes.study.SRect
import ch.fasrv.fanotes.study.cropDragged
import ch.fasrv.fanotes.study.cropFromCorners
import ch.fasrv.fanotes.study.cropGripAt
import ch.fasrv.fanotes.study.cropIsUsable
import ch.fasrv.fanotes.study.SPoint
import ch.fasrv.fanotes.study.StudyAnnotation
import ch.fasrv.fanotes.study.StudyCallout
import ch.fasrv.fanotes.study.StudyHit
import ch.fasrv.fanotes.study.StudyLegend
import ch.fasrv.fanotes.study.StudyPart
import ch.fasrv.fanotes.study.StudyStamp
import ch.fasrv.fanotes.study.StudyTool
import ch.fasrv.fanotes.study.addItem
import ch.fasrv.fanotes.study.dragged
import ch.fasrv.fanotes.study.hitTest
import ch.fasrv.fanotes.study.measurePointsNeeded
import ch.fasrv.fanotes.study.newBranchStroke
import ch.fasrv.fanotes.study.newCallout
import ch.fasrv.fanotes.study.newMeasure
import ch.fasrv.fanotes.study.pageOrNull
import ch.fasrv.fanotes.study.removeItem
import ch.fasrv.fanotes.study.replaceItem
import ch.fasrv.fanotes.study.renumberCallouts
import kotlin.math.hypot

/** Crop rectangle of one page, in page fractions. */
data class StudyCrop(val page: Int, val rect: SRect)

/**
 * Pointer logic of the "Lernen" tools. The ink surface hands it the pen/mouse (or finger, when
 * "finger draws" is on) gestures that `PalmPolicy` already let through, so palm rejection and
 * pen-only mode behave exactly as for ink. One gesture is one undo step in the annotation history.
 */
class StudyController(
    private val host: Host,
    images: StudyImageCache,
    accent: () -> Int,
) {
    interface Host {
        fun studyBox(page: Int): PageBox?
        fun studyPages(): List<Pair<Int, PageBox>>
        fun studyDensity(): Float
        fun studyRedraw()
        /** The toolbar has to rebuild (tool, selection or colours changed). */
        fun studyChrome()
        /** Page most visible in the view, for inserting an image. */
        fun studyVisiblePage(): Int
    }

    private val painter = StudyPainter(images, accent)

    var items: List<StudyAnnotation> = emptyList()
        set(value) {
            field = value
            draft = null
            if (selectedId != null && value.none { it.id == selectedId }) selectedId = null
            host.studyRedraw()
        }
    var tool: StudyTool? = null
        set(value) {
            if (field == value) return
            field = value
            pending = null
            gesture = null
            draft = null
            live = null
            crop = null
            host.studyChrome()
            host.studyRedraw()
        }
    /** The PDF-Ausschnitt rectangle (page fractions) waiting for "Ausschnitt übernehmen". */
    var crop: StudyCrop? = null
        private set
    var stampId = "gain"
    var numbered = false
    var labelColor = "#1d4ed8"
    var branchColor = "#facc15"
    var branchWidth = 18.0
    var selectedId: String? = null
        set(value) {
            if (field == value) return
            field = value
            host.studyChrome()
            host.studyRedraw()
        }

    /** Commit with history: (before, next). */
    var onChange: (List<StudyAnnotation>, List<StudyAnnotation>) -> Unit = { _, _ -> }
    var onEditLabel: (StudyCallout) -> Unit = {}
    var onEditLegendRow: (StudyLegend, String) -> Unit = { _, _ -> }
    var onNotice: (String) -> Unit = {}
    /** Confirmed crop: (page, rectangle in page fractions). */
    var onCrop: (Int, SRect) -> Unit = { _, _ -> }

    private var pending: StudyPending? = null
    private var live: StudyLive? = null
    private var draft: List<StudyAnnotation>? = null
    private var gesture: Gesture? = null

    val active get() = tool != null
    val dragging get() = gesture != null
    val selected: StudyAnnotation? get() = items.firstOrNull { it.id == selectedId }

    private sealed class Gesture {
        abstract val page: Int
        abstract val box: PageBox
        class Drag(override val page: Int, override val box: PageBox, val hit: StudyHit, val original: StudyAnnotation, val startX: Double, val startY: Double, val startPx: Double, val startPy: Double, var moved: Boolean = false) : Gesture()
        class Place(override val page: Int, override val box: PageBox, val start: SPoint) : Gesture()
        class Branch(override val page: Int, override val box: PageBox, val pts: MutableList<SPoint>) : Gesture()
        /** [grip] NONE means a new rectangle spanned from [start]; otherwise [original] is moved or resized. */
        class Crop(override val page: Int, override val box: PageBox, val grip: CropGrip, val original: SRect, val start: SPoint) : Gesture()
    }

    private fun slop() = 12.0 * host.studyDensity()

    private fun effective() = draft ?: items

    fun draw(canvas: Canvas) {
        painter.draw(canvas, effective(), { host.studyBox(it) }, selectedId, pending, live ?: crop?.let { StudyLive.Crop(it.page, it.rect) })
    }

    private fun pageAt(x: Double, y: Double): Pair<Int, PageBox>? =
        host.studyPages().firstOrNull { (_, b) -> x >= b.left && x <= b.left + b.width && y >= b.top && y <= b.top + b.height }

    private fun select(id: String?) { selectedId = id }

    /** Pointer down in unrotated view pixels. Returns true when the gesture continues with move/up. */
    fun down(x: Double, y: Double): Boolean {
        val current = tool ?: return false
        if (current == StudyTool.SELECT) {
            val hit = hitTest(effective(), { host.studyBox(it) }, x, y, selectedId, slop(), painter.measurer)
            if (hit == null) { select(null); return false }
            val item = items.firstOrNull { it.id == hit.id } ?: return false
            select(hit.id)
            val page = pageOf(item) ?: return false
            val box = host.studyBox(page) ?: return false
            gesture = Gesture.Drag(page, box, hit, item, box.fx(x), box.fy(y), x, y)
            return true
        }
        val (page, box) = pageAt(x, y) ?: return false
        val p = SPoint(box.fx(x), box.fy(y))
        when (current) {
            StudyTool.STAMP -> {
                val stamp = StudyStamp(ch.fasrv.fanotes.study.newAnnotationId(), page, p.x, p.y, stampId, 26.0)
                commit(addItem(items, stamp))
                select(stamp.id)
                return false
            }
            StudyTool.LEGEND -> {
                val old = items.filterIsInstance<StudyLegend>().firstOrNull { it.page == page }
                val next = if (old != null) replaceItem(items, old.copy(x = p.x, y = p.y))
                else addItem(items, StudyLegend(ch.fasrv.fanotes.study.newAnnotationId(), page, minOf(p.x, 0.7), p.y))
                commit(next)
                tool = StudyTool.SELECT
                return false
            }
            StudyTool.CALLOUT -> {
                gesture = Gesture.Place(page, box, p)
                return true
            }
            StudyTool.CROP -> {
                val old = crop?.takeIf { it.page == page }
                val grip = old?.let { cropGripAt(it.rect, p.x, p.y, 22.0 * host.studyDensity() / box.width, 22.0 * host.studyDensity() / box.height) } ?: CropGrip.NONE
                gesture = Gesture.Crop(page, box, grip, if (grip == CropGrip.NONE) SRect(p.x, p.y, p.x, p.y) else old!!.rect, p)
                return true
            }
            StudyTool.BRANCH -> {
                gesture = Gesture.Branch(page, box, mutableListOf(p))
                return true
            }
            StudyTool.ANGLE, StudyTool.ANGLE_LINES, StudyTool.DISTANCE -> {
                val base = pending?.takeIf { it.page == page && it.tool == current }?.pts.orEmpty()
                val pts = base + p
                if (pts.size >= measurePointsNeeded(current)) {
                    val measure = newMeasure(current, page, pts)
                    pending = null
                    commit(addItem(items, measure))
                    select(measure.id)
                } else {
                    pending = StudyPending(current, page, pts)
                    host.studyRedraw()
                }
                return false
            }
            else -> return false
        }
    }

    fun move(x: Double, y: Double) {
        when (val g = gesture ?: return) {
            is Gesture.Drag -> {
                if (!g.moved && hypot(x - g.startPx, y - g.startPy) < slop() * 0.6) return
                g.moved = true
                val dx = g.box.fx(x) - g.startX
                val dy = g.box.fy(y) - g.startY
                val next = dragged(g.original, g.hit.part, g.hit.index, dx, dy, g.box.fx(x), g.box.fy(y))
                draft = replaceItem(items, next)
            }
            is Gesture.Crop -> {
                val at = SPoint(g.box.fx(x), g.box.fy(y))
                val rect = if (g.grip == CropGrip.NONE) cropFromCorners(g.start.x, g.start.y, at.x, at.y)
                else cropDragged(g.original, g.grip, at.x - g.start.x, at.y - g.start.y)
                crop = StudyCrop(g.page, rect)
            }
            is Gesture.Place -> live = StudyLive.Leader(g.page, g.start, SPoint(g.box.fx(x), g.box.fy(y)), labelColor)
            is Gesture.Branch -> {
                g.pts += SPoint(g.box.fx(x), g.box.fy(y))
                live = StudyLive.Branch(g.page, g.pts.toList(), branchColor, branchWidth)
            }
        }
        host.studyRedraw()
    }

    fun up(x: Double, y: Double, cancel: Boolean) {
        val g = gesture ?: return
        gesture = null
        val end = SPoint(g.box.fx(x), g.box.fy(y))
        val next = draft
        draft = null
        live = null
        if (!cancel) {
            when (g) {
                is Gesture.Drag -> when {
                    g.moved && next != null -> commit(next)
                    !g.moved -> tap(g)
                }
                is Gesture.Place -> {
                    val callout = newCallout(items, g.page, g.start.x, g.start.y, end.x, end.y, labelColor, numbered)
                    commit(addItem(items, callout))
                    select(callout.id)
                    onEditLabel(callout)
                }
                is Gesture.Branch -> commit(addItem(items, newBranchStroke(g.page, g.pts + end, branchColor, branchWidth)))
                is Gesture.Crop -> {
                    // A tap or a sliver is not a crop; a bare tap outside keeps the previous rectangle.
                    if (crop?.rect?.let { cropIsUsable(it) } != true) crop = if (g.grip == CropGrip.NONE) null else StudyCrop(g.page, g.original)
                }
            }
        } else if (g is Gesture.Crop) {
            crop = if (g.grip == CropGrip.NONE) null else StudyCrop(g.page, g.original)
        }
        if (g is Gesture.Crop) host.studyChrome()
        host.studyRedraw()
    }

    private fun tap(g: Gesture.Drag) {
        val item = items.firstOrNull { it.id == g.hit.id } ?: return
        when {
            item is StudyCallout && g.hit.part == StudyPart.LABEL -> onEditLabel(item)
            item is StudyLegend && g.hit.part == StudyPart.LEGEND_ROW -> g.hit.rowKey?.let { onEditLegendRow(item, it) }
        }
    }

    private fun commit(next: List<StudyAnnotation>) {
        if (next == items) return
        onChange(items, next)
    }

    /** Applies [change] to the selected annotation as one undo step. */
    fun patchSelected(change: (StudyAnnotation) -> StudyAnnotation) {
        val item = selected ?: return
        commit(replaceItem(items, change(item)))
    }

    fun deleteSelected() {
        val id = selectedId ?: return
        val next = removeItem(items, id)
        select(null)
        commit(next)
    }

    fun replace(next: StudyAnnotation) = commit(replaceItem(items, next))

    fun setTerms(list: List<String>) = commit(ch.fasrv.fanotes.study.withTerms(items, list))

    fun visiblePage() = host.studyVisiblePage()

    fun renumber() = commit(renumberCallouts(items))

    /** Hands the rectangle to [onCrop] and leaves the crop tool. */
    fun confirmCrop() {
        val c = crop ?: return
        if (!cropIsUsable(c.rect)) return
        crop = null
        tool = StudyTool.SELECT
        onCrop(c.page, c.rect)
    }

    fun cancelCrop() {
        if (crop == null) return
        crop = null
        host.studyChrome()
        host.studyRedraw()
    }

    fun cancelPending() {
        if (pending != null) {
            pending = null
            host.studyRedraw()
        }
    }

    private fun pageOf(item: StudyAnnotation): Int? = item.pageOrNull()
}
