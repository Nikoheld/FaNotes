package ch.fasrv.fanotes.schulnetz

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.escapeJson
import ch.fasrv.fanotes.json.parseJson

private val LIST_KEYS = setOf(
    "data", "items", "results", "grades", "events", "exams", "absences", "homework",
    "notifications", "vacations", "messages", "value", "lateness",
)

fun parseRawSnapshot(raw: SchulnetzRaw, fetchedAt: String = ""): SchulnetzSnapshot {
    val absences = parseAbsences(raw.absences) + parseLateness(raw.lateness)
    return SchulnetzSnapshot(
        fetchedAt = fetchedAt,
        profile = parseProfile(raw.me),
        grades = parseGrades(raw.grades),
        events = parseEvents(raw.events),
        exams = parseEvents(raw.exams),
        absences = absences,
        homework = parseHomework(raw.homework),
        messages = parseMessages(raw.messages),
        vacations = parseVacations(raw.vacations),
        konto = parseKontoauszug(raw.kontoHtml.orEmpty()),
        startMessages = parseStartMessages(raw.startHtml.orEmpty()),
    )
}

fun parseProfile(json: String?): SchoolProfile? {
    val obj = rootObject(json) ?: return null
    val classes = obj.array("regularClasses")?.items.orEmpty().mapNotNull { it as? JsonValue.Obj }
    val className = classes.firstOrNull()?.flexString("className", "name", "classId").orEmpty()
    val profile = SchoolProfile(
        id = obj.flexString("id", "idNr"),
        firstName = obj.flexString("firstName", "firstname", "vorname"),
        lastName = obj.flexString("lastName", "lastname", "name"),
        className = className,
        email = obj.flexString("email"),
    )
    return profile.takeIf { it.displayName.isNotBlank() || it.id.isNotBlank() }
}

fun parseGrades(json: String?): List<SchoolGrade> = jsonObjects(json).mapNotNull { obj ->
    val course = obj.flexString("course", "courseName", "kurs")
    val subject = obj.flexString("subject", "fach")
    val title = obj.flexString("title", "name", "description")
    val date = obj.flexString("date", "examDate").take(10)
    val mark = parseMark(obj.flexString("mark", "grade", "note"))
    val courseGrade = parseMark(obj.flexString("courseGrade", "classGrade", "average"))
    if (course.isBlank() && subject.isBlank() && title.isBlank() && mark == null) return@mapNotNull null
    val id = obj.flexString("id").ifBlank { stableId("grade", course, subject, title, date, numKey(mark)) }
    SchoolGrade(
        id = id,
        course = course,
        courseId = obj.flexString("courseId", "courseToken"),
        subject = subject,
        title = title,
        date = date,
        mark = mark,
        weight = parseWeight(obj.flexString("weight", "gewichtung")),
        confirmed = obj.flexBool("isConfirmed", "confirmed"),
        courseGrade = courseGrade,
        comment = obj.flexString("comment", "remark"),
    )
}

fun parseEvents(json: String?): List<AgendaEvent> = jsonObjects(json).mapNotNull { obj ->
    val start = obj.flexString("startDate", "start", "from")
    val text = obj.flexString("text", "title", "name")
    val courseName = obj.flexString("courseName", "course", "subject")
    if (start.isBlank() && text.isBlank() && courseName.isBlank()) return@mapNotNull null
    val end = obj.flexString("endDate", "end", "to").ifBlank { start }
    val id = obj.flexString("id").ifBlank { stableId("event", start, end, text, courseName) }
    AgendaEvent(
        id = id,
        start = start,
        end = end,
        text = text,
        comment = obj.flexString("comment"),
        room = obj.flexString("roomToken", "room", "roomName"),
        teachers = obj.flexStrings("teachers", "teacher"),
        courseId = obj.flexString("courseId", "courseToken"),
        courseName = courseName,
        status = obj.flexString("status"),
        eventType = obj.flexString("eventType", "type"),
        color = obj.flexString("color"),
        timetableText = obj.flexString("timetableText"),
    )
}

