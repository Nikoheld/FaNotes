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
    fun aPenContactThatNeverStartedInkStillReleasesThePalmLock() {
        // Barrel button mapped to undo, a stamp tap or a rejected second pointer: DOWN, then UP, and no ink pointer in between.
        var state = touchPalmState(PalmState(), pen(PointerAction.DOWN, 5_000))
        assertTrue(state.stylusDown)
        assertFalse(fingerMayNavigate(state, 5_300))
        state = palmAfterContactEnd(state, PointerTool.STYLUS, cancel = false, streamTools = listOf(PointerTool.STYLUS), now = 5_400)
        assertFalse(state.stylusDown)
        assertEquals(5_400L, state.lastStylusAt)
        // The post-pen window still protects the page from the resting palm, then fingers navigate again.
        assertFalse(fingerMayNavigate(state, 5_400 + POST_PEN_IGNORE_MS - 1))
        assertTrue(fingerMayNavigate(state, 5_400 + POST_PEN_IGNORE_MS))
    }

    @Test
    fun theEraserEndReleasesLikeThePenTip() {
        val down = PointerSample(2, PointerTool.ERASER, PointerAction.DOWN, 1f, 1f, 0.4f, 0f, 0f, 1_000)
        val state = touchPalmState(PalmState(), down)
        assertTrue(state.stylusDown)
        val ended = palmAfterContactEnd(state, PointerTool.ERASER, cancel = false, streamTools = listOf(PointerTool.ERASER), now = 1_200)
        assertFalse(ended.stylusDown)
    }

    @Test
    fun aCancelReleasesWhenAnyPenIsPartOfTheStream() {
        val state = touchPalmState(PalmState(), pen(PointerAction.DOWN, 2_000))
        // ACTION_CANCEL reports the action index of pointer 0, which can be the palm.
        val cancelled = palmAfterContactEnd(state, PointerTool.FINGER, cancel = true, streamTools = listOf(PointerTool.FINGER, PointerTool.STYLUS), now = 2_500)
        assertFalse(cancelled.stylusDown)
        assertEquals(2_500L, cancelled.lastStylusAt)
    }

    @Test
    fun aFingerOrMouseEndingNeverTouchesThePenState() {
        val penDown = touchPalmState(PalmState(), pen(PointerAction.DOWN, 3_000))
        // The palm lifts while the pen is still down: the lock stays.
        assertEquals(penDown, palmAfterContactEnd(penDown, PointerTool.FINGER, cancel = false, streamTools = listOf(PointerTool.FINGER, PointerTool.STYLUS), now = 3_100))
        // A cancel of a touch-only stream (separate digitizer) leaves a pen that is down elsewhere alone.
        assertEquals(penDown, palmAfterContactEnd(penDown, PointerTool.FINGER, cancel = true, streamTools = listOf(PointerTool.FINGER), now = 3_200))
        // A finger or mouse lifting on its own must not start the 850 ms post-pen window.
        val idle = PalmState()
        assertEquals(idle, palmAfterContactEnd(idle, PointerTool.FINGER, cancel = false, streamTools = listOf(PointerTool.FINGER), now = 4_000))
        assertEquals(idle, palmAfterContactEnd(idle, PointerTool.MOUSE, cancel = true, streamTools = listOf(PointerTool.MOUSE), now = 4_000))
        assertTrue(fingerMayNavigate(idle, 4_001))
    }

    @Test
    fun penOnlyLeavesTheStylusAndALiveStrokeAlone() {
        assertFalse(penOnlyEnabled(null))
        assertTrue(penOnlyEnabled("on"))
        assertTrue(shouldRejectNonPenInk("mouse", penOnly = true))
        assertTrue(shouldRejectNonPenInk("touch", penOnly = true))
        assertFalse(shouldRejectNonPenInk("pen", penOnly = true))
        assertFalse(shouldRejectNonPenInk("mouse", penOnly = false))
        assertFalse(shouldRejectNonPenInkMove("mouse", penOnly = true, liveStroke = true))
        assertTrue(shouldRejectNonPenInkMove("mouse", penOnly = true, liveStroke = false))
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
