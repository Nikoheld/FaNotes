package ch.fasrv.fanotes.schulnetz

import java.time.Instant
import java.time.LocalDate
import java.time.temporal.ChronoUnit
import kotlin.math.abs

/** Near weeks refresh on the existing sync. Far weeks wait a day, and only one of them per sync. */
const val WEEK_ADJACENT_MS = 30L * 60L * 1000L
const val WEEK_FAR_MS = 24L * 60L * 60L * 1000L
const val WEEK_CAP = 48

/** Future Mondays tried when the page has no start or end. Current week plus this many. */
const val WEEK_PROBE = 4

data class WeekSpan(val start: LocalDate, val end: LocalDate)

data class WeekPlan(val fetch: List<LocalDate>, val fetchIcal: Boolean)

data class EventWindow(val min: LocalDate, val max: LocalDate, val wide: Boolean)

fun weekMonday(day: LocalDate): LocalDate =
    day.with(java.time.temporal.TemporalAdjusters.previousOrSame(java.time.DayOfWeek.MONDAY))

fun eventDate(start: String): LocalDate? {
    val iso = Regex("""(\d{4}-\d{2}-\d{2})""").find(start)?.groupValues?.get(1)
    if (iso != null) return runCatching { LocalDate.parse(iso) }.getOrNull()
    val swiss = Regex("""(\d{1,2})\.(\d{1,2})\.(\d{4})""").find(start) ?: return null
    return runCatching {
        LocalDate.of(swiss.groupValues[3].toInt(), swiss.groupValues[2].toInt(), swiss.groupValues[1].toInt())
    }.getOrNull()
}

fun weekMondayKey(start: String): String? = eventDate(start)?.let { weekMonday(it).toString() }

fun mondaysBetween(start: LocalDate, end: LocalDate): List<LocalDate> {
    if (end.isBefore(start)) return emptyList()
    val last = weekMonday(end)
    val out = mutableListOf<LocalDate>()
    var monday = weekMonday(start)
    while (!monday.isAfter(last) && out.size < 520) {
        out += monday
        monday = monday.plusDays(7)
    }
    return out
}

fun capMondays(mondays: List<LocalDate>, today: LocalDate): List<LocalDate> {
    val unique = mondays.map { weekMonday(it) }.distinct().sorted()
    if (unique.size <= WEEK_CAP) return unique
    val anchor = weekMonday(today)
    return unique.sortedWith(compareBy<LocalDate> { abs(ChronoUnit.DAYS.between(anchor, it)) }.thenBy { it }).take(WEEK_CAP).sorted()
}

/** Current Monday through [WEEK_PROBE] future Mondays. Not a school year. */
fun probeMondays(today: LocalDate): List<LocalDate> {
    val current = weekMonday(today)
    return (0..WEEK_PROBE).map { current.plusWeeks(it.toLong()) }
}

/**
 * Weeks the page actually offers. A missing limit stays null: callers then
 * probe a few future weeks and do not invent a school year.
 */
fun parseWeekSpan(html: String): WeekSpan? {
    val scriptStart = limitDate(html, "start")
    val scriptEnd = limitDate(html, "end")
    if (scriptStart != null && scriptEnd != null && !scriptEnd.isBefore(scriptStart)) return WeekSpan(scriptStart, scriptEnd)
    val min = dataDate(html, "min")
    val max = dataDate(html, "max")
    if (min != null && max != null && !max.isBefore(min)) return WeekSpan(min, max)
    return null
}

fun spanOfEvents(events: List<AgendaEvent>): WeekSpan? {
    val days = events.mapNotNull { eventDate(it.start) }
    if (days.isEmpty()) return null
    return WeekSpan(days.min(), days.max())
}