fun parseAbsences(json: String?): List<SchoolAbsence> = jsonObjects(json).mapNotNull { obj ->
    val from = obj.flexString("dateFrom", "date", "from")
    val subject = obj.flexString("subject", "course", "courseName")
    val reason = obj.flexString("reason", "comment")
    if (from.isBlank() && subject.isBlank() && reason.isBlank()) return@mapNotNull null
    val id = obj.flexString("id").ifBlank { stableId("absence", from, subject, reason) }
    SchoolAbsence(
        id = id,
        dateFrom = from.take(10),
        dateTo = obj.flexString("dateTo", "to").take(10).ifBlank { from.take(10) },
        hourFrom = obj.flexString("hourFrom", "fromTime"),
        hourTo = obj.flexString("hourTo", "toTime"),
        subject = subject,
        reason = reason,
        excused = obj.flexBool("isExcused", "excused"),
        acknowledged = obj.flexBool("isAcknowledged", "acknowledged"),
        status = obj.flexString("statusEAE", "status").ifBlank { obj.flexString("statusEAB") },
    )
}

fun parseLateness(json: String?): List<SchoolAbsence> = jsonObjects(json).mapNotNull { obj ->
    val date = obj.flexString("date").take(10)
    if (date.isBlank()) return@mapNotNull null
    val id = obj.flexString("id").ifBlank { stableId("late", date, obj.flexString("courseToken")) }
    SchoolAbsence(
        id = id,
        dateFrom = date,
        dateTo = date,
        hourFrom = obj.flexString("startTime"),
        hourTo = obj.flexString("endTime"),
        subject = obj.flexString("courseToken", "courseId"),
        reason = obj.flexString("reason").ifBlank { "Verspätung" },
        excused = obj.flexBool("excused"),
        acknowledged = obj.flexBool("excused"),
        status = if (obj.flexBool("excused")) "entschuldigt" else "offen",
    )
}

fun parseHomework(json: String?): List<SchoolHomework> = jsonObjects(json).mapNotNull { obj ->
    val title = obj.flexString("title", "name", "text")
    if (title.isBlank()) return@mapNotNull null
    SchoolHomework(
        id = obj.flexString("id").ifBlank { stableId("hw", title, obj.flexString("dueDate")) },
        title = title,
        description = obj.flexString("description", "comment", "notes"),
        dueDate = obj.flexString("dueDate", "date").take(10),
        courseId = obj.flexString("courseId"),
        courseName = obj.flexString("courseName", "course", "subject"),
    )
}

fun parseMessages(json: String?): List<SchoolMessage> {
    if (json.isNullOrBlank()) return emptyList()
    val root = runCatching { parseJson(json) }.getOrNull() ?: return emptyList()
    if (root is JsonValue.Arr && root.items.all { it is JsonValue.Str }) {
        return root.items.mapIndexedNotNull { index, item ->
            val text = (item as? JsonValue.Str)?.value?.trim().orEmpty()
            if (text.isEmpty()) null else SchoolMessage(stableId("msg", text), "Mitteilung", text, "")
        }
    }
    return jsonObjects(json).mapNotNull { obj ->
        val body = obj.flexString("body", "message", "text", "content", "description")
        val title = obj.flexString("title", "subject", "name")
        if (body.isBlank() && title.isBlank()) return@mapNotNull null
        SchoolMessage(
            id = obj.flexString("id").ifBlank { stableId("msg", title, body) },
            title = title,
            body = body.ifBlank { title },
            at = obj.flexString("date", "createdAt", "at", "timestamp"),
        )
    }
}

fun parseVacations(json: String?): List<SchoolVacation> = jsonObjects(json).mapNotNull { obj ->
    val name = obj.flexString("name", "title", "text")
    val start = obj.flexString("startDate", "start", "from", "dateFrom")
    if (name.isBlank() && start.isBlank()) return@mapNotNull null
    SchoolVacation(
        id = obj.flexString("id").ifBlank { stableId("vac", name, start) },
        name = name.ifBlank { "Ferien" },
        start = start,
        end = obj.flexString("endDate", "end", "to", "dateTo"),
    )
}

fun parseMark(raw: String): Double? {
    val cleaned = raw.trim().replace(" ", "").replace(",", ".")
    if (cleaned.isEmpty() || cleaned == "-" || cleaned.equals("null", true)) return null
    val value = cleaned.toDoubleOrNull() ?: return null
    if (!value.isFinite() || value < 1.0 || value > 6.0) return null
    return value
}

fun parseWeight(raw: String): Double {
    val cleaned = raw.trim().replace(",", ".")
    val value = cleaned.toDoubleOrNull()
    if (value == null || !value.isFinite() || value <= 0.0 || value > 100.0) return 1.0
    return value
}

