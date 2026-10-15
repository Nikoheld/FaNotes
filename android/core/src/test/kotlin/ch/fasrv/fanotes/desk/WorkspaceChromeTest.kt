package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class WorkspaceChromeTest {
    @Test
    fun chromeDefaultsMatchTheDesktopShell() {
        assertEquals("clean", workspaceBackground(null))
        assertEquals("clean", workspaceBackground("linen"))
        assertEquals("mesh", workspaceBackground("mesh"))
        assertEquals("inter", uiFontId(null))
        assertEquals("dm", uiFontId("'DM Sans', ui-sans-serif, system-ui"))
        assertEquals("atkinson", uiFontId("Atkinson Hyperlegible"))
        assertEquals("source", uiFontId("'Source Sans 3', ui-sans-serif, system-ui"))
        assertFalse(compactChrome(null))
        assertFalse(glassChrome("off"))
        assertTrue(compactChrome("on"))
        assertTrue(glassChrome("on"))
        assertEquals(31, chromeRowHeightDp(false))
        assertEquals(27, chromeRowHeightDp(true))
        assertEquals(4, WORKSPACE_BACKGROUNDS.size)
        assertEquals(5, UI_FONTS.size)
        assertEquals(286, sidebarWidthDp(null))
        assertEquals(210, sidebarWidthDp("40"))
        assertEquals(430, sidebarWidthDp("900"))
        assertEquals(286, rightPanelWidthDp(""))
        assertEquals(220, rightPanelWidthDp("100"))
        assertEquals(320, rightPanelWidthDp("320"))
    }
}
