package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class EscapeDismissTest {
    @Test
    fun escapeClosesTheTopmostSurfaceInDesktopOrder() {
        assertEquals("confirm", escapeDismisses(EscapeLayer(confirm = true, palette = true, focus = true)))
        assertEquals("placing-link", escapeDismisses(EscapeLayer(placingLink = true, worksheetImport = true, palette = true)))
        assertEquals("selected-link", escapeDismisses(EscapeLayer(selectedLink = true, palette = true)))
        assertEquals("worksheet", escapeDismisses(EscapeLayer(worksheetImport = true, palette = true, destination = "search")))
        assertEquals("palette", escapeDismisses(EscapeLayer(palette = true, destination = "settings")))
        assertEquals("search", escapeDismisses(EscapeLayer(destination = "search", focus = true)))
        assertEquals("settings", escapeDismisses(EscapeLayer(destination = "settings")))
        assertEquals("ai", escapeDismisses(EscapeLayer(destination = "ai")))
        assertEquals("calendar", escapeDismisses(EscapeLayer(destination = "calendar")))
        assertEquals("tasks", escapeDismisses(EscapeLayer(destination = "tasks")))
        assertEquals("overview", escapeDismisses(EscapeLayer(destination = "overview", pen = true)))
        assertEquals("pen", escapeDismisses(EscapeLayer(pen = true, focus = true)))
        assertEquals("focus", escapeDismisses(EscapeLayer(focus = true)))
        assertNull(escapeDismisses(EscapeLayer(destination = "notes")))
        assertNull(escapeDismisses(EscapeLayer(destination = "history")))
        assertNull(escapeDismisses(EscapeLayer(destination = "books")))
        assertEquals("goto-line", escapeDismisses(EscapeLayer(gotoLine = true, destination = "search")))
        assertEquals("math", escapeDismisses(EscapeLayer(math = true, palette = true)))
    }
}