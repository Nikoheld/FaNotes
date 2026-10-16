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

    @Test
    fun aTextToolTapLandsOnThatWorksheetPage() {
        val frame = layoutWorksheetColumn(900.0, 200.0, listOf("sheet" to (600.0 / 900.0))).single()
        val sheetX = (frame.left + frame.width * 0.25) / 900.0
        val sheetY = (frame.top + frame.height * 0.5) / 1273.0
        val local = pointOnWorksheet(sheetX, sheetY, frame, 900.0, 1273.0)
        assertEquals(0.25, local?.first ?: -1.0, 0.001)
        assertEquals(0.5, local?.second ?: -1.0, 0.001)
        assertNull(pointOnWorksheet(0.01, sheetY, frame, 900.0, 1273.0))
        val box = placeWorksheetTextBox(frame.page, 1.4, -0.2, "box-1")
        assertEquals(1, box.page)
        assertEquals(0.78, box.x, 0.001)
        assertEquals(0.0, box.y, 0.001)
        assertEquals(0.28, box.width, 0.001)
        assertEquals(16.0, box.fontSize, 0.001)
        assertEquals("", box.text)
        assertNull(worksheetBoxTextError("Hallo"))
        assertEquals("Ein Arbeitsblatt-Text ist ungültig.", worksheetBoxTextError("a".repeat(20_001)))
    }

    @Test
    fun worksheetToolsShowTheDesktopHintWhileArmed() {
        assertEquals(null, worksheetPlaceHint(false, false))
        assertEquals(WORKSHEET_TEXT_HINT, worksheetPlaceHint(true, false))
        assertEquals(WORKSHEET_HIGHLIGHT_HINT, worksheetPlaceHint(false, true))
        assertEquals(WORKSHEET_HIGHLIGHT_HINT, worksheetPlaceHint(true, true))
        assertEquals("Antwort eingeben …", BOX_EDITOR_PLACEHOLDER)
        assertEquals("Textfeld entfernen", BOX_EDITOR_REMOVE)
        assertEquals(5, BOX_EDITOR_RADIUS_DP)
        assertEquals(80, BOX_EDITOR_MIN_DP)
    }

    @Test
    fun theImportDialogUsesTheDesktopCard() {
        assertEquals(620, SHEET_IMPORT_MAX_DP)
        assertEquals(0.92f, SHEET_IMPORT_WIDTH_FRACTION)
        assertEquals(12, SHEET_IMPORT_RADIUS_DP)
        assertEquals(12, SHEET_IMPORT_OPTION_RADIUS_DP)
        assertEquals(620, sheetImportWidthDp(900))
        assertEquals(368, sheetImportWidthDp(400))
        assertEquals(2, sheetImportColumns(561))
        assertEquals(1, sheetImportColumns(560))
        assertEquals(1, sheetImportColumns(400))
        assertEquals(SheetImportShadow(12, 40, 0.08f), sheetImportShadow(false))
        assertEquals(SheetImportShadow(16, 48, 0.32f), sheetImportShadow(true))
        assertEquals("Bild oder PDF", SHEET_IMPORT_EYEBROW)
        assertEquals("In der Linux- oder Windows-App", SHEET_IMPORT_ONENOTE_DETAIL)
        assertEquals("PDF · Bilder · ONE · ONETOC2 · ONEPKG · ZIP", SHEET_IMPORT_FORMATS)
        assertEquals(0.45f, SHEET_IMPORT_DISABLED_ALPHA)
    }
}
