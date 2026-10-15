package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals

class MarkdownDeleteTest {
    @Test
    fun shiftCtrlKDeletesTheLineAndKeepsTheColumn() {
        assertEquals(MarkdownEdit("cd", 1, 1), deleteMarkdownLines("ab\ncd", 1, 1))
        assertEquals(MarkdownEdit("ab", 2, 2), deleteMarkdownLines("ab\ncd", 4, 4))
        assertEquals(MarkdownEdit("a\nc", 3, 3), deleteMarkdownLines("a\nbb\nc", 3, 3))
        assertEquals(MarkdownEdit("", 0, 0), deleteMarkdownLines("Hallo", 2, 2))
        assertEquals(MarkdownEdit("", 0, 0), deleteMarkdownLines("a\n", 0, 0))
        assertEquals(MarkdownEdit("b", 0, 0), deleteMarkdownLines("a\nb", 0, 2))
        assertEquals(MarkdownEdit("c", 1, 1), deleteMarkdownLines("a\nb\nc", 0, 3))
    }
}
