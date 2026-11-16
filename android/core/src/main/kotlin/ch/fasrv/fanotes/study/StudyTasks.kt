package ch.fasrv.fanotes.study

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.jsonBool
import ch.fasrv.fanotes.json.jsonString
import ch.fasrv.fanotes.json.parseJson

/**
 * Assignment ("Auftrag") detection for worksheets and the per-PDF task list.
 * Ported from `fanotes/src/lib/study/tasks.ts`; the list is stored in the PDF's
 * companion note as `<!-- fanotes-tasks-v1 {...} -->`, the same text the desktop writes.
 */

data class PageLines(val page: Int, val lines: List<String>)

data class StudyTask(
    val id: String,
    /** Label shown first: "1", "12", or "" for an unnumbered "Auftrag:". */
    val number: String,
    val title: String,
    val minutes: Int,
    val page: Int,
    val done: Boolean,
    val spentSec: Int,
    /** Added or edited by hand; detection never overwrites it. */
    val manual: Boolean,
)

data class StudyTaskList(val tasks: List<StudyTask>, val removed: List<String>)

// (?U) makes \s and \b Unicode aware like the JavaScript `u` flag does for \s.
private const val KEYWORDS = "Auftrag|Aufgabe|Task|Exercise|Übung|Uebung|Arbeitsauftrag"
private val HEAD = Regex(
    "(?U)^\\s*(?:$KEYWORDS)\\s*(?:(\\d{1,3})\\s*[a-z]?\\b|(?=\\s*[:.]))\\s*(?:\\(([^)]{0,60})\\))?\\s*[:.\\-–—)]?\\s*(.*)$",
    RegexOption.IGNORE_CASE,
)
private const val UNIT_MIN = "Minuten|Minute|Min\\.?|min|'|′"
private const val UNIT_LESSON = "Lektionen|Lektion|Lekt\\.?|Doppellektion(?:en)?"
private const val UNIT_HOUR = "Stunden|Stunde|Std\\.?|h"
private const val AMOUNT = "(\\d+(?:[.,]\\d+)?)(?:\\s*[-–]\\s*(\\d+(?:[.,]\\d+)?))?\\s*($UNIT_MIN|$UNIT_LESSON|$UNIT_HOUR)(?![\\p{L}])"
private val TIME = Regex("(?U)$AMOUNT", RegexOption.IGNORE_CASE)
/** Outside parentheses a hint needs "ca." so "Abb. 9 h" is not read as nine hours. */
private val TIME_LOOSE = Regex("(?U)(?:ca\\.?|circa|ungefähr|etwa)\\s*$AMOUNT", RegexOption.IGNORE_CASE)
private val TIME_IN_PARENS = Regex("""\(([^()]*?)\)""")
private val SPACES = Regex("(?U)\\s+")
private val STRIP_TIME = Regex(
    "(?U)\\(\\s*(?:ca\\.?|circa)?\\s*\\d+(?:[.,]\\d+)?(?:\\s*[-–]\\s*\\d+)?\\s*(?:Minuten|Minute|Min\\.?|min|Lektionen|Lektion|Std\\.?|Stunden|Stunde|h)\\s*\\)",
    RegexOption.IGNORE_CASE,
)
private val SPLIT_COLLAPSED = Regex("(?U)(?<=\\S)\\s+(?=(?:$KEYWORDS)\\s*\\d{1,3}\\s*[:.(])", RegexOption.IGNORE_CASE)
private val HYPHEN_END = Regex("\\p{L}-$")
private val LOWER_START = Regex("^\\p{Ll}")
private val CONNECTOR = Regex("^(?:und|oder|bzw|sowie)\\b", RegexOption.IGNORE_CASE)
private val NUMBERED_SECTION = Regex("(?U)^\\d+(?:\\.\\d+)+\\s")
private val UNNUMBERED_PROSE = Regex("(?U)^\\s*(?:\\p{L}+)\\s*[:.]")

