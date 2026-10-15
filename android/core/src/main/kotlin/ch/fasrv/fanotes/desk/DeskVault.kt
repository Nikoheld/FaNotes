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

data class SearchHit(val path: String, val line: Int, val text: String, val anchorY: Double? = null)

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

fun dailyNotePath(
    folder: String,
    day: LocalDate = LocalDate.now(ZoneId.systemDefault()),
    pattern: String = "YYYY-MM-DD",
): String {
    val dir = folder.trim().trim('/').ifBlank { "Tagesnotizen" }
    return "$dir/${dailyNoteFileName(pattern, day)}.md"
}

/** `YYYY` `YY` `MM` `DD`, in that order, matching the desktop daily-note title. */
fun formatNoteDate(pattern: String, day: LocalDate): String {
    val source = pattern.trim().ifBlank { "YYYY-MM-DD" }.take(80)
    return source
        .replace("YYYY", day.year.toString())
        .replace("YY", day.year.toString().takeLast(2))
        .replace("MM", day.monthValue.toString().padStart(2, '0'))
        .replace("DD", day.dayOfMonth.toString().padStart(2, '0'))
}

/** A date title that would become a path is replaced by the ISO day. */
fun dailyNoteFileName(pattern: String, day: LocalDate): String {
    val formatted = formatNoteDate(pattern, day).trim()
    val illegal = formatted.isEmpty() || formatted == "." || formatted == ".." ||
        formatted.any { it == '/' || it == '\\' || it.code < 32 }
    return if (illegal) day.toString() else formatted.take(120)
}

/**
 * Folder for a new root note. A missing setting is Eingang when that folder
 * exists. A blank setting, or a folder that is not in the vault, is the root.
 */
fun defaultNoteParent(setting: String?, folders: Set<String>): String {
    if (setting != null && setting.isBlank()) return ""
    val raw = (setting ?: "Eingang").replace('\\', '/').trim().trim('/')
    if (raw.isEmpty() || raw.split('/').any { it.isEmpty() || it == "." || it == ".." }) return ""
    return if (raw in folders) raw else ""
}

data class SubjectBook(val subjectPath: String, val bookPath: String, val lastPage: Int)

const val SUBJECT_BOOKS_PATH = ".fanotes/subject-books.json"
val SUBJECT_BOOK_PLACEMENTS = listOf("links", "rechts", "oben", "unten", "popout")

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

fun serializeSubjectBooks(books: List<SubjectBook>): String {
    val body = books.take(200).mapNotNull { book ->
        val subject = book.subjectPath.trim('/')
        val path = book.bookPath.trim('/')
        if (subject.isEmpty() || subject.contains("..") || !path.endsWith(".pdf", true)) null
        else """{"subjectPath":${json(subject)},"bookPath":${json(path)},"lastPage":${book.lastPage.coerceAtLeast(1)}}"""
    }.joinToString(",\n")
    return "{\n  \"version\": 1,\n  \"books\": [\n$body\n  ]\n}\n"
}

fun subjectBookForNote(books: List<SubjectBook>, notePath: String): SubjectBook? {
    val normalized = notePath.replace('\\', '/').trim('/')
    if (normalized.isEmpty() || normalized.contains("..")) return null
    books.find { it.subjectPath == normalized }?.let { return it }
    val parts = normalized.split('/').filter { it.isNotEmpty() }
    for (index in parts.size - 1 downTo 1) {
        val folder = parts.take(index).joinToString("/")
        books.find { it.subjectPath == folder }?.let { return it }
    }
    return null
}

fun detachSubjectBook(books: List<SubjectBook>, subjectPath: String): List<SubjectBook> {
    val subject = subjectPath.trim('/')
    if (subject.isEmpty()) return books
    return books.filter { it.subjectPath != subject }
}

fun attachSubjectBook(books: List<SubjectBook>, subjectPath: String, bookPath: String, lastPage: Int = 1): List<SubjectBook> {
    val subject = subjectPath.trim('/')
    val book = bookPath.trim('/')
    if (subject.isEmpty() || !book.endsWith(".pdf", true)) throw IllegalArgumentException("Das Buch konnte dem Fach nicht zugeordnet werden.")
    val next = SubjectBook(subject, book, lastPage.coerceAtLeast(1))
    return (books.filter { it.subjectPath != subject } + next).take(200)
}

fun recordSubjectBookPage(books: List<SubjectBook>, subjectPath: String, page: Int): List<SubjectBook> {
    if (page < 1) return books
    return books.map { if (it.subjectPath == subjectPath) it.copy(lastPage = page) else it }
}

