package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals

class MarkdownSelectTest {
    @Test
    fun altLSelectsTheWholeLineIncludingItsNewline() {
        assertEquals(MarkdownEdit("a\nb\nc", 2, 4), selectMarkdownLine("a\nb\nc", 3, 3))
        assertEquals(MarkdownEdit("a\nb\nc", 4, 5), selectMarkdownLine("a\nb\nc", 4, 4))
        assertEquals(MarkdownEdit("a\nb\nc", 0, 4), selectMarkdownLine("a\nb\nc", 0, 3))
        assertEquals(MarkdownEdit("a\nb", 0, 2), selectMarkdownLine("a\nb", 0, 2))
        assertEquals(MarkdownEdit("", 0, 0), selectMarkdownLine("", 0, 0))
    }
}
