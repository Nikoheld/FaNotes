package ch.fasrv.fanotes.schulnetz

import java.time.LocalDate
import kotlin.math.round

/**
 * Difference between two normalised snapshots.
 * The first snapshot after linking produces no notifications, so a fresh login
 * does not announce every existing grade. Later polls announce only real changes.
 * Category names are stable: grade, timetable, exam, absence, event.
 */
fun diffSnapshots(
    previous: SchulnetzSnapshot?,
    next: SchulnetzSnapshot,
    settings: NotifySettings = NotifySettings(),
    today: LocalDate = LocalDate.now(),
): List<SchulnetzChange> {
    if (previous == null) return emptyList()
    val freshWeeks = introducedWeeks(previous, next)
    val changes = mutableListOf<SchulnetzChange>()
    if (settings.grades) diffGrades(previous.grades.withoutSummaryGrades(), next.grades.withoutSummaryGrades(), changes)
    if (settings.timetable) {
        diffAgenda(
            previous.events.filter { it.isLesson() },
            next.events.filter { it.isLesson() },
            category = "timetable",
            created = "Stundenplan geändert",
            removed = "Lektion entfernt",
            changes = changes,
            skipWeeks = freshWeeks,
            spareAgainst = next.exams,
        )
    }
    if (settings.exams) {
        diffAgenda(
            previous.exams,
            next.exams,
            category = "exam",
            created = "Neue Prüfung",
            removed = "Prüfung entfällt",
            changes = changes,
            skipWeeks = freshWeeks,
            adoptFrom = previous.events,
            stillThere = next.events,
        )
    }
    if (settings.absences) {
        val before = previous.absences.associateBy { it.id }
        for (absence in next.absences) {
            if (before[absence.id] != null) continue
            val whenText = listOf(absence.dateFrom, absence.hourFrom).filter { it.isNotBlank() }.joinToString(" ")
            val subject = absence.subject.ifBlank { "Absenz" }
            val excuse = if (absence.excused) "entschuldigt" else "nicht entschuldigt"
            changes += linkedChange(
                id = "absence:${absence.id}",
                category = "absence",
                title = "Neue Absenz",
                body = listOf(subject, whenText, absence.reason, excuse).filter { it.isNotBlank() }.joinToString(" · "),
                targetId = absenceTargetId(absence),
                date = absence.dateFrom.take(10),
            )
        }
    }
    if (settings.deadlines) changes += excuseReminders(next.absences, today)
    if (settings.events) {
        val beforeMessages = previous.messages.associateBy { it.id }
        val knownMessages = previous.messages.map(::messageIdentity).filter { it.isNotBlank() }.toSet()
        for (message in next.messages) {
            if (beforeMessages[message.id] != null) continue
            val identity = messageIdentity(message)
            if (identity.isNotBlank() && identity in knownMessages) continue
            val title = cleanSchulnetzText(message.title).ifBlank { "Neue Mitteilung" }
            val body = cleanSchulnetzText(message.body).ifBlank { cleanSchulnetzText(message.title) }
            if (body.isBlank()) continue
            changes += linkedChange(
                id = "event:${message.id}",
                category = "event",
                title = title,
                body = body,
                targetId = messageTargetId(message),
            )
        }
        val beforeEvents = previous.events.associateBy { it.id }
        val knownEvents = previous.events + previous.exams + next.exams
        for (event in next.events) {
            if (weekMondayKey(event.start) in freshWeeks) continue
            if (event.isLesson() || event.isExamLike() || beforeEvents[event.id] != null) continue
            if (knownEvents.any { sameSchoolSlot(event, it) }) continue
            val body = eventBody(event)
            if (body.isBlank()) continue
            changes += linkedChange(
                id = "event:${event.id}:${eventKey(event)}",
                category = "event",
                title = "Neuer Termin",
                body = body,
                targetId = lessonTargetId(event),
                courseId = event.courseId.ifBlank { event.label },
                date = eventDay(event),
            )
        }
    }
    return deduped(changes)
}

private fun diffGrades(previous: List<SchoolGrade>, next: List<SchoolGrade>, changes: MutableList<SchulnetzChange>) {
    changes += matchGradeChanges(previous, next)
}

