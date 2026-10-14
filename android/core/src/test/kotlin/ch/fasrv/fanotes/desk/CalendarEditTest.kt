package ch.fasrv.fanotes.desk

import java.time.LocalDate
import java.time.LocalDateTime
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

    @Test
    fun aListCanBeRenamedAndTheLastListCannotBeRemoved() {
        val document = emptyCalendar().copy(
            events = listOf(
                CalendarEvent("a", "personal", "Privat", "2026-10-12", "2026-10-12"),
                CalendarEvent("b", "school", "Kurs", "2026-10-12", "2026-10-12"),
            ),
        )
        assertSame(document, renameCalendarList(document, "school", "   "))
        assertSame(document, renameCalendarList(document, "missing", "Neu"))
        val renamed = renameCalendarList(document, "school", "  Schule   Extra  ")
        assertEquals("Schule Extra", renamed.calendars.first { it.id == "school" }.name)
        assertEquals("#3d8bfd", renamed.calendars.first { it.id == "school" }.color)
        val removed = deleteCalendarList(renamed, "school")
        assertEquals(listOf("personal", "work"), removed.calendars.map { it.id })
        assertEquals(listOf("a"), removed.events.map { it.id })
        val only = removed.copy(calendars = removed.calendars.take(1))
        assertSame(only, deleteCalendarList(only, "personal"))
        assertSame(document, deleteCalendarList(document, "missing"))
    }

    @Test
    fun editingALaterRepeatDetachesThatDayAndKeepsTheSeries() {
        val weekly = CalendarEvent(
            "w",
            "personal",
            "Kurs",
            "2026-10-12T09:00",
            "2026-10-12T10:00",
            allDay = false,
            recurrence = "weekly",
            location = "  Halle   A ",
        )
        val document = emptyCalendar().copy(events = listOf(weekly))
        assertEquals(
            "2026-10-19T09:00" to "2026-10-19T10:00",
            calendarOccurrenceWindow(weekly, LocalDate.parse("2026-10-19")),
        )
        val edited = saveCalendarOccurrence(
            document,
            "w@2026-10-19",
            weekly.copy(title = "Sprechstunde", start = "2026-10-19T15:00", end = "2026-10-19T16:00"),
            newId = "detached",
        )
        assertEquals(listOf("2026-10-19"), edited.events.first { it.id == "w" }.exceptionDates)
        val copy = edited.events.first { it.id == "detached" }
        assertEquals("Sprechstunde", copy.title)
        assertEquals("none", copy.recurrence)
        assertEquals("2026-10-19T15:00", copy.start)
        assertEquals("2026-10-19T16:00", copy.end)
        assertEquals("Halle A", copy.location)
        val again = saveCalendarOccurrence(
            edited,
            "w@2026-10-19",
            weekly.copy(title = "Nochmals", start = "2026-10-19T15:00", end = "2026-10-19T16:00"),
            newId = "second",
        )
        assertEquals(listOf("2026-10-19"), again.events.first { it.id == "w" }.exceptionDates)
        val master = saveCalendarOccurrence(document, "w@2026-10-12", weekly.copy(title = "Seminar"), newId = "unused")
        assertEquals(listOf("w"), master.events.map { it.id })
        assertEquals("Seminar", master.events.single().title)
        assertEquals("weekly", master.events.single().recurrence)
    }

    @Test
    fun aBrokenEditDoesNotReplaceTheOriginalTerm() {
        val event = CalendarEvent("e", "personal", "Alt", "2026-10-12T09:00", "2026-10-12T08:00", allDay = false)
        val document = emptyCalendar().copy(events = listOf(event))
        val fixed = saveCalendarOccurrence(document, null, event.copy(id = "neu", title = "Stunde"))
        assertEquals("2026-10-12T09:30", fixed.events.first { it.id == "neu" }.end)
        assertSame(document, saveCalendarOccurrence(document, "e@2026-10-12", event.copy(title = "   ")))
        assertSame(document, saveCalendarOccurrence(document, null, event.copy(id = "x", calendarId = "missing", title = "Weg")))
        val allDay = CalendarEvent("d", "personal", "Tag", "2026-10-14", "2026-10-12", allDay = true)
        val healed = saveCalendarOccurrence(emptyCalendar(), null, allDay)
        assertEquals("2026-10-14", healed.events.single().start)
        assertEquals("2026-10-14", healed.events.single().end)
    }

    @Test
    fun movingAndResizingMatchTheDesktopDayGrid() {
        val lecture = CalendarEvent(
            "lecture",
            "school",
            "Vorlesung",
            "2026-09-14T09:00",
            "2026-09-14T10:30",
            allDay = false,
            recurrence = "weekly",
        )
        val focus = CalendarEvent("focus", "personal", "Fokus", "2026-09-14T09:15", "2026-09-14T10:00", allDay = false)
        val document = emptyCalendar().copy(events = listOf(lecture, focus))
        val slices = layoutDayColumns(
            listOf(
                CalendarSpan("a", lecture, LocalDateTime.parse("2026-09-14T09:00"), LocalDateTime.parse("2026-09-14T10:30"), LocalDateTime.parse("2026-09-14T09:00"), LocalDateTime.parse("2026-09-14T10:30")),
                CalendarSpan("b", focus, LocalDateTime.parse("2026-09-14T09:15"), LocalDateTime.parse("2026-09-14T10:00"), LocalDateTime.parse("2026-09-14T09:15"), LocalDateTime.parse("2026-09-14T10:00")),
            ),
        )
        assertEquals(2, slices.size)
        assertEquals(setOf(0, 1), slices.map { it.column }.toSet())
        assertTrue(slices.all { it.columns == 2 })
        val packed = timedDayLayout(document, LocalDate.parse("2026-09-14"))
        assertEquals(2, packed.size)
        assertTrue(packed.all { it.columns == 2 })

        val moved = moveCalendarOccurrence(document, "focus@2026-09-14", LocalDateTime.parse("2026-09-14T11:00"))
        val movedFocus = moved.events.first { it.id == "focus" }
        assertEquals("2026-09-14T11:00", movedFocus.start)
        assertEquals("2026-09-14T11:45", movedFocus.end)
        val resized = resizeCalendarOccurrence(moved, "focus@2026-09-14", LocalDateTime.parse("2026-09-14T12:00"))
        assertEquals("2026-09-14T11:00", resized.events.first { it.id == "focus" }.start)
        assertEquals("2026-09-14T12:00", resized.events.first { it.id == "focus" }.end)

        val detached = moveCalendarOccurrence(
            document,
            "lecture@2026-09-21",
            LocalDateTime.parse("2026-09-21T15:00"),
            newId = "copy",
        )
        assertEquals(listOf("2026-09-21"), detached.events.first { it.id == "lecture" }.exceptionDates)
        val copy = detached.events.first { it.id == "copy" }
        assertEquals("Vorlesung", copy.title)
        assertEquals("none", copy.recurrence)
        assertEquals("2026-09-21T15:00", copy.start)
        assertEquals("2026-09-21T16:30", copy.end)

        assertSame(document, moveCalendarOccurrence(document, "focus@2026-09-14", LocalDateTime.parse("2026-09-14T09:15")))
        assertSame(document, resizeCalendarOccurrence(document, "focus@2026-09-14", LocalDateTime.parse("2026-09-14T09:15")))
        assertSame(document, moveCalendarOccurrence(document, "missing@2026-09-14", LocalDateTime.parse("2026-09-14T12:00")))

        val allDay = CalendarEvent("a", "personal", "Abgabe", "2026-09-14", "2026-09-14", allDay = true)
        val shifted = moveCalendarOccurrence(
            emptyCalendar().copy(events = listOf(allDay)),
            "a@2026-09-14",
            LocalDateTime.parse("2026-09-15T00:00"),
        )
        assertEquals("2026-09-15", shifted.events.single().start)
        assertEquals("2026-09-15", shifted.events.single().end)
    }

    @Test
    fun draggingEmptyPaperUsesTheDesktopCreateRange() {
        assertEquals(9 * 60 + 15 to 9 * 60 + 45, dragCreateMinutes(9 * 60 + 15, 9 * 60 + 15, moved = false))
        assertEquals(23 * 60 + 50 to 24 * 60 + 20, dragCreateMinutes(23 * 60 + 50, 23 * 60 + 50, moved = false))
        assertEquals(2 * 60 to 3 * 60 + 15, dragCreateMinutes(2 * 60, 3 * 60, moved = true))
        assertEquals(1 * 60 to 2 * 60 + 15, dragCreateMinutes(2 * 60, 1 * 60, moved = true))
        assertEquals(23 * 60 to 24 * 60, dragCreateMinutes(23 * 60, 24 * 60, moved = true))
    }
}
