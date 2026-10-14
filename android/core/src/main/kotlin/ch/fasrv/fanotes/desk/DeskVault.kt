package ch.fasrv.fanotes.desk

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.jsonNumber
import ch.fasrv.fanotes.json.jsonObject
import ch.fasrv.fanotes.json.jsonString
import ch.fasrv.fanotes.json.parseJson
import java.time.LocalDate
import java.time.ZoneId
import java.util.UUID

/** Homework note shared with the desktop client (`Hausaufgaben.md`). */
const val HOMEWORK_NOTE_PATH = "Hausaufgaben.md"
private const val HOMEWORK_START = "<!-- fanotes-homework-v1"
private const val MARKER_END = "-->"

data class HomeworkTask(
    val id: String,
    val title: String,
    val notes: String = "",
    val subject: String = "",
    val dueDate: String? = null,
    val dueTime: String? = null,
    val done: Boolean = false,
    val kind: String = "homework",
    val priority: String = "normal",
    val createdAt: String = "",
    val updatedAt: String = "",
)

data class HomeworkDocument(val tasks: List<HomeworkTask>, val publishedIds: List<String> = emptyList())

fun parseHomeworkMarkdown(markdown: String): HomeworkDocument {
    val start = markdown.indexOf(HOMEWORK_START)
    val end = if (start >= 0) markdown.indexOf(MARKER_END, start + HOMEWORK_START.length) else -1
    if (start < 0 || end < 0) return HomeworkDocument(emptyList())
    return try {
        val parsed = parseJson(markdown.substring(start + HOMEWORK_START.length, end).trim()) as? JsonValue.Obj
            ?: return HomeworkDocument(emptyList())
        val tasks = parsed.array("tasks")?.items.orEmpty().mapNotNull { item ->
            val obj = item as? JsonValue.Obj ?: return@mapNotNull null
            val title = obj.string("title")?.trim().orEmpty()
            if (title.isEmpty()) return@mapNotNull null
            HomeworkTask(
                id = obj.string("id")?.take(80) ?: UUID.randomUUID().toString(),
                title = title.take(240),
                notes = obj.string("notes").orEmpty().take(4000),
                subject = obj.string("subject")?.trim().orEmpty().take(80),
                dueDate = obj.string("dueDate")?.takeIf { Regex("""\d{4}-\d{2}-\d{2}""").matches(it) },
                dueTime = obj.string("dueTime")?.takeIf { Regex("""\d{2}:\d{2}""").matches(it) },
                done = obj.bool("done") == true,
                kind = if (obj.string("kind") == "appointment") "appointment" else "homework",
                priority = if (obj.string("priority") == "high") "high" else "normal",
                createdAt = obj.string("createdAt").orEmpty(),
                updatedAt = obj.string("updatedAt").orEmpty(),
            )
        }
        val published = parsed.array("publishedIds")?.items.orEmpty().mapNotNull { (it as? JsonValue.Str)?.value }
        HomeworkDocument(tasks, published)
    } catch (_: Exception) {
        HomeworkDocument(emptyList())
    }
}

fun serializeHomeworkMarkdown(document: HomeworkDocument): String {
    val tasks = document.tasks.joinToString(",\n") { task ->
        buildString {
            append("""{"id":${json(task.id)},"title":${json(task.title)},"notes":${json(task.notes)}""")
            append(""","subject":${json(task.subject)},"dueDate":${task.dueDate?.let(::json) ?: "null"}""")
            append(""","dueTime":${task.dueTime?.let(::json) ?: "null"},"done":${task.done}""")
            append(""","kind":${json(task.kind)},"priority":${json(task.priority)}""")
            append(""","createdAt":${json(task.createdAt)},"updatedAt":${json(task.updatedAt)}}""")
        }
    }
    val published = if (document.publishedIds.isEmpty()) "" else ""","publishedIds":[${document.publishedIds.joinToString(",") { json(it) }}]"""
    return """
        |# Hausaufgaben
        |
        |Diese Notiz wird von der **Hausaufgaben-Ansicht** in FaNotes verwaltet.
        |Trage Aufgaben und Termine dort ein – sie bleiben in deinem lokalen Vault.
        |
        |$HOMEWORK_START
        |{
        |  "version": 1,
        |  "tasks": [
        |$tasks
        |  ]$published
        |}
        |$MARKER_END
        |
    """.trimMargin()
}

