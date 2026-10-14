package ch.fasrv.fanotes.input

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class PalmPolicyTest {
    private fun finger(action: PointerAction, at: Long) = PointerSample(1, PointerTool.FINGER, action, 0f, 0f, 1f, 0f, 0f, at)
    private fun pen(action: PointerAction, at: Long) = PointerSample(2, PointerTool.STYLUS, action, 1f, 1f, 0.4f, 0f, 0f, at)

    @Test
    fun fingersNeverInkUnlessAsked() {
        val idle = PalmState()
        assertTrue(shouldRejectFinger(PointerTool.FINGER, idle, 1_000, fingerDraws = false))
        assertFalse(shouldRejectFinger(PointerTool.FINGER, idle, 1_000, fingerDraws = true))
        assertFalse(shouldRejectFinger(PointerTool.STYLUS, idle, 1_000, fingerDraws = false))
        assertFalse(shouldRejectFinger(PointerTool.MOUSE, idle, 1_000, fingerDraws = false))
    }

    @Test
    fun palmIsIgnoredWhileThePenIsDownAndFor850msAfter() {
        var state = touchPalmState(PalmState(), pen(PointerAction.DOWN, 5_000))
        assertTrue(state.stylusDown)
        assertFalse(fingerMayNavigate(state, 5_100))
        assertTrue(shouldRejectFinger(PointerTool.FINGER, state, 5_100, fingerDraws = true))
        state = touchPalmState(state, pen(PointerAction.UP, 6_000))
        assertFalse(state.stylusDown)
        assertFalse(fingerMayNavigate(state, 6_000 + POST_PEN_IGNORE_MS - 1))
        assertTrue(fingerMayNavigate(state, 6_000 + POST_PEN_IGNORE_MS))
    }

    @Test
    fun tiltMatchesPointerEvents() {
        val (x, y) = tiltDegrees(0f, 0f)
        assertEquals(0f, x)
        assertEquals(0f, y)
        val flat = tiltDegrees((Math.PI / 2).toFloat(), 0f)
        assertEquals(0f, flat.first, 0.01f)
        assertEquals(90f, flat.second, 0.01f)
    }
}
