package ch.fasrv.fanotes.desk

import ch.fasrv.fanotes.famd.isoNow
import ch.fasrv.fanotes.ink.InkStroke
import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.deepCopy
import ch.fasrv.fanotes.json.jsonArray
import ch.fasrv.fanotes.json.jsonNull
import ch.fasrv.fanotes.json.jsonNumber
import ch.fasrv.fanotes.json.jsonObject
import ch.fasrv.fanotes.json.jsonString
import java.time.Instant
import java.time.ZoneId
import kotlin.math.ceil
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.round

/**
 * Per-note counters stored in the `.famd` payload as `pageStats`.
 * The shape matches `fanotes/src/lib/pageStats.ts` (version 2). Opening a
 * note counts here; the file is rewritten on the next save, same as desktop.
 */
const val PAGE_STATS_VERSION = 2
private const val MM_PER_SOURCE_PX = 210.0 / 900.0
private val DAY = Regex("""\d{4}-\d{2}-\d{2}""")

data class InkSnapshot(val strokes: Int, val points: Int, val lengthMm: Double, val penDownMs: Long, val savedAt: String?)
data class DocumentStats(
    val words: Int,
    val characters: Int,
    val charactersWithoutSpaces: Int,
    val lines: Int,
    val paragraphs: Int,
    val headings: Int,
    val links: Int,
    val images: Int,
    val tasks: Int,
    val tasksDone: Int,
    val codeBlocks: Int,
    val mathBlocks: Int,
    val tables: Int,
    val blockquotes: Int,
    val listItems: Int,
    val readingMinutes: Int,
    val peakWords: Int,
    val wordsAdded: Int,
    val wordsRemoved: Int,
)

data class PageStats(
    val createdAt: String,
    val modifiedAt: String,
    val firstOpenedAt: String,
    val lastOpenedAt: String,
    val lastClosedAt: String?,
    val lastSavedAt: String?,
    val openCount: Int,
    val saveCount: Int,
    val dwellMs: Long,
    val focusMs: Long,
    val longestSessionMs: Long,
    val lastSessionMs: Long,
    val activeDays: List<String>,
    val opensByHour: List<Int>,
    val typingKeystrokes: Int,
    val inkStrokes: Int,
    val inkPoints: Int,
    val inkLengthMm: Double,
    val inkPenDownMs: Long,
    val strokesErased: Int,
    val current: InkSnapshot,
    val document: DocumentStats,
)

fun emptyPageStats(nowMs: Long): PageStats {
    val at = isoNow(nowMs)
    return PageStats(
        createdAt = at,
        modifiedAt = at,
        firstOpenedAt = at,
        lastOpenedAt = at,
        lastClosedAt = null,
        lastSavedAt = null,
        openCount = 0,
        saveCount = 0,
        dwellMs = 0,
        focusMs = 0,
        longestSessionMs = 0,
        lastSessionMs = 0,
        activeDays = emptyList(),
        opensByHour = List(24) { 0 },
        typingKeystrokes = 0,
        inkStrokes = 0,
        inkPoints = 0,
        inkLengthMm = 0.0,
        inkPenDownMs = 0,
        strokesErased = 0,
        current = InkSnapshot(0, 0, 0.0, 0, null),
        document = emptyDocument(),
    )
}

fun parsePageStats(value: JsonValue.Obj?, nowMs: Long = System.currentTimeMillis()): PageStats {
    if (value == null) return emptyPageStats(nowMs)
    val created = value.string("createdAt") ?: isoNow(nowMs)
    val document = value.obj("document")
    val ink = value.obj("ink")
    val current = ink?.obj("current")
    val measured = documentStatsFrom(document)
    return emptyPageStats(nowMs).copy(
        createdAt = created,
        modifiedAt = value.string("modifiedAt") ?: created,
        firstOpenedAt = value.string("firstOpenedAt") ?: created,
        lastOpenedAt = value.string("lastOpenedAt") ?: created,
        lastClosedAt = value.string("lastClosedAt"),
        lastSavedAt = value.string("lastSavedAt"),
        openCount = count(value, "openCount"),
        saveCount = count(value, "saveCount"),
        dwellMs = countLong(value, "dwellMs"),
        focusMs = countLong(value, "focusMs"),
        longestSessionMs = countLong(value, "longestSessionMs"),
        lastSessionMs = countLong(value, "lastSessionMs"),
        activeDays = value.array("activeDays")?.items.orEmpty().mapNotNull { (it as? JsonValue.Str)?.value }.filter { DAY.matches(it) }.takeLast(400),
        opensByHour = hourCounts(value.array("opensByHour")),
        typingKeystrokes = count(value.obj("typing"), "keystrokes"),
        inkStrokes = count(ink, "strokes"),
        inkPoints = count(ink, "points"),
        inkLengthMm = ink?.double("lengthMm") ?: 0.0,
        inkPenDownMs = countLong(ink, "penDownMs"),
        strokesErased = count(ink, "strokesErased"),
        current = InkSnapshot(
            count(current, "strokes"),
            count(current, "points"),
            current?.double("lengthMm") ?: 0.0,
            countLong(current, "penDownMs"),
            current?.string("savedAt"),
        ),
        document = measured.copy(peakWords = max(measured.peakWords, measured.words)),
    )
}

