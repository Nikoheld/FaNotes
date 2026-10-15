package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class WorksheetLayoutTest {
    @Test
    fun imagesStackInTheTextColumnUnderTheMarkdown() {
        val placed = layoutWorksheetColumn(
            900.0,
            200.0,
            listOf("a" to (600.0 / 900.0), "b" to (300.0 / 900.0)),
        )
        assertEquals(2, placed.size)
        val first = placed[0]
        assertEquals("a", first.id)
        assertEquals(72.0, first.left)
        assertEquals(756.0, first.width)
        assertEquals(218.0, first.captionTop)
        assertEquals(246.0, first.top)
        assertEquals(504.0, first.height, 0.001)
        val second = placed[1]
        assertEquals("b", second.id)
        assertEquals(first.top + first.height + WORKSHEET_PAGE_GAP + WORKSHEET_CAPTION, second.top, 0.001)
        assertEquals(252.0, second.height, 0.001)
        assertTrue(second.top > first.top + first.height)
    }

    @Test
    fun laterPdfPagesShareTheCaptionAndKeepTheirPageNumber() {
        val placed = layoutWorksheetPages(
            900.0,
            200.0,
            listOf(
                WorksheetPageSpec("pdf", 1, 1.4),
                WorksheetPageSpec("pdf", 2, 1.2),
            ),
        )
        assertEquals(1, placed[0].page)
        assertEquals(2, placed[1].page)
        assertTrue(placed[0].captionTop >= 0.0)
        assertEquals(-1.0, placed[1].captionTop)
        assertEquals(placed[0].top + placed[0].height + WORKSHEET_PAGE_GAP, placed[1].top, 0.001)
        val frame = placed[1]
        val sheetX = (frame.left + frame.width * 0.4) / 900.0
        val sheetY = (frame.top + frame.height * 0.2) / 4000.0
        val mark = highlightOnFrame(sheetX, sheetY, frame.width * 0.2 / 900.0, frame.height * 0.1 / 4000.0, frame, 900.0, 4000.0, "hl")
        assertEquals(2, mark?.page)
        assertEquals(0.4, mark!!.x, 0.001)
    }

    @Test
    fun aHighlightStaysOnTheImageItWasDrawnOn() {
        val frame = layoutWorksheetColumn(900.0, 200.0, listOf("a" to (600.0 / 900.0))).single()
        val sheetX = (frame.left + frame.width * 0.25) / 900.0
        val sheetY = (frame.top + frame.height * 0.5) / 1273.0
        val sheetW = (frame.width * 0.2) / 900.0
        val sheetH = (frame.height * 0.1) / 1273.0
        val mark = highlightOnFrame(sheetX, sheetY, sheetW, sheetH, frame, 900.0, 1273.0, "hl")
        assertEquals(1, mark?.page)
        assertEquals(0.25, mark!!.x, 0.001)
        assertEquals(0.5, mark.y, 0.001)
        val back = highlightFrameToSheet(mark, frame, 900.0, 1273.0)
        assertEquals(sheetX, back.x, 0.001)
        assertEquals(sheetY, back.y, 0.001)
        val other = layoutWorksheetColumn(900.0, 200.0, listOf("a" to 1.0, "b" to 1.0))[1]
        assertNull(highlightOnFrame(sheetX, sheetY, sheetW, sheetH, other, 900.0, 1273.0, "hl"))
    }
}
