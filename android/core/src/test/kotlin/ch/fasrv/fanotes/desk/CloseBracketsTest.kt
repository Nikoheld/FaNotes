package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class CloseBracketsTest {
    @Test
    fun typingAnOpenerInsertsThePartner() {
        val round = bracketTyping("Hallo", 5, 0, "Hallo(", emptySet())
        assertEquals("Hallo()", round?.text)
        assertEquals(6, round?.selectionStart)
        assertEquals(setOf(6), round?.closedAt)
        assertEquals("()", bracketTyping("", 0, 0, "(", emptySet())?.text)
        assertEquals("[Notiz]", bracketTyping("Notiz", 0, 5, "[", emptySet())?.text)
        assertEquals(1, bracketTyping("Notiz", 0, 5, "[", emptySet())?.selectionStart)
        assertEquals(6, bracketTyping("Notiz", 0, 5, "[", emptySet())?.selectionEnd)
        assertNull(bracketTyping("Hallo", 2, 0, "Ha(llo", emptySet()))
        assertEquals("() ", bracketTyping(" ", 0, 0, "( ", emptySet())?.text)
        assertEquals("())", bracketTyping(")", 0, 0, "()", emptySet())?.text)
        assertEquals("'Wort'", bracketTyping("Wort", 0, 4, "'", emptySet())?.text)
    }

    @Test
    fun quotesPairUnlessTheyFollowAWordOrCloseAString() {
        assertEquals("''", bracketTyping("", 0, 0, "'", emptySet())?.text)
        assertNull(bracketTyping("don", 3, 0, "don'", emptySet()))
        assertNull(bracketTyping("wort", 0, 0, "'wort", emptySet()))
        assertEquals("\"\"", bracketTyping("", 0, 0, "\"", emptySet())?.text)
        val open = bracketTyping("Hallo ", 6, 0, "Hallo \"", emptySet())
        assertEquals("Hallo \"\"", open?.text)
        assertNull(bracketTyping("\"Hallo", 6, 0, "\"Hallo\"", open?.closedAt.orEmpty()))
    }

    @Test
    fun aTypedCloseStepsOverTheInsertedPartnerAndBackspaceRemovesThePair() {
        val opened = bracketTyping("()", 1, 0, "())", setOf(1))
        assertEquals("()", opened?.text)
        assertEquals(2, opened?.selectionStart)
        assertEquals(emptySet(), opened?.closedAt)
        assertEquals("", bracketTyping("()", 0, 1, ")", emptySet())?.text)
        assertEquals(0, bracketTyping("()", 0, 1, ")", emptySet())?.selectionStart)
        assertNull(bracketTyping("Hallo", 5, 1, "Hall", emptySet()))
    }

    @Test
    fun aPlainLetterInALongNoteIsNotAnEditAndStepsOverOnlyAMarkedPartner() {
        val note = "x".repeat(300_000)
        assertNull(bracketTyping(note, 100, 0, note.substring(0, 100) + "a" + note.substring(100), emptySet()))
        val before = note.substring(0, 100) + ")" + note.substring(100)
        val after = before.substring(0, 100) + ")" + before.substring(100)
        assertEquals(101, bracketTyping(before, 100, 0, after, setOf(100))?.selectionStart)
    }
}
