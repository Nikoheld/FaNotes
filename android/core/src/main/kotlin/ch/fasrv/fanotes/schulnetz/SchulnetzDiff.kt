package ch.fasrv.fanotes.schulnetz

import java.time.LocalDate
import kotlin.math.round

private val alertParent = mapOf(
    "grade-new" to "grades",
    "grade-changed" to "grades",
    "lesson-cancelled" to "timetable",
    "lesson-changed" to "timetable",
    "exam-new" to "exams",
    "exam-moved" to "exams",
    "exam-cancelled" to "exams",
    "exam-room" to "exams",
    "exam-other" to "exams",
    "appointment-new" to "events",
    "message-new" to "events",
    "absence-new" to "absences",
    "deadline" to "deadlines",
)

/** Real school-alert kind. Blank for probes, tests, and categories this diff does not emit. */
fun notifyAlertKind(change: SchulnetzChange): String {
    val title = change.title
    return when (change.category) {
        "grade" -> if (Regex("änderung|aenderung", RegexOption.IGNORE_CASE).containsMatchIn(title)) "grade-changed" else "grade-new"
        "exam" -> when (title) {
            "Neue Prüfung" -> "exam-new"
            "Prüfung verschoben" -> "exam-moved"
            "Prüfung fällt aus", "Prüfung entfällt" -> "exam-cancelled"
            "Raum geändert" -> "exam-room"
            else -> "exam-other"
        }
        "timetable" -> if (title == "Lektion fällt aus" || title == "Lektion entfernt") "lesson-cancelled" else "lesson-changed"
        "event" -> if (title == "Neuer Termin") "appointment-new" else "message-new"
        "absence" -> "absence-new"
        "deadline" -> "deadline"
        else -> ""
    }
}

/**
 * A missing caller that leaves a fine flag at its default still follows the
 * category switch. The master switch blocks every school alert. Probes stay.
 */
fun alertAllowed(settings: NotifySettings, change: SchulnetzChange): Boolean {
    if (isNotificationProbe(change.id)) return true
    if (!settings.enabled) return false
    val kind = notifyAlertKind(change)
    if (kind.isEmpty()) return true
    val parentOn = when (alertParent[kind]) {
        "grades" -> settings.grades
        "timetable" -> settings.timetable
        "exams" -> settings.exams
        "events" -> settings.events
        "absences" -> settings.absences
        "deadlines" -> settings.deadlines
        else -> true
    }
    if (!parentOn) return false
    return when (kind) {
        "grade-new" -> settings.gradeNew
        "grade-changed" -> settings.gradeChanged
        "lesson-cancelled" -> settings.lessonCancelled
        "lesson-changed" -> settings.lessonChanged
        "exam-new" -> settings.examNew
        "exam-moved" -> settings.examMoved
        "exam-cancelled" -> settings.examCancelled
        "exam-room" -> settings.examRoom
        "appointment-new" -> settings.appointmentNew
        "message-new" -> settings.messageNew
        else -> true
    }
}

/** Login and the local test button are not school-event switches. */
fun keepsAlertDespiteSwitches(change: SchulnetzChange): Boolean {
    if (change.id == "schulnetz-login-required" || change.id == "push-test") return true
    return change.category == "settings"
}

/**
 * Decision used before a notice is posted. Remote push, an open app, and the
 * fallback check all use it. A disabled switch is not a notice that is shown
 * and then cancelled. Android permission is a separate gate and does not
 * rewrite the stored switches.
 */
enum class AlertGate { DELIVER, PREFERENCE, PERMISSION }

fun schoolAlertGate(settings: NotifySettings, change: SchulnetzChange, notificationsPermitted: Boolean): AlertGate {
    if (!keepsAlertDespiteSwitches(change) && !alertAllowed(settings, change)) return AlertGate.PREFERENCE
    if (!notificationsPermitted) return AlertGate.PERMISSION
    return AlertGate.DELIVER
}

