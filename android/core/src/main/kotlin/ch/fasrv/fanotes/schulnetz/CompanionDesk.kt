package ch.fasrv.fanotes.schulnetz

import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit

data class CompanionBadge(val id: String, val title: String, val detail: String, val earned: Boolean)

/** Local profile. Nothing here is compared with another account. */
fun companionBadges(notesWritten: Int, streakDays: Int, highestMark: Double?): List<CompanionBadge> = listOf(
    CompanionBadge("notes-1", "Erste Notiz", "Eine Notiz geschrieben", notesWritten >= 1),
    CompanionBadge("notes-10", "Zehn Notizen", "Zehn Notizen im Konto", notesWritten >= 10),
    CompanionBadge("streak-3", "Drei Tage", "Die App an drei Tagen hintereinander geöffnet", streakDays >= 3),
    CompanionBadge("first-six", "Erste 6", "Eine Note mit der Bewertung 6", highestMark != null && highestMark >= 5.999),
)

fun openingStreak(days: Set<String>, today: LocalDate): Int {
    var cursor = today
    var count = 0
    while (days.contains(cursor.toString())) {
        count += 1
        cursor = cursor.minusDays(1)
    }
    return count
}

/**
 * Reminder before an excuse deadline. Excused absences and missing dates produce nothing.
 * The captured Schulnetz pages had no open absence, so this is driven by the date field when a page does contain one.
 */
fun excuseReminders(absences: List<SchoolAbsence>, today: LocalDate, withinDays: Int = 2): List<SchulnetzChange> {
    if (withinDays < 0) return emptyList()
    return absences.mapNotNull { absence ->
        if (absence.excused) return@mapNotNull null
        val deadline = parseSchoolDate(absence.excuseUntil) ?: return@mapNotNull null
        val days = ChronoUnit.DAYS.between(today, deadline)
        if (days < 0 || days > withinDays) return@mapNotNull null
        val whenText = if (days == 0L) "heute" else if (days == 1L) "morgen" else "in $days Tagen"
        linkedChange(
            id = "deadline:${absence.id}:${deadline}",
            category = "deadline",
            title = "Entschuldigung läuft ab",
            body = listOf(absence.subject.ifBlank { "Absenz" }, absence.reason, "Frist $whenText (${deadline.format(DateTimeFormatter.ofPattern("d.M.yyyy"))})").filter { it.isNotBlank() }.joinToString(" · "),
            targetId = absenceTargetId(absence),
            date = absence.dateFrom.take(10),
        )
    }
}

fun parseSchoolDate(raw: String): LocalDate? {
    val match = Regex("""(\d{1,2})\.(\d{1,2})\.(\d{4})""").find(raw) ?: return null
    return runCatching {
        LocalDate.of(match.groupValues[3].toInt(), match.groupValues[2].toInt(), match.groupValues[1].toInt())
    }.getOrNull()
}

data class HiddenLesson(
    val id: String,
    val mode: String,
    val eventId: String,
    val date: String,
    val subject: String,
    val weekday: Int,
    val start: String,
)

val TODAY_CARD_IDS = listOf("pluspunkte", "lessons", "exam", "grades", "absences", "events", "tasks")

data class DeskPrefs(
    val accent: String = "#2a6f97",
    val theme: String = "system",
    val amoled: Boolean = false,
    val todayCards: List<String> = TODAY_CARD_IDS,
    val hiddenCards: List<String> = emptyList(),
    val planCompact: Boolean = false,
    val showWeekend: Boolean = false,
    val dayStartHour: Int = 7,
    val dayEndHour: Int = 18,
    val gradeDecimals: Int = 2,
    val showPluspunkte: Boolean = true,
    val gradeSort: String = "name",
    val courseAliases: Map<String, String> = emptyMap(),
    val widgetCompact: Boolean = false,
    val startTab: String = "Heute",
    val navBar: List<String> = DEFAULT_NAV_BAR,
    /** With guess-the-grade, a hidden mark opens only after a long press. */
    val revealLongPress: Boolean = false,
    /** Half-class choice: group set key to the chosen course labels. Missing or empty shows all. */
    val groupChoices: Map<String, List<String>> = emptyMap(),
)

