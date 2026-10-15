package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class MarkdownLinesTest {
    @Test
    fun altArrowMovesTheSelectedLines() {
        assertEquals(MarkdownEdit("b\na\nc", 2, 2), moveMarkdownLines("a\nb\nc", 0, 0, forward = true))
        assertEquals(MarkdownEdit("b\na\nc", 0, 0), moveMarkdownLines("a\nb\nc", 2, 2, forward = false))
        assertEquals(MarkdownEdit("c\na\nb", 2, 5), moveMarkdownLines("a\nb\nc", 0, 3, forward = true))
        assertEquals(MarkdownEdit("b\na", 2, 3), moveMarkdownLines("a\nb", 0, 2, forward = true))
        assertEquals(MarkdownEdit("\na", 1, 1), moveMarkdownLines("a\n", 0, 0, forward = true))
        assertNull(moveMarkdownLines("a\nb", 0, 0, forward = false))
        assertNull(moveMarkdownLines("a\nb", 2, 2, forward = true))
        assertNull(moveMarkdownLines("", 0, 0, forward = true))
    }

    @Test
    fun shiftAltArrowCopiesTheLineAndKeepsTheCaretOnThatCopy() {
        assertEquals(MarkdownEdit("ab\nab", 3, 3), copyMarkdownLines("ab", 0, 0, forward = true))
        assertEquals(MarkdownEdit("ab\nab", 3, 5), copyMarkdownLines("ab", 0, 2, forward = true))
        assertEquals(MarkdownEdit("ab\nab", 0, 0), copyMarkdownLines("ab", 0, 0, forward = false))
        assertEquals(MarkdownEdit("ab\nab", 0, 2), copyMarkdownLines("ab", 0, 2, forward = false))
        assertEquals(MarkdownEdit("ab\nab", 1, 1), copyMarkdownLines("ab", 1, 1, forward = false))
        assertEquals(MarkdownEdit("\n", 1, 1), copyMarkdownLines("", 0, 0, forward = true))
    }
}
