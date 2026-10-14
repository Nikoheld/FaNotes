package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

class NoteLinksTest {
    @Test
    fun symbolAndTextStayDistinctAndPdfPageStaysLocal() {
        assertTrue(NOTE_LINK_STYLES.map { it.id }.containsAll(listOf("symbol", "text", "symbol-text")))
        assertNotEquals(noteLinkAppearanceToken("symbol"), noteLinkAppearanceToken("text"))
        val symbol = placeNewNoteLink(
            sourcePath = "Faecher/Skript.pdf",
            targetPath = "Faecher/Skript · Notiz.md",
            page = 2,
            x = 0.4,
            y = 0.5,
            style = "symbol",
            id = "nl-style-symbol",
        )
        val text = restyleNoteLink(symbol.copy(id = "nl-style-text"), "text")
        assertEquals("symbol", symbol.style)
        assertEquals("text", text.style)
        assertEquals("symbol", noteLinkAppearanceToken(symbol.style))
        assertEquals("text", noteLinkAppearanceToken(text.style))

        val frames = listOf(
            PageFrame(1, 0.0, 1130.0, 800.0),
            PageFrame(3, 2480.0, 1130.0, 800.0),
        )
        val sheetY = (2480.0 + 0.17 * 1130.0) / 3700.0
        val hit = noteLinkPointOnSheet(0.81, sheetY, frames, 800.0, 3700.0)
        assertEquals(3, hit.page)
        assertEquals(0.81, hit.x, 1e-9)
        assertEquals(0.17, hit.y, 1e-9)
        val markdown = noteLinkPointOnSheet(0.22, 0.41, emptyList(), 800.0, 3700.0)
        assertEquals(1, markdown.page)
        val placed = placeNewNoteLink("Faecher/Mechanik.md", "Faecher/Mechanik · Notiz.md", markdown.page, markdown.x, markdown.y, "symbol", id = "nl-md-place")
        assertEquals(1, placed.page)
        assertEquals("Faecher/Mechanik · Notiz.md", activateNoteLink(placed))
    }

    @Test
    fun removingOneLinkKeepsTheOther() {
        val keep = placeNewNoteLink("Faecher/Skript.pdf", "Faecher/Skript · Notiz.md", 1, 0.2, 0.3, "symbol", id = "nl-keep")
        val drop = placeNewNoteLink("Faecher/Skript.pdf", "Faecher/Skript · Notiz-2.md", 2, 0.8, 0.4, "text", id = "nl-drop")
        val remaining = removeNoteLink(listOf(keep, drop), drop.id)
        assertEquals(listOf("nl-keep"), remaining.map { it.id })
        assertEquals(emptyList(), removeNoteLink(remaining, keep.id))
        assertFailsWith<NoteLinkException> { removeNoteLink(listOf(keep), "nl-missing") }
        assertFailsWith<NoteLinkException> { removeNoteLink(listOf(keep), "") }
    }
}