fun lessonClock(event: AgendaEvent, zone: java.time.ZoneId = java.time.ZoneId.of("Europe/Zurich")): String {
    val clock = event.startsAt(zone)?.atZone(zone)?.toLocalTime()?.toString()?.take(5).orEmpty()
    val end = schulnetzClock(event.end)
    if (clock == "00:00" && (schulnetzClock(event.start).let { it.isBlank() || it == "00:00" }) && (end.isBlank() || end == "00:00")) return ""
    return clock
}

fun lessonWeekday(event: AgendaEvent, zone: java.time.ZoneId = java.time.ZoneId.of("Europe/Zurich")): Int =
    event.startsAt(zone)?.atZone(zone)?.dayOfWeek?.value ?: 0

fun lessonDate(event: AgendaEvent, zone: java.time.ZoneId = java.time.ZoneId.of("Europe/Zurich")): String =
    event.startsAt(zone)?.atZone(zone)?.toLocalDate()?.toString().orEmpty()

fun hideOnce(event: AgendaEvent, existing: List<HiddenLesson>): List<HiddenLesson> {
    val rule = HiddenLesson(
        id = "once:${event.id}:${lessonDate(event)}",
        mode = "once",
        eventId = event.id,
        date = lessonDate(event),
        subject = event.label,
        weekday = lessonWeekday(event),
        start = lessonClock(event),
    )
    return existing.filterNot { it.id == rule.id } + rule
}

fun hideSeries(event: AgendaEvent, existing: List<HiddenLesson>): List<HiddenLesson> {
    val rule = HiddenLesson(
        id = "series:${event.label.lowercase().trim()}|${lessonWeekday(event)}|${lessonClock(event)}",
        mode = "series",
        eventId = event.id,
        date = "",
        subject = event.label,
        weekday = lessonWeekday(event),
        start = lessonClock(event),
    )
    return existing.filterNot { it.id == rule.id } + rule
}

fun lessonHidden(event: AgendaEvent, rules: List<HiddenLesson>, zone: java.time.ZoneId = java.time.ZoneId.of("Europe/Zurich")): Boolean {
    if (rules.isEmpty()) return false
    val date = lessonDate(event, zone)
    val weekday = lessonWeekday(event, zone)
    val start = lessonClock(event, zone)
    val subject = event.label.trim().lowercase()
    return rules.any { rule ->
        when (rule.mode) {
            "once" -> rule.eventId == event.id && (rule.date.isBlank() || rule.date == date)
            else -> {
                val sameSubject = rule.subject.trim().lowercase() == subject || colorKeys(rule.subject).any { it in colorKeys(event.label) }
                sameSubject && rule.weekday == weekday && rule.start == start
            }
        }
    }
}

fun visibleEvents(
    events: List<AgendaEvent>,
    rules: List<HiddenLesson>,
    zone: java.time.ZoneId = java.time.ZoneId.of("Europe/Zurich"),
    groupSets: List<GroupSet> = emptyList(),
    groupChoices: Map<String, List<String>> = emptyMap(),
): List<AgendaEvent> =
    events.filterNot { lessonHidden(it, rules, zone) || lessonHiddenByGroup(it, groupSets, groupChoices) }

/** Group sets worth detecting only when a choice exists; empty otherwise. */
fun activeGroupSets(events: List<AgendaEvent>, groupChoices: Map<String, List<String>>): List<GroupSet> =
    if (groupChoices.isEmpty()) emptyList() else detectGroupSets(events)

fun eventInHours(event: AgendaEvent, startHour: Int, endHour: Int, zone: java.time.ZoneId = java.time.ZoneId.of("Europe/Zurich")): Boolean {
    val hour = event.startsAt(zone)?.atZone(zone)?.hour ?: return true
    val from = startHour.coerceIn(0, 23)
    val to = endHour.coerceIn(0, 24)
    return hour in from until to.coerceAtLeast(from + 1)
}

fun courseAlias(name: String, aliases: Map<String, String>): String {
    val keys = colorKeys(name).toMutableList()
    val code = Regex("""\(([^)]+)\)\s*$""").find(name.trim())?.groupValues?.get(1).orEmpty()
    if (code.isNotEmpty()) keys += colorKeys(code)
    for (key in keys) aliases[key]?.trim()?.takeIf { it.isNotEmpty() }?.let { return it }
    return name
}

fun sortCourses(courses: List<CourseSummary>, sort: String): List<CourseSummary> = when (sort) {
    "average" -> courses.sortedByDescending { it.average ?: -1.0 }
    "pluspunkte" -> courses.sortedByDescending { it.pluspunkte }
    else -> courses.sortedBy { it.label.lowercase() }
}