fun openPageStats(stats: PageStats, nowMs: Long, zone: ZoneId = ZoneId.systemDefault()): PageStats {
    val zoned = Instant.ofEpochMilli(nowMs).atZone(zone)
    val hours = stats.opensByHour.toMutableList().also { if (it.size < 24) while (it.size < 24) it += 0 }
    hours[zoned.hour] = hours[zoned.hour] + 1
    val day = zoned.toLocalDate().toString()
    val days = if (day in stats.activeDays) stats.activeDays else (stats.activeDays + day).takeLast(400)
    return stats.copy(lastOpenedAt = isoNow(nowMs), openCount = stats.openCount + 1, activeDays = days, opensByHour = hours)
}

fun recordPageSaved(
    stats: PageStats,
    markdown: String,
    strokes: List<InkStroke>,
    sourceWidth: Double,
    sourceHeight: Double,
    nowMs: Long,
    dwellDeltaMs: Long = 0,
): PageStats {
    val measured = measureDocument(markdown)
    val delta = measured.words - stats.document.words
    val document = measured.copy(
        peakWords = max(stats.document.peakWords, measured.words),
        wordsAdded = stats.document.wordsAdded + if (delta > 0) delta else 0,
        wordsRemoved = stats.document.wordsRemoved + if (delta < 0) -delta else 0,
    )
    val summary = summarizeInk(strokes, sourceWidth, sourceHeight)
    val addedStrokes = (summary.strokes - stats.current.strokes).coerceAtLeast(0)
    val removedStrokes = (stats.current.strokes - summary.strokes).coerceAtLeast(0)
    val dwell = stats.dwellMs + dwellDeltaMs.coerceAtLeast(0)
    return stats.copy(
        modifiedAt = isoNow(nowMs),
        lastSavedAt = isoNow(nowMs),
        saveCount = stats.saveCount + 1,
        dwellMs = dwell,
        focusMs = minOf(dwell, stats.focusMs + dwellDeltaMs.coerceAtLeast(0)),
        longestSessionMs = max(stats.longestSessionMs, dwellDeltaMs.coerceAtLeast(0)),
        lastSessionMs = if (dwellDeltaMs > 0) dwellDeltaMs else stats.lastSessionMs,
        inkStrokes = stats.inkStrokes + addedStrokes,
        inkPoints = stats.inkPoints + (summary.points - stats.current.points).coerceAtLeast(0),
        inkLengthMm = round1(stats.inkLengthMm + (summary.lengthMm - stats.current.lengthMm).coerceAtLeast(0.0)),
        inkPenDownMs = stats.inkPenDownMs + (summary.penDownMs - stats.current.penDownMs).coerceAtLeast(0),
        strokesErased = stats.strokesErased + removedStrokes,
        current = summary.copy(savedAt = isoNow(nowMs)),
        document = document,
    )
}

fun strokeLengthMm(stroke: InkStroke, sourceWidth: Double, sourceHeight: Double): Double {
    var length = 0.0
    val points = stroke.points
    for (index in 1 until points.size) {
        val dx = (points[index].x - points[index - 1].x) * sourceWidth
        val dy = (points[index].y - points[index - 1].y) * sourceHeight
        length += hypot(dx, dy)
    }
    return length * MM_PER_SOURCE_PX
}

