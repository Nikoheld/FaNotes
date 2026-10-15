package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ReadingHtmlTest {
    @Test
    fun readingViewTurnsSafeHtmlIntoThePreviewMarks() {
        assertEquals("Siehe **fett** und *kursiv*.", readingHtml("Siehe <strong>fett</strong> und <em>kursiv</em>."))
        assertEquals("Zeile\nZeile", readingHtml("Zeile<br>Zeile"))
        assertEquals("Zeile\nZeile", readingHtml("Zeile<br />Zeile"))
        assertEquals("[Name](https://example.com)", readingHtml("<a href=\"https://example.com\">Name</a>"))
        assertEquals("Name", readingHtml("<a href=\"javascript:alert(1)\">Name</a>"))
        assertEquals("`code`", readingHtml("<code>code</code>"))
        assertEquals("~~weg~~", readingHtml("<del>weg</del>"))
        assertEquals("Text", readingHtml("<span class=\"x\">Text</span>"))
        assertEquals("", readingHtml("<script>alert(1)</script>").trim())
        assertEquals("a < b", readingHtml("a < b"))
        assertEquals("```\n<strong>x</strong>\n```", readingHtml("```\n<strong>x</strong>\n```"))
        assertEquals("`<em>nein</em>` und *ja*", readingHtml("`<em>nein</em>` und <em>ja</em>"))
        assertEquals("![Tafel](bilder/tafel.png)", readingHtml("<img alt=\"Tafel\" src=\"bilder/tafel.png\">"))
        assertEquals("# Titel", readingHtml("<h1>Titel</h1>"))
        val (plain, marks) = detailsPlain(readingHtml("<strong>fett</strong> und <a href=\"https://example.com/a\">Seite</a>"), autolinks = true)
        assertEquals("fett und Seite", plain)
        assertEquals("strong", marks.first { it.kind == "strong" }.kind)
        assertEquals("https://example.com/a", marks.first { it.kind == "link" }.target)
        val card = detailsReadingLines("<p><strong>Satz</strong></p>")
        assertEquals("Satz", card.first().text)
        assertTrue(card.first().inlines.any { it.kind == "strong" })
    }
}
