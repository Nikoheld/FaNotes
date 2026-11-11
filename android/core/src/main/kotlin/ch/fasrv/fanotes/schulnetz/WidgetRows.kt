package ch.fasrv.fanotes.schulnetz

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

private val widgetOffsetSuffix = Regex("""[+-]\d{2}:\d{2}$""")

/** One row of the home-screen widget or of the start page strip: a lesson, or the heading of the next school day. */
data class WidgetRow(
    val heading: Boolean,
    val day: LocalDate,
    /** Whether the row belongs to a day after today. */
    val nextDay: Boolean = false,
    val clock: String = "",
    val title: String = "",
    val room: String = "",
    val cancelled: Boolean = false,
    val substitution: Boolean = false,
    val exam: Boolean = false,
    val event: AgendaEvent? = null,
)

/** `HH:mm–HH:mm` of an event, empty without a real time. */
fun lessonClockText(event: AgendaEvent, zone: ZoneId = SCHOOL_ZONE): String {
    val zoned = event.start.contains('Z') || widgetOffsetSuffix.containsMatchIn(event.start)
    if (!zoned) return displayClock(event.start, event.end)
    val fmt = java.time.format.DateTimeFormatter.ofPattern("HH:mm")
    val start = event.startsAt(zone)?.atZone(zone)?.toLocalTime()?.format(fmt).orEmpty()
    val end = event.endsAt(zone)?.atZone(zone)?.toLocalTime()?.format(fmt).orEmpty()
    if (start.isBlank() || (start == "00:00" && (end.isBlank() || end == "00:00"))) return ""
    return if (end.isBlank() || end == start) start else "$start–$end"
}

/** Lessons and exam-slot entries of the schedule after hiding rules, with replaced lessons removed. */
fun mergedScheduleEvents(events: List<AgendaEvent>, exams: List<AgendaEvent>, hidden: List<HiddenLesson>, zone: ZoneId = SCHOOL_ZONE, groupChoices: Map<String, List<String>> = emptyMap()): List<AgendaEvent> {
    val visible = visibleEvents(events, hidden, zone, activeGroupSets(events, groupChoices), groupChoices)
    val visibleExams = visibleEvents(exams, hidden, zone)
    val merge = examsInLessonSlots(visible.filter { it.isLesson() }, visibleExams + visible.filter { it.isExamLike() }, zone)
    return (merge.apply(visible) + merge.exams.map { it.shown }).distinctBy(::slotDedupKey)
}

/**
 * What is left of today (lessons that have not ended, cancelled ones kept with a marker), then a heading
 * and the lessons of the next school day. A day without lessons is skipped, so a weekend rolls to Monday.
 */
fun widgetRows(
    events: List<AgendaEvent>,
    exams: List<AgendaEvent>,
    hidden: List<HiddenLesson>,
    now: Instant,
    zone: ZoneId = SCHOOL_ZONE,
    groupChoices: Map<String, List<String>> = emptyMap(),
): List<WidgetRow> {
    DerivedWorkProbe.hit("widgetRows")
    val merged = mergedScheduleEvents(events, exams, hidden, zone, groupChoices)
    val today = now.atZone(zone).toLocalDate()
    val dated = merged.mapNotNull { event ->
        val start = event.startsAt(zone) ?: return@mapNotNull null
        val end = event.endsAt(zone) ?: return@mapNotNull null
        Triple(start.atZone(zone).toLocalDate(), start, event).takeUnless { end.isBefore(now) }
    }.sortedBy { it.second }
    fun row(day: LocalDate, event: AgendaEvent) = WidgetRow(
        heading = false, day = day, nextDay = day.isAfter(today), clock = lessonClockText(event, zone),
        title = preferredEventTitle(event), room = cleanSchulnetzText(event.room),
        cancelled = event.isCancelled(), substitution = event.isSubstitution(), exam = event.isExamLike(), event = event,
    )
    val todayRows = dated.filter { it.first == today }.map { row(it.first, it.third) }
    val nextDay = dated.map { it.first }.filter { it.isAfter(today) }.minOrNull()
    val nextRows = nextDay?.let { d -> dated.filter { it.first == d }.map { row(d, it.third) } }.orEmpty()
    return todayRows + if (nextDay == null) emptyList() else listOf(WidgetRow(heading = true, day = nextDay, nextDay = true)) + nextRows
}