/** Calendar note shared with the desktop client (`Kalender.md`). */
const val CALENDAR_NOTE_PATH = "Kalender.md"
private const val CALENDAR_START = "<!-- fanotes-calendar-v1"

data class CalendarDef(val id: String, val name: String, val color: String, val visible: Boolean = true)
data class CalendarEvent(
    val id: String,
    val calendarId: String,
    val title: String,
    val start: String,
    val end: String,
    val allDay: Boolean = true,
    val location: String = "",
    val notes: String = "",
    val notePath: String = "",
    val recurrence: String = "none",
    val recurrenceUntil: String? = null,
    val exceptionDates: List<String> = emptyList(),
)
data class CalendarDocument(val calendars: List<CalendarDef>, val events: List<CalendarEvent>)

fun emptyCalendar(): CalendarDocument = CalendarDocument(
    listOf(
        CalendarDef("personal", "Persönlich", "#7f6df2"),
        CalendarDef("school", "Schule", "#3d8bfd"),
        CalendarDef("work", "Arbeit", "#2f9e6b"),
    ),
    emptyList(),
)

fun parseCalendarMarkdown(markdown: String): CalendarDocument {
    val start = markdown.indexOf(CALENDAR_START)
    val end = if (start >= 0) markdown.indexOf(MARKER_END, start + CALENDAR_START.length) else -1
    if (start < 0 || end < 0) return emptyCalendar()
    return try {
        val parsed = parseJson(markdown.substring(start + CALENDAR_START.length, end).trim()) as? JsonValue.Obj
            ?: return emptyCalendar()
        val calendars = parsed.array("calendars")?.items.orEmpty().mapNotNull { item ->
            val obj = item as? JsonValue.Obj ?: return@mapNotNull null
            val name = obj.string("name")?.trim().orEmpty()
            if (name.isEmpty()) return@mapNotNull null
            CalendarDef(obj.string("id") ?: name, name, obj.string("color") ?: "#2a6f97", obj.bool("visible") != false)
        }.ifEmpty { emptyCalendar().calendars }
        val ids = calendars.map { it.id }.toSet()
        val events = parsed.array("events")?.items.orEmpty().mapNotNull { item ->
            val obj = item as? JsonValue.Obj ?: return@mapNotNull null
            val title = obj.string("title")?.trim().orEmpty()
            val calendarId = obj.string("calendarId").orEmpty()
            val eventStart = obj.string("start").orEmpty()
            val eventEnd = obj.string("end").orEmpty()
            if (title.isEmpty() || calendarId !in ids || eventStart.isEmpty()) return@mapNotNull null
            CalendarEvent(
                id = obj.string("id") ?: UUID.randomUUID().toString(),
                calendarId = calendarId,
                title = title,
                start = eventStart,
                end = eventEnd.ifBlank { eventStart },
                allDay = obj.bool("allDay") != false,
                location = obj.string("location").orEmpty(),
                notes = obj.string("notes").orEmpty(),
                notePath = obj.string("notePath").orEmpty(),
                recurrence = obj.string("recurrence")?.takeIf { it in setOf("daily", "weekly", "monthly", "yearly") } ?: "none",
                recurrenceUntil = obj.string("recurrenceUntil"),
                exceptionDates = obj.array("exceptionDates")?.items.orEmpty().mapNotNull { (it as? JsonValue.Str)?.value },
            )
        }
        CalendarDocument(calendars, events)
    } catch (_: Exception) {
        emptyCalendar()
    }
}

fun serializeCalendarMarkdown(document: CalendarDocument): String {
    val calendars = document.calendars.joinToString(",\n") {
        """{"id":${json(it.id)},"name":${json(it.name)},"color":${json(it.color)},"visible":${it.visible}}"""
    }
    val events = document.events.joinToString(",\n") {
        """{"id":${json(it.id)},"calendarId":${json(it.calendarId)},"title":${json(it.title)},"start":${json(it.start)},"end":${json(it.end)},"allDay":${it.allDay},"location":${json(it.location)},"notes":${json(it.notes)},"notePath":${json(it.notePath)},"recurrence":${json(it.recurrence)},"recurrenceUntil":${it.recurrenceUntil?.let(::json) ?: "null"},"exceptionDates":[${it.exceptionDates.joinToString(",") { date -> json(date) }}]}"""
    }
    return """
        |# Kalender
        |
        |Diese Notiz wird von der **Kalender-Ansicht** in FaNotes verwaltet.
        |Termine bleiben lokal in deinem Vault. Ziehe sie im Kalender — nicht in dieser Datei.
        |
        |$CALENDAR_START
        |{
        |  "version": 1,
        |  "calendars": [
        |$calendars
        |  ],
        |  "events": [
        |$events
        |  ]
        |}
        |$MARKER_END
        |
    """.trimMargin()
}

