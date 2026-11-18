package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class PenToolbarChromeTest {
    @Test
    fun positionReadsTheDesktopValues() {
        assertEquals(ToolbarPosition.TOP, toolbarPosition(null))
        assertEquals(ToolbarPosition.TOP, toolbarPosition("left"))
        assertEquals(ToolbarPosition.SIDE, toolbarPosition("side"))
        assertEquals(ToolbarPosition.SIDE_RIGHT, toolbarPosition("side-right"))
        assertTrue(ToolbarPosition.SIDE.vertical)
        assertFalse(ToolbarPosition.TOP.vertical)
    }

    @Test
    fun touchTargetsAreAtLeastFortyEightDp() {
        assertTrue(TOUCH_TARGET_DP >= 48)
        assertTrue(TOUCH_TOOLBAR_DP >= TOUCH_TARGET_DP)
        assertTrue(TOUCH_RAIL_DP >= TOUCH_TARGET_DP)
        // The desktop constants are untouched.
        assertEquals(36, EDITOR_TOOLBAR_DP)
    }

    @Test
    fun widthSliderRoundTripsOnItsStep() {
        assertEquals(0, widthToProgress(1.0, 1.0, 18.0))
        assertEquals(1000, widthToProgress(99.0, 1.0, 18.0))
        assertEquals(2.5, progressToWidth(widthToProgress(2.5, 1.0, 18.0), 1.0, 18.0, 0.5))
        assertEquals(0.75, progressToWidth(0, 0.75, 42.0, 0.25))
        assertEquals(42.0, progressToWidth(1000, 0.75, 42.0, 0.25))
    }

    @Test
    fun quickHoldIsOffUnlessTurnedOn() {
        assertFalse(penQuickHoldEnabled(null))
        assertTrue(penQuickHoldEnabled("on"))
    }
}
