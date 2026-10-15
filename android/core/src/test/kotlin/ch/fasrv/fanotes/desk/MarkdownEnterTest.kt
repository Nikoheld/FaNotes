package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class MarkdownEnterTest {
    @Test
    fun enterContinuesListsQuotesAndTasks() {
        assertEquals(MarkdownCaretEdit("- Milch\n- ", 10), continueMarkdownEnter("- Milch", 7))
        assertEquals(MarkdownCaretEdit("1. Eins\n2. ", 11), continueMarkdownEnter("1. Eins", 7))
        assertEquals(MarkdownCaretEdit("1) Eins\n2) ", 11), continueMarkdownEnter("1) Eins", 7))
        assertEquals(MarkdownCaretEdit("- [x] Fertig\n- [ ] ", 19), continueMarkdownEnter("- [x] Fertig", 12))
        assertEquals(MarkdownCaretEdit("> Zitat\n> ", 10), continueMarkdownEnter("> Zitat", 7))
        assertEquals(MarkdownCaretEdit("> - Punkt\n> - ", 14), continueMarkdownEnter("> - Punkt", 9))
        assertEquals(MarkdownCaretEdit("  - Tief\n  - ", 13), continueMarkdownEnter("  - Tief", 8))
        assertNull(continueMarkdownEnter("- Milch und", 4))
        assertNull(continueMarkdownEnter("Hallo", 5))
        assertEquals(MarkdownCaretEdit("", 0), continueMarkdownEnter("- ", 2))
        assertEquals(MarkdownCaretEdit("> \n> ", 5), continueMarkdownEnter("> ", 2))
        assertEquals(MarkdownCaretEdit("\n", 1), continueMarkdownEnter("> \n> ", 5))
        val fenced = "```\n- nicht\n```"
        assertNull(continueMarkdownEnter(fenced, fenced.indexOf("nicht") + 5))
    }

    @Test
    fun backspaceRemovesTheMarkupInFrontOfTheCursor() {
        assertEquals(MarkdownCaretEdit("  Milch", 2), deleteMarkdownMarkup("- Milch", 2))
        assertEquals(MarkdownCaretEdit("Zitat", 0), deleteMarkdownMarkup("> Zitat", 2))
        assertNull(deleteMarkdownMarkup("- Milch", 5))
        val typed = markdownEnterReplacement("- Milch", "- Milch\n")
        assertEquals(MarkdownCaretEdit("- Milch\n- ", 10), typed)
        assertEquals(MarkdownCaretEdit("  Milch", 2), markdownBackspaceReplacement("- Milch", "-Milch"))
    }
}
