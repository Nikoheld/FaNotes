package ch.fasrv.fanotes.ink

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class PdfInkLayoutTest {
    @Test
    fun withoutStrokesThePagesKeepTheDesktopStack() {
        val pages = pdfInkPages(sourceHeight = 123.0, hasStrokes = false, heightOverWidth = listOf(1.5, 1.0))
        assertEquals(2, pages.size)
        assertEquals(0.0, pages[0].top, 1e-9)
        assertEquals(PAGE_START_WIDTH * 1.5, pages[0].height, 1e-9)
        assertEquals(PAGE_START_WIDTH * 1.5 + PDF_PAGE_GAP, pages[1].top, 1e-9)
        assertEquals(PAGE_START_WIDTH, pages[1].width, 1e-9)
    }

    @Test
    fun theInkHeightIsStretchedOverTheStack() {
        val ratios = listOf(1.4, 1.4, 0.7)
        val stack = pdfStackHeight(layoutPdfStack(PAGE_START_WIDTH, ratios))
        val source = stack * 2
        val pages = pdfInkPages(source, hasStrokes = true, heightOverWidth = ratios)
        assertEquals(0.0, pages.first().top, 1e-9)
        val last = pages.last()
        assertEquals(source, last.top + last.height, 1e-6)
        assertEquals(PAGE_START_WIDTH * 1.4 * 2, pages[0].height, 1e-9)
        assertTrue(pages[1].top > pages[0].top + pages[0].height - 1e-9)
    }

    @Test
    fun noPagesGiveNoBoxes() {
        assertTrue(pdfInkPages(500.0, hasStrokes = true, heightOverWidth = emptyList()).isEmpty())
    }
}