data class FlashCard(
    val id: String,
    val front: String,
    val back: String,
    val ease: Double = 2.5,
    val intervalDays: Int = 0,
    val due: String,
    val reps: Int = 0,
    val lapses: Int = 0,
)

private const val CARDS_START = "<!-- fanotes-cards-v1"

fun cardsFromMarkdown(markdown: String, today: String): List<FlashCard> {
    val stored = parseStoredCards(markdown)
    val byFront = stored.associateBy { it.front }
    val questions = questionBlocks(markdown)
    if (questions.isEmpty()) return stored
    return questions.mapIndexed { index, pair ->
        byFront[pair.first]?.copy(back = pair.second.ifBlank { byFront[pair.first]?.back.orEmpty() })
            ?: FlashCard("card-${index + 1}", pair.first, pair.second, due = today)
    }
}

fun dueCards(cards: List<FlashCard>, today: String) = cards.filter { it.due <= today }

fun reviewCard(card: FlashCard, grade: String, today: String): FlashCard {
    if (grade == "again") {
        return card.copy(lapses = card.lapses + 1, reps = 0, intervalDays = 0, ease = (card.ease - 0.2).coerceAtLeast(1.3), due = today)
    }
    val ease = when (grade) {
        "hard" -> (card.ease - 0.15).coerceAtLeast(1.3)
        "easy" -> card.ease + 0.15
        else -> card.ease
    }
    val factor = when (grade) {
        "hard" -> 1.2
        "easy" -> card.ease * 1.3
        else -> card.ease
    }
    val interval = if (card.intervalDays <= 0) {
        when (grade) {
            "hard" -> 1
            "easy" -> 4
            else -> 2
        }
    } else {
        kotlin.math.max(1, kotlin.math.round(card.intervalDays * factor).toInt())
    }
    val due = LocalDate.parse(today).plusDays(interval.toLong()).toString()
    return card.copy(reps = card.reps + 1, ease = ease, intervalDays = interval, due = due)
}

fun embedCards(markdown: String, cards: List<FlashCard>): String {
    val start = markdown.indexOf(CARDS_START)
    val end = if (start >= 0) markdown.indexOf(MARKER_END, start) else -1
    val without = if (start >= 0 && end >= 0) markdown.removeRange(start, end + MARKER_END.length) else markdown
    val body = cards.joinToString(",\n") {
        """{"id":${json(it.id)},"front":${json(it.front)},"back":${json(it.back)},"ease":${it.ease},"intervalDays":${it.intervalDays},"due":${json(it.due)},"reps":${it.reps},"lapses":${it.lapses}}"""
    }
    return without.trimEnd() + "\n$CARDS_START\n{\n  \"cards\": [\n$body\n  ]\n}\n$MARKER_END\n"
}

fun applyReview(markdown: String, cardId: String, grade: String, today: String): String {
    val next = cardsFromMarkdown(markdown, today).map { if (it.id == cardId) reviewCard(it, grade, today) else it }
    return embedCards(markdown, next)
}

data class SearchHit(val path: String, val line: Int, val text: String)

fun searchVault(files: List<Pair<String, String>>, query: String): List<SearchHit> {
    val needle = query.trim()
    if (needle.length < 2) return emptyList()
    val hits = mutableListOf<SearchHit>()
    for ((path, text) in files) {
        if (!path.endsWith(".md", true) && !path.endsWith(".markdown", true)) continue
        text.replace("\r\n", "\n").lineSequence().forEachIndexed { index, line ->
            if (line.contains(needle, ignoreCase = true) && !line.trimStart().startsWith("<!--")) {
                hits += SearchHit(path, index + 1, line.trim().take(180))
            }
        }
    }
    return hits.take(200)
}

fun dailyNotePath(folder: String, day: LocalDate = LocalDate.now(ZoneId.systemDefault())): String {
    val dir = folder.trim().trim('/').ifBlank { "Daily Notes" }
    return "$dir/${day}.md"
}

data class SubjectBook(val subjectPath: String, val bookPath: String, val lastPage: Int)