/** Joins hyphenated line ends: "Hor-\nmonen" -> "Hormonen", keeps "Hemi- und". */
fun dehyphenate(lines: List<String>): List<String> {
    val out = ArrayList<String>()
    for (raw in lines) {
        val line = raw.replace("­", "").replace(Regex("[ \t]+"), " ").trim()
        val previous = out.lastOrNull()
        if (previous != null && HYPHEN_END.containsMatchIn(previous) && LOWER_START.containsMatchIn(line) && !CONNECTOR.containsMatchIn(line)) {
            val parts = line.split(' ')
            out[out.lastIndex] = previous.dropLast(1) + parts.first()
            val rest = parts.drop(1)
            if (rest.isNotEmpty()) out += rest.joinToString(" ")
            continue
        }
        out += line
    }
    return out
}

private fun minutesOf(match: MatchResult): Int {
    val low = match.groupValues[1].replace(',', '.').toDouble()
    val high = match.groupValues[2].takeIf { it.isNotEmpty() }?.replace(',', '.')?.toDouble() ?: low
    val amount = (low + high) / 2
    val unit = match.groupValues[3].lowercase()
    val factor = when {
        unit.startsWith("lekt") -> 45
        unit.startsWith("doppel") -> 90
        unit.startsWith("std") || unit.startsWith("stunde") || unit == "h" -> 60
        else -> 1
    }
    return jsRound(amount * factor).toInt()
}

/** Minutes in a hint such as "ca. 20 Minuten", "(10 Min.)", "1 Lektion" or "1.5 h"; 0 when none. */
fun parseTimeHint(value: String): Int {
    val found = TIME_IN_PARENS.findAll(value).map { TIME.find(it.groupValues[1]) }.toList() + TIME_LOOSE.find(value)
    for (match in found) {
        if (match == null) continue
        val minutes = minutesOf(match)
        if (minutes in 1..600) return minutes
    }
    return 0
}

private fun clip(value: String, max: Int): String {
    val text = value.replace(SPACES, " ").trim()
    if (text.length <= max) return text
    val cut = text.substring(0, max)
    val space = cut.lastIndexOf(' ')
    val kept = if (space > max * 0.6) cut.substring(0, space) else cut
    return kept.replace(Regex("(?U)[\\s,;:]+$"), "") + " …"
}

private fun stripTime(value: String) = value.replace(STRIP_TIME, "").replace(Regex("(?U)\\s{2,}"), " ").trim()

/** A page whose text arrived as one long line gets a break before each "Auftrag 7". */
private fun splitCollapsed(lines: List<String>) = lines.flatMap { line ->
    if (line.length > 160) line.split(SPLIT_COLLAPSED) else listOf(line)
}

private const val BODY_LINES = 4

/**
 * Finds assignments: lines starting with Auftrag / Aufgabe / Task / Exercise,
 * optionally numbered, optionally followed by a time hint. The first heading
 * per number wins, so a later "Auftrag 4 ..." sentence is not a second task.
 */
fun detectTasks(pages: List<PageLines>): List<StudyTask> {
    val tasks = ArrayList<StudyTask>()
    val seen = HashSet<String>()
    var unnumbered = 0
    for (entry in pages) {
        val lines = dehyphenate(splitCollapsed(entry.lines))
        for (index in lines.indices) {
            val head = HEAD.matchEntire(lines[index]) ?: continue
            val number = head.groupValues[1]
            // "Aufgabe der Hormone" is prose, not a heading: it needs a number or a colon.
            if (number.isEmpty() && !UNNUMBERED_PROSE.containsMatchIn(lines[index])) continue
            val key = if (number.isNotEmpty()) "n${number.toInt()}" else ""
            if (key.isNotEmpty() && key in seen) continue
            val body = mutableListOf(head.groupValues[3])
            var cursor = index + 1
            while (
                parseTimeHint(body.joinToString(" ")) == 0 && cursor < lines.size && body.size < BODY_LINES &&
                lines[cursor].isNotEmpty() && !HEAD.matches(lines[cursor]) && !NUMBERED_SECTION.containsMatchIn(lines[cursor])
            ) {
                body += lines[cursor]
                cursor += 1
                if (parseTimeHint(body.joinToString(" ")) != 0) break
            }
            val raw = body.joinToString(" ")
            val paren = head.groupValues[2]
            val minutes = parseTimeHint("$paren $raw").takeIf { it != 0 } ?: parseTimeHint(paren)
            val title = clip(stripTime(raw).ifEmpty { if (number.isNotEmpty()) "Auftrag $number" else "Auftrag" }, 140)
            if (key.isNotEmpty()) seen += key else unnumbered += 1
            val id = if (number.isNotEmpty()) "auftrag-${number.toInt()}" else "auftrag-p${entry.page}-$unnumbered"
            tasks += StudyTask(id, if (number.isNotEmpty()) number.toInt().toString() else "", title, minutes, entry.page, false, 0, false)
        }
    }
    return tasks
}

