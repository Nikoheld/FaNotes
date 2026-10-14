package ch.fasrv.fanotes.desk

import java.time.LocalDate
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter
import java.util.UUID

/**
 * Delete, duplicate, shift, and skip calendar events.
 * The one-day duplicate and the skipped occurrence match `calendarModel.ts`.
 */

private val WALL = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm")

fun deleteCalendarEvent(document: CalendarDocument, eventId: String): CalendarDocument =
    document.copy(events = document.events.filter { it.id != eventId })

fun duplicateCalendarEvent(document: CalendarDocument, eventId: String): CalendarDocument {
    val event = document.events.find { it.id == eventId } ?: return document
    val copy = event.copy(
        id = UUID.randomUUID().toString(),
        start = shiftCalendarWhen(event.start, event.allDay, 1),
        end = shiftCalendarWhen(event.end, event.allDay, 1),
    )
    return document.copy(events = document.events + copy)
}

fun shiftCalendarEvent(document: CalendarDocument, eventId: String, days: Long): CalendarDocument {
    if (days == 0L) return document
    val event = document.events.find { it.id == eventId } ?: return document
    return document.copy(
        events = document.events.map { item ->
            if (item.id != event.id) item else item.copy(
                start = shiftCalendarWhen(item.start, item.allDay, days),
                end = shiftCalendarWhen(item.end, item.allDay, days),
            )
        },
    )
}

/**
 * Drop one day of an event. A single event is deleted. A later repeat is
 * recorded as an exception. The first day of a series moves to the next repeat.
 */
fun skipCalendarOccurrence(document: CalendarDocument, eventId: String, day: LocalDate): CalendarDocument {
    val event = document.events.find { it.id == eventId } ?: return document
    val key = day.toString()
    if (event.recurrence == "none" || event.recurrence.isBlank()) return deleteCalendarEvent(document, event.id)
    if (event.start.take(10) == key) {
        return document.copy(
            events = document.events.map { item ->
                if (item.id != event.id) item else item.copy(
                    start = advanceCalendarWhen(item.start, item.allDay, item.recurrence),
                    end = advanceCalendarWhen(item.end, item.allDay, item.recurrence),
                )
            },
        )
    }
    if (key in event.exceptionDates) return document
    return document.copy(
        events = document.events.map { item ->
            if (item.id != event.id) item else item.copy(exceptionDates = item.exceptionDates + key)
        },
    )
}

private fun shiftCalendarWhen(value: String, allDay: Boolean, days: Long): String {
    if (allDay || !value.contains('T')) {
        return LocalDate.parse(value.take(10)).plusDays(days).toString()
    }
    return LocalDateTime.parse(value.take(16)).plusDays(days).format(WALL)
}

/** Colors cycle in the same order as the desktop calendar lists. */
val CALENDAR_LIST_COLORS = listOf(
    "#7f6df2",
    "#3d8bfd",
    "#2f9e6b",
    "#e0ac39",
    "#e15b64",
    "#d06ad6",
    "#5aa6a6",
    "#c47b4a",
)

fun createCalendarList(document: CalendarDocument, name: String, id: String = UUID.randomUUID().toString()): CalendarDocument {
    val clean = name.replace(Regex("""\s+"""), " ").trim().take(80)
    if (clean.isEmpty()) return document
    val calendar = CalendarDef(
        id = id,
        name = clean,
        color = CALENDAR_LIST_COLORS[document.calendars.size % CALENDAR_LIST_COLORS.size],
        visible = true,
    )
    return document.copy(calendars = document.calendars + calendar)
}

fun toggleCalendarVisible(document: CalendarDocument, id: String): CalendarDocument =
    document.copy(calendars = document.calendars.map { calendar ->
        if (calendar.id == id) calendar.copy(visible = !calendar.visible) else calendar
    })

fun visibleCalendarEvents(document: CalendarDocument): List<CalendarEvent> {
    val shown = document.calendars.filter { it.visible }.map { it.id }.toSet()
    return document.events.filter { it.calendarId in shown }
}

private fun advanceCalendarWhen(value: String, allDay: Boolean, recurrence: String): String {
    val moment = if (allDay || !value.contains('T')) {
        LocalDate.parse(value.take(10)).atStartOfDay()
    } else {
        LocalDateTime.parse(value.take(16))
    }
    val next = when (recurrence) {
        "weekly" -> moment.plusDays(7)
        "monthly" -> moment.plusMonths(1)
        "yearly" -> moment.plusYears(1)
        else -> moment.plusDays(1)
    }
    return if (allDay || !value.contains('T')) next.toLocalDate().toString() else next.format(WALL)
}
