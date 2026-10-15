package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class MarkdownPasteTest {
    @Test
    fun pasteTurnsTheSelectionIntoALink() {
        val edit = pasteUrlAsMarkdownLink("Siehe FaNotes hier", 6, 13, "https://fanotes.example")
        assertEquals("Siehe [FaNotes](https://fanotes.example) hier", edit?.text)
        assertEquals(7, edit?.selectionStart)
        assertEquals(14, edit?.selectionEnd)
        assertEquals(
            "[Seite](https://www.example.com)",
            pasteUrlAsMarkdownLink("Seite", 0, 5, "www.example.com")?.text,
        )
        assertEquals(
            "- [Milch](mailto:a@b.ch)",
            pasteUrlAsMarkdownLink("- Milch", 2, 7, "mailto:a@b.ch")?.text,
        )
        assertEquals(
            "# [Titel](xmpp:a@b)",
            pasteUrlAsMarkdownLink("# Titel", 2, 7, "xmpp:a@b")?.text,
        )
        assertEquals(
            "**[fett](https://example.com)**",
            pasteUrlAsMarkdownLink("**fett**", 2, 6, "https://example.com")?.text,
        )
        assertEquals(
            "[snake_case](http://example.com)",
            pasteUrlAsMarkdownLink("snake_case", 0, 10, "http://example.com")?.text,
        )
    }

    @Test
    fun pasteLeavesCodeLinksFencesAndPlainTextAlone() {
        assertNull(pasteUrlAsMarkdownLink("Seite", 0, 5, "nicht-url"))
        assertNull(pasteUrlAsMarkdownLink("Seite", 2, 2, "https://example.com"))
        assertNull(pasteUrlAsMarkdownLink("Seite", 0, 5, " https://example.com"))
        assertNull(pasteUrlAsMarkdownLink("Zeile\nZwei", 4, 7, "https://example.com"))
        assertNull(pasteUrlAsMarkdownLink("---", 0, 3, "https://example.com"))
        assertNull(pasteUrlAsMarkdownLink("- Milch", 0, 7, "https://example.com"))
        val fenced = "```\ncode\n```"
        val codeAt = fenced.indexOf("code")
        assertNull(pasteUrlAsMarkdownLink(fenced, codeAt, codeAt + 4, "https://example.com"))
        assertNull(pasteUrlAsMarkdownLink("```", 0, 3, "https://example.com"))
        val inline = "Nutze `code` bitte"
        val inlineAt = inline.indexOf("code")
        assertNull(pasteUrlAsMarkdownLink(inline, inlineAt, inlineAt + 4, "https://example.com"))
        val link = "Siehe [FaNotes](https://alt.example)"
        val label = link.indexOf("FaNotes")
        assertNull(pasteUrlAsMarkdownLink(link, label, label + 7, "https://neu.example"))
        val image = "![Alt](bild.png)"
        val alt = image.indexOf("Alt")
        assertNull(pasteUrlAsMarkdownLink(image, alt, alt + 3, "https://example.com"))
        assertNull(pasteUrlAsMarkdownLink("*fett*", 0, 6, "https://example.com"))
        val closed = "```\ncode\n```\nnach"
        val after = closed.indexOf("nach")
        assertEquals(
            "```\ncode\n```\n[nach](https://example.com)",
            pasteUrlAsMarkdownLink(closed, after, after + 4, "https://example.com")?.text,
        )
    }
}
