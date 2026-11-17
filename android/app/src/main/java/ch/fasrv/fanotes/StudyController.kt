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
import ch.fasrv.fanotes.study.StudyCrop
import ch.fasrv.fanotes.study.StudyDialogState
import ch.fasrv.fanotes.study.StudyHit
import ch.fasrv.fanotes.study.StudyLegend
import ch.fasrv.fanotes.study.StudyPart
import ch.fasrv.fanotes.study.StudyPending
import ch.fasrv.fanotes.study.StudyTap
import ch.fasrv.fanotes.study.StudyTool
import ch.fasrv.fanotes.study.StudyUiState
import ch.fasrv.fanotes.study.addItem
import ch.fasrv.fanotes.study.applyStudyTap
import ch.fasrv.fanotes.study.dragged
import ch.fasrv.fanotes.study.hitTest
import ch.fasrv.fanotes.study.isTapTool
import ch.fasrv.fanotes.study.newBranchStroke
import ch.fasrv.fanotes.study.newCallout
import ch.fasrv.fanotes.study.pageOrNull
import ch.fasrv.fanotes.study.removeItem
import ch.fasrv.fanotes.study.replaceItem
import ch.fasrv.fanotes.study.renumberCallouts
import kotlin.math.hypot

/**
 * Pointer logic of the "Lernen" tools. The ink surface hands it the pen/mouse (or finger, when
 * "finger draws" is on) gestures that `PalmPolicy` already let through, so palm rejection and
 * pen-only mode behave exactly as for ink. One gesture is one undo step in the annotation history.
 * Stamp, legend and measure points are taps: they place their item when the contact lifts without
 * having moved or been cancelled, never when it lands.
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

    /** The label editor that is open, with the text typed so far; the view keeps it current so a recreated screen can reopen it. */
    var openDialog: StudyDialogState? = null

    /** Everything that is not committed to the note yet, for [restore] after the screen is recreated. */
    fun snapshot() = StudyUiState(tool, selectedId, stampId, numbered, labelColor, branchColor, branchWidth, pending, crop, openDialog)

    /**
     * Puts a [snapshot] back after a rotation or a restart. A gesture that was under way is gone; the tool,
     * selection, collected measure points, unconfirmed crop and choices come back. [openDialog] is only
     * handed over: the view reopens the editor once the note's annotations are loaded.
     */
    fun restore(state: StudyUiState) {
        stampId = state.stampId
        numbered = state.numbered
        labelColor = state.labelColor
        branchColor = state.branchColor
        branchWidth = state.branchWidth
        // The tool setter clears gesture, pending and crop, so it goes first.
        tool = state.tool
        selectedId = state.selectedId
        pending = state.pending
        crop = state.crop
        openDialog = state.dialog
        host.studyChrome()
        host.studyRedraw()
    }

    val active get() = tool != null
    val dragging get() = gesture != null
    val selected: StudyAnnotation? get() = items.firstOrNull { it.id == selectedId }

    private sealed class Gesture {
        abstract val page: Int
        abstract val box: PageBox
        class Drag(override val page: Int, override val box: PageBox, val hit: StudyHit, val original: StudyAnnotation, val startX: Double, val startY: Double, val startPx: Double, val startPy: Double, var moved: Boolean = false) : Gesture()
        class Place(override val page: Int, override val box: PageBox, val start: SPoint) : Gesture()
        /** Stamp, legend or one measure point: placed by [StudyController.up] when the [tap] qualifies. */
        class Tap(override val page: Int, override val box: PageBox, val tool: StudyTool, val start: SPoint, val tap: StudyTap) : Gesture()
        class Branch(override val page: Int, override val box: PageBox, val pts: MutableList<SPoint>) : Gesture()
        /** [grip] NONE means a new rectangle spanned from [start]; otherwise [original] is moved or resized. */
        class Crop(override val page: Int, override val box: PageBox, val grip: CropGrip, val original: SRect, val start: SPoint) : Gesture()
    }

    private fun slop() = 12.0 * host.studyDensity()

    private fun effective() = draft ?: items

    private val boxFor: (Int) -> PageBox? = { host.studyBox(it) }

    fun draw(canvas: Canvas) {
        painter.draw(canvas, effective(), boxFor, selectedId, pending, live ?: crop?.let { StudyLive.Crop(it.page, it.rect) })
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
        if (isTapTool(current)) {
            // Nothing is committed yet: a palm the system rejects, or a contact that drags, must leave no item behind.
            gesture = Gesture.Tap(page, box, current, p, StudyTap(x, y, slop()))
            return true
        }
        when (current) {
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
            is Gesture.Tap -> {
                g.tap.move(x, y)
                return
            }
            is Gesture.Branch -> {
                g.pts += SPoint(g.box.fx(x), g.box.fy(y))
                // The painter appends the new points to its path; handing it a copy per move made every frame O(n).
                live = StudyLive.Branch(g.page, g.pts, branchColor, branchWidth)
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
        if (g is Gesture.Tap) {
            if (g.tap.release(x, y, cancel)) commitTap(g)
        } else if (!cancel) {
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
                is Gesture.Tap -> Unit
            }
        } else if (g is Gesture.Crop) {
            crop = if (g.grip == CropGrip.NONE) null else StudyCrop(g.page, g.original)
        }
        if (g is Gesture.Crop) host.studyChrome()
        host.studyRedraw()
    }

    /** Places the item of a tap that qualified on release (see [applyStudyTap]). */
    private fun commitTap(g: Gesture.Tap) {
        val effect = applyStudyTap(g.tool, g.page, g.start, items, stampId, pending) ?: return
        pending = effect.pending
        commit(effect.items)
        effect.select?.let { select(it) }
        effect.tool?.let { tool = it }
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
