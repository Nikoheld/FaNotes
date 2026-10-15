package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals

class PdfThumbsTest {
    @Test
    fun thumbnailsMatchTheDesktopSizeAndStayOnRenderedPages() {
        assertEquals(0, pdfThumbPages(0))
        assertEquals(10, pdfThumbPages(10))
        assertEquals(PDF_NOTE_PAGE_CAP, pdfThumbPages(100, PDF_NOTE_PAGE_CAP))
        assertEquals(108, pdfThumbHeight(595, 842))
        assertEquals(PDF_THUMB_MIN_HEIGHT, pdfThumbHeight(1000, 10))
        val frames = listOf(0.0 to 1000.0, 1016.0 to 800.0)
        assertEquals(1, pdfPageAt(500.0, frames))
        assertEquals(2, pdfPageAt(1500.0, frames))
        assertEquals(2, pdfPageAt(1008.0, frames))
    }
}