package ch.fasrv.fanotes.desk

import java.time.Duration
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.UUID
import kotlin.math.max
import kotlin.math.round

/**
 * Calendar exchange shared with the desktop: iCalendar import and export,
 * homework mirrored onto the Hausaufgaben calendar, and in-app reminders.
 * Ports `icsCalendar.ts`, `homeworkCalendar.ts`, and `calendarReminders.ts`.
 */

private val WALL = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm")
private val STAMP = DateTimeFormatter.ofPattern("yyyyMMdd'T'HHmm'00'")
private val DATE_STAMP = DateTimeFormatter.ofPattern("yyyyMMdd")
private val UID_UNSAFE = Regex("[^\\w.-]")
private val UNTIL_DAY = Regex("""UNTIL=(\d{8})""")
private val FREQ = Regex("""FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)""", RegexOption.IGNORE_CASE)
private const val HOMEWORK_COLOR = "#e15b64"

const val HOMEWORK_CALENDAR_NAME = "Hausaufgaben"

fun homeworkEventId(taskId: String) = "hw:$taskId"

fun isHomeworkEventId(id: String) = id.startsWith("hw:")

data class CalendarReminder(
    val key: String,
    val title: String,
    val startsAt: String,
    val minutesUntil: Int,
)

data class IcsImportResult(
    val document: CalendarDocument,
    val added: Int,
    val updated: Int,
    val removed: Int,
)

fun importIcs(ics: String, calendarId: String): List<CalendarEvent> = importIcs(ics, calendarId, ZoneId.systemDefault())

internal fun importIcs(ics: String, calendarId: String, zone: ZoneId): List<CalendarEvent> =
    parseIcs(ics, calendarId, zone).events

/** Fold an ICS file into a calendar. The same UID updates in place and keeps its calendar. */
fun applyIcsImport(
    document: CalendarDocument,
    ics: String,
    calendarId: String,
    zone: ZoneId = ZoneId.systemDefault(),
): IcsImportResult {
    val parsed = parseIcs(ics, calendarId, zone)
    val cancelled = parsed.cancelledIds.toSet()
    val incoming = linkedMapOf<String, CalendarEvent>()
    for (event in parsed.events) {
        if (event.id !in cancelled) incoming[event.id] = event
    }
    var removed = 0
    var updated = 0
    val kept = mutableListOf<CalendarEvent>()
    for (event in document.events) {
        if (event.id in cancelled) {
            removed += 1
            continue
        }
        val next = incoming.remove(event.id)
        if (next == null) {
            kept += event
            continue
        }
        updated += 1
        kept += next.copy(
            calendarId = event.calendarId,
            notePath = event.notePath.ifEmpty { next.notePath },
            exceptionDates = (event.exceptionDates + next.exceptionDates).distinct().take(400),
        )
    }
    val room = (2_000 - kept.size).coerceAtLeast(0)
    val added = incoming.values.take(room)
    return IcsImportResult(
        document = document.copy(events = kept + added),
        added = added.size,
        updated = updated,
        removed = removed,
    )
}

private data class ParsedIcs(val events: List<CalendarEvent>, val cancelledIds: List<String>)

private fun parseIcs(ics: String, calendarId: String, zone: ZoneId): ParsedIcs {
    val events = mutableListOf<CalendarEvent>()
    val cancelledIds = mutableListOf<String>()
    for (lines in splitEvents(ics)) {
        val uid = field(lines, "UID").replace(UID_UNSAFE, "").take(80)
        if (field(lines, "STATUS").trim().equals("CANCELLED", ignoreCase = true)) {
            if (uid.isNotEmpty()) cancelledIds += uid
            continue
        }
        val summary = field(lines, "SUMMARY").trim().take(240)
        val startRaw = lines.find { it.startsWith("DTSTART") } ?: continue
        if (summary.isEmpty()) continue
        val start = parseIcsDate(startRaw.substring(startRaw.indexOf(':') + 1), zone) ?: continue
        val endRaw = lines.find { it.startsWith("DTEND") }
        val end = endRaw?.let { parseIcsDate(it.substring(it.indexOf(':') + 1), zone) }
        val durationEnd = if (end == null) applyDuration(start.moment, start.allDay, field(lines, "DURATION")) else null
        val rule = field(lines, "RRULE")
        val untilRaw = UNTIL_DAY.find(rule)
        val until = untilRaw?.groupValues?.get(1)?.let { raw ->
            "${raw.substring(0, 4)}-${raw.substring(4, 6)}-${raw.substring(6, 8)}"
        }
        val recurrence = recurrenceFromRule(rule)
        val exceptions = if (recurrence == "none") emptyList() else exceptionDatesFrom(lines, zone)
        val built = eventFromRange(
            calendarId = calendarId,
            title = summary,
            start = start.moment,
            end = end?.moment ?: durationEnd ?: start.moment.plusDays(if (start.allDay) 1 else 0),
            allDay = start.allDay,
            location = field(lines, "LOCATION"),
            notes = field(lines, "DESCRIPTION"),
        )
        events += built.copy(
            id = uid.ifEmpty { built.id },
            recurrence = recurrence,
            recurrenceUntil = if (recurrence == "none") null else until,
            exceptionDates = exceptions,
        )
    }
    return ParsedIcs(events.take(2_000), cancelledIds)
}

