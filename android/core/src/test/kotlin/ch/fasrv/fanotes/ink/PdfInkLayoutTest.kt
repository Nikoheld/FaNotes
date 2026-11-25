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

/** Numbers measured in the desktop UI: a 3-page PDF (A4, A4, 612×792) with strokes drawn at known page spots. */
class DesktopPdfInkLayoutTest {
    private val ratios = listOf(842.0 / 595.0, 842.0 / 595.0, 792.0 / 612.0)

    private fun pageSpot(pages: List<PdfInkPage>, sourceWidth: Double, sourceHeight: Double, x: Double, y: Double): Triple<Int, Double, Double> {
        val px = x * sourceWidth
        val py = y * sourceHeight
        val page = pages.first { py >= it.top - 2 && py <= it.top + it.height + 2 }
        return Triple(page.index, (px - page.left) / page.width, (py - page.top) / page.height)
    }

    private fun assertSpot(expected: Triple<Int, Double, Double>, actual: Triple<Int, Double, Double>) {
        assertEquals(expected.first, actual.first)
        assertEquals(expected.second, actual.second, 0.004)
        assertEquals(expected.third, actual.third, 0.004)
    }

    @Test
    fun aWindow1400WideSheetPutsTheStrokesWhereTheyWereDrawn() {
        val pages = desktopPdfInkPages(1114.0, 3468.0, ratios)
        assertEquals(820.0, desktopPdfColumnWidth(1114.0, 3468.0, ratios), 1e-9)
        assertEquals(148.0, pages[0].left, 1e-9)
        assertSpot(Triple(0, 0.05, 0.05), pageSpot(pages, 1114.0, 3468.0, 0.168756, 0.021917))
        assertSpot(Triple(0, 0.5, 0.5), pageSpot(pages, 1114.0, 3468.0, 0.499995, 0.172488))
        assertSpot(Triple(1, 0.95, 0.95), pageSpot(pages, 1114.0, 3468.0, 0.831233, 0.662273))
        assertSpot(Triple(2, 0.05, 0.05), pageSpot(pages, 1114.0, 3468.0, 0.168756, 0.698915))
    }

    @Test
    fun aWiderWindowOnlyMovesTheColumn() {
        val pages = desktopPdfInkPages(1614.0, 3468.0, ratios)
        assertSpot(Triple(0, 0.05, 0.05), pageSpot(pages, 1614.0, 3468.0, 0.271376, 0.021919))
        assertSpot(Triple(1, 0.95, 0.95), pageSpot(pages, 1614.0, 3468.0, 0.728624, 0.662273))
        assertSpot(Triple(2, 0.05, 0.05), pageSpot(pages, 1614.0, 3468.0, 0.271376, 0.698916))
    }

    @Test
    fun writeRoomBelowThePagesFallsBackToTheDefaultColumn() {
        // The sheet grew 338 px while writing: the height no longer gives the column, the default does.
        assertEquals(DESKTOP_PDF_COLUMN_DEFAULT, desktopPdfColumnWidth(972.0, 3806.0, ratios), 1e-9)
        val pages = desktopPdfInkPages(972.0, 3806.0, ratios)
        assertSpot(Triple(2, 0.05, 0.05), pageSpot(pages, 972.0, 3806.0, 0.120379, 0.636826))
    }

    @Test
    fun aNarrowerContentWidthSettingIsReadFromTheHeight() {
        val column = 640.0
        val height = DESKTOP_PDF_PAPER_TOP + DESKTOP_PDF_PAPER_BOTTOM + PDF_PAGE_GAP * 2 + column * ratios.sum()
        assertEquals(column, desktopPdfColumnWidth(1200.0, height, ratios), 1e-9)
        assertEquals((1200.0 - column) / 2 + DESKTOP_PDF_PAGE_BORDER, desktopPdfInkPages(1200.0, height, ratios)[0].left, 1e-9)
    }

    @Test
    fun noPagesOrABrokenSizeStaySafe() {
        assertTrue(desktopPdfInkPages(1000.0, 3000.0, emptyList()).isEmpty())
        assertEquals(DESKTOP_PDF_COLUMN_DEFAULT, desktopPdfColumnWidth(Double.NaN, Double.NaN, ratios), 1e-9)
    }
}