fun SchulnetzSnapshot.toNormalizedJson(): String = buildString {
    append("{\"revision\":").append(revision)
    append(",\"fetchedAt\":").append(escapeJson(fetchedAt))
    append(",\"profile\":")
    val profile = profile
    if (profile == null) append("null") else {
        append("{")
        append("\"id\":").append(escapeJson(profile.id))
        append(",\"firstName\":").append(escapeJson(profile.firstName))
        append(",\"lastName\":").append(escapeJson(profile.lastName))
        append(",\"className\":").append(escapeJson(profile.className))
        append(",\"email\":").append(escapeJson(profile.email))
        append("}")
    }
    append(",\"grades\":").appendGrades(grades)
    append(",\"events\":").appendEvents(events)
    append(",\"exams\":").appendEvents(exams)
    append(",\"absences\":").appendAbsences(absences)
    append(",\"homework\":").appendHomework(homework)
    append(",\"messages\":").appendMessages(messages)
    append(",\"vacations\":").appendVacations(vacations)
    append(",\"konto\":").appendKonto(konto)
    append(",\"startMessages\":[")
    startMessages.forEachIndexed { index, line ->
        if (index > 0) append(',')
        append(escapeJson(line))
    }
    append("],\"readErrors\":[")
    readErrors.forEachIndexed { index, line ->
        if (index > 0) append(',')
        append(escapeJson(line))
    }
    append("]}")
}

fun parseNormalizedSnapshot(json: String): SchulnetzSnapshot? {
    val obj = rootObject(json) ?: return null
    return SchulnetzSnapshot(
        revision = obj.double("revision")?.toLong() ?: 0L,
        fetchedAt = obj.flexString("fetchedAt"),
        profile = obj.obj("profile")?.let { profile ->
            SchoolProfile(
                id = profile.flexString("id"),
                firstName = profile.flexString("firstName"),
                lastName = profile.flexString("lastName"),
                className = profile.flexString("className"),
                email = profile.flexString("email"),
            )
        },
        grades = obj.array("grades")?.items.orEmpty().mapNotNull { (it as? JsonValue.Obj)?.toGrade() },
        events = obj.array("events")?.items.orEmpty().mapNotNull { (it as? JsonValue.Obj)?.toEvent() },
        exams = obj.array("exams")?.items.orEmpty().mapNotNull { (it as? JsonValue.Obj)?.toEvent() },
        absences = obj.array("absences")?.items.orEmpty().mapNotNull { (it as? JsonValue.Obj)?.toAbsence() },
        homework = obj.array("homework")?.items.orEmpty().mapNotNull { (it as? JsonValue.Obj)?.toHomework() },
        messages = obj.array("messages")?.items.orEmpty().mapNotNull { (it as? JsonValue.Obj)?.toMessage() },
        vacations = obj.array("vacations")?.items.orEmpty().mapNotNull { (it as? JsonValue.Obj)?.toVacation() },
        konto = obj.array("konto")?.items.orEmpty().mapNotNull { (it as? JsonValue.Obj)?.toKonto() },
        startMessages = obj.array("startMessages")?.items.orEmpty().mapNotNull { (it as? JsonValue.Str)?.value },
        readErrors = obj.array("readErrors")?.items.orEmpty().mapNotNull { (it as? JsonValue.Str)?.value },
    )
}

private fun JsonValue.Obj.toGrade(): SchoolGrade? {
    val id = flexString("id")
    if (id.isBlank()) return null
    return SchoolGrade(
        id = id,
        course = flexString("course"),
        courseId = flexString("courseId"),
        subject = flexString("subject"),
        title = flexString("title"),
        date = flexString("date"),
        mark = doubleOrNull("mark"),
        weight = doubleOrNull("weight") ?: 1.0,
        confirmed = flexBool("confirmed"),
        courseGrade = doubleOrNull("courseGrade"),
        comment = flexString("comment"),
    )
}

private fun JsonValue.Obj.toEvent(): AgendaEvent? {
    val id = flexString("id")
    if (id.isBlank()) return null
    return AgendaEvent(
        id = id,
        start = flexString("start"),
        end = flexString("end"),
        text = flexString("text"),
        comment = flexString("comment"),
        room = flexString("room"),
        teachers = flexStrings("teachers"),
        courseId = flexString("courseId"),
        courseName = flexString("courseName"),
        status = flexString("status"),
        eventType = flexString("eventType"),
        color = flexString("color"),
        timetableText = flexString("timetableText"),
    )
}

private fun JsonValue.Obj.toAbsence(): SchoolAbsence? {
    val id = flexString("id")
    if (id.isBlank()) return null
    return SchoolAbsence(
        id, flexString("dateFrom"), flexString("dateTo"), flexString("hourFrom"), flexString("hourTo"),
        flexString("subject"), flexString("reason"), flexBool("excused"), flexBool("acknowledged"), flexString("status"),
    )
}

