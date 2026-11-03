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
        for (message in next.messages) {
            if (beforeMessages[message.id] != null) continue
            changes += linkedChange(
                id = "event:${message.id}",
                category = "event",
                title = message.title.ifBlank { "Neue Mitteilung" },
                body = message.body.ifBlank { message.title },
                targetId = messageTargetId(message),
            )
        }
        val beforeEvents = previous.events.associateBy { it.id }
        for (event in next.events) {
            if (event.isLesson() || event.isExamLike() || beforeEvents[event.id] != null) continue
            changes += linkedChange(
                id = "event:${event.id}:${eventKey(event)}",
                category = "event",
                title = "Neuer Termin",
                body = eventBody(event),
                targetId = lessonTargetId(event),
                courseId = event.courseId.ifBlank { event.label },
                date = eventDay(event),
            )
        }
    }
    return changes
}

private fun diffGrades(previous: List<SchoolGrade>, next: List<SchoolGrade>, changes: MutableList<SchulnetzChange>) {
    val before = previous.associateBy { it.id }
    for (grade in next) {
        val old = before[grade.id]
        val key = gradeKey(grade)
        if (old != null && gradeKey(old) == key) continue
        val title = if (old == null) "Neue Note" else "Notenänderung"
        val mark = formatMark(grade.mark)
        val course = grade.courseLabel.ifBlank { "Kurs" }
        val name = grade.title.ifBlank { "Note" }
        changes += linkedChange(
            id = "grade:${grade.id}:$key",
            category = "grade",
            title = title,
            body = "$course · $name · $mark · Gewicht ${formatMark(grade.weight)}",
            targetId = gradeTargetId(grade),
            courseId = grade.courseKey,
            date = grade.date,
        )
    }
}

private fun diffAgenda(
    previous: List<AgendaEvent>,
    next: List<AgendaEvent>,
    category: String,
    created: String,
    removed: String,
    changes: MutableList<SchulnetzChange>,
) {
    val before = previous.associateBy { it.id }
    val after = next.associateBy { it.id }
    for (event in next) {
        val old = before[event.id]
        val key = eventKey(event)
        if (old != null && eventKey(old) == key) continue
        val title = when {
            old == null -> if (category == "exam") "Neue Prüfung" else created
            event.isCancelled() && !old.isCancelled() -> if (category == "exam") "Prüfung fällt aus" else "Lektion fällt aus"
            event.teachers.joinToString() != old.teachers.joinToString() || (event.isSubstitution() && !old.isSubstitution()) -> "Vertretung"
            category == "exam" && (event.start != old.start || event.room != old.room) -> "Prüfung verschoben"
            event.room != old.room && (event.start != old.start || event.end != old.end) -> if (category == "exam") "Prüfung geändert" else "Stundenplan geändert"
            event.room != old.room -> "Raum geändert"
            event.start != old.start || event.end != old.end -> "Zeit geändert"
            else -> if (category == "exam") "Prüfung geändert" else "Stundenplan geändert"
        }
        changes += linkedChange(
            id = "$category:${event.id}:$key",
            category = category,
            title = title,
            body = eventBody(event),
            targetId = lessonTargetId(event),
            courseId = event.courseId.ifBlank { event.label },
            date = eventDay(event),
        )
    }
    for (event in previous) {
        if (after[event.id] != null) continue
        changes += linkedChange(
            id = "$category:${event.id}:removed",
            category = category,
            title = removed,
            body = eventBody(event),
            targetId = lessonTargetId(event),
            courseId = event.courseId.ifBlank { event.label },
            date = eventDay(event),
        )
    }
}

internal fun gradeKey(grade: SchoolGrade): String =
    listOf(numKey(grade.mark), numKey(grade.weight), grade.title, grade.date).joinToString("|")

internal fun eventKey(event: AgendaEvent): String = listOf(
    event.start,
    event.end,
    event.room,
    event.status,
    event.text,
    event.teachers.joinToString(","),
    if (event.isCancelled()) "aus" else "da",
    event.courseName,
).joinToString("|")

private fun eventBody(event: AgendaEvent): String {
    val time = clockSpan(event)
    val room = event.room.let { if (it.isBlank()) "" else "Raum $it" }
    val flags = listOfNotNull(
        if (event.isCancelled()) "fällt aus" else null,
        if (event.isSubstitution()) "Vertretung" else null,
    )
    return (listOf(event.label, time, room) + flags + listOf(event.comment))
        .filter { it.isNotBlank() }
        .joinToString(" · ")
}

private fun clockSpan(event: AgendaEvent): String {
    val start = event.start.substringAfter('T', "").take(5)
    val end = event.end.substringAfter('T', "").take(5)
    return when {
        start.isBlank() -> ""
        end.isBlank() || end == start -> start
        else -> "$start–$end"
    }
}

/** Stable across Kotlin and the server poller. 5.5 stays "5.5", 1.0 becomes "1". */
fun numKey(value: Double?): String {
    if (value == null || !value.isFinite()) return ""
    val rounded = round(value * 1000.0) / 1000.0
    val asLong = rounded.toLong()
    return if (asLong.toDouble() == rounded) asLong.toString() else rounded.toString()
}
