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
        assertFalse(reduceMotion(null))
        assertFalse(reduceMotion("off"))
        assertTrue(reduceMotion("on"))
        assertEquals("animate", listFollowsSelection(false))
        assertEquals("instant", listFollowsSelection(true))
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
        assertEquals(listOf("notes", "search", "pen", "tasks", "calendar"), RIBBON_PRIMARY.map { it.id })
        assertEquals("Stift", RIBBON_PRIMARY.first { it.id == "pen" }.label)
        assertEquals(listOf("daily", "overview", "cards", "books", "history", "study", "ai", "commands", "focus"), RIBBON_TOOLS.map { it.id })
        assertEquals("Werkzeuge", ribbonToolLabel(false))
        assertEquals("Weniger", ribbonToolLabel(true))
        assertTrue(ribbonItemActive("pen", "notes", penOpen = true))
        assertTrue(ribbonItemActive("notes", "notes", penOpen = false))
        assertTrue(!ribbonItemActive("notes", "notes", penOpen = true))
        assertTrue(ribbonItemActive("calendar", "calendar", penOpen = true))
    }
}
