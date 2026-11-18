package ch.fasrv.fanotes.input

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class PenEraserHoldTest {
    private val defaults = sanitizeTabletButtonMap(null)

    @Test
    fun heldSideButtonLatchesOnHoverAndSurvivesADroppedBit() {
        var hold = nextPenEraserHold(0, ANDROID_TOOL_STYLUS, ANDROID_BUTTON_STYLUS_PRIMARY, defaults, hovering = true)
        assertEquals(2, hold)
        // The contact sample lost the bit; the button is still down.
        hold = nextPenEraserHold(hold, ANDROID_TOOL_STYLUS, 0, defaults, hovering = false)
        assertEquals(2, hold)
        assertTrue(penEraserHeld(hold, "pen-tip"))
        // Released while hovering.
        hold = nextPenEraserHold(hold, ANDROID_TOOL_STYLUS, 0, defaults, hovering = true)
        assertEquals(0, hold)
        assertFalse(penEraserHeld(hold, "pen-tip"))
    }

    @Test
    fun leavingOrCancellingEndsTheLatch() {
        val hold = nextPenEraserHold(0, ANDROID_TOOL_STYLUS, ANDROID_BUTTON_STYLUS_PRIMARY, defaults, hovering = true)
        assertEquals(0, nextPenEraserHold(hold, ANDROID_TOOL_STYLUS, ANDROID_BUTTON_STYLUS_PRIMARY, defaults, hovering = true, left = true))
    }

    @Test
    fun onlyEraserMappedButtonsLatch() {
        val panned = parseTabletButtonMap("pen-barrel:pan")
        assertEquals(0, nextPenEraserHold(0, ANDROID_TOOL_STYLUS, ANDROID_BUTTON_STYLUS_PRIMARY, panned, hovering = true))
        val upper = parseTabletButtonMap("pen-upper:eraser")
        assertEquals(4, nextPenEraserHold(0, ANDROID_TOOL_STYLUS, ANDROID_BUTTON_TERTIARY, upper, hovering = true))
    }

    @Test
    fun fingersAndTheEraserEndLeaveTheLatchAlone() {
        assertEquals(2, nextPenEraserHold(2, ANDROID_TOOL_FINGER, 0, defaults, hovering = true))
        assertEquals(0, nextPenEraserHold(0, ANDROID_TOOL_ERASER, 0, defaults, hovering = true))
        // A mapped button that is not the tip keeps its own action.
        assertFalse(penEraserHeld(2, "pen-barrel"))
    }

    @Test
    fun quickMenuIsAnAssignableAction() {
        assertTrue("menu" in TABLET_BUTTON_ACTIONS)
        assertEquals("Schnellmenü", TABLET_BUTTON_ACTION_LABELS["menu"])
        assertEquals("menu", tabletButtonAction(parseTabletButtonMap("pen-barrel:menu"), "pen-barrel"))
        assertTrue(shouldInterceptTabletButton("menu"))
    }
}
