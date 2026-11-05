package ch.fasrv.fanotes.schulnetz

import java.time.LocalDate
import java.time.ZoneId

/**
 * Deep link carried in every Schulnetz push. [targetId] is a hash of the
 * human fields (course + date + title, or date + time + subject) so a later
 * Schulnetz id change still opens the same row.
 */
data class NotifyLink(
    val kind: String,
    val ids: List<String> = emptyList(),
    val courseId: String = "",
    val date: String = "",
)

data class NotifyRoute(
    val tab: String,
    val section: String,
    val courseId: String = "",
    val highlightIds: List<String> = emptyList(),
    val day: String = "",
    val hint: String = "",
    val found: Boolean = true,
)

fun notifyHash(vararg parts: String): String {
    val raw = parts.joinToString("|") { it.trim().lowercase() }
    var hash = 2166136261u
    for (char in raw) {
        hash = hash xor char.code.toUInt()
        hash *= 16777619u
    }
    return hash.toString(16)
}

fun gradeTargetId(grade: SchoolGrade): String =
    notifyHash(grade.courseKey, grade.date, grade.title)

fun lessonTargetId(event: AgendaEvent): String =
    notifyHash(eventDay(event), eventClock(event), event.label)

fun absenceTargetId(absence: SchoolAbsence): String =
    notifyHash(absence.id, absence.dateFrom, absence.subject, absence.reason)

fun messageTargetId(message: SchoolMessage): String = notifyHash(message.id, message.title, message.body)

fun eventDay(event: AgendaEvent, zone: ZoneId = ZoneId.of("Europe/Zurich")): String {
    if (zonedStamp(event.start)) {
        event.startsAt(zone)?.atZone(zone)?.toLocalDate()?.toString()?.let { return it }
    }
    val key = eventDayKey(event.start)
    if (key.isNotBlank()) return key
    return event.startsAt(zone)?.atZone(zone)?.toLocalDate()?.toString()
        ?: event.start.take(10).takeIf { it.length == 10 }.orEmpty()
}

fun eventClock(event: AgendaEvent, zone: ZoneId = ZoneId.of("Europe/Zurich")): String {
    val clock = if (zonedStamp(event.start)) {
        event.startsAt(zone)?.atZone(zone)?.toLocalTime()?.toString()?.take(5) ?: schulnetzClock(event.start)
    } else {
        schulnetzClock(event.start)
    }
    return if (clock.isBlank() || clock == "00:00") "" else clock
}

private fun zonedStamp(raw: String): Boolean =
    raw.contains('Z') || Regex("""[+-]\d{2}:\d{2}$""").containsMatchIn(raw)

fun notifyKindOf(category: String, id: String = "", title: String = ""): String = when {
    category == "settings" || id == "push-test" || title.contains("Testbenachrichtigung") -> "settings"
    id == "schulnetz-login-required" || id.startsWith("reauth:") -> "home"
    category == "deadline" -> "deadline"
    else -> category
}

fun notifyLinkOf(change: SchulnetzChange): NotifyLink =
    NotifyLink(notifyKindOf(change.category, change.id, change.title), change.linkIds(), change.courseId, change.date)

fun notifyPayload(change: SchulnetzChange): String {
    val ids = change.linkIds()
    return buildString {
        append("{\"id\":").append(ch.fasrv.fanotes.json.escapeJson(change.id))
        append(",\"category\":").append(ch.fasrv.fanotes.json.escapeJson(change.category))
        append(",\"title\":").append(ch.fasrv.fanotes.json.escapeJson(change.title))
        append(",\"body\":").append(ch.fasrv.fanotes.json.escapeJson(change.body))
        append(",\"target\":").append(ch.fasrv.fanotes.json.escapeJson(change.target.ifBlank { defaultTarget(change.category) }))
        append(",\"targetId\":").append(ch.fasrv.fanotes.json.escapeJson(ids.joinToString(",")))
        append(",\"courseId\":").append(ch.fasrv.fanotes.json.escapeJson(change.courseId))
        append(",\"date\":").append(ch.fasrv.fanotes.json.escapeJson(change.date))
        append(",\"targetIds\":[")
        ids.forEachIndexed { index, id ->
            if (index > 0) append(',')
            append(ch.fasrv.fanotes.json.escapeJson(id))
        }
        append("],\"gradeKeys\":[")
        change.gradeKeys.forEachIndexed { index, key ->
            if (index > 0) append(',')
            append(ch.fasrv.fanotes.json.escapeJson(key))
        }
        append("]}")
    }
}