fun parseSubjectBooks(json: String): List<SubjectBook> {
    val root = parseJson(json) as? JsonValue.Obj ?: return emptyList()
    val items = root.array("books")?.items ?: (root as? JsonValue.Arr)?.items ?: return emptyList()
    return items.mapNotNull { item ->
        val obj = item as? JsonValue.Obj ?: return@mapNotNull null
        val subject = obj.string("subjectPath")?.trim('/').orEmpty()
        val book = obj.string("bookPath").orEmpty()
        if (subject.isEmpty() || !book.endsWith(".pdf", true)) return@mapNotNull null
        SubjectBook(subject, book, obj.double("lastPage")?.toInt()?.coerceAtLeast(1) ?: 1)
    }
}

fun parseFolderColors(json: String): Map<String, String> {
    val root = parseJson(json) as? JsonValue.Obj ?: return emptyMap()
    val colors = root.obj("colors") ?: return emptyMap()
    return colors.fields.mapNotNull { (path, value) ->
        val color = (value as? JsonValue.Str)?.value ?: return@mapNotNull null
        path to color
    }.toMap()
}

fun outlineOf(markdown: String) = ch.fasrv.fanotes.text.paperLines(markdown)
    .filter { it.kind.name.startsWith("H") }
    .map { it.kind.name.last().digitToInt() to it.text }

fun wordCount(markdown: String) = markdown.replace(Regex("""<!--[\s\S]*?-->"""), " ")
    .split(Regex("""\s+"""))
    .count { it.any(Char::isLetterOrDigit) }

fun occurrencesOn(event: CalendarEvent, day: java.time.LocalDate): Boolean {
    val startDay = runCatching { java.time.LocalDate.parse(event.start.take(10)) }.getOrNull() ?: return false
    if (day < startDay) return false
    if (event.exceptionDates.contains(day.toString())) return false
    val until = event.recurrenceUntil?.let { runCatching { java.time.LocalDate.parse(it) }.getOrNull() }
    if (until != null && day > until) return false
    if (event.recurrence == "none" || event.recurrence.isBlank()) return day == startDay
    return when (event.recurrence) {
        "daily" -> true
        "weekly" -> day.dayOfWeek == startDay.dayOfWeek
        "monthly" -> day.dayOfMonth == startDay.dayOfMonth
        "yearly" -> day.dayOfMonth == startDay.dayOfMonth && day.month == startDay.month
        else -> day == startDay
    }
}

data class NoteLinkMark(
    val id: String,
    val sourcePath: String,
    val targetPath: String,
    val x: Double,
    val y: Double,
    val style: String = "symbol",
    val label: String = "",
)

fun parseNoteLinkMarks(payload: JsonValue.Obj?): List<NoteLinkMark> {
    val items = payload?.array("noteLinks")?.items ?: return emptyList()
    return items.mapNotNull { item ->
        val obj = item as? JsonValue.Obj ?: return@mapNotNull null
        val source = obj.string("sourcePath").orEmpty()
        val target = obj.string("targetPath").orEmpty()
        if (source.isEmpty() || !target.endsWith(".md")) return@mapNotNull null
        NoteLinkMark(
            id = obj.string("id") ?: "nl",
            sourcePath = source,
            targetPath = target,
            x = obj.double("x") ?: 0.5,
            y = obj.double("y") ?: 0.5,
            style = obj.string("style") ?: "symbol",
            label = obj.string("label").orEmpty(),
        )
    }
}

fun noteLinksJson(links: List<NoteLinkMark>): JsonValue.Arr = JsonValue.Arr(links.map { link ->
    jsonObject(
        "id" to jsonString(link.id),
        "sourcePath" to jsonString(link.sourcePath),
        "targetPath" to jsonString(link.targetPath),
        "page" to jsonNumber(1.0),
        "x" to jsonNumber(link.x),
        "y" to jsonNumber(link.y),
        "style" to jsonString(link.style),
        "label" to jsonString(link.label.ifBlank { link.targetPath.substringAfterLast('/').substringBeforeLast('.') }),
        "appearance" to jsonString(when (link.style) {
            "text" -> "text"
            "symbol-text" -> "symbol-text"
            else -> "symbol"
        }),
    )
}.toMutableList())

data class WorksheetBox(val id: String, val page: Int, val x: Double, val y: Double, val width: Double, val text: String, val fontSize: Double)

