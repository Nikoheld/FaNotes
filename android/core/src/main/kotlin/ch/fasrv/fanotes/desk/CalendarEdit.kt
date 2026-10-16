package ch.fasrv.fanotes.desk

import java.time.Duration
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter
import java.util.UUID
import kotlin.math.min

/**
 * Delete, duplicate, shift, skip, edit, move, and resize calendar events, and
 * rename or remove calendar lists. A later repeat moved or resized on its own
 * day becomes a separate event, matching `calendarModel.ts`.
 */

private val WALL = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm")

/** A short month clamps that one instance. The next month uses the original day again. */
fun calendarMonthShift(origin: LocalDate, months: Long): LocalDate {
    val shifted = origin.withDayOfMonth(1).plusMonths(months)
    return shifted.withDayOfMonth(min(origin.dayOfMonth, shifted.lengthOfMonth()))
}

/** The nth repeat, counted from the original start rather than the previous clamped day. */
fun calendarInstanceStart(origin: LocalDateTime, step: Int, recurrence: String): LocalDateTime {
    val date = when (recurrence) {
        "weekly" -> origin.toLocalDate().plusDays(7L * step)
        "monthly" -> calendarMonthShift(origin.toLocalDate(), step.toLong())
        "yearly" -> calendarMonthShift(origin.toLocalDate(), 12L * step)
        else -> origin.toLocalDate().plusDays(step.toLong())
    }
    return date.atTime(origin.toLocalTime())
}

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
 * recorded as an exception. The first day of a daily or weekly series moves
 * to the next repeat. A monthly or yearly series keeps its original day and
 * records that first day as an exception, so a short month does not stick.
 */
