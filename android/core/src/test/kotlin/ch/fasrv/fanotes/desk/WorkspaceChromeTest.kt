package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class WorkspaceChromeTest {
    @Test
    fun theSidebarAndOutlineCanHideWithoutFocusMode() {
        assertEquals(NoteWorkspacePanels(true, false), noteWorkspacePanels(focus = false, wide = true, showList = true, sidebarOpen = true, inspectorOpen = false, outlineEnabled = true, notes = true))
        assertEquals(NoteWorkspacePanels(false, true), noteWorkspacePanels(focus = false, wide = true, showList = true, sidebarOpen = false, inspectorOpen = true, outlineEnabled = true, notes = true))
        assertEquals(NoteWorkspacePanels(false, false), noteWorkspacePanels(focus = true, wide = true, showList = true, sidebarOpen = true, inspectorOpen = true, outlineEnabled = true, notes = true))
        assertEquals(NoteWorkspacePanels(true, false), noteWorkspacePanels(focus = false, wide = false, showList = true, sidebarOpen = false, inspectorOpen = true, outlineEnabled = true, notes = true))
        assertEquals(NoteWorkspacePanels(false, false), noteWorkspacePanels(focus = false, wide = true, showList = true, sidebarOpen = true, inspectorOpen = true, outlineEnabled = true, notes = false))
    }

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