private fun JsonValue.Obj.toHomework(): SchoolHomework? {
    val title = flexString("title")
    if (title.isBlank()) return null
    return SchoolHomework(flexString("id").ifBlank { stableId("hw", title) }, title, flexString("description"), flexString("dueDate"), flexString("courseId"), flexString("courseName"))
}

private fun JsonValue.Obj.toMessage(): SchoolMessage? {
    val body = flexString("body")
    val title = flexString("title")
    if (body.isBlank() && title.isBlank()) return null
    return SchoolMessage(flexString("id").ifBlank { stableId("msg", title, body) }, title, body, flexString("at"))
}

private fun JsonValue.Obj.toVacation(): SchoolVacation? {
    val name = flexString("name")
    if (name.isBlank()) return null
    return SchoolVacation(flexString("id").ifBlank { stableId("vac", name) }, name, flexString("start"), flexString("end"))
}

private fun JsonValue.Obj.toKonto(): KontoLine? {
    val label = flexString("label")
    val date = flexString("date")
    if (label.isBlank() && date.isBlank()) return null
    return KontoLine(date, label, flexString("amount"), flexString("balance"))
}

private fun StringBuilder.appendGrades(grades: List<SchoolGrade>) {
    append('[')
    grades.forEachIndexed { index, grade ->
        if (index > 0) append(',')
        append("{\"id\":").append(escapeJson(grade.id))
        append(",\"course\":").append(escapeJson(grade.course))
        append(",\"courseId\":").append(escapeJson(grade.courseId))
        append(",\"subject\":").append(escapeJson(grade.subject))
        append(",\"title\":").append(escapeJson(grade.title))
        append(",\"date\":").append(escapeJson(grade.date))
        append(",\"mark\":").append(jsonNumberOrNull(grade.mark))
        append(",\"weight\":").append(jsonNumberOrNull(grade.weight))
        append(",\"confirmed\":").append(grade.confirmed)
        append(",\"courseGrade\":").append(jsonNumberOrNull(grade.courseGrade))
        append(",\"comment\":").append(escapeJson(grade.comment))
        append('}')
    }
    append(']')
}

private fun StringBuilder.appendEvents(events: List<AgendaEvent>) {
    append('[')
    events.forEachIndexed { index, event ->
        if (index > 0) append(',')
        append("{\"id\":").append(escapeJson(event.id))
        append(",\"start\":").append(escapeJson(event.start))
        append(",\"end\":").append(escapeJson(event.end))
        append(",\"text\":").append(escapeJson(event.text))
        append(",\"comment\":").append(escapeJson(event.comment))
        append(",\"room\":").append(escapeJson(event.room))
        append(",\"teachers\":[")
        event.teachers.forEachIndexed { teacherIndex, teacher ->
            if (teacherIndex > 0) append(',')
            append(escapeJson(teacher))
        }
        append("],\"courseId\":").append(escapeJson(event.courseId))
        append(",\"courseName\":").append(escapeJson(event.courseName))
        append(",\"status\":").append(escapeJson(event.status))
        append(",\"eventType\":").append(escapeJson(event.eventType))
        append(",\"color\":").append(escapeJson(event.color))
        append(",\"timetableText\":").append(escapeJson(event.timetableText))
        append('}')
    }
    append(']')
}

private fun StringBuilder.appendAbsences(items: List<SchoolAbsence>) {
    append('[')
    items.forEachIndexed { index, item ->
        if (index > 0) append(',')
        append("{\"id\":").append(escapeJson(item.id))
        append(",\"dateFrom\":").append(escapeJson(item.dateFrom))
        append(",\"dateTo\":").append(escapeJson(item.dateTo))
        append(",\"hourFrom\":").append(escapeJson(item.hourFrom))
        append(",\"hourTo\":").append(escapeJson(item.hourTo))
        append(",\"subject\":").append(escapeJson(item.subject))
        append(",\"reason\":").append(escapeJson(item.reason))
        append(",\"excused\":").append(item.excused)
        append(",\"acknowledged\":").append(item.acknowledged)
        append(",\"status\":").append(escapeJson(item.status))
        append('}')
    }
    append(']')
}

private fun StringBuilder.appendHomework(items: List<SchoolHomework>) {
    append('[')
    items.forEachIndexed { index, item ->
        if (index > 0) append(',')
        append("{\"id\":").append(escapeJson(item.id))
        append(",\"title\":").append(escapeJson(item.title))
        append(",\"description\":").append(escapeJson(item.description))
        append(",\"dueDate\":").append(escapeJson(item.dueDate))
        append(",\"courseId\":").append(escapeJson(item.courseId))
        append(",\"courseName\":").append(escapeJson(item.courseName))
        append('}')
    }
    append(']')
}