fun planWeekFetches(
    mondays: List<LocalDate>,
    fetchedAt: Map<String, String>,
    icalFetchedAt: String,
    now: Instant,
    today: LocalDate,
    icalAvailable: Boolean,
): WeekPlan {
    val current = weekMonday(today)
    val probing = mondays.isEmpty()
    val universe = capMondays(if (probing) probeMondays(today) else mondays, today)
    val near = universe.filter { abs(ChronoUnit.DAYS.between(current, it)) / 7 <= 1 }
    val far = universe.filter { abs(ChronoUnit.DAYS.between(current, it)) / 7 > 1 }
    val first = fetchedAt.isEmpty() && icalFetchedAt.isBlank()
    if (first && icalAvailable) return WeekPlan(near, fetchIcal = true)
    if (first) return WeekPlan(universe, fetchIcal = false)
    val due = mutableListOf<LocalDate>()
    for (monday in near) {
        if (monday == current || stampAge(fetchedAt[monday.toString()], now) >= WEEK_ADJACENT_MS) due += monday
    }
    val icalDue = icalAvailable && stampAge(icalFetchedAt, now) >= WEEK_FAR_MS
    if (icalDue) return WeekPlan(due, fetchIcal = true)
    val farDue = far.filter { stampAge(fetchedAt[it.toString()], now) >= WEEK_FAR_MS }
        .sortedBy { fetchedAt[it.toString()].orEmpty() }
    if (probing) {
        val missing = far.filter { fetchedAt[it.toString()].isNullOrBlank() }
        if (missing.isNotEmpty()) due += missing else if (farDue.isNotEmpty()) due += farDue.first()
    } else if (farDue.isNotEmpty()) {
        due += farDue.first()
    }
    return WeekPlan(due, fetchIcal = false)
}

fun eventQueryWindow(
    spanStart: String,
    spanEnd: String,
    weekFetched: Map<String, String>,
    icalFetchedAt: String,
    today: LocalDate,
    now: Instant,
): EventWindow {
    val nearMin = today.minusDays(7)
    val nearMax = today.plusDays(21)
    val start = runCatching { LocalDate.parse(spanStart) }.getOrNull()
    val end = runCatching { LocalDate.parse(spanEnd) }.getOrNull()
    if (start == null || end == null || end.isBefore(start)) return EventWindow(nearMin, nearMax, wide = false)
    val current = weekMonday(today)
    val far = mondaysBetween(start, end).filter { abs(ChronoUnit.DAYS.between(current, it)) / 7 > 1 }
    val icalFresh = icalFetchedAt.isNotBlank() && stampAge(icalFetchedAt, now) < WEEK_FAR_MS
    val missingFar = far.any { it.toString() !in weekFetched }
    val staleFar = far.any { monday ->
        val stamp = weekFetched[monday.toString()] ?: return@any false
        stampAge(stamp, now) >= WEEK_FAR_MS
    }
    val wide = missingFar || (staleFar && !icalFresh)
    return if (wide) EventWindow(start, end, wide = true) else EventWindow(nearMin, nearMax, wide = false)
}

/** Weeks present on the new snapshot that the previous one had never stored. Empty when the snapshot has no week stamps, so older diffs stay unchanged. */
fun introducedWeeks(previous: SchulnetzSnapshot, next: SchulnetzSnapshot): Set<String> {
    if (next.weekFetched.isEmpty()) return emptySet()
    val known = if (previous.weekFetched.isNotEmpty()) {
        previous.weekFetched.keys
    } else {
        (previous.events + previous.exams).mapNotNull { weekMondayKey(it.start) }.toSet()
    }
    return next.weekFetched.keys - known
}

/** Replace lessons in refreshed weeks. Appointments in those weeks stay, and every other week stays. */
fun overlayLessons(previous: List<AgendaEvent>, incoming: List<AgendaEvent>, refreshed: Set<String>): List<AgendaEvent> {
    if (refreshed.isEmpty()) return previous
    val kept = previous.filter { event ->
        val monday = weekMondayKey(event.start)
        monday !in refreshed || (!event.isLesson() && !event.isExamLike())
    }
    val added = incoming.filter { event -> event.isLesson() && weekMondayKey(event.start) in refreshed }
    return kept + added
}

