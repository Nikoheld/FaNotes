package ch.fasrv.fanotes.desk

import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertSame
import kotlin.test.assertTrue

class CalendarEditTest {
    @Test
    fun deleteDuplicateAndShiftKeepTheDesktopDayStep() {
        val event = CalendarEvent("e1", "personal", "Probe", "2026-10-12", "2026-10-12", allDay = true)
        val timed = CalendarEvent("e2", "personal", "Stunde", "2026-10-12T09:00", "2026-10-12T10:00", allDay = false)
        val document = emptyCalendar().copy(events = listOf(event, timed))
        assertEquals(listOf("e2"), deleteCalendarEvent(document, "e1").events.map { it.id })
        val copy = duplicateCalendarEvent(document, "e1")
        assertEquals("2026-10-13", copy.events.last().start)
        assertEquals("2026-10-13", copy.events.last().end)
        assertTrue(copy.events.last().id != "e1")
        val moved = shiftCalendarEvent(document, "e2", 1)
        assertEquals("2026-10-13T09:00", moved.events.first { it.id == "e2" }.start)
        assertEquals("2026-10-13T10:00", moved.events.first { it.id == "e2" }.end)
    }

    @Test
    fun skippingARepeatDropsThatDayAndKeepsTheSeries() {
        val weekly = CalendarEvent(
            "w",
            "personal",
            "Kurs",
            "2026-10-12T09:00",
            "2026-10-12T10:00",
            allDay = false,
            recurrence = "weekly",
        )
        val document = emptyCalendar().copy(events = listOf(weekly))
        val later = skipCalendarOccurrence(document, "w", LocalDate.parse("2026-10-19"))
        assertEquals(listOf("2026-10-19"), later.events.single().exceptionDates)
        val first = skipCalendarOccurrence(document, "w", LocalDate.parse("2026-10-12"))
        assertEquals("2026-10-19T09:00", first.events.single().start)
        assertEquals("2026-10-19T10:00", first.events.single().end)
        val once = CalendarEvent("o", "personal", "Einmal", "2026-10-12", "2026-10-12")
        assertTrue(skipCalendarOccurrence(emptyCalendar().copy(events = listOf(once)), "o", LocalDate.parse("2026-10-12")).events.isEmpty())
    }

    @Test
    fun aNewListTakesTheNextDesktopColorAndCanBeHidden() {
        val empty = emptyCalendar()
        assertSame(empty, createCalendarList(empty, "   "))
        val created = createCalendarList(empty, "  Schule  Extra  ", "school-extra")
        assertEquals("Schule Extra", created.calendars.last().name)
        assertEquals("#e0ac39", created.calendars.last().color)
        assertEquals("school-extra", created.calendars.last().id)
        val hidden = toggleCalendarVisible(created, "personal")
        val withEvent = hidden.copy(events = listOf(CalendarEvent("e", "personal", "Privat", "2026-10-12", "2026-10-12")))
        assertTrue(visibleCalendarEvents(withEvent).isEmpty())
        assertEquals(1, visibleCalendarEvents(toggleCalendarVisible(withEvent, "personal")).size)
        val located = CalendarEvent("e", "school", "Turnen", "2026-10-12", "2026-10-12", location = "Halle")
        assertTrue(calendarEventMatches(located, "Schule", "halle"))
        assertTrue(calendarEventMatches(located, "Schule", "schule"))
        assertEquals(false, calendarEventMatches(located, "Schule", "Physik"))
        assertTrue(calendarEventMatches(located, "Schule", "  "))
    }
}
