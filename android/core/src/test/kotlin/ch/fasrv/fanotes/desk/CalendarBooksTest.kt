package ch.fasrv.fanotes.desk

import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class CalendarBooksTest {
    @Test
    fun weekStartsOnMondayAndThreeDaysStayPut() {
        val wednesday = LocalDate.parse("2026-10-14")
        assertEquals(
            listOf("2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"),
            calendarRange("week", wednesday).map { it.toString() },
        )
        assertEquals(listOf(wednesday, wednesday.plusDays(1), wednesday.plusDays(2)), calendarRange("three", wednesday))
        assertEquals("09:00–10:00", eventClock(CalendarEvent("e", "personal", "Stunde", "2026-10-14T09:00", "2026-10-14T10:00", allDay = false)))
        assertNull(eventClock(CalendarEvent("e", "personal", "Tag", "2026-10-14", "2026-10-14", allDay = true)))
    }

    @Test
    fun subjectBookFollowsTheFolderAndRemembersThePage() {
        val books = attachSubjectBook(emptyList(), "Schule/Mathe", "Buecher/Algebra.pdf", 4)
        val text = serializeSubjectBooks(books)
        val parsed = parseSubjectBooks(text)
        assertEquals(4, subjectBookForNote(parsed, "Schule/Mathe/Blatt.md")?.lastPage)
        assertEquals(5, recordSubjectBookPage(parsed, "Schule/Mathe", 5).single().lastPage)
    }

    @Test
    fun highlightOnTheSecondPdfPageLandsOnThatSlice() {
        val frames = listOf(PageFrame(1, 0.0, 1000.0, 900.0), PageFrame(2, 1016.0, 800.0, 900.0))
        val mark = WorksheetHighlight("h", 2, 0.1, 0.5, 0.4, 0.25)
        val sheet = highlightToSheet(mark, frames, 900.0, 1816.0)
        assertEquals((1016.0 + 0.5 * 800.0) / 1816.0, sheet.y, 1e-9)
        assertEquals(0.25 * 800.0 / 1816.0, sheet.height, 1e-9)
        val dragged = highlightFromDrag(sheet.x, sheet.y, sheet.width, sheet.height, frames, 900.0, 1816.0, "n")
        assertEquals(2, dragged?.page)
        assertEquals(0.5, dragged?.y ?: 0.0, 1e-6)
    }
}
