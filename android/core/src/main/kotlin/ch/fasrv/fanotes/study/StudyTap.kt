package ch.fasrv.fanotes.study

import kotlin.math.hypot
import kotlin.math.min

/**
 * Place-on-release tools of the "Lernen" menu: the stamp, the legend and every point of a measure.
 *
 * Nothing is committed when the contact lands. [StudyTap] arms the tap, and only a release that stayed
 * within the slop and was not cancelled places the item ([applyStudyTap]). A palm the system rejects
 * after delivering it (`ACTION_CANCEL`, or `FLAG_CANCELED` on the pointer up) and a contact that turned
 * into a drag therefore leave no stray stamp, legend or measure point behind. That is the same rule the
 * callout already follows.
 */

/** Points collected so far for a multi-tap measure, in page fractions. */
data class StudyPending(val tool: StudyTool, val page: Int, val pts: List<SPoint>)

/** Tools whose gesture is one tap that places an item on release. */
fun isTapTool(tool: StudyTool?): Boolean = when (tool) {
    StudyTool.STAMP, StudyTool.LEGEND, StudyTool.ANGLE, StudyTool.ANGLE_LINES, StudyTool.DISTANCE -> true
    else -> false
}

/**
 * One armed tap, in pixels. Once the contact leaves the [slop] circle it is a drag and stays one, even if
 * it comes back, so a wandering palm cannot turn into a tap by ending near where it began.
 */
class StudyTap(private val downX: Double, private val downY: Double, private val slop: Double) {
    var moved = false
        private set
    private var finished = false

    fun move(x: Double, y: Double) {
        if (!finished && !moved && hypot(x - downX, y - downY) > slop) moved = true
    }

    /**
     * Ends the contact at (x, y). True when the tap places its item: the contact stayed within the slop
     * (the last position counts) and was not [cancel]led. A second release of the same contact never commits.
     */
    fun release(x: Double, y: Double, cancel: Boolean): Boolean {
        if (finished) return false
        move(x, y)
        finished = true
        return !cancel && !moved
    }
}

/**
 * What a committed tap changes. [items] is the list to hand to the history (the same instance when
 * nothing changes), [select] the annotation to select afterwards, [tool] a tool to switch to, and
 * [pending] the measure points still to collect (null clears them).
 */
data class StudyTapEffect(
    val items: List<StudyAnnotation>,
    val select: String? = null,
    val tool: StudyTool? = null,
    val pending: StudyPending? = null,
)

/** Default stamp size, in the reference units of [StudyStamp.size]. */
const val STAMP_DEFAULT_SIZE = 26.0

/** Widest left edge of a new legend (page fraction), so it stays on the page. */
const val LEGEND_MAX_X = 0.7

/**
 * The effect of a committed tap of [tool] at [p] on [page], or null when [tool] is not a tap tool.
 * A measure keeps its [pending] points only while the taps stay on one page and one tool.
 */
fun applyStudyTap(
    tool: StudyTool,
    page: Int,
    p: SPoint,
    items: List<StudyAnnotation>,
    stampId: String,
    pending: StudyPending?,
): StudyTapEffect? = when (tool) {
    StudyTool.STAMP -> {
        val stamp = StudyStamp(newAnnotationId(), page, p.x, p.y, stampId, STAMP_DEFAULT_SIZE)
        val next = addItem(items, stamp)
        StudyTapEffect(next, select = stamp.id.takeIf { id -> next.any { it.id == id } })
    }
    StudyTool.LEGEND -> {
        val old = items.filterIsInstance<StudyLegend>().firstOrNull { it.page == page }
        val next = if (old != null) replaceItem(items, old.copy(x = p.x, y = p.y))
        else addItem(items, StudyLegend(newAnnotationId(), page, min(p.x, LEGEND_MAX_X), p.y))
        StudyTapEffect(next, tool = StudyTool.SELECT)
    }
    StudyTool.ANGLE, StudyTool.ANGLE_LINES, StudyTool.DISTANCE -> {
        val points = pending?.takeIf { it.page == page && it.tool == tool }?.pts.orEmpty() + p
        if (points.size >= measurePointsNeeded(tool)) {
            val measure = newMeasure(tool, page, points)
            val next = addItem(items, measure)
            StudyTapEffect(next, select = measure.id.takeIf { id -> next.any { it.id == id } })
        } else {
            StudyTapEffect(items, pending = StudyPending(tool, page, points))
        }
    }
    else -> null
}