fun exportIcs(document: CalendarDocument, calendarId: String? = null): String {
    val events = document.events.filter { calendarId == null || it.calendarId == calendarId }
    val body = events.mapNotNull { event -> eventToIcs(event) }
    return (listOf("BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//FaNotes//Calendar//DE") + body + listOf("END:VCALENDAR", "")).joinToString("\n")
}

fun icsFileName(name: String): String {
    val cleaned = name.replace(Regex("""[^\p{L}\p{N}._-]+"""), "-").replace(Regex("""^-+|-+$"""), "").take(60)
    return "${cleaned.ifEmpty { "kalender" }}.ics"
}

/** Due homework becomes events on the Hausaufgaben calendar. Done tasks stay, marked with a check. */
fun applyHomeworkToCalendar(calendar: CalendarDocument, homework: HomeworkDocument): CalendarDocument {
    val hasDueTask = homework.tasks.any { !it.dueDate.isNullOrBlank() }
    val alreadyThere = calendar.calendars.any { it.name == HOMEWORK_CALENDAR_NAME } || calendar.events.any { isHomeworkEventId(it.id) }
    if (!hasDueTask && !alreadyThere) return calendar
    val withCalendar = ensureHomeworkCalendar(calendar)
    val calendarId = withCalendar.calendars.find { it.name == HOMEWORK_CALENDAR_NAME }?.id ?: return withCalendar
    val wanted = linkedMapOf<String, CalendarEvent>()
    for (task in homework.tasks) {
        val event = eventForTask(calendarId, task) ?: continue
        wanted[event.id] = event
    }
    val kept = withCalendar.events.filter { event -> !isHomeworkEventId(event.id) || wanted.containsKey(event.id) }
    var next = withCalendar.copy(events = kept)
    for (event in wanted.values) next = upsertEvent(next, event)
    return next
}

/** Events that start within the lead window while the app is open. */
fun dueReminders(document: CalendarDocument, now: ZonedDateTime, leadMinutes: Int = 15): List<CalendarReminder> {
    val from = now.minusSeconds(60)
    val to = now.plusMinutes(leadMinutes.toLong())
    val hidden = document.calendars.filter { !it.visible }.map { it.id }.toSet()
    return expandOccurrences(document, from, to)
        .filter { it.event.calendarId !in hidden }
        .filter { !it.event.title.startsWith("✓ ") }
        .filter { !it.start.isBefore(from) && !it.start.isAfter(to) }
        .map { occurrence ->
            val minutes = Duration.between(now, occurrence.start).toMillis() / 60_000.0
            CalendarReminder(
                key = occurrence.key,
                title = occurrence.event.title,
                startsAt = occurrence.start.toInstant().toString(),
                minutesUntil = max(0, round(minutes).toInt()),
            )
        }
}

private data class IcsMoment(val moment: LocalDateTime, val allDay: Boolean)

private data class Occurrence(val event: CalendarEvent, val start: ZonedDateTime, val end: ZonedDateTime, val key: String)

