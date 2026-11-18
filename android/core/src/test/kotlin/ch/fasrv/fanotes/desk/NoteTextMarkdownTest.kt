package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Cases from `fanotes/scripts/check-note-text-markdown.mjs`. */
class NoteTextMarkdownTest {
    @Test
    fun tasksToggleOnTheirSourceLineOnly() {
        assertEquals("- [x] eins\n- [x] zwei", toggleNoteTextTask("- [ ] eins\n- [x] zwei", 1))
        assertEquals("- [ ] eins\n- [ ] zwei", toggleNoteTextTask("- [ ] eins\n- [x] zwei", 2))
        assertEquals("Text\n  1. [ ] tief", toggleNoteTextTask("Text\n  1. [X] tief", 2))
        assertEquals("> * [x] zitiert", toggleNoteTextTask("> * [ ] zitiert", 1))
        assertEquals("kein [ ] Task", toggleNoteTextTask("kein [ ] Task", 1), "only list task markers flip")
        assertEquals("- [ ] eins", toggleNoteTextTask("- [ ] eins", 5), "a stale line number is a no-op")
    }

    @Test
    fun onlyWebAndMailLinksOpen() {
        assertEquals("https://example.org/a%20b", openableNoteTextLink("https://example.org/a b"))
        assertEquals("https://example.org/", openableNoteTextLink("https://example.org"))
        assertEquals("mailto:a@example.org", openableNoteTextLink("mailto:a@example.org"))
        assertNull(openableNoteTextLink("javascript:alert(1)"))
        assertNull(openableNoteTextLink("file:///etc/passwd"))
        assertNull(openableNoteTextLink("Notiz.md"))
        assertNull(openableNoteTextLink(null))
    }

    @Test
    fun headingsEmphasisCodeLinksListsAndTasksRender() {
        val blocks = parseNoteTextMarkdown(
            listOf(
                "# Titel",
                "## Unter",
                "Ein **fetter** und *kursiver* Satz mit `code` und [Link](https://example.org).",
                "",
                "- Punkt",
                "- [ ] offen",
                "- [x] erledigt",
                "",
                "1. eins",
                "2. zwei",
            ).joinToString("\n"),
        )
        assertEquals(NoteTextBlock.Heading(1, NoteTextInline("Titel")), blocks[0])
        assertEquals("Unter", (blocks[1] as NoteTextBlock.Heading).inline.text)
        val paragraph = assertIs<NoteTextBlock.Paragraph>(blocks[2]).inline
        assertEquals("Ein fetter und kursiver Satz mit code und Link.", paragraph.text)
        fun styled(style: NoteTextInlineStyle) = paragraph.spans.filter { it.style == style }.map { paragraph.text.substring(it.start, it.end) }
        assertEquals(listOf("fetter"), styled(NoteTextInlineStyle.BOLD))
        assertEquals(listOf("kursiver"), styled(NoteTextInlineStyle.ITALIC))
        assertEquals(listOf("code"), styled(NoteTextInlineStyle.CODE))
        assertEquals(listOf("Link"), styled(NoteTextInlineStyle.LINK))
        assertEquals("https://example.org/", paragraph.spans.single { it.style == NoteTextInlineStyle.LINK }.href)
        val items = blocks.filterIsInstance<NoteTextBlock.Item>()
        assertEquals(listOf("Punkt", "offen", "erledigt", "eins", "zwei"), items.map { it.inline.text })
        assertEquals(listOf(null, false, true, null, null), items.map { it.task })
        assertEquals(listOf(6, 7), items.filter { it.task != null }.map { it.line })
        assertEquals(listOf(null, null, null, 1, 2), items.map { it.number })
    }

    @Test
    fun oldPlainTextLooksAsTyped() {
        val blocks = parseNoteTextMarkdown("Zeile eins\nZeile zwei\n    eingerückt\n<b>nicht fett</b> & 3 < 4")
        val paragraph = assertIs<NoteTextBlock.Paragraph>(blocks.single())
        assertEquals("Zeile eins\nZeile zwei\neingerückt\n<b>nicht fett</b> & 3 < 4", paragraph.inline.text, "line breaks stay, no code block, no HTML")
        assertTrue(paragraph.inline.spans.isEmpty())
    }

    @Test
    fun unsafeLinksAreInertAndImagesShowTheirAltText() {
        val inline = assertIs<NoteTextBlock.Paragraph>(parseNoteTextMarkdown("[x](javascript:alert(1)) ![bild](https://example.org/a.png)").single()).inline
        assertEquals("x bild", inline.text)
        assertNull(inline.spans.single { it.style == NoteTextInlineStyle.LINK }.href)
    }

    @Test
    fun moreBlocks() {
        val blocks = parseNoteTextMarkdown(
            "Titel\n===\n> zitiert\n\n```\nlet a = 1\n  b\n```\n---\n| A | B |\n|---|:-:|\n| 1 | **2** |\n- oben\n  - unten\n~~weg~~ \\*kein\\* stern www.example.org",
        )
        assertEquals(NoteTextBlock.Heading(1, NoteTextInline("Titel")), blocks[0])
        assertEquals(1, assertIs<NoteTextBlock.Paragraph>(blocks[1]).quoteDepth)
        assertEquals("let a = 1\n  b", assertIs<NoteTextBlock.Code>(blocks[2]).text)
        assertIs<NoteTextBlock.Rule>(blocks[3])
        val table = assertIs<NoteTextBlock.Table>(blocks[4])
        assertEquals(listOf("A", "B"), table.header.map { it.text })
        assertEquals(listOf("1", "2"), table.rows.single().map { it.text })
        val items = blocks.filterIsInstance<NoteTextBlock.Item>()
        assertEquals(listOf(0, 1), items.map { it.depth })
        val last = items.last().inline
        assertEquals("unten\nweg *kein* stern www.example.org", last.text, "a lazy line continues the item")
        assertEquals("weg", last.spans.first { it.style == NoteTextInlineStyle.STRIKE }.let { last.text.substring(it.start, it.end) })
        assertEquals("http://www.example.org/", last.spans.single { it.style == NoteTextInlineStyle.LINK }.href)
        assertEquals("fett und kursiv", parseNoteTextInline("**fett *und* kursiv**").text)
        assertEquals(
            listOf(NoteTextInlineStyle.BOLD, NoteTextInlineStyle.ITALIC),
            parseNoteTextInline("**fett *und* kursiv**").spans.map { it.style },
        )
        assertEquals("a*b", parseNoteTextInline("a*b").text, "a lone star stays")
        assertEquals("snake_case_name", parseNoteTextInline("snake_case_name").text, "no emphasis inside words with _")
        assertEquals("Aufgabe\nlesen", noteTextMarkdownPlain("# Aufgabe\n- [ ] lesen"))
    }
}