fun skipCalendarOccurrence(document: CalendarDocument, eventId: String, day: LocalDate): CalendarDocument {
    val event = document.events.find { it.id == eventId } ?: return document
    val key = day.toString()
    if (event.recurrence == "none" || event.recurrence.isBlank()) return deleteCalendarEvent(document, event.id)
    if (event.start.take(10) == key) {
        if (event.recurrence == "monthly" || event.recurrence == "yearly") {
            if (key in event.exceptionDates) return document
            return document.copy(
                events = document.events.map { item ->
                    if (item.id != event.id) item else item.copy(exceptionDates = item.exceptionDates + key)
                },
            )
        }
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

/** One occurrence, or the part of it that falls on a single day. */
data class CalendarSpan(
    val key: String,
    val event: CalendarEvent,
    val start: LocalDateTime,
    val end: LocalDateTime,
    val originStart: LocalDateTime,
    val originEnd: LocalDateTime,
)

/** Overlapping timed events packed into columns the way the desktop day grid does. */
data class LaidOutSpan(
    val key: String,
    val event: CalendarEvent,
    val start: LocalDateTime,
    val end: LocalDateTime,
    val originStart: LocalDateTime,
    val originEnd: LocalDateTime,
    val column: Int,
    val columns: Int,
)

fun layoutDayColumns(items: List<CalendarSpan>): List<LaidOutSpan> {
    val sorted = items.sortedWith { left, right ->
        val byStart = left.start.compareTo(right.start)
        if (byStart != 0) byStart else right.end.compareTo(left.end)
    }
    val laid = mutableListOf<LaidOutSpan>()
    val cluster = mutableListOf<CalendarSpan>()
    var clusterEnd = LocalDateTime.MIN
    fun flush() {
        if (cluster.isEmpty()) return
        val columnEnds = mutableListOf<LocalDateTime>()
        val assigned = cluster.map { item ->
            val index = columnEnds.indexOfFirst { !it.isAfter(item.start) }
            val column = if (index < 0) {
                columnEnds += item.end
                columnEnds.lastIndex
            } else {
                columnEnds[index] = item.end
                index
            }
            column to item
        }
        val columns = columnEnds.size.coerceAtLeast(1)
        for ((column, item) in assigned) {
            laid += LaidOutSpan(item.key, item.event, item.start, item.end, item.originStart, item.originEnd, column, columns)
        }
        cluster.clear()
        clusterEnd = LocalDateTime.MIN
    }
    for (item in sorted) {
        if (cluster.isNotEmpty() && !item.start.isBefore(clusterEnd)) flush()
        cluster += item
        if (item.end.isAfter(clusterEnd)) clusterEnd = item.end
    }
    flush()
    return laid
}

/** Timed events on [day], clipped to that day and packed into columns. */
fun timedDayLayout(document: CalendarDocument, day: LocalDate): List<LaidOutSpan> {
    val dayStart = day.atStartOfDay()
    val dayEnd = day.plusDays(1).atStartOfDay()
    val spans = occurrenceSpans(document, day.minusDays(1).atStartOfDay(), dayEnd)
        .filter { !it.event.allDay && it.end.isAfter(dayStart) && it.start.isBefore(dayEnd) }
        .mapNotNull { sliceSpan(it, dayStart, dayEnd) }
    return layoutDayColumns(spans)
}

fun allDaySpans(document: CalendarDocument, day: LocalDate): List<CalendarSpan> {
    val dayStart = day.atStartOfDay()
    val dayEnd = day.plusDays(1).atStartOfDay()
    return occurrenceSpans(document, day.minusDays(1).atStartOfDay(), dayEnd)
        .filter { it.event.allDay && it.end.isAfter(dayStart) && it.start.isBefore(dayEnd) }
}

/**
 * Moves one occurrence so it starts at [nextStart], keeping its length.
 * The first day of a series moves the series. A later day becomes its own event.
 */
fun moveCalendarOccurrence(
    document: CalendarDocument,
    key: String,
    nextStart: LocalDateTime,
    newId: String = UUID.randomUUID().toString(),
): CalendarDocument {
    val occurrence = findSpan(document, key, nextStart) ?: return document
    val delta = Duration.between(occurrence.start, nextStart)
    if (delta.isZero) return document
    return placeSpan(document, occurrence, key, nextStart, occurrence.end.plus(delta), newId)
}

/**
 * Minutes covered by a drag on empty paper. A tap stays a 30 minute block.
 * A drag follows the desktop grid: the block starts at the earlier minute and
 * ends 15 minutes past the pointer, never before the press plus 15 minutes.
 * An end of 1440 is midnight at the start of the next day.
 */
fun dragCreateMinutes(origin: Int, pointer: Int, moved: Boolean): Pair<Int, Int> {
    val day = 24 * 60
    val startOrigin = origin.coerceIn(0, day - 1)
    if (!moved) return startOrigin to (startOrigin + 30)
    val pointed = pointer.coerceIn(0, day)
    val start = minOf(startOrigin, pointed)
    val end = maxOf(startOrigin + 15, minOf(day, pointed + 15))
    return start to end
}

/** Changes the end of one occurrence. An end at or before the start is ignored. */
fun resizeCalendarOccurrence(
    document: CalendarDocument,
    key: String,
    nextEnd: LocalDateTime,
    newId: String = UUID.randomUUID().toString(),
): CalendarDocument {
    val occurrence = findSpan(document, key, nextEnd) ?: return document
    if (!nextEnd.isAfter(occurrence.start)) return document
    return placeSpan(document, occurrence, key, occurrence.start, nextEnd, newId)
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

private fun occurrenceSpans(document: CalendarDocument, rangeStart: LocalDateTime, rangeEnd: LocalDateTime): List<CalendarSpan> {
    val visible = document.calendars.filter { it.visible }.map { it.id }.toSet()
    val spans = mutableListOf<CalendarSpan>()
    for (event in document.events) {
        if (event.calendarId !in visible) continue
        val bounds = spanBounds(event) ?: continue
        val duration = Duration.between(bounds.first, bounds.second)
        // Java 17 has isZero and isNegative. isPositive arrived in Java 18.
        if (duration.isZero || duration.isNegative) continue
        val until = event.recurrenceUntil?.let { runCatching { LocalDate.parse(it) }.getOrNull() }
        val untilEnd = until?.plusDays(1)?.atStartOfDay()
        val skipped = event.exceptionDates.toSet()
        var step = 0
        var cursor = bounds.first
        var guard = 0
        while (cursor.isBefore(rangeEnd) && guard < 500) {
            if (untilEnd != null && !cursor.isBefore(untilEnd)) break
            val end = cursor.plus(duration)
            val dayKey = cursor.toLocalDate().toString()
            if (dayKey !in skipped && end.isAfter(rangeStart) && cursor.isBefore(rangeEnd)) {
                spans += CalendarSpan("${event.id}@$dayKey", event, cursor, end, cursor, end)
            }
            if (event.recurrence == "none" || event.recurrence.isBlank()) break
            step += 1
            val next = calendarInstanceStart(bounds.first, step, event.recurrence)
            if (!next.isAfter(cursor)) break
            cursor = next
            guard += 1
        }
    }
    return spans.sortedWith(compareBy<CalendarSpan> { it.start }.thenBy { it.event.title.lowercase(java.util.Locale.GERMAN) })
}

private fun spanBounds(event: CalendarEvent): Pair<LocalDateTime, LocalDateTime>? {
    if (event.allDay || !event.start.contains('T')) {
        val startDate = runCatching { LocalDate.parse(event.start.take(10)) }.getOrNull() ?: return null
        val inclusive = runCatching { LocalDate.parse(event.end.take(10)) }.getOrNull() ?: startDate
        return startDate.atStartOfDay() to inclusive.plusDays(1).atStartOfDay()
    }
    val start = parseWallClock(event.start) ?: return null
    val parsedEnd = parseWallClock(event.end)
    val end = if (parsedEnd == null || !parsedEnd.isAfter(start)) start.plusMinutes(30) else parsedEnd
    return start to end
}

private fun sliceSpan(span: CalendarSpan, dayStart: LocalDateTime, dayEnd: LocalDateTime): CalendarSpan? {
    val start = if (span.start.isBefore(dayStart)) dayStart else span.start
    val end = if (span.end.isAfter(dayEnd)) dayEnd else span.end
    if (!end.isAfter(start)) return null
    return span.copy(start = start, end = end)
}

private fun findSpan(document: CalendarDocument, key: String, around: LocalDateTime): CalendarSpan? {
    val day = key.substringAfter('@', "")
    val anchor = runCatching { LocalDate.parse(day) }.getOrNull() ?: around.toLocalDate()
    val rangeStart = anchor.minusDays(1).atStartOfDay()
    val opened = document.copy(calendars = document.calendars.map { it.copy(visible = true) })
    return occurrenceSpans(opened, rangeStart, rangeStart.plusDays(3)).find { it.key == key }
}

private fun placeSpan(
    document: CalendarDocument,
    occurrence: CalendarSpan,
    key: String,
    start: LocalDateTime,
    end: LocalDateTime,
    newId: String,
): CalendarDocument {
    val instanceDay = key.substringAfter('@')
    val masterDay = occurrence.event.start.take(10)
    val recurringLater = occurrence.event.recurrence in setOf("daily", "weekly", "monthly", "yearly") && masterDay != instanceDay
    val startText = if (occurrence.event.allDay) start.toLocalDate().toString() else start.format(WALL)
    val endText = if (occurrence.event.allDay) {
        end.toLocalDate().atStartOfDay().minusDays(1).toLocalDate().toString()
    } else {
        end.format(WALL)
    }
    if (!recurringLater) {
        val updated = occurrence.event.copy(start = startText, end = endText)
        return document.copy(events = document.events.map { if (it.id == updated.id) updated else it })
    }
    val skipped = document.copy(
        events = document.events.map { item ->
            if (item.id != occurrence.event.id || instanceDay in item.exceptionDates) item
            else item.copy(exceptionDates = item.exceptionDates + instanceDay)
        },
    )
    val detached = occurrence.event.copy(
        id = newId.take(80).ifBlank { UUID.randomUUID().toString() },
        start = startText,
        end = endText,
        recurrence = "none",
        recurrenceUntil = null,
        exceptionDates = emptyList(),
    )
    return skipped.copy(events = skipped.events + detached)
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

/** Termin editor after the later chrome pass: 12px panel-strong card, min(440px, viewport − 32px). */
const val CAL_EDITOR_MAX_DP = 440
const val CAL_EDITOR_INSET_DP = 16
const val CAL_EDITOR_RADIUS_DP = 12
const val CAL_EDITOR_GAP_DP = 10
const val CAL_EDITOR_PAD_DP = 16
const val CAL_EDITOR_TITLE_SP = 18
const val CAL_EDITOR_FIELD_RADIUS_DP = 8
const val CAL_EDITOR_FIELD_PAD_Y_DP = 6
const val CAL_EDITOR_FIELD_PAD_X_DP = 8
const val CAL_EDITOR_LABEL_SP = 12
const val CAL_EDITOR_LABEL_GAP_DP = 4
const val CAL_EDITOR_WHEN_GAP_DP = 8
const val CAL_EDITOR_ACTION_DP = 30
const val CAL_EDITOR_ACTION_RADIUS_DP = 8
const val CAL_EDITOR_ACTION_PAD_DP = 10
const val CAL_EDITOR_ACTION_SP = 12
const val CAL_EDITOR_ACTION_ICON_DP = 13
const val CAL_EDITOR_ACTION_GAP_DP = 8
const val CAL_EDITOR_SCRIM = 0x48000000
const val CAL_EDITOR_TITLE = "Neuer Termin"
const val CAL_EDITOR_CALENDAR = "Kalender"
const val CAL_EDITOR_ALL_DAY = "Ganztägig"
const val CAL_EDITOR_START = "Beginn"
const val CAL_EDITOR_END = "Ende"
const val CAL_EDITOR_REPEAT = "Wiederholen"
const val CAL_EDITOR_UNTIL = "Bis"
const val CAL_EDITOR_LOCATION = "Ort"
const val CAL_EDITOR_NOTES = "Notizen"
const val CAL_EDITOR_NOTE = "Notizpfad"
const val CAL_EDITOR_NOTE_HINT = "Schule/Mathe.md"
const val CAL_EDITOR_SAVE = "Speichern"
const val CAL_EDITOR_CANCEL = "Abbrechen"
const val CAL_EDITOR_DUPLICATE = "Duplizieren"
const val CAL_EDITOR_OPEN_NOTE = "Notiz öffnen"
const val CAL_EDITOR_DELETE_ONE = "Nur diesen löschen"
const val CAL_EDITOR_DELETE_SERIES = "Serie löschen"
const val CAL_EDITOR_DATE_ERROR = "Beginn oder Ende ist kein Datum."
const val CAL_EDITOR_DETACH = "Dieser Termin wird aus der Serie gelöst."

val CAL_EDITOR_REPEATS = listOf(
    "none" to "Nie",
    "daily" to "Täglich",
    "weekly" to "Wöchentlich",
    "monthly" to "Monatlich",
    "yearly" to "Jährlich",
)

fun calEditorWidthDp(windowWidthDp: Int): Int = min(CAL_EDITOR_MAX_DP, (windowWidthDp - CAL_EDITOR_INSET_DP * 2).coerceAtLeast(0))

fun calEditorRepeatLabel(id: String): String = CAL_EDITOR_REPEATS.firstOrNull { it.first == id }?.second ?: "Nie"

data class CalEditorShadow(val yDp: Int, val blurDp: Int, val alpha: Float)

/** Theme `--shadow` on the Termin card. */
fun calEditorShadow(dark: Boolean): CalEditorShadow = if (dark) {
    CalEditorShadow(16, 48, 0.32f)
} else {
    CalEditorShadow(12, 40, 0.08f)
}
