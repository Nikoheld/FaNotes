package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class PdfTextMarksTest {
    @Test
    fun aQuoteIsStoredOnItsPageAndReadBack() {
        val withMark = writePdfMarks("# PDF\n", addPdfMark(emptyList(), 2, "der Satz", "highlight"))
        val marks = readPdfMarks(withMark)
        assertEquals("der Satz", marks[0].quote)
        assertEquals(2, marks[0].page)
        assertEquals("highlight", marks[0].kind)
        assertTrue(withMark.contains("der Satz"))
        assertEquals(listOf("der Satz"), quotesOnPage(marks, 2))
    }

    @Test
    fun duplicatesKindsAndEmptyMarksFollowTheDesktopRules() {
        val once = addPdfMark(emptyList(), 1, "  der   Satz  ")
        assertEquals("der Satz", once[0].quote)
        assertEquals(1, addPdfMark(once, 1, "der Satz").size)
        assertEquals("underline", addPdfMark(emptyList(), 3, "Zeile", "underline")[0].kind)
        assertEquals(emptyList(), addPdfMark(emptyList(), 0, "weg"))
        val cleared = writePdfMarks("# PDF\n\n\n\n<!-- fanotes-pdf-marks-v1\n{}\n-->\n", emptyList())
        assertEquals("# PDF\n\n", cleared)
        assertEquals(emptyList(), readPdfMarks("# PDF\n<!-- fanotes-pdf-marks-v1\n{not json\n-->"))
        assertEquals(emptyList(), readPdfMarks("""<!-- fanotes-pdf-marks-v1 {"marks":[{"quote":"x","page":2.5}]} -->"""))
    }
}
