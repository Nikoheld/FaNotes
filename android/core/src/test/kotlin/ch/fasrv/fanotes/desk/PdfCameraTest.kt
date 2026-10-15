package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals

class PdfCameraTest {
    private val fit = PdfFitInput(
        viewWidth = 1000.0,
        viewHeight = 800.0,
        columnWidth = 900.0,
        pageHeight = 1200.0,
        min = 0.5,
        max = 3.25,
    )

    @Test
    fun thePdfToolbarFitsWidthAndTheWholePage() {
        assertEquals(1.071, pdfFitWidthZoom(fit))
        assertEquals(0.637, pdfFitPageZoom(fit))
        val measured = pdfFitZoom(fit)
        assertEquals("fit-width", pdfZoomModeForZoom(1.071, measured))
        assertEquals("fit-page", pdfZoomModeForZoom(0.637, measured))
        assertEquals("custom", pdfZoomModeForZoom(1.0, measured))
        assertEquals(1.2, pdfZoomStep(1.0, 1, 0.5, 3.25))
        assertEquals(0.83, pdfZoomStep(1.0, -1, 0.5, 3.25))
        assertEquals(3.25, pdfZoomStep(3.0, 1, 0.5, 3.25))
        assertEquals(0.5, pdfZoomStep(0.55, -1, 0.5, 3.25))
        assertEquals("107 %", pdfZoomPercentLabel(1.071))
        assertEquals(1, pdfPageTarget(0.0, 12))
        assertEquals(12, pdfPageTarget(40.0, 12))
        assertEquals(5, pdfPageTarget(4.6, 12))
        assertEquals("…", pdfPageCountLabel(0))
        assertEquals("1 Seite", pdfPageCountLabel(1))
        assertEquals("3 Seiten", pdfPageCountLabel(3))
        assertEquals("next", pdfViewerKey("page-down", ctrl = false, meta = false, alt = false, shift = false))
        assertEquals("next", pdfViewerKey("down", ctrl = false, meta = false, alt = false, shift = true))
        assertEquals("previous", pdfViewerKey("page-up", ctrl = false, meta = false, alt = false, shift = false))
        assertEquals("previous", pdfViewerKey("up", ctrl = false, meta = false, alt = false, shift = false))
        assertEquals("first", pdfViewerKey("home", ctrl = false, meta = false, alt = false, shift = false))
        assertEquals("last", pdfViewerKey("end", ctrl = false, meta = false, alt = false, shift = false))
        assertEquals("search", pdfViewerKey("f", ctrl = true, meta = false, alt = false, shift = false))
        assertEquals(null, pdfViewerKey("f", ctrl = true, meta = false, alt = false, shift = true))
        assertEquals(null, pdfViewerKey("down", ctrl = true, meta = false, alt = false, shift = false))
        assertEquals(null, pdfViewerKey("down", ctrl = false, meta = false, alt = true, shift = false))
        assertEquals(null, pdfViewerKey("left", ctrl = false, meta = false, alt = false, shift = false))
    }
}
