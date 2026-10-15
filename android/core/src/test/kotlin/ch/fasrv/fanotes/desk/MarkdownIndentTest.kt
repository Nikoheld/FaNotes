package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals

class MarkdownIndentTest {
    @Test
    fun tabIndentsEverySelectedLineByTwoSpaces() {
        assertEquals(MarkdownEdit("  Hallo", 7, 7), indentMarkdownLines("Hallo", 5, 5, outdent = false))
        assertEquals(MarkdownEdit("  a\n  b", 2, 7), indentMarkdownLines("a\nb", 0, 3, outdent = false))
        assertEquals(MarkdownEdit("  a\nb", 2, 4), indentMarkdownLines("a\nb", 0, 2, outdent = false))
        assertEquals(MarkdownEdit("  Hallo", 3, 6), indentMarkdownLines("Hallo", 1, 4, outdent = false))
        assertEquals(MarkdownEdit("  ", 2, 2), indentMarkdownLines("", 0, 0, outdent = false))
    }

    @Test
    fun shiftTabRemovesOneIndentAndATabBecomesSpaces() {
        assertEquals(MarkdownEdit("Hallo", 5, 5), indentMarkdownLines("  Hallo", 7, 7, outdent = true))
        assertEquals(MarkdownEdit("  Hallo", 2, 2), indentMarkdownLines("\tHallo", 1, 1, outdent = true))
        assertEquals(MarkdownEdit(" Hallo", 6, 6), indentMarkdownLines("   Hallo", 8, 8, outdent = true))
        assertEquals(MarkdownEdit("  X", 2, 2), indentMarkdownLines("    X", 2, 2, outdent = true))
        assertEquals(MarkdownEdit("Hallo", 0, 5), indentMarkdownLines("Hallo", 0, 5, outdent = true))
        assertEquals(MarkdownEdit("", 0, 0), indentMarkdownLines("  ", 2, 2, outdent = true))
    }
}