private fun eventForTask(calendarId: String, task: HomeworkTask): CalendarEvent? {
    val day = task.dueDate?.let { runCatching { LocalDate.parse(it) }.getOrNull() } ?: return null
    val title = if (task.done) "✓ ${task.title}" else task.title
    val dueTime = task.dueTime
    if (dueTime != null) {
        val parts = dueTime.split(':')
        val hours = parts.getOrNull(0)?.toLongOrNull() ?: 0L
        val minutes = parts.getOrNull(1)?.toLongOrNull() ?: 0L
        val start = day.atStartOfDay().plusHours(hours).plusMinutes(minutes)
        return eventFromRange(
            calendarId = calendarId,
            title = title,
            start = start,
            end = start.plusMinutes(45),
            allDay = false,
            notes = task.notes,
            notePath = HOMEWORK_NOTE_PATH,
        ).copy(id = homeworkEventId(task.id))
    }
    val start = day.atStartOfDay()
    return eventFromRange(
        calendarId = calendarId,
        title = title,
        start = start,
        end = start.plusDays(1),
        allDay = true,
        notes = task.notes,
        notePath = HOMEWORK_NOTE_PATH,
    ).copy(id = homeworkEventId(task.id))
}

private fun ensureHomeworkCalendar(document: CalendarDocument): CalendarDocument {
    if (document.calendars.any { it.name == HOMEWORK_CALENDAR_NAME }) return document
    return document.copy(
        calendars = document.calendars + CalendarDef("homework", HOMEWORK_CALENDAR_NAME, HOMEWORK_COLOR, visible = true),
    )
}

private fun upsertEvent(document: CalendarDocument, event: CalendarEvent): CalendarDocument {
    val exists = document.events.any { it.id == event.id }
    val events = if (exists) document.events.map { if (it.id == event.id) event else it } else document.events + event
    return document.copy(events = events)
}

private fun eventFromRange(
    calendarId: String,
    title: String,
    start: LocalDateTime,
    end: LocalDateTime,
    allDay: Boolean,
    location: String = "",
    notes: String = "",
    notePath: String = "",
): CalendarEvent {
    val endMoment = if (end.isAfter(start)) end else if (allDay) start.plusHours(24) else start.plusMinutes(30)
    val startText = if (allDay) start.toLocalDate().toString() else start.format(WALL)
    val endText = if (allDay) endMoment.toLocalDate().minusDays(1).toString() else endMoment.format(WALL)
    return CalendarEvent(
        id = UUID.randomUUID().toString(),
        calendarId = calendarId,
        title = title.ifBlank { "Neuer Termin" },
        start = startText,
        end = endText,
        allDay = allDay,
        location = location,
        notes = notes,
        notePath = notePath,
    )
}

private fun eventToIcs(event: CalendarEvent): String? {
    val start = storedMoment(event.start, event.allDay) ?: return null
    val end = storedMoment(event.end, event.allDay) ?: return null
    val endOut = if (event.allDay) end.plusDays(1) else end
    val dtStart = if (event.allDay) "DTSTART;VALUE=DATE:${endDate(start)}" else "DTSTART:${start.format(STAMP)}"
    val dtEnd = if (event.allDay) "DTEND;VALUE=DATE:${endDate(endOut)}" else "DTEND:${endOut.format(STAMP)}"
    val rule = ruleFor(event)
    return listOf(
        "BEGIN:VEVENT",
        "UID:${event.id}@fanotes",
        "SUMMARY:${icsEscape(event.title)}",
        dtStart,
        dtEnd,
        event.location.takeIf { it.isNotEmpty() }?.let { "LOCATION:${icsEscape(it)}" },
        event.notes.takeIf { it.isNotEmpty() }?.let { "DESCRIPTION:${icsEscape(it)}" },
        rule.takeIf { it.isNotEmpty() },
        event.exceptionDates.takeIf { event.recurrence != "none" && it.isNotEmpty() }
            ?.let { "EXDATE;VALUE=DATE:${it.joinToString(",") { day -> day.replace("-", "") }}" },
        "END:VEVENT",
    ).filterNotNull().joinToString("\n")
}

private fun storedMoment(value: String, allDay: Boolean): LocalDateTime? {
    if (allDay || Regex("""^\d{4}-\d{2}-\d{2}$""").matches(value.take(10)) && value.length == 10) {
        return runCatching { LocalDate.parse(value.take(10)).atStartOfDay() }.getOrNull()
    }
    return runCatching { LocalDateTime.parse(value.take(16), WALL) }.getOrNull()
}

private fun endDate(moment: LocalDateTime) = moment.format(DATE_STAMP)

private fun ruleFor(event: CalendarEvent): String {
    if (event.recurrence == "none") return ""
    val until = event.recurrenceUntil?.let { ";UNTIL=${it.replace("-", "")}" }.orEmpty()
    return "RRULE:FREQ=${event.recurrence.uppercase()}$until"
}

