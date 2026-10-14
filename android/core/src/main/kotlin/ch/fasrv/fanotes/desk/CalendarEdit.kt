package ch.fasrv.fanotes.desk

import java.time.LocalDate
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter
import java.util.UUID

/**
 * Delete, duplicate, shift, skip, and edit calendar events, and rename or
 * remove calendar lists. A later repeat edited on its own day becomes a
 * separate event, matching `saveOccurrenceEdit` in `calendarModel.ts`.
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

fun renameCalendarList(document: CalendarDocument, id: String, name: String): CalendarDocument {
    val clean = cleanCalendarText(name, 80)
    if (clean.isEmpty()) return document
    val current = document.calendars.find { it.id == id } ?: return document
    if (current.name == clean) return document
    return document.copy(calendars = document.calendars.map { calendar ->
        if (calendar.id == id) calendar.copy(name = clean) else calendar
    })
}

/** The last remaining list stays. Its events would otherwise become unreadable. */
fun deleteCalendarList(document: CalendarDocument, id: String): CalendarDocument {
    if (document.calendars.size <= 1) return document
    if (document.calendars.none { it.id == id }) return document
    return document.copy(
        calendars = document.calendars.filter { it.id != id },
        events = document.events.filter { it.calendarId != id },
    )
}

/** Start and end of one occurrence, shifted onto [day] from the series start. */
fun calendarOccurrenceWindow(event: CalendarEvent, day: LocalDate): Pair<String, String> {
    val master = runCatching { LocalDate.parse(event.start.take(10)) }.getOrNull() ?: return event.start to event.end
    val delta = java.time.temporal.ChronoUnit.DAYS.between(master, day)
    return shiftCalendarWhen(event.start, event.allDay, delta) to shiftCalendarWhen(event.end, event.allDay, delta)
}

/**
 * Writes a popover edit. [key] is `eventId@YYYY-MM-DD`. A later repeat becomes
 * its own event and the series skips that day. A blank or unknown edit is left
 * untouched so a failed save does not drop the original term.
 */
fun saveCalendarOccurrence(
    document: CalendarDocument,
    key: String?,
    next: CalendarEvent,
    newId: String = UUID.randomUUID().toString(),
): CalendarDocument {
    val ids = document.calendars.map { it.id }.toSet()
    val eventId = key?.substringBefore('@').orEmpty()
    val day = key?.substringAfter('@', "").orEmpty()
    val master = document.events.find { it.id == eventId }
    if (master == null || !DATE_KEY.matches(day)) {
        val cleaned = sanitizeCalendarEvent(next, ids) ?: return document
        return upsertCalendarEvent(document, cleaned)
    }
    val masterDay = master.start.take(10)
    if (master.recurrence == "none" || master.recurrence.isBlank() || masterDay == day) {
        val cleaned = sanitizeCalendarEvent(
            next.copy(
                id = master.id,
                exceptionDates = if (master.recurrence == "none" || master.recurrence.isBlank()) emptyList() else next.exceptionDates,
            ),
            ids,
        ) ?: return document
        return upsertCalendarEvent(document, cleaned)
    }
    val skipped = document.copy(
        events = document.events.map { item ->
            if (item.id != master.id || day in item.exceptionDates) item
            else item.copy(exceptionDates = item.exceptionDates + day)
        },
    )
    val detached = sanitizeCalendarEvent(
        next.copy(
            id = newId.take(80).ifBlank { UUID.randomUUID().toString() },
            recurrence = "none",
            recurrenceUntil = null,
            exceptionDates = emptyList(),
        ),
        skipped.calendars.map { it.id }.toSet(),
    ) ?: return skipped
    return upsertCalendarEvent(skipped, detached)
}

fun calendarEventMatches(event: CalendarEvent, calendarName: String, query: String): Boolean {
    val needle = query.trim().lowercase(java.util.Locale.GERMAN)
    if (needle.isEmpty()) return true
    val haystack = listOf(event.title, event.location, event.notes, event.notePath, calendarName)
        .joinToString("\n")
        .lowercase(java.util.Locale.GERMAN)
    return haystack.contains(needle)
}

fun visibleCalendarEvents(document: CalendarDocument): List<CalendarEvent> {
    val shown = document.calendars.filter { it.visible }.map { it.id }.toSet()
    return document.events.filter { it.calendarId in shown }
}

private val DATE_KEY = Regex("""^\d{4}-\d{2}-\d{2}$""")
private val WALL_KEY = Regex("""^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$""")

private fun cleanCalendarText(value: String, max: Int): String =
    value.replace(Regex("""\s+"""), " ").trim().take(max)

private fun upsertCalendarEvent(document: CalendarDocument, event: CalendarEvent): CalendarDocument {
    val exists = document.events.any { it.id == event.id }
    val events = if (exists) document.events.map { if (it.id == event.id) event else it } else document.events + event
    return document.copy(events = events)
}

private fun sanitizeCalendarEvent(event: CalendarEvent, calendarIds: Set<String>): CalendarEvent? {
    val title = cleanCalendarText(event.title, 240)
    if (title.isEmpty()) return null
    val calendarId = cleanCalendarText(event.calendarId, 80)
    if (calendarId !in calendarIds) return null
    val bounds = normalizeCalendarBounds(event.start, event.end, event.allDay) ?: return null
    val recurrence = event.recurrence.takeIf { it in setOf("daily", "weekly", "monthly", "yearly") } ?: "none"
    val until = event.recurrenceUntil?.takeIf { recurrence != "none" && validDateKey(it) }
    val exceptions = if (recurrence == "none") {
        emptyList()
    } else {
        event.exceptionDates.filter(::validDateKey).distinct().take(400)
    }
    return event.copy(
        id = cleanCalendarText(event.id, 80).ifBlank { UUID.randomUUID().toString() },
        calendarId = calendarId,
        title = title,
        start = bounds.first,
        end = bounds.second,
        location = cleanCalendarText(event.location, 160),
        notes = event.notes.take(4_000),
        notePath = cleanCalendarText(event.notePath, 400),
        recurrence = recurrence,
        recurrenceUntil = until,
        exceptionDates = exceptions,
    )
}

private fun validDateKey(value: String): Boolean =
    DATE_KEY.matches(value) && runCatching { LocalDate.parse(value) }.isSuccess

private fun normalizeCalendarBounds(startRaw: String, endRaw: String, allDay: Boolean): Pair<String, String>? {
    if (allDay) {
        val start = runCatching { LocalDate.parse(startRaw.take(10)) }.getOrNull() ?: return null
        val end = runCatching { LocalDate.parse(endRaw.take(10)) }.getOrNull() ?: return null
        return start.toString() to (if (end.isBefore(start)) start else end).toString()
    }
    val start = parseWallClock(startRaw) ?: return null
    val parsedEnd = parseWallClock(endRaw)
    val end = if (parsedEnd == null || !parsedEnd.isAfter(start)) start.plusMinutes(30) else parsedEnd
    return start.format(WALL) to end.format(WALL)
}

private fun parseWallClock(value: String): LocalDateTime? {
    val match = WALL_KEY.matchEntire(value.take(16)) ?: return null
    return runCatching {
        LocalDateTime.of(
            LocalDate.parse(match.groupValues[1]),
            java.time.LocalTime.of(match.groupValues[2].toInt(), match.groupValues[3].toInt()),
        )
    }.getOrNull()
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