fun parseNotifyLink(json: String): NotifyLink? {
    val obj = runCatching { ch.fasrv.fanotes.json.parseJson(json) as? ch.fasrv.fanotes.json.JsonValue.Obj }.getOrNull() ?: return null
    return parseNotifyLink(obj)
}

fun parseNotifyLink(obj: ch.fasrv.fanotes.json.JsonValue.Obj): NotifyLink? {
    if (obj.string("event") == "keepalive" || obj.string("event") == "open") return null
    val nested = obj.string("message")?.let { runCatching { ch.fasrv.fanotes.json.parseJson(it) as? ch.fasrv.fanotes.json.JsonValue.Obj }.getOrNull() }
    val source = nested ?: obj
    val category = source.string("category") ?: obj.string("category") ?: "event"
    val title = source.string("title") ?: obj.string("title").orEmpty()
    val id = source.string("id") ?: obj.string("id").orEmpty()
    val fromArray = source.array("targetIds")?.items.orEmpty().mapNotNull { (it as? ch.fasrv.fanotes.json.JsonValue.Str)?.value }
    val fromField = (source.string("targetId") ?: obj.string("targetId")).orEmpty().split(',').map { it.trim() }.filter { it.isNotBlank() }
    val ids = (fromArray + fromField).distinct().ifEmpty { listOf(id).filter { it.isNotBlank() } }
    return NotifyLink(
        kind = notifyKindOf(category, id, title),
        ids = ids,
        courseId = source.string("courseId") ?: obj.string("courseId").orEmpty(),
        date = source.string("date") ?: obj.string("date").orEmpty(),
    )
}

fun changeFromPayload(json: String): SchulnetzChange? {
    val obj = runCatching { ch.fasrv.fanotes.json.parseJson(json) as? ch.fasrv.fanotes.json.JsonValue.Obj }.getOrNull() ?: return null
    return changeFromObj(obj)
}

fun changeFromObj(obj: ch.fasrv.fanotes.json.JsonValue.Obj): SchulnetzChange? {
    if (obj.string("event") == "keepalive" || obj.string("event") == "open") return null
    val nested = obj.string("message")?.let { runCatching { ch.fasrv.fanotes.json.parseJson(it) as? ch.fasrv.fanotes.json.JsonValue.Obj }.getOrNull() }
    val source = nested ?: obj
    val id = source.string("id") ?: obj.string("id") ?: return null
    val ids = (source.array("targetIds")?.items.orEmpty().mapNotNull { (it as? ch.fasrv.fanotes.json.JsonValue.Str)?.value }
        + (source.string("targetId").orEmpty().split(',').map { it.trim() }.filter { it.isNotBlank() })).distinct()
    val gradeKeys = source.array("gradeKeys")?.items.orEmpty().mapNotNull { (it as? ch.fasrv.fanotes.json.JsonValue.Str)?.value }.distinct()
    return SchulnetzChange(
        id = id,
        category = source.string("category") ?: obj.string("category") ?: "event",
        title = source.string("title") ?: obj.string("title") ?: "Schulnetz",
        body = source.string("body") ?: source.string("message") ?: obj.string("body").orEmpty(),
        target = source.string("target").orEmpty(),
        targetId = ids.joinToString(","),
        courseId = source.string("courseId").orEmpty(),
        date = source.string("date").orEmpty(),
        targetIds = ids,
        gradeKeys = gradeKeys,
    )
}

fun groupGradeChanges(changes: List<SchulnetzChange>): List<SchulnetzChange> {
    val grades = changes.filter { it.category == "grade" }
    if (grades.size <= 1) return changes
    val rest = changes.filter { it.category != "grade" }
    val ids = grades.flatMap { it.linkIds() }.filter { it.isNotBlank() }.distinct()
    val grouped = SchulnetzChange(
        id = "grades:${ids.sorted().joinToString(",")}",
        category = "grade",
        title = "${grades.size} neue Noten",
        body = grades.joinToString("\n") { it.body },
        target = "grades",
        targetId = ids.joinToString(","),
        courseId = grades.map { it.courseId }.distinct().singleOrNull().orEmpty(),
        date = "",
        targetIds = ids,
        gradeKeys = grades.flatMap { it.gradeKeys }.filter { it.isNotBlank() }.distinct(),
    )
    return listOf(grouped) + rest
}

fun routeNotify(link: NotifyLink, snapshot: SchulnetzSnapshot, zone: ZoneId = ZoneId.of("Europe/Zurich")): NotifyRoute {
    return when (link.kind) {
        "settings" -> NotifyRoute(tab = "Mehr", section = "Einstellungen")
        "home" -> NotifyRoute(tab = "Heute", section = "Menu")
        "grade" -> routeGrades(link, snapshot)
        "timetable" -> routeLesson(link, snapshot, zone)
        "exam" -> routeExam(link, snapshot, zone)
        "deadline", "absence" -> routeAbsence(link, snapshot)
        else -> routeEvent(link, snapshot)
    }
}