private fun diffAgenda(
    previous: List<AgendaEvent>,
    next: List<AgendaEvent>,
    category: String,
    created: String,
    removed: String,
    changes: MutableList<SchulnetzChange>,
    skipWeeks: Set<String> = emptySet(),
    adoptFrom: List<AgendaEvent> = emptyList(),
    stillThere: List<AgendaEvent> = emptyList(),
    spareAgainst: List<AgendaEvent> = emptyList(),
) {
    val before = previous.associateBy { it.id }
    val after = next.associateBy { it.id }
    for (event in next) {
        val old = before[event.id]
        if (old == null && weekMondayKey(event.start) in skipWeeks) continue
        val adopted = if (old == null) {
            adoptFrom.firstOrNull { candidate -> sameSchoolSlot(event, candidate) && stillThere.none { it.id == candidate.id } }
        } else {
            null
        }
        if (old == null && adopted != null && !schoolEventMoved(adopted, event)) continue
        val key = eventKey(event)
        if (old != null && eventKey(old) == key) continue
        val title = when {
            old == null && adopted != null -> "Prüfung verschoben"
            old == null -> if (category == "exam") "Neue Prüfung" else created
            event.isCancelled() && !old.isCancelled() -> if (category == "exam") "Prüfung fällt aus" else "Lektion fällt aus"
            event.teachers.joinToString() != old.teachers.joinToString() || (event.isSubstitution() && !old.isSubstitution()) -> "Vertretung"
            category == "exam" && (event.start != old.start || event.room != old.room) -> "Prüfung verschoben"
            event.room != old.room && (event.start != old.start || event.end != old.end) -> if (category == "exam") "Prüfung geändert" else "Stundenplan geändert"
            event.room != old.room -> "Raum geändert"
            event.start != old.start || event.end != old.end -> "Zeit geändert"
            else -> if (category == "exam") "Prüfung geändert" else "Stundenplan geändert"
        }
        val body = eventBody(event)
        if (body.isBlank()) continue
        changes += linkedChange(
            id = "$category:${event.id}:$key",
            category = category,
            title = title,
            body = body,
            targetId = lessonTargetId(event),
            courseId = event.courseId.ifBlank { event.label },
            date = eventDay(event),
        )
    }
    for (event in previous) {
        if (after[event.id] != null) continue
        if (weekMondayKey(event.start) in skipWeeks) continue
        if (spareAgainst.any { sameSchoolSlot(event, it) }) continue
        val body = eventBody(event)
        if (body.isBlank()) continue
        changes += linkedChange(
            id = "$category:${event.id}:removed",
            category = category,
            title = removed,
            body = body,
            targetId = lessonTargetId(event),
            courseId = event.courseId.ifBlank { event.label },
            date = eventDay(event),
        )
    }
}

internal fun gradeKey(grade: SchoolGrade): String =
    listOf(numKey(grade.mark), numKey(grade.weight), grade.title, grade.date).joinToString("|")

internal fun eventKey(event: AgendaEvent): String = listOf(
    eventDayKey(event.start),
    realClock(event.start),
    realClock(event.end),
    cleanSchulnetzText(event.room),
    cleanSchulnetzText(event.status),
    cleanSchulnetzText(event.text),
    event.teachers.joinToString(",") { cleanSchulnetzText(it) },
    if (event.isCancelled()) "aus" else "da",
    cleanSchulnetzText(event.courseName),
).joinToString("|")

private fun eventBody(event: AgendaEvent): String {
    val time = displayClock(event.start, event.end)
    val room = cleanSchulnetzText(event.room).let { if (it.isBlank()) "" else "Raum $it" }
    val name = listOf(event.courseName, event.text, event.timetableText).map(::cleanSchulnetzText).firstOrNull { it.isNotBlank() }.orEmpty()
    val flags = listOfNotNull(
        if (event.isCancelled()) "fällt aus" else null,
        if (event.isSubstitution()) "Vertretung" else null,
    )
    return (listOf(name, time, room) + flags + listOf(cleanSchulnetzText(event.comment)))
        .filter { it.isNotBlank() }
        .joinToString(" · ")
}

/** Same subject on the same day. A missing clock still matches, so a stored lesson can be the same test. */
internal fun sameSchoolSlot(left: AgendaEvent, right: AgendaEvent): Boolean {
    if (left.id.isNotBlank() && left.id == right.id) return true
    val leftLabel = eventMatchLabel(left)
    val rightLabel = eventMatchLabel(right)
    if (leftLabel.isBlank() || leftLabel != rightLabel) return false
    val leftDay = eventDayKey(left.start)
    val rightDay = eventDayKey(right.start)
    return leftDay.isNotBlank() && leftDay == rightDay
}

internal fun schoolEventMoved(left: AgendaEvent, right: AgendaEvent): Boolean {
    val leftClock = realClock(left.start)
    val rightClock = realClock(right.start)
    if (leftClock.isNotBlank() && rightClock.isNotBlank() && leftClock != rightClock) return true
    val leftRoom = cleanSchulnetzText(left.room)
    val rightRoom = cleanSchulnetzText(right.room)
    return leftRoom.isNotBlank() && rightRoom.isNotBlank() && leftRoom != rightRoom
}

private fun eventMatchLabel(event: AgendaEvent): String =
    listOf(event.courseName, event.text, event.timetableText)
        .map { cleanSchulnetzText(it).lowercase() }
        .firstOrNull { it.isNotBlank() }
        .orEmpty()

private fun realClock(raw: String): String = schulnetzClock(raw).let { if (it == "00:00") "" else it }

private fun messageIdentity(message: SchoolMessage): String {
    val title = cleanSchulnetzText(message.title).lowercase()
    val body = cleanSchulnetzText(message.body).lowercase()
    if (title.isBlank() && body.isBlank()) return ""
    return "$title|$body"
}

private fun deduped(changes: List<SchulnetzChange>): List<SchulnetzChange> {
    val seen = mutableSetOf<String>()
    return changes.filter { change ->
        if (change.category != "exam" && change.category != "event" && change.category != "timetable") return@filter true
        seen.add("${change.category}|${change.title}|${cleanSchulnetzText(change.body)}")
    }
}

/** Stable across Kotlin and the server poller. 5.5 stays "5.5", 1.0 becomes "1". */
fun numKey(value: Double?): String {
    if (value == null || !value.isFinite()) return ""
    val rounded = round(value * 1000.0) / 1000.0
    val asLong = rounded.toLong()
    return if (asLong.toDouble() == rounded) asLong.toString() else rounded.toString()
}
