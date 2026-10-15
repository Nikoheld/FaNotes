package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals

class MarkdownNewlineTest {
    @Test
    fun shiftEnterKeepsTheIndentAndSplitsBracketPairs() {
        assertEquals(MarkdownEdit("  Hallo \n  Welt", 11, 11), insertMarkdownNewlineIndent("  Hallo Welt", 8, 8))
        assertEquals(MarkdownEdit("Hallo\n", 6, 6), insertMarkdownNewlineIndent("Hallo", 5, 5))
        assertEquals(MarkdownEdit("\n   ", 4, 4), insertMarkdownNewlineIndent("   ", 2, 2))
        assertEquals(MarkdownEdit("fn(\n\n)", 4, 4), insertMarkdownNewlineIndent("fn()", 3, 3))
        assertEquals(MarkdownEdit("  (\n  \n  )", 6, 6), insertMarkdownNewlineIndent("  ()", 3, 3))
        assertEquals(MarkdownEdit("\tHi\n    ", 8, 8), insertMarkdownNewlineIndent("\tHi", 3, 3))
    }
}
