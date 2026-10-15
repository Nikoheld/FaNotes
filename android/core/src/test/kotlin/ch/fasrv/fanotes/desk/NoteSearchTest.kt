package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
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

    @Test
    fun caseWholeWordAndRegexpMatchTheSearchPanel() {
        val text = "Alpha Beta und beta, betabeta."
        assertEquals(listOf(6), searchNoteText(text, "Beta", options = NoteSearchOptions(caseSensitive = true)).map { it.start })
        val words = searchNoteText(text, "beta", options = NoteSearchOptions(wholeWord = true))
        assertEquals(listOf(6, 15), words.map { it.start })
        val pattern = searchNoteText(text, "b.ta", options = NoteSearchOptions(regexp = true))
        assertEquals(listOf(6, 15, 21, 25), pattern.map { it.start })
        assertEquals(emptyList(), searchNoteText("xText", "^Text", options = NoteSearchOptions(regexp = true)))
        assertEquals(listOf(4), searchNoteText("foo\nText", "^Text", options = NoteSearchOptions(regexp = true)).map { it.start })
        assertEquals(emptyList(), searchNoteText("foo\nbar", "foo.bar", options = NoteSearchOptions(regexp = true)))
        assertEquals(listOf(1), searchNoteText("a\tb", "\\t").map { it.start })
        assertEquals(emptyList(), searchNoteText("a1", "\\d"))
        assertEquals(listOf(1), searchNoteText("a1", "\\d", options = NoteSearchOptions(regexp = true)).map { it.start })
        assertEquals(emptyList(), searchNoteText("Hallo", "(", options = NoteSearchOptions(regexp = true)))
        assertEquals("a\nb", replaceNoteMatch("ab", searchNoteText("ab", "a").first(), "a\\n"))
        assertEquals("[a] [b]", replaceAllNoteMatches("a b", "(\\w)", "[\$1]", NoteSearchOptions(regexp = true)))
        assertEquals("a2", replaceAllNoteMatches("a", "(a)", "\$12", NoteSearchOptions(regexp = true)))
        assertEquals("\$", replaceAllNoteMatches("a", "a", "\$\$", NoteSearchOptions(regexp = true)))
        assertEquals("aa", replaceAllNoteMatches("a", "a", "a\$&", NoteSearchOptions(regexp = true)))
    }

    @Test
    fun theFullNoteStillContainsAFoldedBody() {
        val note = "# Einleitung\n\nAbsatz beta.\n\n# Nächstes\n"
        val shown = markdownWithFolds(note, setOf(1))
        assertEquals(emptyList(), searchNoteText(shown, "beta"))
        assertEquals(listOf(note.indexOf("beta")), searchNoteText(note, "beta").map { it.start })
        assertTrue(replaceAllNoteMatches(note, "beta", "X").contains("Absatz X."))
    }

    @Test
    fun searchKeysOpenFindAndGoToLine() {
        assertEquals("open", editorSearchShortcut(true, false, false, false, "f"))
        assertEquals("next", editorSearchShortcut(true, false, false, false, "g"))
        assertEquals("previous", editorSearchShortcut(true, true, false, false, "g"))
        assertEquals("next", editorSearchShortcut(false, false, false, false, "f3"))
        assertEquals("previous", editorSearchShortcut(false, true, false, false, "f3"))
        assertEquals("goto", editorSearchShortcut(true, false, true, false, "g"))
        assertNull(editorSearchShortcut(true, true, false, false, "f"))
        assertNull(editorSearchShortcut(true, false, false, true, "g"))
        assertEquals("beta", searchQueryFromSelection("alt", "beta"))
        assertEquals("a\\nb", searchQueryFromSelection("", "a\nb"))
        assertEquals("alt", searchQueryFromSelection("alt", ""))
        assertEquals("alt", searchQueryFromSelection("alt", "x".repeat(101)))
        val hits = listOf(NoteSearchHit(0, 4, ""), NoteSearchHit(10, 14, ""))
        assertEquals(1, nextSearchHitIndex(hits, 4, true))
        assertEquals(0, nextSearchHitIndex(hits, 20, true))
        assertEquals(0, nextSearchHitIndex(hits, 4, false))
        assertEquals(1, nextSearchHitIndex(hits, 0, false))
        assertEquals(-1, nextSearchHitIndex(emptyList(), 0, true))
    }
}