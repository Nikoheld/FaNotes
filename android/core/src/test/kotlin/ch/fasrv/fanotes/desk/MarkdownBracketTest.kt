package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class MarkdownBracketTest {
    @Test
    fun theCaretJumpsToTheMatchingBracket() {
        assertEquals(2, matchingBracketJump("()", 0, 0)?.selectionStart)
        assertEquals(0, matchingBracketJump("()", 2, 2)?.selectionStart)
        assertEquals(6, matchingBracketJump("{[()]}", 0, 0)?.selectionStart)
        assertEquals(2, matchingBracketJump("(a(b)c)", 5, 5)?.selectionStart)
        assertEquals(4, matchingBracketJump("fn()", 2, 2)?.selectionStart)
        assertNull(matchingBracketJump("(a", 0, 0))
        assertNull(matchingBracketJump("Hallo", 2, 2))
    }

    @Test
    fun aCollapsedCaretPaintsTheBracketBesideIt() {
        assertEquals(BracketHighlight(0, 1, true), bracketHighlight("()", 1))
        assertEquals(BracketHighlight(1, 0, true), bracketHighlight("()", 2))
        assertEquals(BracketHighlight(0, 5, true), bracketHighlight("{[()]}", 0))
        assertEquals(BracketHighlight(0, 1, false), bracketHighlight("(]", 0))
        assertEquals(BracketHighlight(0, null, false), bracketHighlight("(a", 0))
        assertEquals(BracketHighlight(0, null, false), bracketHighlight(")(", 1))
        assertNull(bracketHighlight("Hallo", 2))
        assertNull(bracketHighlight("(" + "x".repeat(10_001), 0))
        assertEquals(MATCHING_BRACKET_ARGB, 0x52328C82)
        assertEquals(NONMATCHING_BRACKET_ARGB, 0x44BB5555)
        assertTrue(bracketHighlight("fn()", 2)?.matched == true)
        assertFalse(bracketHighlight("(]", 1)?.matched == true)
    }
}
