package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

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
}
