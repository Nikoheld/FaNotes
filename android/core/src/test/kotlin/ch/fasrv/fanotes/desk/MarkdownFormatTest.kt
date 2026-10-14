package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class MarkdownFormatTest {
    @Test
    fun wrapsPlaceholdersAndPrefixesWholeLines() {
        val bold = applyMarkdownFormat("Hallo", 0, 5, "bold")
        assertEquals("**Hallo**", bold.text)
        assertEquals(2, bold.selectionStart)
        assertEquals(7, bold.selectionEnd)
        val empty = applyMarkdownFormat("", 0, 0, "bold")
        assertEquals("**fetter Text**", empty.text)
        assertEquals("# Punkt", applyMarkdownFormat("- Punkt", 0, 7, "heading1").text)
        assertEquals("1. Eins\n2. Zwei", applyMarkdownFormat("Eins\nZwei", 0, 9, "numberedList").text)
        val link = applyMarkdownFormat("FaNotes", 0, 7, "link")
        assertEquals("[FaNotes](https://)", link.text)
        assertTrue(applyMarkdownFormat("", 0, 0, "table").text.contains("| Thema | Notiz |"))
        assertTrue(applyMarkdownFormat("a\nb", 0, 3, "inlineCode").text.contains("```"))
        assertEquals("> Zitat", applyMarkdownFormat("# Zitat", 0, 7, "quote").text)
    }
}
