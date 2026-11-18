package ch.fasrv.fanotes.ink

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class PenQuickMenuTest {
    @Test
    fun panButtonTapWithoutMovingOpensTheMenu() {
        val chord = QuickMenuGesture()
        chord.begin(3, QuickMenuSource.PAN, 100f, 100f, at = 1_000)
        assertTrue(chord.move(3, 104f, 103f, slopPx = 20f))
        assertTrue(chord.tapUp(3, now = 1_000 + QUICK_MENU_TAP_MS))
        assertFalse(chord.tapUp(3, now = 1_000 + QUICK_MENU_TAP_MS + 1))
    }

    @Test
    fun movingPastTheSlopKeepsTheOldPan() {
        val chord = QuickMenuGesture()
        chord.begin(3, QuickMenuSource.PAN, 100f, 100f, at = 0)
        assertFalse(chord.move(3, 130f, 100f, slopPx = 20f))
        assertFalse(chord.pending)
        assertFalse(chord.holdDue(3, now = 10_000))
        assertFalse(chord.tapUp(3, now = 10))
        // Coming back into the slop does not revive it.
        assertFalse(chord.move(3, 100f, 100f, slopPx = 20f))
    }

    @Test
    fun holdingStillOpensAfterTheSourceDelay() {
        val pan = QuickMenuGesture()
        pan.begin(1, QuickMenuSource.PAN, 0f, 0f, at = 0)
        assertFalse(pan.holdDue(1, QUICK_MENU_HOLD_MS - 1))
        assertTrue(pan.holdDue(1, QUICK_MENU_HOLD_MS))
        assertFalse(pan.holdDue(2, QUICK_MENU_HOLD_MS))
        val ink = QuickMenuGesture()
        ink.begin(1, QuickMenuSource.INK, 0f, 0f, at = 0)
        assertFalse(ink.holdDue(1, QUICK_MENU_HOLD_MS))
        assertTrue(ink.holdDue(1, QUICK_MENU_LONG_PRESS_MS))
        // A bare-tip tap is a dot of ink, never the menu.
        assertFalse(ink.tapUp(1, 10))
    }

    @Test
    fun openMenuOwnsThePointerUntilItEnds() {
        val chord = QuickMenuGesture()
        chord.begin(4, QuickMenuSource.PAN, 0f, 0f, at = 0)
        chord.open(4)
        assertTrue(chord.isMenuPointer(4))
        assertFalse(chord.pending)
        assertFalse(chord.isMenuPointer(QuickMenuGesture.NO_POINTER))
        chord.end(5)
        assertTrue(chord.isMenuPointer(4))
        chord.end(4)
        assertFalse(chord.isMenuPointer(4))
    }

    @Test
    fun ringStartsAtTwelveAndGoesClockwise() {
        val ring = quickMenuRing(4, 10f)
        assertEquals(0f to -10f, ring[0])
        assertEquals(10f to 0f, ring[1])
        assertEquals(0f to 10f, ring[2])
        assertEquals(-10f to 0f, ring[3])
        // Desktop offsets the colour ring by half a slot.
        assertEquals(7.1f to -7.1f, quickMenuRing(4, 10f, 0.5f)[0])
    }

    @Test
    fun centreIsClampedInsideTheView() {
        assertEquals(150f to 150f, clampQuickMenuCenter(10f, 20f, 1000f, 800f, 150f))
        assertEquals(850f to 650f, clampQuickMenuCenter(990f, 790f, 1000f, 800f, 150f))
        assertEquals(100f to 400f, clampQuickMenuCenter(10f, 400f, 200f, 800f, 150f))
    }

    @Test
    fun hitTestFindsHubToolsAndColours() {
        val hit = { dx: Float, dy: Float -> quickMenuHitTest(dx, dy, 5, 8, 64f, 124f, 48f, 40f) }
        assertEquals(QuickMenuHit.Hub, hit(3f, -4f))
        assertEquals(QuickMenuHit.Tool(0), hit(0f, -64f))
        assertEquals(QuickMenuHit.Tool(0), hit(10f, -55f))
        val second = quickMenuRing(8, 124f, 0.5f)[1]
        assertEquals(QuickMenuHit.Color(1), hit(second.first, second.second))
        assertNull(hit(0f, -100f))
        assertNull(hit(400f, 0f))
    }

    @Test
    fun coloursFollowTheModeAndAddRecentOnes() {
        val pen = listOf("#202333", "#2457D6")
        assertEquals(listOf("#202333", "#2457d6", "#ff0000"), quickMenuColors(false, pen, listOf("#ff0000", "#2457d6")))
        assertEquals(QUICK_ART_COLORS + "#123456", quickMenuColors(true, pen, listOf("#123456")))
        assertEquals(QUICK_MENU_MAX_COLORS, quickMenuColors(true, pen, List(20) { "#0000%02x".format(it) }).size)
    }

    @Test
    fun toolsMatchTheDesktopOrder() {
        assertEquals(listOf("write", "highlighter", "eraser", "select", "laser"), QUICK_MENU_TOOLS.map { it.id })
    }
}
