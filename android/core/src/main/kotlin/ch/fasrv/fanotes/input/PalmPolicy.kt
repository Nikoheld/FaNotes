package ch.fasrv.fanotes.input

/**
 * Palm rejection shared with the desktop client (`inkPointerPolicy.ts`).
 *
 * A finger never lays ink. While a stylus is down, and for [POST_PEN_IGNORE_MS]
 * after it lifts, finger contacts are also ignored for navigation so a resting
 * palm does not pan or zoom the page. A mouse may ink (emulator, Bluetooth
 * mouse) unless the caller disables it. The side button and the eraser end
 * follow the tablet button map; their defaults still erase.
 */
const val POST_PEN_IGNORE_MS = 850L

enum class PointerTool { STYLUS, ERASER, FINGER, MOUSE, UNKNOWN }

enum class PointerAction { DOWN, MOVE, UP, CANCEL, HOVER }

data class PointerSample(
    val pointerId: Int,
    val tool: PointerTool,
    val action: PointerAction,
    /** View pixels. */
    val x: Float,
    val y: Float,
    /** 0..1, matching Pointer Events and MotionEvent pressure. */
    val pressure: Float,
    /** Degrees, matching Pointer Events tiltX / tiltY. */
    val tiltX: Float,
    val tiltY: Float,
    val timeMs: Long,
    /** Predicted samples are painted and never committed. */
    val predicted: Boolean = false,
)

data class PalmState(
    val stylusDown: Boolean = false,
    val lastStylusAt: Long = 0L,
)

fun isPenTool(tool: PointerTool) = tool == PointerTool.STYLUS || tool == PointerTool.ERASER

/** Desktop `shouldRejectNonPenInk`. Pen-only still allows zoom and mapped buttons. */
fun penOnlyEnabled(raw: String?) = raw == "on"

fun shouldRejectNonPenInk(pointerType: String?, penOnly: Boolean) = penOnly && pointerType != "pen"

/** A stroke that already started keeps its move events, even if the device labelled them mouse. */
fun shouldRejectNonPenInkMove(pointerType: String?, penOnly: Boolean, liveStroke: Boolean) =
    if (liveStroke) false else shouldRejectNonPenInk(pointerType, penOnly)

/**
 * True when this contact must not move the page and must not draw.
 * Stylus and mouse are never rejected here.
 */
fun shouldRejectFinger(
    tool: PointerTool,
    state: PalmState,
    now: Long,
    fingerDraws: Boolean,
): Boolean {
    if (tool != PointerTool.FINGER && tool != PointerTool.UNKNOWN) return false
    if (state.stylusDown) return true
    if (state.lastStylusAt > 0L && now - state.lastStylusAt < POST_PEN_IGNORE_MS) return true
    return !fingerDraws && tool == PointerTool.FINGER
}

/** Fingers navigate only outside the post-pen window. They never start ink unless [fingerDraws]. */
fun fingerMayNavigate(state: PalmState, now: Long): Boolean {
    if (state.stylusDown) return false
    if (state.lastStylusAt > 0L && now - state.lastStylusAt < POST_PEN_IGNORE_MS) return false
    return true
}

fun touchPalmState(state: PalmState, sample: PointerSample): PalmState {
    if (!isPenTool(sample.tool)) return state
    return when (sample.action) {
        PointerAction.DOWN, PointerAction.MOVE, PointerAction.HOVER -> state.copy(
            stylusDown = sample.action != PointerAction.HOVER,
            lastStylusAt = sample.timeMs,
        )
        PointerAction.UP, PointerAction.CANCEL -> state.copy(
            stylusDown = false,
            lastStylusAt = sample.timeMs,
        )
    }
}

/**
 * Palm state after a contact left the screen (`UP`, `POINTER_UP` or `CANCEL`).
 *
 * Every pen contact [touchPalmState] counted when it landed has to be released when it ends, whether or not
 * it started ink. A mapped tablet button (undo, redo, pan, none), a tap tool, a mouse that already owns the
 * ink pointer and a cancelled gesture all return before an ink pointer exists. Releasing only together with
 * the ink pointer left [PalmState.stylusDown] set, so finger pan and zoom stayed dead until a later hover,
 * and a pen without hover never recovered.
 *
 * [endedTool] is the tool of the pointer that went up. A cancel ends the whole touch stream, so any pen in
 * [streamTools] (the tools of every pointer of that event) releases the state. A finger or mouse ending
 * never touches it: the pen may still be down, and a finger must not start the post-pen window.
 */
fun palmAfterContactEnd(
    state: PalmState,
    endedTool: PointerTool,
    cancel: Boolean,
    streamTools: List<PointerTool>,
    now: Long,
): PalmState {
    val penEnded = if (cancel) streamTools.any { isPenTool(it) } else isPenTool(endedTool)
    return if (penEnded) state.copy(stylusDown = false, lastStylusAt = now) else state
}

/**
 * Android reports tilt as an angle off the screen normal plus a direction.
 * Pointer Events store the same pose as tiltX / tiltY in degrees. See the
 * mapping notes in `android/ARCHITECTURE.md`.
 */
fun tiltDegrees(tiltRadians: Float, orientationRadians: Float): Pair<Float, Float> {
    if (tiltRadians <= 0f) return 0f to 0f
    val degrees = Math.toDegrees(tiltRadians.toDouble()).toFloat()
    val tiltX = (kotlin.math.sin(orientationRadians) * degrees)
    val tiltY = (kotlin.math.cos(orientationRadians) * degrees)
    return tiltX to tiltY
}