fun overlayDated(previous: List<AgendaEvent>, incoming: List<AgendaEvent>, refreshed: Set<String>): List<AgendaEvent> {
    if (refreshed.isEmpty()) return previous
    val kept = previous.filter { weekMondayKey(it.start) !in refreshed }
    val added = incoming.filter { weekMondayKey(it.start) in refreshed }
    return kept + added
}

fun applyEventWindow(previous: List<AgendaEvent>, incoming: List<AgendaEvent>, minDay: String, maxDay: String): List<AgendaEvent> {
    val min = runCatching { LocalDate.parse(minDay) }.getOrNull() ?: return previous
    val max = runCatching { LocalDate.parse(maxDay) }.getOrNull() ?: return previous
    fun inside(event: AgendaEvent): Boolean {
        val day = eventDate(event.start) ?: return false
        return !day.isBefore(min) && !day.isAfter(max)
    }
    return previous.filterNot(::inside) + incoming.filter(::inside)
}

fun stampWeeks(previous: Map<String, String>, minDay: String, maxDay: String, nowIso: String): Map<String, String> {
    val min = runCatching { LocalDate.parse(minDay) }.getOrNull() ?: return previous
    val max = runCatching { LocalDate.parse(maxDay) }.getOrNull() ?: return previous
    val out = previous.toMutableMap()
    for (monday in mondaysBetween(min, max)) out[monday.toString()] = nowIso
    return out
}

fun mergeById(base: List<AgendaEvent>, incoming: List<AgendaEvent>): List<AgendaEvent> {
    if (incoming.isEmpty()) return base
    val incomingById = incoming.associateBy { it.id }
    val seen = mutableSetOf<String>()
    val out = mutableListOf<AgendaEvent>()
    for (event in base) {
        if (!seen.add(event.id)) continue
        out += incomingById[event.id] ?: event
    }
    for (event in incoming) if (seen.add(event.id)) out += event
    return out
}

fun schedulerBodyUsable(body: String): Boolean {
    val trimmed = body.trim()
    return trimmed.isNotEmpty() && (trimmed.contains("<data") || trimmed.contains("<event"))
}

/** An empty `<data></data>` body is readable but not a timetable. It must not wipe the week. */
fun schedulerWeekLoaded(body: String): Boolean =
    schedulerBodyUsable(body) && Regex("""(?i)<event""").containsMatchIn(body)

fun icalBodyUsable(body: String): Boolean = body.contains("BEGIN:VCALENDAR")

private fun stampAge(stamp: String?, now: Instant): Long {
    if (stamp.isNullOrBlank()) return Long.MAX_VALUE
    val then = runCatching { Instant.parse(stamp) }.getOrNull() ?: return Long.MAX_VALUE
    return now.toEpochMilli() - then.toEpochMilli()
}

private fun limitDate(html: String, which: String): LocalDate? {
    val constructed = Regex(
        """scheduler\.config\.limit_$which\s*=\s*new\s+Date\(\s*(\d{4})\s*,\s*(\d{1,2})\s*,\s*(\d{1,2})""",
        RegexOption.IGNORE_CASE,
    ).find(html)
    if (constructed != null) {
        val year = constructed.groupValues[1].toIntOrNull() ?: return null
        val month = (constructed.groupValues[2].toIntOrNull() ?: return null) + 1
        val day = constructed.groupValues[3].toIntOrNull() ?: return null
        return runCatching { LocalDate.of(year, month, day) }.getOrNull()
    }
    val iso = Regex("""scheduler\.config\.limit_$which\s*=\s*["'](\d{4}-\d{2}-\d{2})["']""", RegexOption.IGNORE_CASE).find(html)
    return iso?.groupValues?.get(1)?.let { runCatching { LocalDate.parse(it) }.getOrNull() }
}

private fun dataDate(html: String, which: String): LocalDate? {
    val match = Regex("""data-$which-date\s*=\s*["'](\d{4}-\d{2}-\d{2})["']""", RegexOption.IGNORE_CASE).find(html) ?: return null
    return runCatching { LocalDate.parse(match.groupValues[1]) }.getOrNull()
}