fun measureDocument(markdown: String): DocumentStats {
    val lines = if (markdown.isEmpty()) emptyList() else markdown.replace("\r\n", "\n").split('\n')
    var headings = 0
    var listItems = 0
    var tasks = 0
    var tasksDone = 0
    var codeBlocks = 0
    var mathBlocks = 0
    var tables = 0
    var blockquotes = 0
    var paragraphs = 0
    var inCode = false
    var inMath = false
    var inParagraph = false
    var previous = ""
    for (line in lines) {
        if (line.startsWith("```") || line.startsWith("~~~")) {
            if (!inCode) codeBlocks += 1
            inCode = !inCode
            inParagraph = false
            previous = line
            continue
        }
        if (inCode) {
            previous = line
            continue
        }
        val trimmed = line.trim()
        if (trimmed.startsWith("$$")) {
            val closes = trimmed.length > 2 && trimmed.endsWith("$$")
            if (!inMath) mathBlocks += 1
            if (!closes) inMath = !inMath
            inParagraph = false
            previous = line
            continue
        }
        if (inMath) {
            previous = line
            continue
        }
        if (trimmed.isEmpty()) {
            inParagraph = false
            previous = line
            continue
        }
        if (trimmed.startsWith("#")) {
            headings += 1
            inParagraph = false
            previous = line
            continue
        }
        if (TABLE_SEPARATOR.matches(line) && previous.contains('|')) {
            tables += 1
            inParagraph = false
            previous = line
            continue
        }
        val quote = trimmed.startsWith(">")
        if (quote && !inParagraph) blockquotes += 1
        if (TASK.containsMatchIn(line)) {
            tasks += 1
            if (Regex("""\[[xX]]""").containsMatchIn(line.substringBefore(']') + "]")) tasksDone += 1
            listItems += 1
        } else if (LIST_ITEM.containsMatchIn(line)) {
            listItems += 1
        } else if (!inParagraph && !quote && !line.contains('|')) {
            paragraphs += 1
        }
        inParagraph = true
        previous = line
    }
    val words = WORD.findAll(markdown).count()
    val images = IMAGE.findAll(markdown).count()
    val links = LINK.findAll(markdown.replace(IMAGE, "")).count()
    return DocumentStats(
        words = words,
        characters = markdown.length,
        charactersWithoutSpaces = markdown.count { !it.isWhitespace() },
        lines = lines.size,
        paragraphs = paragraphs,
        headings = headings,
        links = links,
        images = images,
        tasks = tasks,
        tasksDone = tasksDone,
        codeBlocks = codeBlocks,
        mathBlocks = mathBlocks,
        tables = tables,
        blockquotes = blockquotes,
        listItems = listItems,
        readingMinutes = if (words == 0) 0 else max(1, ceil(words / 210.0).toInt()),
        peakWords = words,
        wordsAdded = 0,
        wordsRemoved = 0,
    )
}

