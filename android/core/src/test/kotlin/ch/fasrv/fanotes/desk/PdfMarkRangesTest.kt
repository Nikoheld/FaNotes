package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

class PdfMarkRangesTest {
    // PDFium breaks lines with \r\n; pdf.js joins runs with single spaces. Quotes match either way.
    private val page = "Die Zelle ist die kleinste\r\nEinheit des Lebens. Die Zelle teilt sich."

    private fun painted(marks: List<PdfTextMark>) = pdfMarkRanges(page, marks, 1).map { page.substring(it.start, it.end) }

    @Test
    fun aQuoteIsFoundAcrossLineBreaksAndPaintsEveryOccurrenceWithoutNth() {
        assertEquals(listOf("kleinste\r\nEinheit"), painted(listOf(PdfTextMark("m", 1, "kleinste Einheit", "highlight"))))
        assertEquals(listOf("Zelle", "Zelle"), painted(listOf(PdfTextMark("m", 1, "Zelle", "highlight"))))
        assertEquals(listOf("Zelle"), painted(listOf(PdfTextMark("m", 1, "Zelle", "highlight", nth = 1))))
        assertEquals(emptyList(), painted(listOf(PdfTextMark("m", 1, "Zelle", "highlight", nth = 7))))
        assertEquals(emptyList(), painted(listOf(PdfTextMark("m", 2, "Zelle", "highlight"))), "other pages are not painted")
        assertEquals(emptyList(), painted(listOf(PdfTextMark("m", 1, "D", "highlight"))), "under two characters paints nothing")
        assertEquals(emptyList(), painted(listOf(PdfTextMark("m", 1, "zelle", "highlight"))), "case-sensitive like the desktop")
    }

    @Test
    fun aSelectionStoresItsOccurrenceOnlyWhenTheQuoteRepeats() {
        val second = page.lastIndexOf("Zelle")
        assertEquals(1, pdfSelectionOccurrence(page, second, second + 5))
        val unique = page.indexOf("Einheit")
        assertNull(pdfSelectionOccurrence(page, unique, unique + 7))
        val stored = addPdfMark(emptyList(), 1, page.substring(second, second + 5), nth = 1)
        assertEquals(listOf("Zelle"), painted(stored))
        assertEquals(second, pdfMarkRanges(page, stored, 1).single().start)
    }

    @Test
    fun unmarkingTheMiddleKeepsBothEndsPinnedToTheirOccurrence() {
        val marks = listOf(PdfTextMark("m", 1, "Die Zelle ist die kleinste Einheit", "underline"))
        val from = page.indexOf("die kleinste")
        val next = unmarkPdfRange(marks, 1, page, from, from + "die kleinste".length)
        assertEquals(listOf("Die Zelle ist", "Einheit"), next.map { it.quote })
        assertEquals(listOf("underline", "underline"), next.map { it.kind })
        assertTrue(next.all { it.nth != null && it.page == 1 })
        assertEquals(listOf("Die Zelle ist", "Einheit"), painted(next))
        assertTrue(next.map { it.id }.toSet().size == 2, "pieces get their own ids")
    }

    @Test
    fun unmarkingOneOccurrenceKeepsTheOthers() {
        val marks = listOf(PdfTextMark("m", 1, "Zelle", "highlight"), PdfTextMark("o", 2, "Zelle", "highlight"))
        val second = page.lastIndexOf("Zelle")
        val next = unmarkPdfRange(marks, 1, page, second, second + 5)
        assertEquals(listOf(page.indexOf("Zelle")), pdfMarkRanges(page, next, 1).map { it.start })
        assertTrue(next.any { it.page == 2 && it.id == "o" }, "other pages untouched")
        assertSame(marks, unmarkPdfRange(marks, 1, page, page.indexOf("Einheit"), page.indexOf("Einheit") + 7), "nothing marked there")
        assertSame(marks, unmarkPdfRange(marks, 3, page, 0, 5))
    }

    @Test
    fun selectionsWidenToWordsAndKnowWhetherTheyTouchMarks() {
        val inside = page.indexOf("lein")
        val word = pdfWordAlignedRange(page, inside, inside + 2)!!
        assertEquals("kleinste", page.substring(word.first, word.last + 1))
        assertNull(pdfWordAlignedRange(page, 5, 5))
        val words = pdfWordRanges(page, 0, page.indexOf("ist") + 3).map { page.substring(it.first, it.last + 1) }
        assertEquals(listOf("Die", "Zelle", "ist"), words)
        val ranges = pdfMarkRanges(page, listOf(PdfTextMark("m", 1, "Einheit", "highlight")), 1)
        assertTrue(pdfRangeTouchesMarks(page, ranges, page.indexOf("Einheit") - 3, page.indexOf("Einheit") + 1))
        assertFalse(pdfRangeTouchesMarks(page, ranges, 0, 10))
    }

    @Test
    fun nthIsStoredAndReadInTheDesktopFormat() {
        val markdown = writePdfMarks("# PDF\n", listOf(PdfTextMark("mark-a", 3, "Zelle", "highlight", nth = 2), PdfTextMark("mark-b", 1, "alt", "underline")))
        assertTrue(markdown.contains("\"kind\": \"highlight\",\n      \"nth\": 2\n    }"), markdown)
        val back = readPdfMarks(markdown)
        assertEquals(2, back[0].nth)
        assertNull(back[1].nth)
        // A quote with `-->` inside the JSON does not end the block early (desktop `locateEmbeddedJsonComment`).
        val tricky = writePdfMarks("# PDF\n", listOf(PdfTextMark("mark-c", 1, "a --> b", "highlight")))
        assertEquals("a --> b", readPdfMarks(tricky).single().quote)
        assertEquals("# PDF\n\n", writePdfMarks(tricky, emptyList()))
        // Desktop JSON with nth, read as the desktop reads it.
        val desktop = "Notiz\n<!-- fanotes-pdf-marks-v1\n{\"marks\":[{\"id\":\"mark-x\",\"page\":4,\"quote\":\"Satz\",\"kind\":\"highlight\",\"nth\":0},{\"id\":\"mark-y\",\"page\":4,\"quote\":\"Satz\",\"kind\":\"highlight\",\"nth\":-1}]}\n-->\n"
        assertEquals(listOf(0, null), readPdfMarks(desktop).map { it.nth })
    }
}