// -- stored list ---------------------------------------------------------------

const val TASKS_START = "<!-- fanotes-tasks-v1"
private const val TASKS_END = "-->"

/** Where an embedded `<!-- marker {json} -->` sits; a `-->` inside the JSON text does not close it. */
data class EmbeddedComment(val start: Int, val jsonStart: Int, val jsonEnd: Int, val end: Int)

/** Port of `locateEmbeddedJsonComment`. */
fun locateEmbeddedJsonComment(source: String, startMarker: String, from: Int = 0): EmbeddedComment? {
    if (source.isEmpty() || startMarker.isEmpty()) return null
    val start = source.indexOf(startMarker, from)
    if (start < 0) return null
    var index = start + startMarker.length
    while (index < source.length && source[index].isWhitespace()) index += 1
    if (index >= source.length || source[index] != '{') return null
    val jsonStart = index
    var depth = 0
    var inString = false
    var escape = false
    while (index < source.length) {
        val char = source[index]
        if (inString) {
            if (escape) escape = false
            else if (char == '\\') escape = true
            else if (char == '"') inString = false
        } else if (char == '"') {
            inString = true
        } else if (char == '{') {
            depth += 1
        } else if (char == '}') {
            depth -= 1
            if (depth == 0) {
                val jsonEnd = index + 1
                var closer = jsonEnd
                while (closer < source.length && source[closer].isWhitespace()) closer += 1
                if (!source.startsWith("-->", closer)) return null
                return EmbeddedComment(start, jsonStart, jsonEnd, closer + 3)
            }
        }
        index += 1
    }
    return null
}

private fun JsonValue?.str(max: Int): String = (this as? JsonValue.Str)?.value?.take(max).orEmpty()
private fun JsonValue?.intOr0(): Int {
    val value = when (this) {
        is JsonValue.Num -> value
        is JsonValue.Str -> value.trim().toDoubleOrNull()
        is JsonValue.Bool -> if (value) 1.0 else 0.0
        else -> null
    }
    return if (value == null || !value.isFinite()) 0 else jsRound(value).toInt()
}

/** One `<!-- fanotes-tasks-v1` marker in a note; [comment] is null when its JSON is damaged. */
private data class TaskComment(val start: Int, val end: Int, val comment: EmbeddedComment?, val list: StudyTaskList?)

private const val BROKEN_TASKS_START = "<!-- fanotes-tasks-v1-broken"

/** Every real tasks marker (the marker must be followed by whitespace, so the "-broken" copy is not one). */
private fun taskComments(markdown: String): List<TaskComment> {
    val found = ArrayList<TaskComment>()
    var from = 0
    while (true) {
        val start = markdown.indexOf(TASKS_START, from)
        if (start < 0) break
        val after = start + TASKS_START.length
        if (after < markdown.length && !markdown[after].isWhitespace()) {
            from = after
            continue
        }
        val comment = locateEmbeddedJsonComment(markdown, TASKS_START, start)?.takeIf { it.start == start }
        val list = comment?.let { parseTaskJson(markdown.substring(it.jsonStart, it.jsonEnd)) }
        if (comment != null && list != null) {
            found += TaskComment(start, comment.end, comment, list)
            from = comment.end
        } else {
            val close = markdown.indexOf("-->", after)
            found += TaskComment(start, if (close >= 0) close + 3 else -1, null, null)
            from = after
        }
    }
    return found
}