/** Updates the counters and leaves every other field the desktop already stored. */
fun mergePageStats(existing: JsonValue.Obj?, stats: PageStats): JsonValue.Obj {
    val root = (existing?.deepCopy() as? JsonValue.Obj) ?: JsonValue.Obj()
    fun num(key: String, value: Double) = root.put(key, jsonNumber(value))
    fun str(key: String, value: String?) = root.put(key, value?.let(::jsonString) ?: jsonNull())
    num("version", PAGE_STATS_VERSION.toDouble())
    str("createdAt", stats.createdAt)
    str("modifiedAt", stats.modifiedAt)
    str("firstOpenedAt", stats.firstOpenedAt)
    str("lastOpenedAt", stats.lastOpenedAt)
    str("lastClosedAt", stats.lastClosedAt)
    str("lastSavedAt", stats.lastSavedAt)
    num("openCount", stats.openCount.toDouble())
    num("saveCount", stats.saveCount.toDouble())
    num("dwellMs", stats.dwellMs.toDouble())
    num("focusMs", stats.focusMs.toDouble())
    num("longestSessionMs", stats.longestSessionMs.toDouble())
    num("lastSessionMs", stats.lastSessionMs.toDouble())
    root.put("activeDays", jsonArray(*stats.activeDays.map(::jsonString).toTypedArray()))
    root.put("opensByHour", jsonArray(*stats.opensByHour.map { jsonNumber(it.toDouble()) }.toTypedArray()))
    val typing = root.obj("typing") ?: JsonValue.Obj()
    typing.put("keystrokes", jsonNumber(stats.typingKeystrokes.toDouble()))
    root.put("typing", typing)
    val ink = root.obj("ink") ?: JsonValue.Obj()
    ink.put("strokes", jsonNumber(stats.inkStrokes.toDouble()))
    ink.put("points", jsonNumber(stats.inkPoints.toDouble()))
    ink.put("lengthMm", jsonNumber(round1(stats.inkLengthMm)))
    ink.put("penDownMs", jsonNumber(stats.inkPenDownMs.toDouble()))
    ink.put("strokesErased", jsonNumber(stats.strokesErased.toDouble()))
    val current = ink.obj("current") ?: JsonValue.Obj()
    current.put("strokes", jsonNumber(stats.current.strokes.toDouble()))
    current.put("points", jsonNumber(stats.current.points.toDouble()))
    current.put("lengthMm", jsonNumber(round1(stats.current.lengthMm)))
    current.put("penDownMs", jsonNumber(stats.current.penDownMs.toDouble()))
    current.put("savedAt", stats.current.savedAt?.let(::jsonString) ?: jsonNull())
    ink.put("current", current)
    root.put("ink", ink)
    val document = root.obj("document") ?: JsonValue.Obj()
    fun doc(key: String, value: Int) = document.put(key, jsonNumber(value.toDouble()))
    doc("words", stats.document.words)
    doc("characters", stats.document.characters)
    doc("charactersWithoutSpaces", stats.document.charactersWithoutSpaces)
    doc("lines", stats.document.lines)
    doc("paragraphs", stats.document.paragraphs)
    doc("headings", stats.document.headings)
    doc("links", stats.document.links)
    doc("images", stats.document.images)
    doc("tasks", stats.document.tasks)
    doc("tasksDone", stats.document.tasksDone)
    doc("codeBlocks", stats.document.codeBlocks)
    doc("mathBlocks", stats.document.mathBlocks)
    doc("tables", stats.document.tables)
    doc("blockquotes", stats.document.blockquotes)
    doc("listItems", stats.document.listItems)
    doc("readingMinutes", stats.document.readingMinutes)
    doc("peakWords", stats.document.peakWords)
    doc("wordsAdded", stats.document.wordsAdded)
    doc("wordsRemoved", stats.document.wordsRemoved)
    root.put("document", document)
    return root
}

fun pageStatsJson(stats: PageStats): JsonValue.Obj = jsonObject(
    "version" to jsonNumber(PAGE_STATS_VERSION.toDouble()),
    "createdAt" to jsonString(stats.createdAt),
    "modifiedAt" to jsonString(stats.modifiedAt),
    "firstOpenedAt" to jsonString(stats.firstOpenedAt),
    "lastOpenedAt" to jsonString(stats.lastOpenedAt),
    "lastClosedAt" to stats.lastClosedAt?.let(::jsonString),
    "lastSavedAt" to stats.lastSavedAt?.let(::jsonString),
    "openCount" to jsonNumber(stats.openCount.toDouble()),
    "saveCount" to jsonNumber(stats.saveCount.toDouble()),
    "dwellMs" to jsonNumber(stats.dwellMs.toDouble()),
    "focusMs" to jsonNumber(stats.focusMs.toDouble()),
    "longestSessionMs" to jsonNumber(stats.longestSessionMs.toDouble()),
    "lastSessionMs" to jsonNumber(stats.lastSessionMs.toDouble()),
    "activeDays" to jsonArray(*stats.activeDays.map(::jsonString).toTypedArray()),
    "opensByHour" to jsonArray(*stats.opensByHour.map { jsonNumber(it.toDouble()) }.toTypedArray()),
    "typing" to jsonObject("keystrokes" to jsonNumber(stats.typingKeystrokes.toDouble())),
    "ink" to jsonObject(
        "strokes" to jsonNumber(stats.inkStrokes.toDouble()),
        "points" to jsonNumber(stats.inkPoints.toDouble()),
        "lengthMm" to jsonNumber(round1(stats.inkLengthMm)),
        "penDownMs" to jsonNumber(stats.inkPenDownMs.toDouble()),
        "strokesErased" to jsonNumber(stats.strokesErased.toDouble()),
        "current" to jsonObject(
            "strokes" to jsonNumber(stats.current.strokes.toDouble()),
            "points" to jsonNumber(stats.current.points.toDouble()),
            "lengthMm" to jsonNumber(round1(stats.current.lengthMm)),
            "penDownMs" to jsonNumber(stats.current.penDownMs.toDouble()),
            "savedAt" to stats.current.savedAt?.let(::jsonString),
        ),
    ),
    "document" to documentJson(stats.document),
)

