package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class NoteSearchTest {
    @Test
    fun findIsCaseInsensitiveAndStopsAtFourHundred() {
        assertEquals(emptyList(), searchNoteText("Hallo", "  "))
        val hits = searchNoteText("Alpha Beta und beta nochmal.", "Beta")
        assertEquals(listOf(6, 15), hits.map { it.start })
        assertEquals(listOf(10, 19), hits.map { it.end })
        assertTrue(hits[0].excerpt.contains("Beta"))
        assertEquals(400, searchNoteText("wort ".repeat(500), "wort").size)
    }
}