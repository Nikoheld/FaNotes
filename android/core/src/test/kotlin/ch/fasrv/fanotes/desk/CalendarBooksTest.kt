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
        val month = calendarRange("month", LocalDate.parse("2026-10-15"))
        assertEquals(42, month.size)
        assertEquals(LocalDate.parse("2026-09-28"), month.first())
        assertEquals(LocalDate.parse("2026-11-08"), month.last())
        val timed = CalendarEvent("e", "personal", "Lesen", "2026-10-15T08:00", "2026-10-15T09:00", allDay = false)
        assertEquals("08:00 Lesen", monthEventLabel(timed))
        assertEquals("Raum 12", agendaPlace(timed.copy(location = "  Raum 12  ")))
        assertNull(agendaPlace(timed.copy(location = "   ")))
        assertEquals("Tag", monthEventLabel(CalendarEvent("e", "personal", "Tag", "2026-10-14", "2026-10-14", allDay = true)))
        val agenda = calendarRange("agenda", LocalDate.parse("2026-10-15"))
        assertEquals(21, agenda.size)
        assertEquals(LocalDate.parse("2026-10-14"), agenda.first())
        assertEquals(LocalDate.parse("2026-11-03"), agenda.last())
        val cursor = LocalDate.parse("2026-10-15")
        assertEquals(cursor.plusWeeks(1), calendarShift("agenda", cursor, 1))
        assertEquals(cursor.plusWeeks(1), calendarShift("week", cursor, 1))
        assertEquals(cursor.plusDays(3), calendarShift("three", cursor, 1))
        assertEquals(cursor.plusMonths(1), calendarShift("month", cursor, 1))
        assertEquals(cursor.plusDays(1), calendarShift("day", cursor, 1))
        assertEquals(false, calendarShowsSide(960))
        assertEquals(true, calendarShowsSide(961))
        assertEquals(248, CAL_SIDE_DP)
        assertEquals(28, CAL_MINI_CELL_DP)
        assertEquals(4, CAL_MINI_DOT_DP)
    }

    @Test
    fun monthCellsUseTheDesktopChip() {
        assertEquals(24, CAL_MONTH_DAY_DP)
        assertEquals(6, CAL_CHIP_RADIUS_DP)
        assertEquals(3, CAL_MONTH_LIMIT)
        assertEquals(0.22f, CAL_CHIP_ALPHA)
        assertEquals("+2 weitere", calendarMoreLabel(2))
        assertEquals("+1 weitere", calendarMoreLabel(1))
        val thursday = LocalDate.parse("2026-10-15")
        assertEquals("Oktober 2026", calendarHeading("month", thursday))
        assertEquals("Donnerstag, 15. Oktober", calendarHeading("day", thursday))
        assertEquals("12. Okt. – 18. Okt.", calendarHeading("week", thursday))
        assertEquals(42, calendarIsoWeek(thursday))
        assertEquals(42, calendarIsoWeek(LocalDate.parse("2026-10-12")))
        assertEquals(1, calendarIsoWeek(LocalDate.parse("2026-01-01")))
        assertEquals(1, calendarIsoWeek(LocalDate.parse("2025-12-29")))
        assertEquals("KW", CAL_WEEK)
        assertEquals("today", calendarKeyAction("t", ctrl = false, alt = false, meta = false))
        assertEquals("new", calendarKeyAction("n", ctrl = false, alt = false, meta = false))
        assertEquals(null, calendarKeyAction("n", ctrl = true, alt = false, meta = false))
        assertEquals("previous", calendarKeyAction("left", ctrl = false, alt = false, meta = false))
        assertEquals("next", calendarKeyAction("right", ctrl = false, alt = false, meta = false))
        assertEquals("day", calendarKeyAction("1", ctrl = false, alt = false, meta = false))
        assertEquals("agenda", calendarKeyAction("5", ctrl = false, alt = false, meta = false))
        assertEquals(null, calendarKeyAction("t", ctrl = false, alt = true, meta = false))
        assertEquals("Ganztägig", agendaWhenLabel(CalendarEvent("e", "personal", "Tag", "2026-10-14", "2026-10-14", allDay = true)))
        assertEquals("09:00–10:00", agendaWhenLabel(CalendarEvent("e", "personal", "Stunde", "2026-10-14T09:00", "2026-10-14T10:00", allDay = false)))
        assertEquals(30, CAL_TOOL_DP)
        assertEquals("Termine suchen", CAL_SEARCH)
        assertEquals("Tagesnotiz", CAL_DAILY)
        assertEquals("Do", calendarWeekdayShort(thursday))
        assertEquals("Mo", calendarWeekdayShort(LocalDate.parse("2026-10-12")))
        assertEquals(0f, calendarNowOffsetDp(0, 0))
        assertEquals(7.5f * 48f, calendarNowOffsetDp(7, 30))
        assertEquals(56, CAL_GUTTER_DP)
        assertEquals(8, CAL_NOW_DOT_DP)
        assertEquals(SnappedClock(0, 10, 0), snapCalendarClock(10, 7))
        assertEquals(SnappedClock(0, 10, 15), snapCalendarClock(10, 8))
        assertEquals(SnappedClock(1, 0, 0), snapCalendarClock(23, 53))
        assertEquals(true, calendarRangeIsEmpty("week", 0))
        assertEquals(false, calendarRangeIsEmpty("month", 0))
        assertEquals(false, calendarRangeIsEmpty("agenda", 2))
        assertEquals("Keine Termine in diesem Zeitraum.", CAL_EMPTY)
        assertEquals("Neuer Termin", CAL_NEW_EVENT)
        assertEquals(6, CAL_EVENT_RADIUS_DP)
        assertEquals(6, CAL_EVENT_PAD_X_DP)
        assertEquals(3, CAL_EVENT_PAD_Y_DP)
        assertEquals(2, CAL_EVENT_INSET_DP)
        assertEquals(0.22f, CAL_CHIP_ALPHA)
    }

    @Test
    fun timedResizeHandleIsTheDesktopEdge() {
        assertEquals(6, CAL_RESIZE_DP)
    }

    @Test
    fun calendarToolbarWrapsWhenThePaneCannotHoldTheControls() {
        assertEquals(6, CAL_TOOLBAR_GAP_DP)
        assertEquals(862, CAL_TOOLBAR_CONTENT_DP)
        assertEquals(false, calendarToolbarWraps(862, CAL_TOOLBAR_CONTENT_DP))
        assertEquals(false, calendarToolbarWraps(863, CAL_TOOLBAR_CONTENT_DP))
        assertEquals(true, calendarToolbarWraps(861, CAL_TOOLBAR_CONTENT_DP))
    }

    @Test
    fun monthRowsShareTheLeftoverHeight() {
        assertEquals(88, monthRowHeightDp(0, minDp = 88))
        assertEquals(100, monthRowHeightDp(600, minDp = 88))
        assertEquals(88, monthRowHeightDp(400, minDp = 88))
    }

    @Test
    fun hourViewportUsesTheLeftoverHeight() {
        assertEquals(48, CAL_HOUR_DP)
        assertEquals(48, hourViewportDp(0, minDp = 48))
        assertEquals(900, hourViewportDp(900, minDp = 48))
        assertEquals(48, hourViewportDp(47, minDp = 48))
        assertEquals(48, hourViewportDp(-4, minDp = 48))
        assertEquals(0, hourViewportDp(-4, minDp = -8))
    }

    @Test
    fun subjectBookFollowsTheFolderAndRemembersThePage() {
        val books = attachSubjectBook(emptyList(), "Schule/Mathe", "Buecher/Algebra.pdf", 4)
        val text = serializeSubjectBooks(books)
        val parsed = parseSubjectBooks(text)
        assertEquals(4, subjectBookForNote(parsed, "Schule/Mathe/Blatt.md")?.lastPage)
        assertEquals(5, recordSubjectBookPage(parsed, "Schule/Mathe", 5).single().lastPage)
        assertEquals(emptyList(), detachSubjectBook(parsed, "Schule/Mathe"))
        assertEquals(parsed, detachSubjectBook(parsed, "Chemie"))
        assertEquals(parsed, detachSubjectBook(parsed, ""))
        assertEquals(SubjectBookView(false, false, null), subjectBookViewPolicy(false, true, "rechts"))
        assertEquals(SubjectBookView(true, false, "rechts"), subjectBookViewPolicy(true, false, "rechts"))
        assertEquals(SubjectBookView(true, true, "links"), subjectBookViewPolicy(true, true, "links"))
        assertEquals(SubjectBookToggle(true, "rechts"), toggleSubjectBookView(false, "nope"))
        assertEquals(SubjectBookToggle(false, "oben"), toggleSubjectBookView(true, "oben"))
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
