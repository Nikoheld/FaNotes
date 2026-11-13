package ch.fasrv.fanotes.schulnetz

import ch.fasrv.fanotes.json.*
import java.time.Instant

/** Private, per-week notification state. Fetch coverage and exam coverage are independent. */
data class AgendaRead(val before: SchulnetzSnapshot, val weeks: Map<String, SchulnetzSnapshot>)

fun prepareAgendaRead(stored: Map<String, SchulnetzSnapshot>, next: SchulnetzSnapshot): AgendaRead {
    val weeks = stored.toMutableMap()
    val beforeEvents = mutableListOf<AgendaEvent>()
    val beforeExams = mutableListOf<AgendaEvent>()
    val knownExams = distinctExams(stored.filter { (week, value) -> agendaStamp(value.examWeekFetched[week]) != null }.values.flatMap { it.exams })
    val keys = (stored.keys + next.weekFetched.keys + next.examWeekFetched.keys +
        (next.events + next.exams).mapNotNull { weekMondayKey(eventDay(it)) }).toSet()
    val at = runCatching { Instant.parse(next.fetchedAt) }.getOrNull()
    fun fresh(stamp: String?, old: String?): Boolean {
        if (next.readErrors.any(::agendaReadFailed) || at == null) return false
        val value = runCatching { Instant.parse(stamp) }.getOrNull() ?: return false
        val prior = runCatching { Instant.parse(old) }.getOrNull()
        return !value.isAfter(at) && (prior == null || value.isAfter(prior))
    }
    for (week in keys) {
        if (weekMondayKey(week) != week) continue
        val old = stored[week] ?: SchulnetzSnapshot()
        val events = next.events.filter { !it.isExamLike() && weekMondayKey(eventDay(it)) == week }
        val exams = next.exams.filter { weekMondayKey(eventDay(it)) == week }
        val lessonsFresh = fresh(next.weekFetched[week], old.weekFetched[week])
        val ambiguous = exams.any { event -> exams.any { other -> sameExamId(event, other) && examTimeChanged(event, other) } }
        val partial = ambiguous || (exams.isEmpty() && old.exams.isNotEmpty()) || exams.any { candidate ->
            knownExams.any { sameExamId(it, candidate) && completeExamTime(it) && !completeExamTime(candidate) }
        }
        val examsFresh = !partial && fresh(next.examWeekFetched[week], old.examWeekFetched[week])
        beforeEvents += if (lessonsFresh && agendaStamp(old.weekFetched[week]) != null) old.events else events
        beforeExams += when {
            !examsFresh -> exams
            agendaStamp(old.examWeekFetched[week]) != null -> old.exams
            else -> exams.map { event ->
                // A new destination week can still contain an already-known exam moving across weeks.
                knownExams.filter { sameExamId(it, event) }.singleOrNull() ?: event
            }
        }
        if (lessonsFresh || examsFresh) weeks[week] = old.copy(
            fetchedAt = next.fetchedAt,
            events = if (lessonsFresh) events else old.events,
            exams = if (examsFresh) exams else old.exams,
            weekFetched = if (lessonsFresh) mapOf(week to next.weekFetched.getValue(week)) else old.weekFetched,
            examWeekFetched = if (examsFresh) mapOf(week to next.examWeekFetched.getValue(week)) else old.examWeekFetched,
        )
    }
    // Once an exam moves, its old week must not keep an obsolete identity forever.
    for ((week, record) in weeks.toMap()) {
        val elsewhere = weeks.filterKeys { it != week }.values.flatMap { it.exams }
        val kept = record.exams.filter { event -> elsewhere.none { other ->
            sameExamId(event, other) && eventDay(event) != eventDay(other) &&
                (agendaStamp(weeks[weekMondayKey(eventDay(other))]?.examWeekFetched?.values?.firstOrNull())?.isAfter(
                    agendaStamp(record.examWeekFetched.values.firstOrNull()) ?: Instant.MIN) == true)
        } }
        if (kept.size != record.exams.size) weeks[week] = record.copy(exams = kept)
    }
    return AgendaRead(next.copy(events = beforeEvents.distinctBy { "${it.id}|${it.start}|${it.end}" },
        exams = beforeExams.distinctBy { "${it.id}|${it.start}|${it.end}" }), weeks)
}

fun agendaBaselineJson(weeks: Map<String, SchulnetzSnapshot>): String = jsonObject(
    "version" to jsonNumber(1.0),
    "weeks" to JsonValue.Obj(linkedMapOf<String, JsonValue>().also { out ->
        for ((week, value) in weeks) out[week] = parseJson(value.toNormalizedJson())
    }),
).stringify()