/** Tag, 3 Tage, Woche and Agenda windows. Monday starts the week, matching the desktop grid. */
fun calendarRange(view: String, anchor: java.time.LocalDate): List<java.time.LocalDate> = when (view) {
    "day" -> listOf(anchor)
    "three" -> (0..2).map { anchor.plusDays(it.toLong()) }
    "week" -> {
        val monday = anchor.minusDays(((anchor.dayOfWeek.value + 6) % 7).toLong())
        (0..6).map { monday.plusDays(it.toLong()) }
    }
    "agenda" -> (0..27).map { anchor.plusDays(it.toLong()) }
    else -> emptyList()
}

fun eventClock(event: CalendarEvent): String? {
    if (event.allDay || !event.start.contains('T')) return null
    val start = event.start.substringAfter('T').take(5)
    if (!Regex("""\d{2}:\d{2}""").matches(start)) return null
    val end = event.end.substringAfter('T', "").take(5)
    return if (Regex("""\d{2}:\d{2}""").matches(end)) "$start–$end" else start
}

data class WorksheetHighlight(
    val id: String,
    val page: Int,
    val x: Double,
    val y: Double,
    val width: Double,
    val height: Double,
    val color: String = "#ffe566",
)

data class PageFrame(val page: Int, val top: Double, val height: Double, val width: Double)

data class SheetRect(val x: Double, val y: Double, val width: Double, val height: Double)

fun parseWorksheetHighlights(json: String): List<WorksheetHighlight> {
    val root = parseJson(json) as? JsonValue.Obj ?: return emptyList()
    return root.array("highlights")?.items.orEmpty().mapNotNull { item ->
        val obj = item as? JsonValue.Obj ?: return@mapNotNull null
        val id = obj.string("id") ?: return@mapNotNull null
        WorksheetHighlight(
            id = id,
            page = obj.double("page")?.toInt()?.coerceAtLeast(1) ?: 1,
            x = (obj.double("x") ?: 0.0).coerceIn(0.0, 1.0),
            y = (obj.double("y") ?: 0.0).coerceIn(0.0, 1.0),
            width = (obj.double("width") ?: 0.0).coerceIn(0.0, 1.0),
            height = (obj.double("height") ?: 0.0).coerceIn(0.0, 1.0),
            color = obj.string("color")?.takeIf { Regex("""#[0-9a-fA-F]{6}""").matches(it) } ?: "#ffe566",
        )
    }
}

/** Page-local highlight → 0–1 of the stacked sheet. One frame uses the whole sheet. */
fun highlightToSheet(mark: WorksheetHighlight, frames: List<PageFrame>, sourceWidth: Double, sourceHeight: Double): SheetRect {
    val frame = frames.firstOrNull { it.page == mark.page } ?: frames.singleOrNull()
    if (frame == null || sourceWidth <= 0 || sourceHeight <= 0 || frame.height <= 0 || frame.width <= 0) {
        return SheetRect(mark.x, mark.y, mark.width, mark.height)
    }
    return SheetRect(
        x = (mark.x * frame.width) / sourceWidth,
        y = (frame.top + mark.y * frame.height) / sourceHeight,
        width = (mark.width * frame.width) / sourceWidth,
        height = (mark.height * frame.height) / sourceHeight,
    )
}

/** A drag on the stacked sheet becomes a page-local highlight, pages numbered from 1. */
fun highlightFromDrag(
    x: Double,
    y: Double,
    width: Double,
    height: Double,
    frames: List<PageFrame>,
    sourceWidth: Double,
    sourceHeight: Double,
    id: String,
): WorksheetHighlight? {
    if (width < 0.012 || height < 0.008) return null
    val centerPx = (y + height / 2) * sourceHeight
    val frame = frames.firstOrNull { centerPx >= it.top && centerPx <= it.top + it.height }
        ?: return WorksheetHighlight(id, 1, x.coerceIn(0.0, 1.0), y.coerceIn(0.0, 1.0), width.coerceIn(0.0, 1.0), height.coerceIn(0.0, 1.0))
    if (frame.width <= 0 || frame.height <= 0) return null
    val localX = ((x * sourceWidth) / frame.width).coerceIn(0.0, 1.0)
    val localY = (((y * sourceHeight) - frame.top) / frame.height).coerceIn(0.0, 1.0)
    val localW = ((width * sourceWidth) / frame.width).coerceIn(0.008, 1.0)
    val localH = ((height * sourceHeight) / frame.height).coerceIn(0.008, 1.0)
    if (localW < 0.012 || localH < 0.008) return null
    return WorksheetHighlight(id, frame.page, localX, localY, localW, localH)
}