fun shownTodayCards(prefs: DeskPrefs): List<String> {
    val order = prefs.todayCards.ifEmpty { TODAY_CARD_IDS }.distinct()
    val rest = TODAY_CARD_IDS.filter { it !in order }
    val hidden = prefs.hiddenCards.toSet()
    return (order + rest).filter { it in TODAY_CARD_IDS && it !in hidden }
}

fun changeIsHidden(
    change: SchulnetzChange,
    rules: List<HiddenLesson>,
    groupSets: List<GroupSet> = emptyList(),
    groupChoices: Map<String, List<String>> = emptyMap(),
): Boolean {
    if (changeHiddenByGroup(change, groupSets, groupChoices)) return true
    if (change.category != "timetable" || rules.isEmpty()) return false
    val eventId = change.id.split(':').getOrNull(1).orEmpty()
    if (rules.any { it.eventId == eventId && it.eventId.isNotBlank() }) return true
    val body = change.body.lowercase()
    return rules.any { rule ->
        if (rule.mode != "series") return@any false
        val subject = rule.subject.trim().lowercase()
        subject.isNotBlank() && body.contains(subject.take(8).lowercase()) && (rule.start.isBlank() || body.contains(rule.start))
    }
}

fun parseHiddenLessons(json: String): List<HiddenLesson> {
    val obj = runCatching { ch.fasrv.fanotes.json.parseJson(json) as? ch.fasrv.fanotes.json.JsonValue.Obj }.getOrNull() ?: return emptyList()
    return obj.array("items")?.items.orEmpty().mapNotNull { item ->
        val row = item as? ch.fasrv.fanotes.json.JsonValue.Obj ?: return@mapNotNull null
        val id = row.string("id").orEmpty()
        if (id.isBlank()) return@mapNotNull null
        HiddenLesson(
            id = id,
            mode = if (row.string("mode") == "once") "once" else "series",
            eventId = row.string("eventId").orEmpty(),
            date = row.string("date").orEmpty(),
            subject = row.string("subject").orEmpty(),
            weekday = row.double("weekday")?.toInt() ?: 0,
            start = row.string("start").orEmpty(),
        )
    }
}

fun serializeHiddenLessons(rules: List<HiddenLesson>): String = buildString {
    append("{\"items\":[")
    rules.forEachIndexed { index, rule ->
        if (index > 0) append(',')
        append("{\"id\":").append(ch.fasrv.fanotes.json.escapeJson(rule.id))
        append(",\"mode\":").append(ch.fasrv.fanotes.json.escapeJson(rule.mode))
        append(",\"eventId\":").append(ch.fasrv.fanotes.json.escapeJson(rule.eventId))
        append(",\"date\":").append(ch.fasrv.fanotes.json.escapeJson(rule.date))
        append(",\"subject\":").append(ch.fasrv.fanotes.json.escapeJson(rule.subject))
        append(",\"weekday\":").append(rule.weekday)
        append(",\"start\":").append(ch.fasrv.fanotes.json.escapeJson(rule.start))
        append('}')
    }
    append("]}")
}

