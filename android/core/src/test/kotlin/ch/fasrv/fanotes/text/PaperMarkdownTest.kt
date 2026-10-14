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
        assertEquals("Vorlesung", lines.first().text)
        assertEquals("Ein **Satz** auf dem Papier.", lines[2].text)
        assertEquals(listOf("erster", "zweiter"), lines.filter { it.kind == PaperKind.BULLET }.map { it.text })
        assertTrue(lines.none { it.text.contains("fanotes-ink") })
    }

    @Test
    fun codeFencesStayTogether() {
        val lines = paperLines("Text\n\n```\nalpha\nbeta\n```\n")
        val code = lines.first { it.kind == PaperKind.CODE }
        assertEquals("alpha\nbeta", code.text)
    }
}