/** One representative school change for each kind the diff can emit. */
fun sampleSchoolAlert(kind: String): SchulnetzChange = when (kind) {
    "grade-new" -> SchulnetzChange("grade:g1", "grade", "Neue Note", "Mathematik")
    "grade-changed" -> SchulnetzChange("grade:g1", "grade", "Notenänderung", "Mathematik")
    "lesson-cancelled" -> SchulnetzChange("lesson:e1", "timetable", "Lektion fällt aus", "Mathematik")
    "lesson-changed" -> SchulnetzChange("lesson:e1", "timetable", "Stundenplan geändert", "Mathematik")
    "exam-new" -> SchulnetzChange("exam:x", "exam", "Neue Prüfung", "Mathematik")
    "exam-moved" -> SchulnetzChange("exam:x", "exam", "Prüfung verschoben", "Mathematik")
    "exam-cancelled" -> SchulnetzChange("exam:x", "exam", "Prüfung fällt aus", "Mathematik")
    "exam-room" -> SchulnetzChange("exam:x", "exam", "Raum geändert", "Mathematik")
    "appointment-new" -> SchulnetzChange("event:t1", "event", "Neuer Termin", "Elternabend")
    "message-new" -> SchulnetzChange("event:m1", "event", "Neue Mitteilung", "Hinweis")
    "absence-new" -> SchulnetzChange("absence:a1", "absence", "Neue Absenz", "Deutsch")
    "deadline" -> SchulnetzChange("deadline:a1:2026-11-08", "deadline", "Entschuldigung läuft ab", "Deutsch")
    else -> SchulnetzChange("other", "home", "Hinweis", "")
}

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
    now: java.time.ZonedDateTime = if (today == LocalDate.now(SCHOOL_ZONE)) java.time.ZonedDateTime.now(SCHOOL_ZONE) else today.atStartOfDay(SCHOOL_ZONE),
): List<SchulnetzChange> {
    if (previous == null) return emptyList()
    // The master switch drops the diff before any row is built. Callers still store the snapshot.
    if (!settings.enabled) return emptyList()
    val freshWeeks = introducedWeeks(previous, next) + legacyBackfillWeeks(previous, next) + lessonSeedWeeks(previous, next)
    val changes = mutableListOf<SchulnetzChange>()
    if (settings.grades) diffGrades(previous.grades.withoutSummaryGrades(), next.grades.withoutSummaryGrades(), changes)
    if (settings.timetable) {
        val lessonChanges = mutableListOf<SchulnetzChange>()
        diffAgenda(
            previous.events.filter { it.isLesson() },
            next.events.filter { it.isLesson() },
            category = "timetable",
            created = "Stundenplan geändert",
            removed = "Lektion entfernt",
            changes = lessonChanges,
            skipWeeks = freshWeeks,
            spareAgainst = next.exams,
        )
        // So many lesson changes in one read is the timetable reloading, not news.
        if (lessonChanges.size <= TIMETABLE_BURST) changes += lessonChanges
    }
    if (settings.exams) {
        // An exam-like appointment that is still listed has not been cancelled.
        val stillListed = next.events.mapTo(HashSet()) { it.id }
        diffExams(previous.exams + previous.events.filter { it.isExamLike() && it.id !in stillListed }, next.exams, changes, freshWeeks)
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
        // Only the range the previous appointment list already covered can hold news; later
        // appointments are the list reaching further. A large batch is the list growing too.
        val horizon = appointmentHorizon(previous)
        val appointments = next.events.filter { event ->
            weekMondayKey(event.start) !in freshWeeks && !event.isLesson() && !event.isExamLike() && beforeEvents[event.id] == null &&
                knownEvents.none { sameSchoolSlot(event, it) } && eventBody(event).isNotBlank() &&
                (horizon == null || eventDate(eventDay(event))?.let { !it.isAfter(horizon) } == true)
        }
        for (event in if (appointments.size > APPOINTMENT_BURST) emptyList() else appointments) {
            val body = eventBody(event)
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
    // A notice about a lesson, exam or appointment that has already ended is never sent.
    return deduped(changes).filter { alertAllowed(settings, it) && !changeIsOver(it, now) }
}

private fun diffGrades(previous: List<SchoolGrade>, next: List<SchoolGrade>, changes: MutableList<SchulnetzChange>) {
    changes += matchGradeChanges(previous, next)
}

private fun diffExams(previous: List<AgendaEvent>, next: List<AgendaEvent>, changes: MutableList<SchulnetzChange>, skipWeeks: Set<String>) {
    val before = distinctExams(previous)
    val consumed = mutableSetOf<Int>()
    for (event in distinctExams(next)) {
        if (eventDate(eventDay(event)) == null) continue
        val ids = before.indices.filter { it !in consumed && sameExamId(before[it], event) }
        val slots = before.indices.filter { it !in consumed && sameExamSlot(before[it], event) }
        val index = ids.singleOrNull() ?: slots.singleOrNull()
        val prior = index?.let { before[it] }
        if (index != null) consumed += index
        if (prior == null && weekMondayKey(eventDay(event)) in skipWeeks) continue
        val title = when {
            prior == null -> "Neue Prüfung"
            event.isCancelled() && !prior.isCancelled() -> "Prüfung fällt aus"
            examTimeChanged(prior, event) -> "Prüfung verschoben"
            prior.room.isNotBlank() && event.room.isNotBlank() && cleanSchulnetzText(prior.room) != cleanSchulnetzText(event.room) -> "Raum geändert"
            else -> continue
        }
        changes += linkedChange("exam:${event.id.substringBefore('@')}:${eventKey(event)}", "exam", title, eventBody(event),
            targetId = lessonTargetId(event), courseId = event.courseId.ifBlank { event.label }, date = eventDay(event))
    }
    // Empty/partial snapshots cannot establish a cancellation. A later complete fetch can.
    if (next.isEmpty()) return
    for ((index, event) in before.withIndex()) {
        if (index in consumed || weekMondayKey(eventDay(event)) in skipWeeks || eventDate(eventDay(event)) == null) continue
        if (next.any { sameExamId(event, it) || sameExamSlot(event, it) }) continue
        changes += linkedChange("exam:${event.id}:removed", "exam", "Prüfung entfällt", eventBody(event),
            targetId = lessonTargetId(event), courseId = event.courseId.ifBlank { event.label }, date = eventDay(event))
    }
}

private fun diffAgenda(
    previous: List<AgendaEvent>,
    next: List<AgendaEvent>,
    category: String,
    created: String,
    removed: String,
    changes: MutableList<SchulnetzChange>,
    skipWeeks: Set<String> = emptySet(),
    spareAgainst: List<AgendaEvent> = emptyList(),
) {
    val before = previous.associateBy { it.id }
    val after = next.associateBy { it.id }
    for (event in next) {
        val old = before[event.id]
        if (old == null && weekMondayKey(event.start) in skipWeeks) continue
        val slotTwin = if (old == null && category == "timetable") previous.firstOrNull { sameLessonSlot(event, it) } else null
        val prior = old ?: slotTwin
        if (prior != null && category == "timetable" && !lessonContentChanged(prior, event)) continue
        val key = eventKey(event)
        if (old != null && eventKey(old) == key) continue
        val title = when {
            prior == null -> if (category == "exam") "Neue Prüfung" else created
            event.isCancelled() && !prior.isCancelled() -> if (category == "exam") "Prüfung fällt aus" else "Lektion fällt aus"
            event.teachers.joinToString() != prior.teachers.joinToString() || (event.isSubstitution() && !prior.isSubstitution()) -> "Vertretung"
            event.room != prior.room && (event.start != prior.start || event.end != prior.end) -> if (category == "exam") "Prüfung geändert" else "Stundenplan geändert"
            event.room != prior.room -> "Raum geändert"
            event.start != prior.start || event.end != prior.end -> "Zeit geändert"
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
        if (category == "timetable" && next.any { sameLessonSlot(event, it) }) continue
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
    fun wall(raw: String): String {
        if (schulnetzClock(raw).isBlank()) return raw
        return parseSchulnetzInstant(raw)?.atZone(java.time.ZoneId.of("Europe/Zurich"))?.toLocalDateTime()?.toString() ?: raw
    }
    val time = displayClock(wall(event.start), wall(event.end))
    val room = cleanSchulnetzText(event.room).let { if (it.isBlank()) "" else "Raum $it" }
    val name = listOf(event.courseName, event.text, event.timetableText).map(::cleanSchulnetzText).firstOrNull { it.isNotBlank() }.orEmpty()
    val flags = listOfNotNull(
        if (event.isCancelled()) "fällt aus" else null,
        if (event.isSubstitution()) "Vertretung" else null,
    )
    val day = eventDate(eventDay(event))?.format(java.time.format.DateTimeFormatter.ofPattern("dd.MM.yyyy")).orEmpty()
    return (listOf(day, name, time, room) + flags + listOf(cleanSchulnetzText(event.comment)))
        .filter { it.isNotBlank() }
        .joinToString(" · ")
}

/**
 * Same lesson after an id or parser change. Course, clock, and room identify it.
 * A blank room on one side still matches, so a field the parser dropped is not a removal.
 */
internal fun sameLessonSlot(left: AgendaEvent, right: AgendaEvent): Boolean {
    val leftDay = eventDayKey(left.start)
    val rightDay = eventDayKey(right.start)
    if (leftDay.isBlank() || leftDay != rightDay) return false
    if (!sameCourse(left, right)) return false
    val leftClock = realClock(left.start)
    val rightClock = realClock(right.start)
    if (leftClock.isBlank() || rightClock.isBlank() || leftClock != rightClock) return false
    val leftRoom = cleanSchulnetzText(left.room)
    val rightRoom = cleanSchulnetzText(right.room)
    return leftRoom.isBlank() || rightRoom.isBlank() || leftRoom.equals(rightRoom, ignoreCase = true)
}

private fun lessonContentChanged(previous: AgendaEvent, next: AgendaEvent): Boolean {
    if (schoolEventMoved(previous, next)) return true
    if (next.isCancelled() != previous.isCancelled()) return true
    val beforeTeachers = previous.teachers.map { cleanSchulnetzText(it) }.filter { it.isNotBlank() }
    val afterTeachers = next.teachers.map { cleanSchulnetzText(it) }.filter { it.isNotBlank() }
    if (beforeTeachers.isNotEmpty() && afterTeachers.isNotEmpty() && beforeTeachers.joinToString() != afterTeachers.joinToString()) return true
    return next.isSubstitution() != previous.isSubstitution()
}

private fun sameCourse(left: AgendaEvent, right: AgendaEvent): Boolean {
    val rightKeys = courseKeys(right)
    if (rightKeys.isEmpty()) return false
    return courseKeys(left).any { it in rightKeys }
}

private fun courseKeys(event: AgendaEvent): Set<String> {
    val texts = listOf(event.courseName, event.text, event.timetableText, event.courseId)
        .map { cleanSchulnetzText(it).lowercase() }
        .filter { it.isNotBlank() }
    return texts.flatMap { text ->
        listOf(text, text.substringBefore(' ').trim(), text.substringBefore('(').trim())
    }.filter { it.length >= 2 }.toSet()
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