private fun documentJson(document: DocumentStats) = jsonObject(
    "words" to jsonNumber(document.words.toDouble()),
    "characters" to jsonNumber(document.characters.toDouble()),
    "charactersWithoutSpaces" to jsonNumber(document.charactersWithoutSpaces.toDouble()),
    "lines" to jsonNumber(document.lines.toDouble()),
    "paragraphs" to jsonNumber(document.paragraphs.toDouble()),
    "headings" to jsonNumber(document.headings.toDouble()),
    "links" to jsonNumber(document.links.toDouble()),
    "images" to jsonNumber(document.images.toDouble()),
    "tasks" to jsonNumber(document.tasks.toDouble()),
    "tasksDone" to jsonNumber(document.tasksDone.toDouble()),
    "codeBlocks" to jsonNumber(document.codeBlocks.toDouble()),
    "mathBlocks" to jsonNumber(document.mathBlocks.toDouble()),
    "tables" to jsonNumber(document.tables.toDouble()),
    "blockquotes" to jsonNumber(document.blockquotes.toDouble()),
    "listItems" to jsonNumber(document.listItems.toDouble()),
    "readingMinutes" to jsonNumber(document.readingMinutes.toDouble()),
    "peakWords" to jsonNumber(document.peakWords.toDouble()),
    "wordsAdded" to jsonNumber(document.wordsAdded.toDouble()),
    "wordsRemoved" to jsonNumber(document.wordsRemoved.toDouble()),
)

private fun summarizeInk(strokes: List<InkStroke>, sourceWidth: Double, sourceHeight: Double): InkSnapshot {
    var points = 0
    var length = 0.0
    var penDown = 0L
    for (stroke in strokes) {
        points += stroke.points.size
        length += strokeLengthMm(stroke, sourceWidth, sourceHeight)
        val first = stroke.points.firstOrNull()?.t
        val last = stroke.points.lastOrNull()?.t
        if (first != null && last != null) penDown += (last - first).coerceAtLeast(0.0).toLong()
    }
    return InkSnapshot(strokes.size, points, round1(length), penDown, null)
}

private fun emptyDocument() = DocumentStats(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)

private fun documentStatsFrom(value: JsonValue.Obj?): DocumentStats {
    if (value == null) return emptyDocument()
    return DocumentStats(
        words = count(value, "words"),
        characters = count(value, "characters"),
        charactersWithoutSpaces = count(value, "charactersWithoutSpaces"),
        lines = count(value, "lines"),
        paragraphs = count(value, "paragraphs"),
        headings = count(value, "headings"),
        links = count(value, "links"),
        images = count(value, "images"),
        tasks = count(value, "tasks"),
        tasksDone = count(value, "tasksDone"),
        codeBlocks = count(value, "codeBlocks"),
        mathBlocks = count(value, "mathBlocks"),
        tables = count(value, "tables"),
        blockquotes = count(value, "blockquotes"),
        listItems = count(value, "listItems"),
        readingMinutes = count(value, "readingMinutes"),
        peakWords = count(value, "peakWords"),
        wordsAdded = count(value, "wordsAdded"),
        wordsRemoved = count(value, "wordsRemoved"),
    )
}

private fun count(obj: JsonValue.Obj?, key: String) = obj?.double(key)?.toInt()?.coerceAtLeast(0) ?: 0
private fun countLong(obj: JsonValue.Obj?, key: String) = obj?.double(key)?.toLong()?.coerceAtLeast(0) ?: 0L

private fun hourCounts(array: JsonValue.Arr?): List<Int> {
    val values = array?.items.orEmpty().map { (it as? JsonValue.Num)?.value?.toInt()?.coerceAtLeast(0) ?: 0 }
    return List(24) { index -> values.getOrElse(index) { 0 } }
}

private fun round1(value: Double) = round(value * 10.0) / 10.0

private val TABLE_SEPARATOR = Regex("""^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$""")
private val TASK = Regex("""^\s*(?:[-*+]|\d+[.)])\s+\[( |x|X)]""")
private val LIST_ITEM = Regex("""^\s*(?:[-*+]|\d+[.)])\s+""")
private val WORD = Regex("""[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*""")
private val IMAGE = Regex("""!\[[^\]]*]\([^)]*\)""")
private val LINK = Regex("""(?<!!)\[[^\]]*]\([^)]*\)|\[\[[^\]]+]]|https?://\S+""")
