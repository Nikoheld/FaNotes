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
}