private fun StringBuilder.appendMessages(items: List<SchoolMessage>) {
    append('[')
    items.forEachIndexed { index, item ->
        if (index > 0) append(',')
        append("{\"id\":").append(escapeJson(item.id))
        append(",\"title\":").append(escapeJson(item.title))
        append(",\"body\":").append(escapeJson(item.body))
        append(",\"at\":").append(escapeJson(item.at))
        append('}')
    }
    append(']')
}

private fun StringBuilder.appendVacations(items: List<SchoolVacation>) {
    append('[')
    items.forEachIndexed { index, item ->
        if (index > 0) append(',')
        append("{\"id\":").append(escapeJson(item.id))
        append(",\"name\":").append(escapeJson(item.name))
        append(",\"start\":").append(escapeJson(item.start))
        append(",\"end\":").append(escapeJson(item.end))
        append('}')
    }
    append(']')
}

private fun StringBuilder.appendKonto(items: List<KontoLine>) {
    append('[')
    items.forEachIndexed { index, item ->
        if (index > 0) append(',')
        append("{\"date\":").append(escapeJson(item.date))
        append(",\"label\":").append(escapeJson(item.label))
        append(",\"amount\":").append(escapeJson(item.amount))
        append(",\"balance\":").append(escapeJson(item.balance))
        append('}')
    }
    append(']')
}

private fun jsonNumberOrNull(value: Double?): String {
    if (value == null || !value.isFinite()) return "null"
    return numKey(value).ifBlank { "null" }
}

internal fun jsonObjects(json: String?): List<JsonValue.Obj> {
    if (json.isNullOrBlank()) return emptyList()
    val root = runCatching { parseJson(json) }.getOrNull() ?: return emptyList()
    val array = when (root) {
        is JsonValue.Arr -> root
        is JsonValue.Obj -> LIST_KEYS.firstNotNullOfOrNull { root.array(it) }
        else -> null
    }
    if (array != null) return array.items.mapNotNull { it as? JsonValue.Obj }
    val single = root as? JsonValue.Obj ?: return emptyList()
    return if (single.fields.keys.any { it in setOf("mark", "startDate", "dateFrom", "title", "id") }) listOf(single) else emptyList()
}

private fun rootObject(json: String?): JsonValue.Obj? {
    if (json.isNullOrBlank()) return null
    return runCatching { parseJson(json) as? JsonValue.Obj }.getOrNull()
}

internal fun JsonValue.Obj.flexString(vararg keys: String): String {
    for (key in keys) {
        when (val value = this[key]) {
            is JsonValue.Str -> if (value.value.isNotBlank()) return value.value.trim()
            is JsonValue.Num -> return value.raw.trim()
            is JsonValue.Bool -> return if (value.value) "true" else "false"
            else -> Unit
        }
    }
    return ""
}

internal fun JsonValue.Obj.flexBool(vararg keys: String): Boolean {
    for (key in keys) {
        when (val value = this[key]) {
            is JsonValue.Bool -> return value.value
            is JsonValue.Num -> return value.value != 0.0
            is JsonValue.Str -> return value.value.equals("true", true) || value.value == "1"
            else -> Unit
        }
    }
    return false
}

internal fun JsonValue.Obj.flexStrings(vararg keys: String): List<String> {
    for (key in keys) {
        when (val value = this[key]) {
            is JsonValue.Arr -> return value.items.mapNotNull { item ->
                when (item) {
                    is JsonValue.Str -> item.value.trim().takeIf { it.isNotEmpty() }
                    is JsonValue.Obj -> item.flexString("name", "token", "id").takeIf { it.isNotEmpty() }
                    else -> null
                }
            }
            is JsonValue.Str -> return value.value.split(',').map { it.trim() }.filter { it.isNotEmpty() }
            else -> Unit
        }
    }
    return emptyList()
}

private fun JsonValue.Obj.doubleOrNull(key: String): Double? = when (val value = this[key]) {
    is JsonValue.Num -> value.value
    is JsonValue.Str -> parseMark(value.value) ?: value.value.replace(",", ".").toDoubleOrNull()
    else -> null
}

internal fun stableId(prefix: String, vararg parts: String): String {
    var hash = 2166136261u
    val basis = parts.joinToString("|")
    for (char in basis) {
        hash = hash xor char.code.toUInt()
        hash *= 16777619u
    }
    return "$prefix-${hash.toString(16)}"
}
