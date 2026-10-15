package ch.fasrv.fanotes.desk

import ch.fasrv.fanotes.ink.PAGE_START_HEIGHT
import ch.fasrv.fanotes.ink.PAGE_START_WIDTH
import kotlin.math.abs
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class NotePdfTest {
    @Test
    fun aStartingPageFitsOnOneSheetAndATallPageIsSliced() {
        val one = pdfPageSlices(PAGE_START_WIDTH, PAGE_START_HEIGHT)
        assertEquals(1, one.size)
        assertEquals(0.0, one.first().sourceTop)
        assertTrue(one.first().sourceHeight >= PAGE_START_HEIGHT)

        val tall = pdfPageSlices(PAGE_START_WIDTH, 4000.0)
        assertTrue(tall.size >= 3)
        assertEquals(0.0, tall.first().sourceTop)
        assertTrue(tall.zipWithNext().all { (left, right) -> abs(left.sourceTop + left.sourceHeight - right.sourceTop) < 0.001 })
        val last = tall.last()
        assertEquals(4000.0, last.sourceTop + last.sourceHeight, 0.001)
        assertEquals(PDF_EXPORT_FILE_NAME, "FaNotes-Notiz.pdf")
    }

    @Test
    fun paperTextDropsMarkersAndKeepsTheTable() {
        val text = pdfPaperText(
            """
            # Titel

            Siehe [[Mechanik|Skript]] und **fett**

            - Punkt

            - [x] fertig

            | A | B |
            | --- | --- |
            | 1 | 2 |

            <!-- fanotes-famd:v1 chars=0 -->
            """.trimIndent(),
        )
        assertTrue(text.startsWith("Titel"))
        assertTrue(text.contains("Siehe Skript und fett"))
        assertTrue(text.contains("• Punkt"))
        assertTrue(text.contains("☑ fertig"))
        assertTrue(text.contains("A    B"))
        assertTrue(text.contains("1    2"))
        assertTrue(!text.contains("fanotes-famd"))
        assertTrue(!text.contains("**"))
    }
}
