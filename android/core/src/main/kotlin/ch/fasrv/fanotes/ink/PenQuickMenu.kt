package ch.fasrv.fanotes.ink

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin

/**
 * Pen quick menu, ported from `fanotes/src/lib/penQuickMenu.ts` and `PenQuickMenu.tsx`.
 *
 * The desktop opens a radial colour / tool menu when the tip touches while the pen button mapped to
 * "Schwenken" is held. Android only sees that button once the tip is down, and the same contact is
 * also a pan. So the chord is told apart by movement: pan button + tip that stays put (a tap, or held
 * still for [QUICK_MENU_HOLD_MS]) opens the menu; moving past the slop first pans as before. A button
 * mapped to "Schnellmenü" opens it at once. Pens without buttons can opt in to a long press of the
 * bare tip ([QUICK_MENU_LONG_PRESS_MS]).
 */

/** Pan button + tip held this still for this long opens the menu under the pen. */
const val QUICK_MENU_HOLD_MS = 500L
/** Pan button + tip lifted this fast without moving is a tap that opens the menu. */
const val QUICK_MENU_TAP_MS = 320L
/** Bare tip held still at the start of a stroke (opt-in setting `pen-quick-hold`). */
const val QUICK_MENU_LONG_PRESS_MS = 650L
/** Movement in dp that turns a candidate into a pan or a stroke. */
const val QUICK_MENU_SLOP_DP = 9f

/** Ring geometry in dp. Larger than the desktop px values so a finger hits an item too. */
const val QUICK_MENU_TOOL_RADIUS_DP = 64f
const val QUICK_MENU_COLOR_RADIUS_DP = 124f
const val QUICK_MENU_ITEM_DP = 48f
const val QUICK_MENU_HUB_DP = 40f
/** Outer edge of the menu from its centre, swatches included. */
const val QUICK_MENU_EXTENT_DP = QUICK_MENU_COLOR_RADIUS_DP + QUICK_MENU_ITEM_DP / 2f + 10f

enum class QuickMenuSource { PAN, INK }

/**
 * One pointer that may still become the quick menu. Plain state, driven by the view's touch handler
 * and its timer; no Android types so the rules can be tested on the host.
 */
class QuickMenuGesture {
    var pointerId = NO_POINTER
        private set
    var source = QuickMenuSource.PAN
        private set
    var startX = 0f
        private set
    var startY = 0f
        private set
    private var startAt = 0L
    private var moved = false

    /** Pointer that opened the menu while its tip is still down. Its moves and lift go to the menu. */
    var menuPointer = NO_POINTER
        private set

    val pending: Boolean get() = pointerId != NO_POINTER && !moved && menuPointer == NO_POINTER

    fun begin(pointer: Int, source: QuickMenuSource, x: Float, y: Float, at: Long) {
        pointerId = pointer
        this.source = source
        startX = x
        startY = y
        startAt = at
        moved = false
    }

    /** False once the pointer has left the slop circle; the gesture is then a pan or a stroke. */
    fun move(pointer: Int, x: Float, y: Float, slopPx: Float): Boolean {
        if (pointer != pointerId || moved) return false
        if (hypot((x - startX).toDouble(), (y - startY).toDouble()) > slopPx) moved = true
        return !moved
    }

    fun isCandidate(pointer: Int) = pointer == pointerId && pending

    /** The hold timer fired: true when this pointer is still a candidate and held long enough. */
    fun holdDue(pointer: Int, now: Long): Boolean {
        if (!isCandidate(pointer)) return false
        val wait = if (source == QuickMenuSource.PAN) QUICK_MENU_HOLD_MS else QUICK_MENU_LONG_PRESS_MS
        return now - startAt >= wait
    }

    /** A pan-button contact lifted quickly without moving: a tap that opens the menu. */
    fun tapUp(pointer: Int, now: Long): Boolean =
        isCandidate(pointer) && source == QuickMenuSource.PAN && now - startAt <= QUICK_MENU_TAP_MS

    /** The menu is open and [pointer] (when still down) now slides over it. */
    fun open(pointer: Int) {
        menuPointer = pointer
        pointerId = NO_POINTER
    }

    fun isMenuPointer(pointer: Int) = pointer != NO_POINTER && pointer == menuPointer

