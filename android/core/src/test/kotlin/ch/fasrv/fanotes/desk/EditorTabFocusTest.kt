package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class EditorTabFocusTest {
    @Test
    fun ctrlMTogglesTabFocusAndTabThenLeavesTheEditor() {
        assertTrue(togglesEditorTabFocus(true, false, false, false, "m"))
        assertTrue(togglesEditorTabFocus(false, false, false, true, "m"))
        assertFalse(togglesEditorTabFocus(true, true, false, false, "m"))
        assertFalse(togglesEditorTabFocus(true, false, true, false, "m"))
        assertFalse(togglesEditorTabFocus(false, false, false, false, "m"))
        assertTrue(editorIndentsOnTab(false, false, false, false))
        assertFalse(editorIndentsOnTab(true, false, false, false))
        assertFalse(editorIndentsOnTab(false, true, false, false))
        assertEquals("Tab verlässt den Editor", editorTabFocusAnnouncement(true))
        assertEquals("Tab rückt die Zeile ein", editorTabFocusAnnouncement(false))
    }
}