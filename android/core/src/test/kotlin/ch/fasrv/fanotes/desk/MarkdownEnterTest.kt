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
        assertEquals(MarkdownCaretEdit("- Mi\n- lch und", 7), continueMarkdownEnter("- Milch und", 4))
        assertNull(continueMarkdownEnter("Hallo", 5))
        assertEquals(MarkdownCaretEdit("", 0), continueMarkdownEnter("- ", 2))
        assertEquals(MarkdownCaretEdit(">\n> ", 4), continueMarkdownEnter("> ", 2))
        assertEquals(MarkdownCaretEdit("\n", 1), continueMarkdownEnter("> \n> ", 5))
        val fenced = "```\n- nicht\n```"
        assertNull(continueMarkdownEnter(fenced, fenced.indexOf("nicht") + 5))
    }

    @Test
    fun enterRenumbersTheFollowingOrderedItems() {
        assertEquals(MarkdownCaretEdit("1. Eins\n2. \n3. Zwei", 11), continueMarkdownEnter("1. Eins\n2. Zwei", 7))
        assertEquals(MarkdownCaretEdit("1. Eins\n2. \n3. Zwei\n4. Drei", 11), continueMarkdownEnter("1. Eins\n2. Zwei\n3. Drei", 7))
        assertEquals(MarkdownCaretEdit("1. Eins\n2. \n3. Zwei\n4. Vier", 11), continueMarkdownEnter("1. Eins\n2. Zwei\n4. Vier", 7))
        assertEquals(MarkdownCaretEdit("1. Eins\n2. \n3. Drei", 11), continueMarkdownEnter("1. Eins\n3. Drei", 7))
        assertEquals(MarkdownCaretEdit("1. Eins\n2. Zwei\n3. \n4. Drei", 19), continueMarkdownEnter("1. Eins\n2. Zwei\n3. Drei", 15))
        assertEquals(MarkdownCaretEdit("5. Fuenf\n6. \n7. Sechs", 12), continueMarkdownEnter("5. Fuenf\n6. Sechs", 8))
        assertEquals(MarkdownCaretEdit("1) Eins\n2) \n3) Zwei\n4) Drei", 11), continueMarkdownEnter("1) Eins\n2) Zwei\n3) Drei", 7))
        assertEquals(MarkdownCaretEdit("1. Eins\n\n2. \n\n3. Zwei", 12), continueMarkdownEnter("1. Eins\n\n2. Zwei", 7))
        assertEquals(MarkdownCaretEdit("> 1. Eins\n> 2. \n> 3. Zwei", 15), continueMarkdownEnter("> 1. Eins\n> 2. Zwei", 9))
        assertEquals(MarkdownCaretEdit("1. E\n2. ins\n3. Zwei", 8), continueMarkdownEnter("1. Eins\n2. Zwei", 4))
        assertEquals(MarkdownCaretEdit("1. a\n2. \n   1. b\n   2. c\n3. d", 8), continueMarkdownEnter("1. a\n   1. b\n   2. c\n2. d", 4))
        val inner = "1. a\n   1. b"
        assertEquals(
            MarkdownCaretEdit("1. a\n   1. b\n   2. \n   3. c\n2. d", inner.length + 7),
            continueMarkdownEnter("$inner\n   2. c\n2. d", inner.length),
        )
    }

    @Test
    fun enterSplitsATightListBeforeClearingTheMarker() {
        assertEquals(MarkdownCaretEdit("1. Eins\n\n2. ", 12), continueMarkdownEnter("1. Eins\n2. ", 11))
        assertEquals(MarkdownCaretEdit("- Milch\n\n- ", 11), continueMarkdownEnter("- Milch\n- ", 10))
        assertEquals(MarkdownCaretEdit("1. Eins\n2. Zwei\n", 16), continueMarkdownEnter("1. Eins\n2. Zwei\n3. ", 19))
        assertEquals(MarkdownCaretEdit("1. Eins\n2. Zwei\n\n3. Vier", 16), continueMarkdownEnter("1. Eins\n2. Zwei\n3. \n4. Vier", 19))
        assertEquals(MarkdownCaretEdit("1. a\n2. b\n\n3. c\n6. e", 10), continueMarkdownEnter("1. a\n2. b\n3. \n4. c\n6. e", "1. a\n2. b\n3. ".length))
        assertEquals(MarkdownCaretEdit("- a\n- b\n", 8), continueMarkdownEnter("- a\n- b\n- ", 10))
        assertEquals(MarkdownCaretEdit("> 1. Eins\n>\n> 2. ", 17), continueMarkdownEnter("> 1. Eins\n> 2. ", 15))
        assertEquals(MarkdownCaretEdit("> 1. Eins\n> 2. Zwei\n> ", 22), continueMarkdownEnter("> 1. Eins\n> 2. Zwei\n> 3. ", 25))
        assertEquals(
            MarkdownCaretEdit("> 1. Eins\n> 2. Zwei\n> \n> 3. Vier", 22),
            continueMarkdownEnter("> 1. Eins\n> 2. Zwei\n> 3. \n> 4. Vier", 25),
        )
        assertEquals(
            MarkdownCaretEdit("1. outer\n   1. inner\n  \n   2. ", 30),
            continueMarkdownEnter("1. outer\n   1. inner\n   2. ", 27),
        )
        assertEquals(
            MarkdownCaretEdit("1. outer\n   1. inner\n\n2. ", 25),
            continueMarkdownEnter("1. outer\n   1. inner\n\n   2. ", 28),
        )
        assertEquals(
            MarkdownCaretEdit("1. outer\n   1. inner\n   2. mid\n2. \n   3. more\n3. next", 34),
            continueMarkdownEnter("1. outer\n   1. inner\n   2. mid\n   3. \n   4. more\n2. next", 37),
        )
        assertEquals(
            MarkdownCaretEdit("- outer\n  - inner\n\n- ", 21),
            continueMarkdownEnter("- outer\n  - inner\n\n  - ", 23),
        )
        assertEquals(
            MarkdownCaretEdit("- a\n  - b\n    - c\n\n  - ", 23),
            continueMarkdownEnter("- a\n  - b\n    - c\n\n    - ", 25),
        )
        assertEquals(MarkdownCaretEdit("1. Eins\n2. \n   weiter\n3. Zwei", 11), continueMarkdownEnter("1. Eins\n   weiter\n2. Zwei", 7))
        assertEquals(MarkdownCaretEdit("1. Eins\n   weiter\n   ", 21), continueMarkdownEnter("1. Eins\n   weiter", "1. Eins\n   weiter".length))
        assertEquals(MarkdownCaretEdit("1. a\n    code\n   ", 17), continueMarkdownEnter("1. a\n    code", "1. a\n    code".length))
        assertNull(continueMarkdownEnter("    - not", "    - not".length))
        assertEquals(MarkdownCaretEdit("   - yes\n   - ", 14), continueMarkdownEnter("   - yes", "   - yes".length))
        assertEquals(
            MarkdownCaretEdit("1. a\n    - nested\n    - ", 24),
            continueMarkdownEnter("1. a\n    - nested", "1. a\n    - nested".length),
        )
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
