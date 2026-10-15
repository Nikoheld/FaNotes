package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals

class MarkdownBlankLineTest {
    @Test
    fun ctrlEnterInsertsAnIndentedBlankLineBelow() {
        assertEquals(MarkdownEdit("  Hallo\n  ", 10, 10), insertMarkdownBlankLine("  Hallo", 4, 4))
        assertEquals(MarkdownEdit("\n", 1, 1), insertMarkdownBlankLine("", 0, 0))
        assertEquals(MarkdownEdit("\n   ", 4, 4), insertMarkdownBlankLine("   ", 3, 3))
        assertEquals(MarkdownEdit("\tHi\n    ", 8, 8), insertMarkdownBlankLine("\tHi", 0, 0))
        assertEquals(MarkdownEdit("a\nb\n", 4, 4), insertMarkdownBlankLine("a\nb", 0, 3))
    }
}