private fun parseTaskJson(json: String): StudyTaskList? {
    val parsed = try {
        parseJson(json) as? JsonValue.Obj
    } catch (_: Exception) {
        null
    } ?: return null
    val tasks = parsed["tasks"].asArray(300).mapNotNull { entry ->
        val task = entry as? JsonValue.Obj ?: return@mapNotNull null
        val id = task["id"].str(80)
        if (id.isEmpty()) return@mapNotNull null
        val page = (task["page"] as? JsonValue.Num)?.value ?: (task["page"] as? JsonValue.Str)?.value?.trim()?.toDoubleOrNull()
        StudyTask(
            id = id,
            number = task["number"].str(8),
            title = task["title"].str(400),
            minutes = task["minutes"].intOr0().coerceIn(0, 600),
            page = if (page != null && page % 1.0 == 0.0 && page >= 1 && page <= 5000) page.toInt() else 1,
            done = (task["done"] as? JsonValue.Bool)?.value == true,
            spentSec = task["spentSec"].intOr0().coerceIn(0, 86_400 * 7),
            manual = (task["manual"] as? JsonValue.Bool)?.value == true,
        )
    }
    val removed = parsed["removed"].asArray(300).mapNotNull { (it as? JsonValue.Str)?.value }
    return StudyTaskList(tasks, removed)
}

/** The first tasks comment that parses; a damaged one before it is skipped. */
fun readTaskList(markdown: String): StudyTaskList? = taskComments(markdown).firstNotNullOfOrNull { it.list }

private fun taskJson(task: StudyTask): JsonValue = ch.fasrv.fanotes.json.jsonObject(
    "id" to jsonString(task.id),
    "number" to jsonString(task.number),
    "title" to jsonString(task.title),
    "minutes" to num(task.minutes),
    "page" to num(task.page),
    "done" to jsonBool(task.done),
    "spentSec" to num(task.spentSec),
    "manual" to jsonBool(task.manual),
)

/**
 * Replaces every tasks comment by one. A damaged comment is not deleted: its marker is renamed to
 * `fanotes-tasks-v1-broken`, so the text stays in the note but is never read or duplicated again.
 */
fun writeTaskList(markdown: String, list: StudyTaskList): String {
    var text = markdown
    for (entry in taskComments(markdown).sortedByDescending { it.start }) {
        if (entry.list == null) {
            text = text.substring(0, entry.start) + BROKEN_TASKS_START + text.substring(entry.start + TASKS_START.length)
        } else {
            text = removeRange(text, entry.start, entry.end)
        }
    }
    if (list.tasks.isEmpty() && list.removed.isEmpty()) return text
    val json = ch.fasrv.fanotes.json.jsonObject(
        "tasks" to JsonValue.Arr(list.tasks.map(::taskJson).toMutableList()),
        "removed" to JsonValue.Arr(list.removed.map { jsonString(it) as JsonValue }.toMutableList()),
    )
    val block = "\n$TASKS_START\n${prettyJson(json)}\n$TASKS_END\n"
    return text.replace(Regex("(?U)\\s*$"), "") + block
}

/** Cuts [start, end); blank lines around the cut collapse to one, the rest of the note is untouched. */
private fun removeRange(text: String, start: Int, end: Int): String {
    var before = text.substring(0, start)
    var after = text.substring(end)
    val left = before.length - before.trimEnd('\n').length
    val right = after.length - after.trimStart('\n').length
    if (left + right >= 3) {
        after = after.substring(right)
        if (left < 2) after = "\n".repeat(2 - left) + after
    }
    return before + after
}

private fun numberOrder(task: StudyTask): Long = task.number.toLongOrNull() ?: Long.MAX_VALUE

fun sortTasks(tasks: List<StudyTask>): List<StudyTask> = tasks.sortedWith(
    compareBy<StudyTask> { it.page }.thenBy { numberOrder(it) }.thenBy { it.id },
)

