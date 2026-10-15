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
