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
        val nested = paperLines("- erste\n    - zweite\n\t- dritte\n    1. Nummer\n    > Zitat\n    - [x] Fertig")
        assertEquals(listOf("erste", "    zweite", "\tdritte"), nested.filter { it.kind == PaperKind.BULLET }.map { it.text })
        assertEquals("    1. Nummer", nested.first { it.kind == PaperKind.NUMBER }.text)
        assertEquals("    Zitat", nested.first { it.kind == PaperKind.QUOTE }.text)
        assertEquals("x|    Fertig", nested.first { it.kind == PaperKind.TASK }.text)
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
        assertEquals(listOf(TableAlign.LEFT, TableAlign.LEFT), tableAlignments(table.text))
    }

    @Test
    fun aMarkdownTableKeepsThePreviewColumnAlignment() {
        val table = paperLines(
            """
            | Links | Mitte | Rechts |
            | :--- | :---: | ---: |
            | a | b | c |
            """.trimIndent(),
        ).single { it.kind == PaperKind.TABLE }
        assertEquals(listOf(listOf("Links", "Mitte", "Rechts"), listOf("a", "b", "c")), tableRows(table.text))
        assertEquals(listOf(TableAlign.LEFT, TableAlign.CENTER, TableAlign.RIGHT), tableAlignments(table.text))
        assertEquals("left\u001fcenter\u001fright", tableAlignWire(table.text))
        assertEquals(TableAlign.RIGHT, tableAlignAt(tableAlignWire(table.text), 2))
        assertEquals(TableAlign.LEFT, tableAlignAt("", 0))
        assertEquals(6f, tableCellOrigin(TableAlign.LEFT, 0f, 100f, 20f, 6f))
        assertEquals(40f, tableCellOrigin(TableAlign.CENTER, 0f, 100f, 20f, 6f))
        assertEquals(74f, tableCellOrigin(TableAlign.RIGHT, 0f, 100f, 20f, 6f))
        assertEquals(6f, tableCellOrigin(TableAlign.RIGHT, 0f, 100f, 200f, 6f))
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
        assertEquals(
            listOf("bilder/tafel.png", "ordner/foto.png"),
            paperImageSources("![Tafel](bilder/tafel.png)\n\nText\n\n![](ordner/foto.png)\n\n![Tafel](bilder/tafel.png)"),
        )
        assertEquals(emptyList(), paperImageSources("Text ![Tafel](a.png) danach"))
    }

    @Test
    fun parenthesisMarkersAreOrderedLists() {
        val lines = paperLines("1) Eins\n2) Zwei\n    3) Drei")
        assertEquals(listOf(PaperKind.NUMBER, PaperKind.NUMBER, PaperKind.NUMBER), lines.map { it.kind })
        assertEquals(listOf("1) Eins", "2) Zwei", "    3) Drei"), lines.map { it.text })
        assertEquals(PaperKind.PARAGRAPH, paperLines("Siehe 1) oben").single().kind)
        assertEquals(PaperKind.NUMBER, paperLines("12. Zwölf").single().kind)
    }
}