fun linkedChange(
    id: String,
    category: String,
    title: String,
    body: String,
    targetId: String,
    courseId: String = "",
    date: String = "",
    gradeKeys: List<String> = emptyList(),
): SchulnetzChange = SchulnetzChange(
    id = id,
    category = category,
    title = title,
    body = body,
    target = defaultTarget(category),
    targetId = targetId,
    courseId = courseId,
    date = date,
    targetIds = listOf(targetId).filter { it.isNotBlank() },
    gradeKeys = gradeKeys,
)

private fun routeGrades(link: NotifyLink, snapshot: SchulnetzSnapshot): NotifyRoute {
    val found = snapshot.grades.filter { grade ->
        gradeTargetId(grade) in link.ids || grade.id in link.ids
    }
    val courses = found.map { it.courseKey }.distinct()
    val hint = if (found.isEmpty()) "Die Note ist nicht mehr im letzten Stand." else ""
    return NotifyRoute(
        tab = "Noten",
        section = "Menu",
        courseId = if (courses.size == 1) courses.single() else link.courseId,
        highlightIds = if (found.isNotEmpty()) found.map(::gradeTargetId) else link.ids,
        hint = hint,
        found = found.isNotEmpty(),
    )
}

private fun routeLesson(link: NotifyLink, snapshot: SchulnetzSnapshot, zone: ZoneId): NotifyRoute {
    val found = snapshot.events.filter { event ->
        lessonTargetId(event) in link.ids || event.id in link.ids
    }
    val event = found.firstOrNull()
    val day = event?.let { eventDay(it, zone) } ?: link.date
    val hint = if (event == null) "Die Lektion ist nicht mehr im letzten Stand." else ""
    return NotifyRoute(
        tab = "Plan",
        section = "Menu",
        highlightIds = if (event != null) listOf(lessonTargetId(event)) else link.ids,
        day = day,
        hint = hint,
        found = event != null,
    )
}

private fun routeExam(link: NotifyLink, snapshot: SchulnetzSnapshot, zone: ZoneId): NotifyRoute {
    val pool = snapshot.exams + snapshot.events.filter { it.isExamLike() }
    val found = pool.filter { lessonTargetId(it) in link.ids || it.id in link.ids }
    val event = found.firstOrNull()
    return NotifyRoute(
        tab = "Mehr",
        section = "Pruefungen",
        highlightIds = if (event != null) listOf(lessonTargetId(event)) else link.ids,
        day = event?.let { eventDay(it, zone) } ?: link.date,
        hint = if (event == null) "Die Prüfung ist nicht mehr im letzten Stand." else "",
        found = event != null,
    )
}

private fun routeAbsence(link: NotifyLink, snapshot: SchulnetzSnapshot): NotifyRoute {
    val found = snapshot.absences.filter { absenceTargetId(it) in link.ids || it.id in link.ids }
    return NotifyRoute(
        tab = "Mehr",
        section = "Absenzen",
        highlightIds = if (found.isNotEmpty()) found.map(::absenceTargetId) else link.ids,
        hint = if (found.isEmpty()) "Die Absenz ist nicht mehr im letzten Stand." else "",
        found = found.isNotEmpty(),
    )
}

private fun routeEvent(link: NotifyLink, snapshot: SchulnetzSnapshot): NotifyRoute {
    val messages = snapshot.messages.filter { messageTargetId(it) in link.ids || it.id in link.ids }
    if (messages.isNotEmpty()) {
        return NotifyRoute(tab = "Mehr", section = "Termine", highlightIds = messages.map(::messageTargetId), found = true)
    }
    val events = snapshot.events.filter { !it.isLesson() && (lessonTargetId(it) in link.ids || it.id in link.ids) }
    return NotifyRoute(
        tab = "Mehr",
        section = "Termine",
        highlightIds = if (events.isNotEmpty()) events.map(::lessonTargetId) else link.ids,
        hint = if (events.isEmpty() && messages.isEmpty()) "Der Termin ist nicht mehr im letzten Stand." else "",
        found = events.isNotEmpty(),
    )
}

internal fun defaultTarget(category: String): String = when (category) {
    "grade" -> "grades"
    "timetable" -> "plan"
    "exam" -> "exams"
    "absence", "deadline" -> "absences"
    "settings" -> "settings"
    else -> "events"
}

fun todayIso(zone: ZoneId = ZoneId.of("Europe/Zurich")): String = LocalDate.now(zone).toString()