private fun exceptionDatesFrom(lines: List<String>, zone: ZoneId): List<String> {
    val dates = linkedSetOf<String>()
    for (line in lines) {
        if (!line.startsWith("EXDATE")) continue
        val colon = line.indexOf(':')
        if (colon < 0) continue
        val dateOnly = line.substring(0, colon).contains("VALUE=DATE", ignoreCase = true)
        for (part in line.substring(colon + 1).split(',')) {
            val raw = part.trim()
            if (raw.isEmpty()) continue
            if (dateOnly || Regex("""^\d{8}$""").matches(raw)) {
                val day = Regex("""^(\d{4})(\d{2})(\d{2})$""").find(raw) ?: continue
                val date = runCatching {
                    LocalDate.of(day.groupValues[1].toInt(), day.groupValues[2].toInt(), day.groupValues[3].toInt())
                }.getOrNull() ?: continue
                dates += date.toString()
                continue
            }
            val parsed = parseIcsDate(raw, zone) ?: continue
            dates += parsed.moment.toLocalDate().toString()
        }
    }
    return dates.take(400)
}

private fun recurrenceFromRule(rule: String): String {
    val freq = FREQ.find(rule)?.groupValues?.get(1)?.lowercase()
    return if (freq == "daily" || freq == "weekly" || freq == "monthly" || freq == "yearly") freq else "none"
}

private val DURATION_RE = Regex(
    """^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$""",
    RegexOption.IGNORE_CASE,
)

private fun applyDuration(start: LocalDateTime, allDay: Boolean, raw: String): LocalDateTime? {
    val match = DURATION_RE.matchEntire(raw.trim()) ?: return null
    val sign = if (match.groupValues[1] == "-") -1L else 1L
    val weeks = match.groupValues[2].toLongOrNull() ?: 0L
    val days = match.groupValues[3].toLongOrNull() ?: 0L
    val hours = match.groupValues[4].toLongOrNull() ?: 0L
    val minutes = match.groupValues[5].toLongOrNull() ?: 0L
    val seconds = match.groupValues[6].toLongOrNull() ?: 0L
    if (weeks == 0L && days == 0L && hours == 0L && minutes == 0L && seconds == 0L) return null
    if (allDay && hours == 0L && minutes == 0L && seconds == 0L) return start.plusDays(sign * (weeks * 7 + days))
    return start
        .plusDays(sign * (weeks * 7 + days))
        .plusHours(sign * hours)
        .plusMinutes(sign * minutes)
        .plusSeconds(sign * seconds)
}

private fun parseIcsDate(raw: String, zone: ZoneId): IcsMoment? {
    val value = raw.trim()
    val day = Regex("""^(\d{4})(\d{2})(\d{2})$""").find(value)
    if (day != null) {
        val date = runCatching {
            LocalDate.of(day.groupValues[1].toInt(), day.groupValues[2].toInt(), day.groupValues[3].toInt())
        }.getOrNull() ?: return null
        return IcsMoment(date.atStartOfDay(), true)
    }
    val timed = Regex(
        """^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(?:(\d{2})(?:\.\d+)?)?(Z|[+-]\d{4})?$""",
        RegexOption.IGNORE_CASE,
    ).find(value) ?: return null
    val year = timed.groupValues[1].toInt()
    val month = timed.groupValues[2].toInt()
    val dayOfMonth = timed.groupValues[3].toInt()
    val hour = timed.groupValues[4].toInt()
    val minute = timed.groupValues[5].toInt()
    val second = timed.groupValues[6].toIntOrNull() ?: 0
    val zoneText = timed.groupValues[7]
    val moment = runCatching {
        when {
            zoneText.equals("Z", ignoreCase = true) -> {
                ZonedDateTime.of(year, month, dayOfMonth, hour, minute, second, 0, ZoneOffset.UTC)
                    .withZoneSameInstant(zone)
                    .toLocalDateTime()
            }
            zoneText.isNotEmpty() -> {
                val sign = if (zoneText.startsWith("-")) -1 else 1
                val offsetHours = zoneText.substring(1, 3).toInt()
                val offsetMinutes = zoneText.substring(3, 5).toInt()
                if (offsetHours > 23 || offsetMinutes > 59) return null
                LocalDateTime.of(year, month, dayOfMonth, hour, minute, second)
                    .atOffset(ZoneOffset.ofHoursMinutes(sign * offsetHours, sign * offsetMinutes))
                    .atZoneSameInstant(zone)
                    .toLocalDateTime()
            }
            else -> LocalDateTime.of(year, month, dayOfMonth, hour, minute, second)
        }
    }.getOrNull() ?: return null
    return IcsMoment(moment, false)
}

