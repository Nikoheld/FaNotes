package ch.fasrv.fanotes.text

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class PaperMarkdownTest {
    @Test
    fun keepsHeadingsListsAndDropsTheInkMarker() {
        val lines = paperLines(
            """
            # Vorlesung

            Ein **Satz** auf dem Papier.

            - erster
            - zweiter

            <!-- fanotes-ink:abc-1 -->
            """.trimIndent(),
        )
        assertEquals(PaperKind.H1, lines.first().kind)
        assertEquals(PaperKind.H5, paperLines("##### Klein").single().kind)
        assertEquals(PaperKind.H6, paperLines("###### Kleiner").single().kind)
        assertEquals("Klein", paperLines("##### Klein").single().text)
        assertEquals("Vorlesung", lines.first().text)
        assertEquals("Ein **Satz** auf dem Papier.", lines[2].text)
        assertEquals(listOf("erster", "zweiter"), lines.filter { it.kind == PaperKind.BULLET }.map { it.text })
        assertTrue(lines.none { it.text.contains("fanotes-ink") })
    }

    @Test
    fun aMarkdownTableBecomesOneGridWithoutTheRuleRow() {
        val table = paperLines(
            """
            | Stichworte | Notizen |
            | --- | --- |
            | Begriff | Erklärung |
            """.trimIndent(),
        ).single { it.kind == PaperKind.TABLE }
        assertEquals(listOf(listOf("Stichworte", "Notizen"), listOf("Begriff", "Erklärung")), tableRows(table.text))
    }

    @Test
    fun codeFencesStayTogether() {
        val lines = paperLines("Text\n\n```\nalpha\nbeta\n```\n")
        val code = lines.first { it.kind == PaperKind.CODE }
        assertEquals("alpha\nbeta", code.text)
        assertEquals(2, code.sourceLine)
    }

    @Test
    fun aTaskRemembersTheSourceLineACheckboxToggles() {
        val note = "Text\n\n```\nalpha\n```\n- [ ] Offen\n- [x] Fertig"
        val tasks = paperLines(note).filter { it.kind == PaperKind.TASK }
        assertEquals(listOf(5, 6), tasks.map { it.sourceLine })
        val marked = "A\n<!-- fanotes-ink:abc -->\n- [ ] B"
        assertEquals(2, paperLines(marked).first { it.kind == PaperKind.TASK }.sourceLine)
        assertEquals("- [x] B", ch.fasrv.fanotes.desk.toggleTask(marked, 2).substringAfterLast('\n'))
    }

    @Test
    fun aWholeLineImageBecomesAPaperCard() {
        val image = paperLines("Siehe\n\n![Tafel](bilder/tafel.png)\n\nNachher")
        val card = image.first { it.kind == PaperKind.IMAGE }
        assertEquals("Tafel", paperImageCaption(card.text))
        assertEquals("bilder/tafel.png", paperImageSource(card.text))
        assertEquals("foto.png", paperImageCaption(paperLines("![](ordner/foto.png)").single().text))
        assertEquals(PaperKind.PARAGRAPH, paperLines("Text ![Tafel](a.png) danach").single().kind)
        assertEquals(listOf("Schule/bilder/tafel.png", "bilder/tafel.png"), resolvePaperImagePaths("Schule/Mathe.md", "./bilder/tafel.png"))
        assertEquals(emptyList(), resolvePaperImagePaths("Schule/Mathe.md", "https://example.com/a.png"))
        assertEquals(emptyList(), resolvePaperImagePaths("Schule/Mathe.md", "../geheim.png"))
        assertEquals(900f to 450f, paperImageFrame(1800, 900, 900f))
        assertEquals(900f to 1215f, paperImageFrame(100, 400, 900f))
    }
}