/** Detected tasks merged into the stored list: progress and manual edits survive a re-scan. */
fun mergeDetected(stored: StudyTaskList?, detected: List<StudyTask>): StudyTaskList {
    val list = stored ?: StudyTaskList(emptyList(), emptyList())
    val byId = list.tasks.associateBy { it.id }
    val removed = list.removed.toSet()
    val merged = list.tasks.filter { it.id !in removed }.toMutableList()
    for (task in detected) {
        if (task.id in removed) continue
        val known = byId[task.id]
        if (known != null) {
            if (!known.manual) {
                val index = merged.indexOf(known)
                if (index >= 0) merged[index] = known.copy(title = task.title, minutes = if (known.minutes != 0) known.minutes else task.minutes, page = task.page, number = task.number)
            }
            continue
        }
        merged += task
    }
    return StudyTaskList(sortTasks(merged), removed.toList())
}

data class TaskProgress(val total: Int, val done: Int, val ratio: Double, val plannedMinutes: Int, val remainingMinutes: Int)

fun taskProgress(tasks: List<StudyTask>): TaskProgress {
    val total = tasks.size
    val done = tasks.count { it.done }
    val planned = tasks.sumOf { it.minutes }
    val remaining = tasks.filter { !it.done }.sumOf { maxOf(0, it.minutes * 60 - it.spentSec) }
    return TaskProgress(total, done, if (total > 0) done.toDouble() / total else 0.0, planned, Math.ceil(remaining / 60.0).toInt())
}

fun newManualTask(tasks: List<StudyTask>, page: Int, now: Long = System.currentTimeMillis()): StudyTask {
    val highest = tasks.fold(0) { max, task -> maxOf(max, task.number.toIntOrNull() ?: 0) }
    val number = (highest + 1).toString()
    return StudyTask("manual-${java.lang.Long.toString(now, 36)}-$number", number, "", 0, maxOf(1, page), false, 0, true)
}

fun formatClock(seconds: Int): String {
    val total = maxOf(0, seconds)
    fun pad(value: Int) = value.toString().padStart(2, '0')
    val hours = total / 3600
    return if (hours > 0) "$hours:${pad(total % 3600 / 60)}:${pad(total % 60)}" else "${pad(total / 60)}:${pad(total % 60)}"
}

/** The list with [id] changed by [change]; unknown ids leave it as it was. */
fun updateTask(list: StudyTaskList, id: String, change: (StudyTask) -> StudyTask) =
    list.copy(tasks = list.tasks.map { if (it.id == id) change(it) else it })

/** Removing a detected task remembers its id so a re-scan does not bring it back. */
fun removeTask(list: StudyTaskList, id: String): StudyTaskList {
    val task = list.tasks.firstOrNull { it.id == id } ?: return list
    return StudyTaskList(list.tasks.filter { it.id != id }, if (task.manual) list.removed else (list.removed + id).distinct())
}

// -- text runs from the PDF -------------------------------------------------------

/** One piece of text with its vertical extent on the page, as the Android PDF renderer reports it. */
data class PdfTextRun(val text: String, val top: Float = Float.NaN, val bottom: Float = Float.NaN)

/**
 * Groups text runs into lines. A new line starts at a line break inside a run or when the vertical
 * position moves by more than half a text height; runs without bounds are one line each.
 */
fun linesFromRuns(runs: List<PdfTextRun>): List<String> {
    val lines = ArrayList<String>()
    val current = StringBuilder()
    var lastCentre = Float.NaN
    fun flush() {
        val line = current.toString().replace(SPACES, " ").trim()
        if (line.isNotEmpty()) lines += line
        current.setLength(0)
    }
    for (run in runs) {
        val hasBounds = !run.top.isNaN() && !run.bottom.isNaN()
        val centre = if (hasBounds) (run.top + run.bottom) / 2f else Float.NaN
        val height = if (hasBounds) run.bottom - run.top else 0f
        if (!hasBounds || (!lastCentre.isNaN() && kotlin.math.abs(centre - lastCentre) > maxOf(3f, height * 0.5f))) flush()
        run.text.split('\n').forEachIndexed { index, part ->
            if (index > 0) flush()
            if (current.isNotEmpty() && !current.last().isWhitespace() && part.isNotEmpty() && !part.first().isWhitespace()) current.append(' ')
            current.append(part)
        }
        if (!hasBounds) flush()
        if (hasBounds) lastCentre = centre
    }
    flush()
    return lines
}

const val MAX_TASK_SCAN_PAGES = 120
