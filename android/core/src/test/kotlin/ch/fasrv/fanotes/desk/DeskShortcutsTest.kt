package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class DeskShortcutsTest {
    @Test
    fun windowShortcutsMatchTheDesktopHandler() {
        assertEquals("tab-next", deskShortcut(true, false, false, false, "tab"))
        assertEquals("tab-prev", deskShortcut(true, true, false, false, "tab"))
        assertEquals("back", deskShortcut(false, false, true, false, "left"))
        assertEquals("forward", deskShortcut(false, false, true, false, "right"))
        assertEquals("tab-1", deskShortcut(true, false, false, false, "1"))
        assertEquals("tab-9", deskShortcut(true, false, false, false, "9"))
        assertEquals("reopen-tab", deskShortcut(true, true, false, false, "t"))
        assertEquals("quick-open", deskShortcut(true, false, false, false, "o"))
        assertEquals("split", deskShortcut(true, false, false, false, "\\"))
        assertEquals("split-swap", deskShortcut(true, true, false, false, "\\"))
        assertEquals("close-tab", deskShortcut(true, false, false, false, "w"))
        assertEquals("save", deskShortcut(true, false, false, false, "s"))
        assertEquals("palette", deskShortcut(true, false, false, false, "p"))
        assertEquals("vault-search", deskShortcut(true, true, false, false, "f"))
        assertEquals("ai", deskShortcut(true, true, false, false, "a"))
        assertEquals("worksheet", deskShortcut(true, true, false, false, "i"))
        assertEquals("new-note", deskShortcut(true, false, false, false, "n"))
        assertEquals("settings", deskShortcut(true, false, false, false, ","))
        assertEquals("focus", deskShortcut(true, true, false, false, "e"))
        assertEquals("pen", deskShortcut(true, false, false, false, "d"))
        assertEquals("stamp", deskShortcut(true, true, false, false, "d"))
        assertEquals("toggle-task", deskShortcut(true, false, false, false, "enter"))
        assertEquals("toggle-task", deskShortcut(false, false, false, true, "enter"))
        assertNull(deskShortcut(true, false, true, false, "enter"))
        assertNull(deskShortcut(true, true, false, false, "g"))
        assertNull(deskShortcut(true, false, false, false, "q"))
        assertNull(deskShortcut(false, false, false, false, "s"))
    }
}