fun parseDeskPrefs(json: String): DeskPrefs {
    val obj = runCatching { ch.fasrv.fanotes.json.parseJson(json) as? ch.fasrv.fanotes.json.JsonValue.Obj }.getOrNull() ?: return DeskPrefs()
    val accent = obj.string("accent").orEmpty().ifBlank { "#2a6f97" }
    val cards = obj.array("todayCards")?.items?.mapNotNull { (it as? ch.fasrv.fanotes.json.JsonValue.Str)?.value } ?: TODAY_CARD_IDS
    val hidden = obj.array("hiddenCards")?.items?.mapNotNull { (it as? ch.fasrv.fanotes.json.JsonValue.Str)?.value } ?: emptyList()
    val aliases = linkedMapOf<String, String>()
    obj.obj("courseAliases")?.fields?.forEach { (key, value) ->
        val name = (value as? ch.fasrv.fanotes.json.JsonValue.Str)?.value ?: return@forEach
        if (key.isNotBlank() && name.isNotBlank()) aliases[key.lowercase()] = name
    }
    val choices = linkedMapOf<String, List<String>>()
    obj.obj("groupChoices")?.fields?.forEach { (key, value) ->
        val labels = (value as? ch.fasrv.fanotes.json.JsonValue.Arr)?.items?.mapNotNull { (it as? ch.fasrv.fanotes.json.JsonValue.Str)?.value?.takeIf(String::isNotBlank) }.orEmpty()
        if (key.isNotBlank() && labels.isNotEmpty()) choices[key] = labels
    }
    return DeskPrefs(
        accent = if (Regex("^#[0-9A-Fa-f]{6}$").matches(accent)) accent.lowercase() else "#2a6f97",
        theme = obj.string("theme").orEmpty().ifBlank { "system" },
        amoled = obj.bool("amoled") == true,
        todayCards = cards.ifEmpty { TODAY_CARD_IDS },
        hiddenCards = hidden,
        planCompact = obj.bool("planCompact") == true,
        showWeekend = obj.bool("showWeekend") == true,
        dayStartHour = obj.double("dayStartHour")?.toInt()?.coerceIn(0, 23) ?: 7,
        dayEndHour = obj.double("dayEndHour")?.toInt()?.coerceIn(1, 24) ?: 18,
        gradeDecimals = obj.double("gradeDecimals")?.toInt()?.coerceIn(0, 3) ?: 2,
        showPluspunkte = obj.bool("showPluspunkte") != false,
        gradeSort = obj.string("gradeSort").orEmpty().ifBlank { "name" },
        courseAliases = aliases,
        widgetCompact = obj.bool("widgetCompact") == true,
        startTab = obj.string("startTab").orEmpty().ifBlank { "Heute" },
        navBar = validateNavBar(obj.array("navBar")?.items?.mapNotNull { (it as? ch.fasrv.fanotes.json.JsonValue.Str)?.value }),
        revealLongPress = obj.bool("revealLongPress") == true,
        groupChoices = choices,
    )
}

fun serializeDeskPrefs(prefs: DeskPrefs): String = buildString {
    append("{\"accent\":").append(ch.fasrv.fanotes.json.escapeJson(prefs.accent))
    append(",\"theme\":").append(ch.fasrv.fanotes.json.escapeJson(prefs.theme))
    append(",\"amoled\":").append(prefs.amoled)
    append(",\"todayCards\":[")
    prefs.todayCards.forEachIndexed { index, id ->
        if (index > 0) append(',')
        append(ch.fasrv.fanotes.json.escapeJson(id))
    }
    append("],\"hiddenCards\":[")
    prefs.hiddenCards.forEachIndexed { index, id ->
        if (index > 0) append(',')
        append(ch.fasrv.fanotes.json.escapeJson(id))
    }
    append("],\"planCompact\":").append(prefs.planCompact)
    append(",\"showWeekend\":").append(prefs.showWeekend)
    append(",\"dayStartHour\":").append(prefs.dayStartHour)
    append(",\"dayEndHour\":").append(prefs.dayEndHour)
    append(",\"gradeDecimals\":").append(prefs.gradeDecimals)
    append(",\"showPluspunkte\":").append(prefs.showPluspunkte)
    append(",\"gradeSort\":").append(ch.fasrv.fanotes.json.escapeJson(prefs.gradeSort))
    append(",\"courseAliases\":{")
    prefs.courseAliases.entries.forEachIndexed { index, (key, value) ->
        if (index > 0) append(',')
        append(ch.fasrv.fanotes.json.escapeJson(key)).append(':').append(ch.fasrv.fanotes.json.escapeJson(value))
    }
    append("},\"widgetCompact\":").append(prefs.widgetCompact)
    append(",\"startTab\":").append(ch.fasrv.fanotes.json.escapeJson(prefs.startTab))
    append(",\"navBar\":[")
    validateNavBar(prefs.navBar).forEachIndexed { index, id ->
        if (index > 0) append(',')
        append(ch.fasrv.fanotes.json.escapeJson(id))
    }
    append("]")
    append(",\"revealLongPress\":").append(prefs.revealLongPress)
    append(",\"groupChoices\":{")
    prefs.groupChoices.entries.filter { it.value.isNotEmpty() }.forEachIndexed { index, (key, labels) ->
        if (index > 0) append(',')
        append(ch.fasrv.fanotes.json.escapeJson(key)).append(":[")
        labels.forEachIndexed { i, label -> if (i > 0) append(','); append(ch.fasrv.fanotes.json.escapeJson(label)) }
        append(']')
    }
    append('}')
    append('}')
}