const val FOLDER_COLORS_PATH = ".fanotes/folder-colors.json"

/** Swatches from the desktop file tree. */
val FOLDER_COLOR_CHOICES = listOf(
    "#6b7280", "#2a6f97", "#337ea9", "#0f7b6c", "#448361",
    "#ba9b4a", "#d9730d", "#c4554d", "#9065b0", "#787774",
)

fun parseFolderColors(json: String): Map<String, String> {
    val root = parseJson(json) as? JsonValue.Obj ?: return emptyMap()
    val colors = root.obj("colors") ?: return emptyMap()
    return colors.fields.mapNotNull { (path, value) ->
        val color = (value as? JsonValue.Str)?.value?.lowercase() ?: return@mapNotNull null
        if (!Regex("#[0-9a-f]{6}").matches(color)) return@mapNotNull null
        path to color
    }.toMap()
}

fun serializeFolderColors(colors: Map<String, String>): String {
    val entries = colors.mapNotNull { (rawPath, rawColor) ->
        val color = rawColor.trim().lowercase()
        val path = rawPath.replace('\\', '/').trim('/')
        if (!Regex("#[0-9a-f]{6}").matches(color) || path.isEmpty() || path.split('/').any { it == "." || it == ".." }) {
            null
        } else {
            path to color
        }
    }.sortedWith(compareBy(java.text.Collator.getInstance(java.util.Locale.GERMAN)) { it.first })
    val body = entries.joinToString(",\n") { (path, color) -> "    ${ch.fasrv.fanotes.json.escapeJson(path)}: ${ch.fasrv.fanotes.json.escapeJson(color)}" }
    val colorsJson = if (body.isEmpty()) "{}" else "{\n$body\n  }"
    return "{\n  \"version\": 1,\n  \"colors\": $colorsJson\n}\n"
}

/** Folder colours follow a rename or move, the way a desktop folder record keeps its colour. */
fun remapFolderColors(colors: Map<String, String>, from: String, to: String): Map<String, String> {
    val source = from.replace('\\', '/').trim('/')
    val target = to.replace('\\', '/').trim('/')
    if (source.isEmpty() || source == target) return colors
    var changed = false
    val next = LinkedHashMap<String, String>(colors.size)
    for ((path, color) in colors) {
        val mapped = if (path == source || path.startsWith("$source/")) target + path.substring(source.length) else path
        if (mapped != path) changed = true
        if (mapped !in next) next[mapped] = color
    }
    return if (changed) next else colors
}

fun withFolderColor(colors: Map<String, String>, path: String, color: String?): Map<String, String> {
    val key = path.replace('\\', '/').trim('/')
    if (color == null) return colors - key
    val hex = color.trim().lowercase()
    if (!Regex("#[0-9a-f]{6}").matches(hex)) throw IllegalArgumentException("Ungültige Ordnerfarbe.")
    return colors + (key to hex)
}

fun outlineOf(markdown: String) = ch.fasrv.fanotes.text.paperLines(markdown)
    .filter { it.kind.name.startsWith("H") }
    .map { it.kind.name.last().digitToInt() to it.text }

fun wordCount(markdown: String) = markdown.replace(Regex("""<!--[\s\S]*?-->"""), " ")
    .split(Regex("""\s+"""))
    .count { it.any(Char::isLetterOrDigit) }

private val INSPECTOR_MARKERS = Regex("""<!--\s*fanotes-(?:ink|worksheet):[a-zA-Z0-9_-]{1,96}\s*-->""")
private val STATUS_INK_MARKER = Regex("""<!--\s*fanotes-ink:[a-zA-Z0-9_-]{1,96}\s*-->""")
private val STATUS_WORKSHEET_MARKER = Regex("""<!--\s*fanotes-worksheet:[a-zA-Z0-9_-]{1,96}\s*-->""")
private val FAMD_TAIL = Regex("""(?:^|\n)<!--\s*fanotes-famd:v1[\s\S]*$""")
private val INSPECTOR_PUNCTUATION = Regex("""[`#>*_~\[\]()-]""")

/** Status-bar count: trimmed visible note text, split on whitespace. */
fun statusWordCount(content: String): Int {
    val visible = content
        .replaceFirst(STATUS_INK_MARKER, "")
        .replace(STATUS_WORKSHEET_MARKER, "")
        .replace(FAMD_TAIL, "")
        .trim()
    if (visible.isEmpty()) return 0
    return visible.split(Regex("""\s+""")).size
}

