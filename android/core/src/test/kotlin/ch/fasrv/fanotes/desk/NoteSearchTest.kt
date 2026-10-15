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

    @Test
    fun replaceOneLeavesLaterMatches() {
        val text = "Alpha Beta und beta nochmal."
        val first = searchNoteText(text, "Beta").first()
        assertEquals("Alpha X und beta nochmal.", replaceNoteMatch(text, first, "X"))
        assertEquals("Alpha  und beta nochmal.", replaceNoteMatch(text, first, ""))
        assertEquals(text, replaceNoteMatch(text, NoteSearchHit(-1, 2, ""), "X"))
    }

    @Test
    fun replaceAllWalksOriginalHitsFromTheEnd() {
        val text = "Alpha Beta und beta nochmal."
        assertEquals("Alpha X und X nochmal.", replaceAllNoteMatches(text, "beta", "X"))
        assertEquals("bb", replaceAllNoteMatches("aaaa", "aa", "b"))
        assertEquals("beta und beta", replaceAllNoteMatches("beta", "beta", "beta und beta"))
        assertEquals("wort ".repeat(500), replaceAllNoteMatches("wort ".repeat(500), "   ", "x"))
        assertEquals("x ".repeat(500), replaceAllNoteMatches("wort ".repeat(500), "wort", "x"))
    }

    @Test
    fun replaceAllKeepsFoldedHeadingBodies() {
        val note = "# Einleitung\n\nAbsatz beta.\n\n# Nächstes\n\nbeta hier\n"
        val folded = setOf(1)
        val shown = markdownWithFolds(note, folded)
        val next = replaceAllNoteMatches(shown, "beta", "X")
        val edited = applyFoldedEdit(note, folded, shown, next)
        assertTrue(edited.contains("Absatz beta."))
        assertTrue(edited.contains("X hier"))
        assertEquals(false, edited.contains("beta hier"))
    }
}