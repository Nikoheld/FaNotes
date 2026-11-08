package ch.fasrv.fanotes.schulnetz

import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZonedDateTime

/*
 * When a school notice is still worth sending, and when a timetable week really counts as read.
 * Mirrored in fanotes-site/schulnetz-logic.mjs; keep both in step.
 */

val SCHOOL_ZONE: ZoneId = ZoneId.of("Europe/Zurich")

/** Notices about a dated lesson, exam or appointment. Messages carry no date and never expire. */
private val DATED_CATEGORIES = setOf("exam", "timetable", "event")

private val CLOCK_RANGE = Regex("""\b(\d{1,2}):(\d{2})\s*[–-]\s*(\d{1,2}):(\d{2})\b""")

/** The day a notice is about, from its date field or, for lessons and exams, the leading DD.MM.YYYY. */
fun changeDay(change: SchulnetzChange): LocalDate? =
    eventDate(change.date) ?: if (change.category == "exam" || change.category == "timetable") eventDate(change.body.take(12)) else null

/**
 * True when the lesson, exam or appointment a notice is about has already ended: an earlier day,
 * or today after its end time. Such a notice ("Neue Prüfung" for last week) is noise.
 * Grades, absences, messages, deadlines and delivery tests are never treated as over.
 */
fun changeIsOver(change: SchulnetzChange, now: ZonedDateTime = ZonedDateTime.now(SCHOOL_ZONE)): Boolean {
    if (change.category !in DATED_CATEGORIES || isNotificationProbe(change.id)) return false
    val day = changeDay(change) ?: return false
    val today = now.withZoneSameInstant(SCHOOL_ZONE).toLocalDate()
    if (day.isBefore(today)) return true
    if (day.isAfter(today)) return false
    val range = CLOCK_RANGE.find(change.body) ?: return false
    val end = runCatching { LocalTime.of(range.groupValues[3].toInt(), range.groupValues[4].toInt()) }.getOrNull() ?: return false
    return now.withZoneSameInstant(SCHOOL_ZONE).toLocalTime().isAfter(end)
}

/** More new appointments than this in one read is the list growing, not news. */
const val APPOINTMENT_BURST = 8

/** Last day the previous appointment list reached. Appointments after it are newly visible, not new. */
fun appointmentHorizon(previous: SchulnetzSnapshot): LocalDate? =
    previous.events.asSequence().filter { !it.isLesson() && !it.isExamLike() }.mapNotNull { eventDate(eventDay(it)) }.maxOrNull()

private fun vacationDays(vacations: List<SchoolVacation>): List<ClosedRange<LocalDate>> = vacations.mapNotNull { v ->
    val start = eventDate(v.start) ?: return@mapNotNull null
    val end = eventDate(v.end) ?: start
    if (end.isBefore(start)) null else start..end
}

/** A school week that lies inside a known holiday (at least its Monday to Friday). */
fun weekIsHoliday(monday: LocalDate, vacations: List<SchoolVacation>): Boolean {
    val ranges = vacationDays(vacations)
    return (0L..4L).all { offset -> val day = monday.plusDays(offset); ranges.any { day in it } }
}

/**
 * An empty but well-formed scheduler answer only proves a free week when the scheduler returned
 * lessons for another week in the same read, or the week is a holiday. Otherwise it may simply be
 * a scheduler that answers nothing, and the week must stay "not loaded" instead of looking free.
 */
fun emptyWeekCountsAsRead(monday: LocalDate, schedulerProven: Boolean, vacations: List<SchoolVacation>): Boolean =
    schedulerProven || weekIsHoliday(monday, vacations)

/** Drops "read" stamps that only came from empty answers of an unproven scheduler. */
fun withoutUnprovenEmptyReads(reads: Map<String, String>, events: List<AgendaEvent>, vacations: List<SchoolVacation>): Map<String, String> {
    val taught = events.asSequence().filter { it.isLesson() }.mapNotNull { weekMondayKey(it.start) }.toSet()
    return reads.filterKeys { key ->
        key in taught || runCatching { weekIsHoliday(LocalDate.parse(key), vacations) }.getOrDefault(false)
    }
}

/**
 * The school year when the timetable page shows no date range: from the appointment list and
 * holidays: four weeks back, at least four and at most forty weeks ahead.
 */
fun fallbackSchoolSpan(events: List<AgendaEvent>, vacations: List<SchoolVacation>, today: LocalDate): WeekSpan? {
    val days = events.asSequence().filter { !it.isLesson() }.mapNotNull { eventDate(eventDay(it)) } +
        vacationDays(vacations).asSequence().flatMap { sequenceOf(it.start, it.endInclusive) }
    val all = days.toList()
    if (all.isEmpty()) return null
    // Never narrower than the four-week probe around today.
    return WeekSpan(today.minusWeeks(4), maxOf(today.plusWeeks(4), minOf(all.max(), today.plusWeeks(40))))
}