    /** Ends the candidate of [pointer]; -1 ends whatever is tracked. */
    fun end(pointer: Int = NO_POINTER) {
        if (pointer == NO_POINTER || pointer == pointerId) pointerId = NO_POINTER
        if (pointer == NO_POINTER || pointer == menuPointer) menuPointer = NO_POINTER
    }

    companion object {
        const val NO_POINTER = -1
    }
}

data class QuickMenuTool(val id: String, val label: String, val icon: String)

/** Same tools and order as the desktop quick menu. [icon] names a Lucide icon. */
val QUICK_MENU_TOOLS = listOf(
    QuickMenuTool("write", "Schreiben", "pen-line"),
    QuickMenuTool("highlighter", "Textmarker", "highlighter"),
    QuickMenuTool("eraser", "Radierer", "eraser"),
    QuickMenuTool("select", "Verschieben", "move"),
    QuickMenuTool("laser", "Laserpointer", "crosshair"),
)

/** Drawing colours of the desktop quick menu ring (Textmarker yellow first). */
val QUICK_ART_COLORS = listOf("#f2b735", "#77ad3a", "#21a8c7", "#e5489a", "#f06c32", "#6548dc", "#d83b52", "#17191f")

/** Most swatches the outer ring holds before they crowd. */
const val QUICK_MENU_MAX_COLORS = 10

/**
 * Colours on the outer ring: the drawing palette while drawing, otherwise the pen palette plus the
 * most recent custom colours, without duplicates.
 */
fun quickMenuColors(drawing: Boolean, penColors: List<String>, recent: List<String>): List<String> {
    val base = if (drawing) QUICK_ART_COLORS else penColors
    val out = ArrayList<String>(QUICK_MENU_MAX_COLORS)
    for (color in base + recent) {
        val hex = color.lowercase()
        if (out.none { it == hex }) out += hex
        if (out.size >= QUICK_MENU_MAX_COLORS) break
    }
    return out
}

/** Positions on a ring, starting at 12 o'clock and going clockwise (desktop `ringPositions`). */
fun quickMenuRing(count: Int, radius: Float, offset: Float = 0f): List<Pair<Float, Float>> =
    List(count) { index ->
        val angle = -PI / 2 + ((index + offset) / max(1, count).toDouble()) * PI * 2
        val x = (cos(angle) * radius * 10).roundToInt() / 10f
        val y = (sin(angle) * radius * 10).roundToInt() / 10f
        x to y
    }

/** Keeps the whole radial menu inside the view (desktop `clampQuickMenuCenter`). */
fun clampQuickMenuCenter(x: Float, y: Float, width: Float, height: Float, extent: Float): Pair<Float, Float> {
    fun clamp(value: Float, size: Float) = if (size <= extent * 2) size / 2 else min(max(value, extent), size - extent)
    return clamp(x, width) to clamp(y, height)
}

sealed class QuickMenuHit {
    object Hub : QuickMenuHit()
    data class Tool(val index: Int) : QuickMenuHit()
    data class Color(val index: Int) : QuickMenuHit()
}

/**
 * What lies under ([dx], [dy]) from the menu centre, all in the same unit as the radii. A point
 * between items picks the nearest item within a generous radius so a slide-and-lift forgives a miss.
 */
fun quickMenuHitTest(
    dx: Float,
    dy: Float,
    toolCount: Int,
    colorCount: Int,
    toolRadius: Float,
    colorRadius: Float,
    item: Float,
    hub: Float,
): QuickMenuHit? {
    if (hypot(dx.toDouble(), dy.toDouble()) <= hub / 2) return QuickMenuHit.Hub
    var best: QuickMenuHit? = null
    var bestDistance = item * 0.75
    quickMenuRing(toolCount, toolRadius).forEachIndexed { index, (x, y) ->
        val d = hypot((dx - x).toDouble(), (dy - y).toDouble())
        if (d < bestDistance) {
            bestDistance = d
            best = QuickMenuHit.Tool(index)
        }
    }
    quickMenuRing(colorCount, colorRadius, 0.5f).forEachIndexed { index, (x, y) ->
        val d = hypot((dx - x).toDouble(), (dy - y).toDouble())
        if (d < bestDistance) {
            bestDistance = d
            best = QuickMenuHit.Color(index)
        }
    }
    return best
}