fun parseWorksheetBoxes(json: String): List<WorksheetBox> {
    val root = parseJson(json) as? JsonValue.Obj ?: return emptyList()
    return root.array("textBoxes")?.items.orEmpty().mapNotNull { item ->
        val obj = item as? JsonValue.Obj ?: return@mapNotNull null
        WorksheetBox(
            id = obj.string("id") ?: return@mapNotNull null,
            page = obj.double("page")?.toInt() ?: 1,
            x = obj.double("x") ?: 0.1,
            y = obj.double("y") ?: 0.1,
            width = obj.double("width") ?: 0.4,
            text = obj.string("text").orEmpty(),
            fontSize = obj.double("fontSize") ?: 18.0,
        )
    }
}

fun wikiTargets(markdown: String) = Regex("""\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?]]""")
    .findAll(markdown)
    .map { it.groupValues[1].trim() }
    .filter { it.isNotEmpty() }
    .distinct()
    .toList()

fun taskLines(markdown: String) = markdown.replace("\r\n", "\n").lineSequence()
    .mapIndexedNotNull { index, line ->
        val match = Regex("""^(\s*[-*+]\s+)\[([ xX])](.*)$""").find(line) ?: return@mapIndexedNotNull null
        Triple(index, match.groupValues[2].equals("x", true), match.groupValues[3].trim())
    }
    .toList()

fun toggleTask(markdown: String, lineIndex: Int): String {
    val lines = markdown.replace("\r\n", "\n").split('\n').toMutableList()
    val line = lines.getOrNull(lineIndex) ?: return markdown
    lines[lineIndex] = when {
        line.contains("[ ]") -> line.replaceFirst("[ ]", "[x]")
        line.contains("[x]", true) -> line.replace(Regex("""\[[xX]]"""), "[ ]")
        else -> line
    }
    return lines.joinToString("\n")
}

private fun questionBlocks(markdown: String): List<Pair<String, String>> {
    val section = markdown.split(Regex("""(?m)^##\s+Lernfragen\s*$""")).getOrNull(1) ?: return emptyList()
    val body = section.split(Regex("""(?m)^##\s+""")).first()
    val details = Regex("""<details>\s*<summary>([\s\S]*?)</summary>([\s\S]*?)</details>""", RegexOption.IGNORE_CASE)
        .findAll(body)
        .map { clean(it.groupValues[1]) to clean(it.groupValues[2]) }
        .filter { it.first.isNotEmpty() }
        .toList()
    if (details.isNotEmpty()) return details
    return Regex("""(?m)^(?:\d+\.\s+)(.+)$""").findAll(body).map { clean(it.groupValues[1]) to "" }.filter { it.first.isNotEmpty() }.toList()
}

private fun parseStoredCards(markdown: String): List<FlashCard> {
    val start = markdown.indexOf(CARDS_START)
    val end = if (start >= 0) markdown.indexOf(MARKER_END, start + CARDS_START.length) else -1
    if (start < 0 || end < 0) return emptyList()
    return try {
        val parsed = parseJson(markdown.substring(start + CARDS_START.length, end).trim()) as? JsonValue.Obj ?: return emptyList()
        parsed.array("cards")?.items.orEmpty().mapNotNull { item ->
            val obj = item as? JsonValue.Obj ?: return@mapNotNull null
            val front = obj.string("front")?.let(::clean).orEmpty()
            if (front.isEmpty()) return@mapNotNull null
            FlashCard(
                id = obj.string("id") ?: front.take(12),
                front = front,
                back = obj.string("back")?.let(::clean).orEmpty(),
                ease = obj.double("ease")?.takeIf { it > 1 } ?: 2.5,
                intervalDays = obj.double("intervalDays")?.toInt()?.coerceAtLeast(0) ?: 0,
                due = obj.string("due") ?: "1970-01-01",
                reps = obj.double("reps")?.toInt() ?: 0,
                lapses = obj.double("lapses")?.toInt() ?: 0,
            )
        }
    } catch (_: Exception) {
        emptyList()
    }
}

private fun clean(value: String) = value.replace(Regex("""\s+"""), " ").trim().take(600)

private fun json(value: String) = buildString {
    append('"')
    for (char in value) {
        when (char) {
            '\\' -> append("\\\\")
            '"' -> append("\\\"")
            '\n' -> append("\\n")
            '\r' -> append("\\r")
            else -> append(char)
        }
    }
    append('"')
}