fun parseAgendaBaseline(source: String): Map<String, SchulnetzSnapshot> {
    val root = parseJson(source) as? JsonValue.Obj ?: return emptyMap()
    if (root.double("version") != 1.0) return emptyMap()
    return root.obj("weeks")?.fields.orEmpty().mapNotNull { (week, value) ->
        if (weekMondayKey(week) != week) null else parseNormalizedSnapshot(value.stringify())?.let { week to it }
    }.toMap()
}

private fun agendaReadFailed(error: String): Boolean {
    val session = Regex("inaktivit|ip.adresse|anmeld|login|abgelaufen|microsoft|oauth", RegexOption.IGNORE_CASE)
    val unrelated = Regex("^(Noten|Absenzen|Termine|Mitteilungen|Konto):", RegexOption.IGNORE_CASE)
    return session.containsMatchIn(error) || !unrelated.containsMatchIn(error)
}

private fun agendaStamp(value: String?): Instant? = runCatching { Instant.parse(value) }.getOrNull()

/** Full calendar UIDs and their scheduler local part are one identity, never a subject/day guess. */
internal fun sameExamId(left: AgendaEvent, right: AgendaEvent): Boolean {
    fun key(event: AgendaEvent) = cleanSchulnetzText(event.id).substringBefore('@')
    return key(left).isNotBlank() && key(left) == key(right)
}

internal fun sameExamSlot(left: AgendaEvent, right: AgendaEvent): Boolean {
    fun label(event: AgendaEvent) = listOf(event.text, event.timetableText, event.courseName)
        .map { cleanSchulnetzText(it).lowercase() }.firstOrNull { it.isNotBlank() }.orEmpty()
    return label(left).isNotBlank() && label(left) == label(right) && eventDay(left) == eventDay(right) &&
        (eventClock(left).isBlank() || eventClock(right).isBlank() || eventClock(left) == eventClock(right)) &&
        (schulnetzClock(left.end).isBlank() || schulnetzClock(right.end).isBlank() || left.endsAt() == right.endsAt())
}

internal fun completeExamTime(event: AgendaEvent): Boolean = eventDate(event.start) != null && eventDate(event.end) != null &&
    schulnetzClock(event.start).isNotBlank() && schulnetzClock(event.end).isNotBlank() &&
    !(schulnetzClock(event.start) == "00:00" && schulnetzClock(event.end) == "00:00") &&
    event.startsAt() != null && event.endsAt() != null

internal fun examTimeChanged(left: AgendaEvent, right: AgendaEvent): Boolean =
    completeExamTime(left) && completeExamTime(right) && (left.startsAt() != right.startsAt() || left.endsAt() != right.endsAt())

/** Only agenda notification comparisons use the baseline; grade/message/calendar histories stay intact. */
fun AgendaRead.comparison(previous: SchulnetzSnapshot?): SchulnetzSnapshot? = previous?.copy(
    events = before.events.filter { it.isLesson() } + previous.events.filter { !it.isLesson() && !it.isExamLike() },
    exams = before.exams,
)

/**
 * Two all-day entries (no clock) of the same exam: the class overview can list one exam twice under
 * different ids. Same day, same label and same course name, so two different exams are never merged.
 * Server mirror: sameAllDayExam (schulnetz-logic.mjs).
 */
internal fun sameAllDayExam(left: AgendaEvent, right: AgendaEvent): Boolean {
    fun label(event: AgendaEvent) = listOf(event.text, event.timetableText, event.courseName)
        .map { cleanSchulnetzText(it).lowercase() }.firstOrNull { it.isNotBlank() }.orEmpty()
    return eventClock(left).isBlank() && eventClock(right).isBlank() &&
        eventDay(left).isNotBlank() && eventDay(left) == eventDay(right) &&
        label(left).isNotBlank() && label(left) == label(right) &&
        cleanSchulnetzText(left.courseName).lowercase() == cleanSchulnetzText(right.courseName).lowercase()
}

internal fun distinctExams(events: List<AgendaEvent>): List<AgendaEvent> {
    val out = mutableListOf<AgendaEvent>()
    for (event in events) {
        val index = out.indexOfFirst { candidate ->
            (sameExamId(candidate, event) && candidate.startsAt() == event.startsAt() && candidate.endsAt() == event.endsAt()) ||
                (eventClock(candidate).isNotBlank() && eventClock(event).isNotBlank() && sameExamSlot(candidate, event)) ||
                sameAllDayExam(candidate, event)
        }
        if (index < 0) out += event else if (!completeExamTime(out[index]) && completeExamTime(event)) out[index] = event
    }
    return out
}
