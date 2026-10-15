package ch.fasrv.fanotes.desk

import kotlin.math.abs
import kotlin.math.max

/**
 * One-finger swipe from the desktop hand-gesture recogniser.
 * The longer axis must clearly win, and the travel must pass 56px.
 */
enum class SwipeDirection { LEFT, RIGHT, UP, DOWN }

fun swipeDirection(dx: Float, dy: Float, threshold: Float = 56f): SwipeDirection? {
    val ax = abs(dx)
    val ay = abs(dy)
    if (max(ax, ay) < threshold) return null
    if (ax >= ay * 1.35f) return if (dx < 0f) SwipeDirection.LEFT else SwipeDirection.RIGHT
    if (ay >= ax * 1.35f) return if (dy < 0f) SwipeDirection.UP else SwipeDirection.DOWN
    return null
}

/**
 * A horizontal swipe that starts in the outer 36px of the sheet walks the
 * note history. Right from the left edge goes back. Left from the right edge
 * goes forward. Anywhere else is not a history swipe.
 */
fun paperEdgeHistory(startX: Float, width: Float, direction: SwipeDirection, edgePx: Float = 36f): Int? {
    if (width <= edgePx * 2f) return null
    if (direction == SwipeDirection.RIGHT && startX <= edgePx) return -1
    if (direction == SwipeDirection.LEFT && startX >= width - edgePx) return 1
    return null
}

/** Calendar and homework planners: left moves forward, right moves back. */
fun calendarSwipeStep(direction: SwipeDirection): Int? = when (direction) {
    SwipeDirection.LEFT -> 1
    SwipeDirection.RIGHT -> -1
    else -> null
}

/**
 * Flashcard review. The first swipe shows the answer. The next one grades:
 * left again, right good, up easy, down hard.
 */
fun cardSwipeAction(revealed: Boolean, direction: SwipeDirection): String = when {
    !revealed -> "reveal"
    direction == SwipeDirection.LEFT -> "again"
    direction == SwipeDirection.RIGHT -> "good"
    direction == SwipeDirection.UP -> "easy"
    else -> "hard"
}