private fun splitEvents(text: String): List<List<String>> {
    val blocks = mutableListOf<List<String>>()
    var current: MutableList<String>? = null
    for (line in unfold(text).split('\n')) {
        when (line) {
            "BEGIN:VEVENT" -> current = mutableListOf()
            "END:VEVENT" -> {
                current?.let { blocks += it }
                current = null
            }
            else -> current?.add(line)
        }
    }
    return blocks
}

private fun field(lines: List<String>, name: String): String {
    val line = lines.find { it.startsWith("$name:") || it.startsWith("$name;") } ?: return ""
    val index = line.indexOf(':')
    return if (index >= 0) icsUnescape(line.substring(index + 1)) else ""
}

private fun unfold(value: String) = value.replace("\r\n", "\n").replace(Regex("""\n[ \t]"""), "")

private fun icsEscape(value: String) = value
    .replace("\\", "\\\\")
    .replace("\n", "\\n")
    .replace(",", "\\,")
    .replace(";", "\\;")

private fun icsUnescape(value: String): String {
    val out = StringBuilder()
    var index = 0
    while (index < value.length) {
        if (value[index] == '\\' && index + 1 < value.length) {
            when (val next = value[index + 1]) {
                'n', 'N' -> out.append('\n')
                else -> out.append(next)
            }
            index += 2
        } else {
            out.append(value[index])
            index += 1
        }
    }
    return out.toString()
}

private fun expandOccurrences(document: CalendarDocument, rangeStart: ZonedDateTime, rangeEnd: ZonedDateTime): List<Occurrence> {
    val visible = document.calendars.filter { it.visible }.map { it.id }.toSet()
    val zone = rangeStart.zone
    val occurrences = mutableListOf<Occurrence>()
    for (event in document.events) {
        if (event.calendarId !in visible) continue
        val bounds = eventBounds(event, zone) ?: continue
        val duration = Duration.between(bounds.first, bounds.second)
        if (!duration.isPositive) continue
        val until = event.recurrenceUntil?.let { runCatching { LocalDate.parse(it) }.getOrNull() }
        val untilEnd = until?.plusDays(1)?.atStartOfDay(zone)
        val skipped = event.exceptionDates.toSet()
        var step = 0
        var cursor = bounds.first
        var guard = 0
        while (cursor.isBefore(rangeEnd) && guard < 500) {
            if (untilEnd != null && !cursor.isBefore(untilEnd)) break
            val end = cursor.plus(duration)
            val dayKey = cursor.toLocalDate().toString()
            if (dayKey !in skipped && end.isAfter(rangeStart) && cursor.isBefore(rangeEnd)) {
                occurrences += Occurrence(event, cursor, end, "${event.id}@$dayKey")
            }
            if (event.recurrence == "none") break
            step += 1
            val next = nextInstance(bounds.first, step, event.recurrence)
            if (!next.isAfter(cursor)) break
            cursor = next
            guard += 1
        }
    }
    return occurrences.sortedWith(compareBy<Occurrence> { it.start.toInstant() }.thenBy { it.event.title })
}

private fun eventBounds(event: CalendarEvent, zone: ZoneId): Pair<ZonedDateTime, ZonedDateTime>? {
    if (event.allDay) {
        val startDate = runCatching { LocalDate.parse(event.start.take(10)) }.getOrNull() ?: return null
        val inclusive = runCatching { LocalDate.parse(event.end.take(10)) }.getOrNull() ?: startDate
        return startDate.atStartOfDay(zone) to inclusive.plusDays(1).atStartOfDay(zone)
    }
    val start = storedMoment(event.start, false)?.atZone(zone) ?: return null
    val parsedEnd = storedMoment(event.end, false)?.atZone(zone)
    val end = if (parsedEnd == null || !parsedEnd.isAfter(start)) start.plusMinutes(30) else parsedEnd
    return start to end
}

private fun nextInstance(origin: ZonedDateTime, step: Int, recurrence: String): ZonedDateTime {
    val local = calendarInstanceStart(origin.toLocalDateTime(), step, recurrence)
    return ZonedDateTime.ofLocal(local, origin.zone, origin.offset)
}