data class InspectorDocument(val words: Int, val characters: Int, val readingMinutes: Int)

/** Live inspector counts from `RightInspector`, including the one-minute floor. */
fun inspectorDocument(content: String): InspectorDocument {
    val visible = content
        .replace(INSPECTOR_MARKERS, "")
        .replace(FAMD_TAIL, "")
    val plain = visible.replace(INSPECTOR_PUNCTUATION, " ").trim()
    val words = if (plain.isEmpty()) 0 else plain.split(Regex("""\s+""")).size
    val reading = maxOf(1, kotlin.math.ceil(words / 210.0).toInt())
    return InspectorDocument(words, visible.length, reading)
}

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
    val page: Int = 1,
    val style: String = "symbol",
    val label: String = "",
)

fun parseNoteLinkMarks(payload: JsonValue.Obj?): List<NoteLinkMark> = parseNoteLinks(payload?.array("noteLinks"))

fun noteLinksJson(links: List<NoteLinkMark>): JsonValue.Arr = JsonValue.Arr(links.map { link ->
    jsonObject(
        "id" to jsonString(link.id),
        "sourcePath" to jsonString(link.sourcePath),
        "targetPath" to jsonString(link.targetPath),
        "page" to jsonNumber(link.page.toDouble()),
        "x" to jsonNumber(link.x),
        "y" to jsonNumber(link.y),
        "style" to jsonString(link.style),
        "label" to jsonString(link.label.ifBlank { linkedNoteDefaultLabel(link.targetPath) }),
        "appearance" to jsonString(noteLinkAppearanceToken(link.style)),
    )
}.toMutableList())

data class WorksheetBox(val id: String, val page: Int, val x: Double, val y: Double, val width: Double, val text: String, val fontSize: Double)

/** Same clamp as a desktop worksheet text tool: x stays in 0–0.78, y in 0–0.94. */
fun placeWorksheetTextBox(page: Int, localX: Double, localY: Double, id: String): WorksheetBox {
    val x = if (localX.isFinite()) localX.coerceIn(0.0, 0.78) else 0.0
    val y = if (localY.isFinite()) localY.coerceIn(0.0, 0.94) else 0.0
    return WorksheetBox(
        id = id,
        page = page.coerceIn(1, 2000),
        x = x,
        y = y,
        width = 0.28,
        text = "",
        fontSize = 16.0,
    )
}

fun worksheetBoxTextError(text: String): String? =
    if (text.indexOf('\u0000') >= 0 || text.length > 20_000) "Ein Arbeitsblatt-Text ist ungültig." else null

/** Wrapped lines for a worksheet text box. Existing line breaks stay. */
fun wrapBoxLines(text: String, maxChars: Int): List<String> {
    val width = maxChars.coerceAtLeast(1)
    if (text.isEmpty()) return listOf("")
    val lines = mutableListOf<String>()
    for (paragraph in text.replace("\r\n", "\n").replace('\r', '\n').split('\n')) {
        if (paragraph.isEmpty()) {
            lines += ""
            continue
        }
        var rest = paragraph
        while (rest.length > width) {
            val space = rest.lastIndexOf(' ', width)
            val breakAt = if (space > 0) space else width
            lines += rest.substring(0, breakAt).trimEnd()
            rest = rest.substring(if (space > 0) space + 1 else breakAt).trimStart()
            if (rest.isEmpty()) break
        }
        if (rest.isNotEmpty()) lines += rest
    }
    return lines.ifEmpty { listOf("") }
}

/** How many characters fit on one line of a worksheet card. */
fun worksheetCharsPerLine(widthPx: Float, fontSizePx: Float, scale: Float): Int {
    val font = fontSizePx.coerceAtLeast(1f)
    val inner = (widthPx - 12f * scale).coerceAtLeast(font)
    return (inner / (font * 0.52f)).toInt().coerceAtLeast(1)
}

/** Card height in screen pixels. Line height 1.35 matches the desktop textarea. */
fun worksheetCardHeightPx(text: String, widthPx: Float, fontSizePx: Float, scale: Float): Float {
    val font = fontSizePx.coerceAtLeast(1f)
    val lines = wrapBoxLines(text.ifEmpty { "Text" }, worksheetCharsPerLine(widthPx, font, scale))
    return (lines.size * font * 1.35f + 10f * scale).coerceAtLeast(38f * scale)
}

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

fun wikiTargets(markdown: String) = wikilinkTargets(markdown)

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
