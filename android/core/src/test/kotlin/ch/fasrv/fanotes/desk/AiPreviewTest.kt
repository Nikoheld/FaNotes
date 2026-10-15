package ch.fasrv.fanotes.desk

import ch.fasrv.fanotes.text.PaperKind
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class AiPreviewTest {
    @Test
    fun schoenPreviewHidesMarkersAndKeepsThePaperBlocks() {
        val lines = aiPreviewLines(
            """
            # Titel

            Siehe [Welt](https://example.com) und **fett** sowie [[Notiz|Alias]].

            - [x] Fertig
            """.trimIndent(),
        )
        assertEquals(PaperKind.H1, lines.first().kind)
        assertEquals("Titel", aiPreviewLineText(lines.first()))
        assertEquals(2f, aiPreviewScale(PaperKind.H1))
        assertTrue(aiPreviewHeading(PaperKind.H1))
        val paragraph = lines.first { it.kind == PaperKind.PARAGRAPH }
        assertEquals("Siehe Welt und fett sowie Alias.", aiPreviewLineText(paragraph))
        val task = lines.first { it.kind == PaperKind.TASK }
        assertEquals("☑ Fertig", aiPreviewLineText(task))
        assertEquals("code und kursiv", stripPreviewMarkers("`code` und *kursiv*"))
    }

    @Test
    fun schoenPreviewUsesTheDesktopMarkdownSizesAndMarks() {
        assertEquals(2.15f, aiPreviewReadingScale(PaperKind.H1))
        assertEquals(1.55f, aiPreviewReadingScale(PaperKind.H2))
        assertEquals(1.22f, aiPreviewReadingScale(PaperKind.H3))
        assertEquals(1.02f, aiPreviewReadingScale(PaperKind.H4))
        val lines = aiPreviewReading("# Titel\n\nSiehe **fett** und [^a].\n\n[^a]: Die Quelle\n\n| A | B |\n| --- | --- |\n| 1 | 2 |")
        assertEquals("Titel", lines.first().text)
        assertEquals(2.15f, lines.first().scale)
        val body = lines.first { it.text.startsWith("Siehe") }
        assertEquals("Siehe fett und 1.", body.text)
        assertEquals("strong", body.inlines.first { it.kind == "strong" }.kind)
        val number = body.inlines.first { it.kind == "footnote" }
        assertEquals("1", body.text.substring(number.start, number.end))
        assertEquals("1. Die Quelle ↩", lines.first { it.kind == "footnote" }.text)
        val table = lines.first { it.kind == "table" }
        val shown = expandFieldSeparators(table.text, table.inlines)
        assertEquals("A · B", shown.first)
        assertEquals("left\u001fleft", table.source)
    }
}