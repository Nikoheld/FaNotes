package ch.fasrv.fanotes.schulnetz

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.escapeJson
import ch.fasrv.fanotes.json.parseJson
import java.time.LocalDate

private val plannedClock = Regex("""^\s*([01]?\d|2[0-3]):([0-5]\d)""")

/*
 * Planned (provisional) absences. The student marks lessons in the timetable in advance. They live
 * only on the device and in the user's own vault sync, like hidden lessons, and are never sent to
 * Schulnetz. They only feed the provisional points on the Absenzen screen.
 */

data class PlannedAbsence(
    val id: String,
    /** YYYY-MM-DD. */
    val date: String,
    /** HH:MM. */
    val start: String,
    /** HH:MM. */
    val end: String,
    val subject: String,
    /** The timetable lesson it was marked on; empty when unknown. */
    val lessonId: String = "",
    val createdAt: Long = 0L,
)

enum class PlannedState {
    /** A real open report or booked entry covers it; the real absence counts, not the plan. */
    Matched,

    /** Today or later, no real absence yet: counted in the provisional points. */
    Upcoming,

    /** In the past and no real absence: it was never entered. Not counted; the user can remove it. */
    NotEntered,
}

data class PlannedItem(val absence: PlannedAbsence, val state: PlannedState)

data class ProvisionalTally(
    /** Real absences plus the upcoming planned ones, tallied with the usual rules. */
    val tally: AbsenceTally,
    /** The tally of the real absences alone. */
    val current: AbsenceTally,
    val items: List<PlannedItem>,
) {
    /** Points the planned absences add on top of the current estimate. */
    val plannedPoints: Int get() = tally.estimated - current.estimated
    val upcoming: List<PlannedItem> get() = items.filter { it.state == PlannedState.Upcoming }
    val notEntered: List<PlannedItem> get() = items.filter { it.state == PlannedState.NotEntered }

    /** Estimated points of the block an upcoming planned item belongs to, or null. */
    fun blockPoints(item: PlannedAbsence): Int? = tally.estimates[plannedAbsenceRowId(item)]?.points
}

fun plannedAbsenceRowId(absence: PlannedAbsence): String = "planned:${absence.id}"

private fun plannedDate(raw: String): LocalDate? = runCatching { LocalDate.parse(raw.trim()) }.getOrNull()

private fun plannedMinutes(clock: String): Int? =
    plannedClock.find(clock)?.let { it.groupValues[1].toInt() * 60 + it.groupValues[2].toInt() }

/**
 * Classifies each planned absence against the real ones. A pending or booked absence matches when it
 * covers the same date and the times overlap. Rows without times match by date.
 */
fun matchPlanned(planned: List<PlannedAbsence>, snapshot: SchulnetzSnapshot, today: LocalDate = LocalDate.now()): List<PlannedItem> {
    val real = snapshot.absences.filter { it.pending || it.points != null }
    return planned.map { item ->
        val day = plannedDate(item.date)
        val from = plannedMinutes(item.start)
        val to = plannedMinutes(item.end)
        val matched = day != null && real.any { entry ->
            val first = eventDate(entry.dateFrom) ?: return@any false
            val last = eventDate(entry.dateTo)?.takeIf { !it.isBefore(first) } ?: first
            if (day.isBefore(first) || day.isAfter(last)) return@any false
            val eFrom = plannedMinutes(entry.hourFrom)
            val eTo = plannedMinutes(entry.hourTo)
            if (first == last && eFrom != null && eTo != null && eTo > eFrom && from != null && to != null && to > from) eFrom < to && from < eTo else true
        }
        val state = when {
            matched -> PlannedState.Matched
            day != null && !day.isBefore(today) -> PlannedState.Upcoming
            else -> PlannedState.NotEntered
        }
        PlannedItem(item, state)
    }
}

/** The points the student would have with the planned absences entered as open reports. */
fun provisionalTally(snapshot: SchulnetzSnapshot, planned: List<PlannedAbsence>, today: LocalDate = LocalDate.now()): ProvisionalTally {
    val items = matchPlanned(planned, snapshot, today)
    val rows = items.filter { it.state == PlannedState.Upcoming }.map { (item, _) ->
        SchoolAbsence(
            id = plannedAbsenceRowId(item),
            dateFrom = item.date,
            dateTo = item.date,
            hourFrom = item.start,
            hourTo = item.end,
            subject = item.subject,
            reason = "",
            excused = false,
            acknowledged = false,
            status = "geplant",
            pending = true,
        )
    }
    return ProvisionalTally(absenceTally(snapshot.copy(absences = snapshot.absences + rows)), absenceTally(snapshot), items)
}

/** Adds a planned absence for [lesson]; the same lesson is not added twice. */
fun planAbsence(lesson: AgendaEvent, existing: List<PlannedAbsence>, now: Long = System.currentTimeMillis()): List<PlannedAbsence> {
    val day = eventDate(lesson.start) ?: return existing
    val start = schulnetzClock(lesson.start)
    val end = schulnetzClock(lesson.end).ifBlank { start }
    if (start.isBlank()) return existing
    if (existing.any { it.date == day.toString() && it.start == start && it.end == end }) return existing
    val id = stableId("planned", day.toString(), start, lesson.id)
    return existing + PlannedAbsence(id, day.toString(), start, end, preferredEventTitle(lesson), lesson.id, now)
}

/** The planned absence marked on [lesson], if any. */
fun plannedFor(lesson: AgendaEvent, planned: List<PlannedAbsence>): PlannedAbsence? {
    val day = eventDate(lesson.start)?.toString() ?: return null
    val start = schulnetzClock(lesson.start)
    return planned.firstOrNull { (it.lessonId.isNotBlank() && it.lessonId == lesson.id && it.date == day) || (it.date == day && it.start == start) }
}

fun parsePlannedAbsences(json: String): List<PlannedAbsence> {
    val obj = runCatching { parseJson(json) as? JsonValue.Obj }.getOrNull() ?: return emptyList()
    return obj.array("items")?.items.orEmpty().mapNotNull { item ->
        val row = item as? JsonValue.Obj ?: return@mapNotNull null
        val id = row.string("id").orEmpty()
        val date = row.string("date").orEmpty()
        if (id.isBlank() || plannedDate(date) == null) return@mapNotNull null
        PlannedAbsence(
            id = id,
            date = date,
            start = row.string("start").orEmpty(),
            end = row.string("end").orEmpty(),
            subject = row.string("subject").orEmpty(),
            lessonId = row.string("lessonId").orEmpty(),
            createdAt = row.double("createdAt")?.toLong() ?: 0L,
        )
    }
}

fun serializePlannedAbsences(items: List<PlannedAbsence>): String = buildString {
    append("{\"items\":[")
    items.forEachIndexed { index, item ->
        if (index > 0) append(',')
        append("{\"id\":").append(escapeJson(item.id))
        append(",\"date\":").append(escapeJson(item.date))
        append(",\"start\":").append(escapeJson(item.start))
        append(",\"end\":").append(escapeJson(item.end))
        append(",\"subject\":").append(escapeJson(item.subject))
        append(",\"lessonId\":").append(escapeJson(item.lessonId))
        append(",\"createdAt\":").append(item.createdAt)
        append('}')
    }
    append("]}")
}
