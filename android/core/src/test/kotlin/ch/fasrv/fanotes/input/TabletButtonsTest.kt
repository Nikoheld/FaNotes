package ch.fasrv.fanotes.input

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class TabletButtonsTest {
    @Test
    fun identitiesMatchTheDesktopPointerFixtures() {
        val barrel = PointerButtonLike("pen", button = 2, buttons = 2)
        val eraser = PointerButtonLike("pen", button = 5, buttons = 32)
        val pad = PointerButtonLike("mouse", button = 3, buttons = 8)
        val tip = PointerButtonLike("pen", button = 0, buttons = 1)
        val mouseRight = PointerButtonLike("mouse", button = 2, buttons = 2)
        val wacomAsMouse = PointerButtonLike("mouse", button = 2, buttons = 2)
        assertEquals("pen-barrel", tabletButtonIdentityFromPointer(barrel))
        assertEquals("pen-eraser", tabletButtonIdentityFromPointer(eraser))
        assertEquals("tablet-1", tabletButtonIdentityFromPointer(pad))
        assertEquals("pen-tip", tabletButtonIdentityFromPointer(tip))
        assertNull(tabletButtonIdentityFromPointer(mouseRight))
        assertEquals("pen-barrel", tabletButtonIdentityFromPointer(wacomAsMouse, asStylus = true))
    }

    @Test
    fun factoryAndRemappedActionsMatchTheDesktopCheck() {
        val factory = sanitizeTabletButtonMap(null)
        assertEquals("eraser", tabletButtonAction(factory, "pen-barrel"))
        assertEquals("eraser", tabletButtonActionFromPointer(factory, PointerButtonLike("pen", 5, 32)))
        assertEquals("undo", tabletButtonActionFromPointer(factory, PointerButtonLike("mouse", 3, 8)))
        val changed = sanitizeTabletButtonMap(
            mapOf(
                "pen-barrel" to "undo",
                "pen-eraser" to "none",
                "tablet-1" to "redo",
                "junk" to "pan",
            ),
        )
        assertEquals("undo", changed["pen-barrel"])
        assertEquals("none", changed["pen-eraser"])
        assertEquals("redo", changed["tablet-1"])
        assertEquals("ink", changed["pen-tip"])
        assertEquals("pan", changed["pen-upper"])
        assertEquals("undo", tabletButtonActionFromPointer(changed, PointerButtonLike("pen", 2, 2)))
        assertEquals("none", tabletButtonActionFromPointer(changed, PointerButtonLike("pen", 5, 32)))
        assertEquals("redo", tabletButtonActionFromPointer(changed, PointerButtonLike("mouse", 3, 8)))
        assertEquals("os", tabletButtonAction(changed, null))
        assertFalse(shouldInterceptTabletButton("os"))
        assertTrue(shouldInterceptTabletButton("none"))
    }

    @Test
    fun androidSideButtonAndEraserEndUseThoseControls() {
        assertEquals("pen-barrel", tabletButtonIdentityFromAndroid(ANDROID_TOOL_STYLUS, ANDROID_BUTTON_STYLUS_PRIMARY))
        assertEquals("pen-eraser", tabletButtonIdentityFromAndroid(ANDROID_TOOL_ERASER, 0))
        assertEquals("pen-tip", tabletButtonIdentityFromAndroid(ANDROID_TOOL_STYLUS, ANDROID_BUTTON_PRIMARY))
        assertEquals("pen-upper", tabletButtonIdentityFromAndroid(ANDROID_TOOL_STYLUS, ANDROID_BUTTON_TERTIARY))
        assertEquals("tablet-1", tabletButtonIdentityFromAndroid(ANDROID_TOOL_MOUSE, ANDROID_BUTTON_BACK))
        assertEquals("tablet-2", tabletButtonIdentityFromAndroid(ANDROID_TOOL_MOUSE, ANDROID_BUTTON_FORWARD))
        assertNull(tabletButtonIdentityFromAndroid(ANDROID_TOOL_MOUSE, ANDROID_BUTTON_SECONDARY))
        assertEquals(
            "pen-barrel",
            tabletButtonIdentityFromAndroid(ANDROID_TOOL_MOUSE, ANDROID_BUTTON_SECONDARY, asStylus = true),
        )
        val defaults = parseTabletButtonMap(null)
        assertEquals("eraser", tabletButtonAction(defaults, tabletButtonIdentityFromAndroid(ANDROID_TOOL_STYLUS, ANDROID_BUTTON_STYLUS_PRIMARY)))
        assertEquals("eraser", tabletButtonAction(defaults, tabletButtonIdentityFromAndroid(ANDROID_TOOL_ERASER, 0)))
        assertEquals("ink", tabletButtonAction(defaults, tabletButtonIdentityFromAndroid(ANDROID_TOOL_STYLUS, 0)))
        val changed = parseTabletButtonMap("pen-barrel:undo;pen-eraser:none;tablet-1:redo;junk:pan")
        assertEquals("undo", tabletButtonAction(changed, "pen-barrel"))
        assertEquals("none", tabletButtonAction(changed, "pen-eraser"))
        assertEquals("ink", changed["pen-tip"])
        assertEquals(changed, parseTabletButtonMap(serializeTabletButtonMap(changed)))
        assertTrue(rejectsUnmappedMouseButton(null, ANDROID_TOOL_MOUSE, ANDROID_BUTTON_SECONDARY))
        assertFalse(rejectsUnmappedMouseButton("tablet-1", ANDROID_TOOL_MOUSE, ANDROID_BUTTON_BACK))
        assertEquals("Wiederholen", TABLET_BUTTON_ACTION_LABELS[nextTabletButtonAction("undo")])
    }
}
