package ch.fasrv.fanotes.desk

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/**
 * Settings → Statistik, the aggregation half. Pure functions that mirror
 * `fanotes/src/lib/vaultStats.mjs`: the loader ([VaultStatsLoader]) reads the vault and hands
 * the facts over, nothing here does I/O.
 */
const val STATS_HEATMAP_WEEKS = 53
const val STATS_NO_SUBJECT = "Eingang"
const val STATS_NO_HOMEWORK_SUBJECT = "Ohne Fach"

private val EXAM_WORDS = Regex("klausur|prüfung|pruefung|exam|test|schulaufgabe|probe|lernkontrolle|lk\\b|arbeit", setOf(RegexOption.IGNORE_CASE))
private val DAY_KEY = Regex("^\\d{4}-\\d{2}-\\d{2}$")

enum class StatKind(val id: String) { MARKDOWN("markdown"), HANDWRITING("handwriting"), PDF("pdf"), STORY("story"), IMAGE("image"), MEDIA("media") }

/** What the file is before page facts decide between a typed and a handwritten note. */
enum class StatBase { NOTE, PDF, STORY, IMAGE, MEDIA }

data class StatScanFile(
    val path: String,
    val name: String,
    val base: StatBase,
    val size: Long,
    val mtime: Long,
    val subject: String,
    val color: String?,
)

data class CardSummary(val total: Int, val due: Int, val reviewed: Int, val reps: Int, val lapses: Int)

data class FactStats(
    val dwellMs: Long,
    val wordsTyped: Int,
    val strokes: Int,
    val penMs: Long,
    val activeDays: List<String>,
    val dwellByWeekday: List<Long>,
    /** Epoch ms of the page's `createdAt`, or 0. Used as the creation day. */
    val createdAtMs: Long = 0,
)

/**
 * What one note contributes. [partial] is true when it could only be read in part: it was bigger than
 * the read cap, its payload could not be parsed, or memory ran out. The words are then a lower bound
 * and [stats] may be missing.
 */
data class NoteFacts(val words: Int, val ink: Boolean, val cards: CardSummary?, val stats: FactStats?, val partial: Boolean = false)

/**
 * Words the way a student counts them: markdown syntax and the famd payload do not count. The rules
 * are the desktop ones (`vaultStats.mjs`): comments, fenced code, images and link targets go, link
 * text stays, a word is a letter or digit followed by letters, digits and apostrophes.
 *
 * Every step is one linear scan. The regular expressions this replaces copied the whole text five
 * times and, with many unclosed `<!--` or fences, rescanned the rest of the note for each one.
 */
fun countWords(markdown: String?): Int {
    if (markdown.isNullOrEmpty()) return 0
    var body: String = markdown
    body = removeSpans(body, "<!--", "-->")
    body = removeSpans(body, "```", "```")
    if (body.indexOf("](") >= 0) {
        body = removeImages(body)
        body = unwrapLinks(body)
    }
    // The syntax characters `# > * _ ` ~ | -` are neither letters nor digits, so they already end a word.
    return countWordRuns(body)
}

/** `open[\s\S]*?close` replaced by a space, without rescanning once no closer is left. */
private fun removeSpans(text: String, open: String, close: String): String {
    var start = text.indexOf(open)
    if (start < 0) return text
    val out = StringBuilder(text.length)
    var copied = 0
    while (start >= 0) {
        val end = text.indexOf(close, start + open.length)
        if (end < 0) break // No closer after this opener, so none after a later one either.
        out.append(text, copied, start).append(' ')
        copied = end + close.length
        start = text.indexOf(open, copied)
    }
    if (copied == 0) return text
    return out.append(text, copied, text.length).toString()
}

/** `!\[[^\]]*\]\([^)]*\)` replaced by a space. */
private fun removeImages(text: String): String = replaceLinks(text, image = true)

/** `\[([^\]]*)\]\([^)]*\)` replaced by its first group, the link text. */
private fun unwrapLinks(text: String): String = replaceLinks(text, image = false)

/**
 * The two link rules share one scan: an opener (`![` or `[`), the first `]` after it, a `(` right behind
 * it and the first `)` after that. The first `]` and `)` are remembered while later openers still share
 * them, so a run of unclosed openers costs one scan, not one per opener.
 */
private fun replaceLinks(text: String, image: Boolean): String {
    val opener = if (image) "![" else "["
    var start = text.indexOf(opener)
    if (start < 0) return text
    val out = StringBuilder(text.length)
    var copied = 0
    var bracket = NOT_SCANNED // first ']' at or after the current opener's text; -1: there is none
    var paren = NOT_SCANNED // first ')' at or after bracket + 2; -1: there is none
    while (start >= 0) {
        val textStart = start + opener.length
        if (bracket == NOT_SCANNED || bracket >= 0 && textStart > bracket) {
            bracket = text.indexOf(']', textStart)
            paren = NOT_SCANNED
        }
        if (bracket < 0) break // No ']' left: no later opener can close either.
        if (bracket + 1 < text.length && text[bracket + 1] == '(') {
            if (paren == NOT_SCANNED) paren = text.indexOf(')', bracket + 2)
            if (paren < 0) break // No ')' left after this point.
            out.append(text, copied, start)
            if (image) out.append(' ') else out.append(text, textStart, bracket)
            copied = paren + 1
            start = text.indexOf(opener, copied)
            bracket = NOT_SCANNED
            paren = NOT_SCANNED
        } else {
            start = text.indexOf(opener, start + 1)
        }
    }
    if (copied == 0) return text
    return out.append(text, copied, text.length).toString()
}

private const val NOT_SCANNED = -2

private fun isWordChar(codePoint: Int): Boolean = when (Character.getType(codePoint).toByte()) {
    Character.UPPERCASE_LETTER, Character.LOWERCASE_LETTER, Character.TITLECASE_LETTER, Character.MODIFIER_LETTER, Character.OTHER_LETTER,
    Character.DECIMAL_DIGIT_NUMBER, Character.LETTER_NUMBER, Character.OTHER_NUMBER,
    -> true
    else -> false
}

/** `[\p{L}\p{N}][\p{L}\p{N}'’]*` matches, counted without building them. */
private fun countWordRuns(text: String): Int {
    var count = 0
    var index = 0
    val end = text.length
    while (index < end) {
        val first = text.codePointAt(index)
        index += Character.charCount(first)
        if (!isWordChar(first)) continue
        count += 1
        while (index < end) {
            val next = text.codePointAt(index)
            if (!isWordChar(next) && next != '\''.code && next != '’'.code) break
            index += Character.charCount(next)
        }
    }
    return count
}

fun summarizeCards(cards: List<FlashCard>, today: String): CardSummary? = storedCards(cards)?.summary(today)

fun dayKeyOf(epochMs: Long, zone: ZoneId): String? =
    if (epochMs > 0) Instant.ofEpochMilli(epochMs).atZone(zone).toLocalDate().toString() else null

data class StatStreak(val current: Int, val longest: Int, val activeDays: Int)

fun statStreaks(activeDays: Set<String>, today: LocalDate): StatStreak {
    var current = 0
    var cursor = today
    // Today without activity does not break a streak that ran until yesterday.
    if (cursor.toString() !in activeDays) cursor = cursor.minusDays(1)
    while (cursor.toString() in activeDays) {
        current += 1
        cursor = cursor.minusDays(1)
    }
    val sorted = activeDays.filter { DAY_KEY.matches(it) }.mapNotNull { runCatching { LocalDate.parse(it) }.getOrNull() }.sorted()
    var longest = 0
    var run = 0
    var previous: LocalDate? = null
    for (day in sorted) {
        run = if (previous != null && previous.plusDays(1) == day) run + 1 else 1
        previous = day
        longest = maxOf(longest, run)
    }
    return StatStreak(current, longest, sorted.size)
}

data class StatSubject(
    val name: String,
    val color: String?,
    val count: Int,
    val bytes: Long,
    val words: Int,
    val dwellMs: Long,
    val kinds: Map<StatKind, Int>,
)

data class StatFileRow(val path: String, val name: String, val kind: StatKind, val size: Long, val mtime: Long, val ctime: Long, val subject: String)
data class StatKindRow(val count: Int, val bytes: Long)
data class StatHeatCell(val date: String, val count: Int, val level: Int, val future: Boolean, val words: Int)
data class StatWeek(val start: String, val edited: Int, val created: Int)
data class StatActivity(val cells: List<StatHeatCell>, val weeks: List<StatWeek>, val streak: StatStreak, val total: Int)
data class StatWriting(val wordsInNotes: Int, val wordsTyped: Int, val storyWords: Int, val strokes: Int, val penMs: Long)
data class StatTimeSubject(val name: String, val color: String?, val dwellMs: Long)
data class StatTime(val dwellMs: Long, val byWeekday: List<Long>, val notesMeasured: Int, val bySubject: List<StatTimeSubject>)
data class StatCards(val total: Int, val due: Int, val reviewed: Int, val reps: Int, val lapses: Int, val notes: Int, val retention: Double?)
data class StatHomeworkSubject(val name: String, val done: Int, val open: Int, val overdue: Int)
data class StatAppointment(val title: String, val subject: String, val date: String, val time: String?, val exam: Boolean)
data class StatSchool(val done: Int, val open: Int, val overdue: Int, val bySubject: List<StatHomeworkSubject>, val upcoming: List<StatAppointment>, val exams: List<StatAppointment>)
data class StatTotals(val files: Int, val bytes: Long, val folders: Int, val notes: Int)

data class VaultStats(
    val generatedAt: Long,
    val totals: StatTotals,
    val kinds: Map<StatKind, StatKindRow>,
    val subjects: List<StatSubject>,
    val largest: List<StatFileRow>,
    val newest: List<StatFileRow>,
    val recent: List<StatFileRow>,
    val activity: StatActivity,
    val writing: StatWriting,
    val time: StatTime,
    val cards: StatCards,
    val school: StatSchool?,
    /** Notes that were read only in part (see [NoteFacts.partial]). */
    val partialNotes: Int = 0,
)

data class StatsInput(
    val files: List<StatScanFile>,
    val folders: Int,
    /** path -> facts, for note files only. */
    val facts: Map<String, NoteFacts> = emptyMap(),
    /** path -> epoch ms of note-history snapshots. */
    val history: Map<String, List<Long>> = emptyMap(),
    /** story path -> day -> words (summed over devices). */
    val stories: Map<String, Map<String, Int>> = emptyMap(),
    val homework: List<HomeworkTask>? = null,
    val nowMs: Long = System.currentTimeMillis(),
    val zone: ZoneId = ZoneId.systemDefault(),
)

private fun level(count: Int, max: Int): Int = when {
    count <= 0 -> 0
    max <= 1 -> 4
    else -> minOf(4, 1 + Math.floor((count - 1).toDouble() / max * 4).toInt())
}

private class Cell(var edited: Int = 0, var created: Int = 0, var opened: Int = 0, var words: Int = 0)

fun aggregateVault(input: StatsInput): VaultStats {
    val zone = input.zone
    val today = Instant.ofEpochMilli(input.nowMs).atZone(zone).toLocalDate()
    val todayKey = today.toString()
    val counts = StatKind.values().associateWith { 0 }.toMutableMap()
    val bytesByKind = StatKind.values().associateWith { 0L }.toMutableMap()
    val subjects = LinkedHashMap<String, MutableSubject>()
    val activity = HashMap<String, Cell>()
    val activeDays = HashSet<String>()
    fun bump(day: String?, field: Int, by: Int = 1) {
        // A day after today (a clock that runs ahead, a synced file from such a device) is not activity.
        if (day == null || day > todayKey) return
        val cell = activity.getOrPut(day) { Cell() }
        when (field) {
            0 -> cell.edited += by
            1 -> cell.created += by
            2 -> cell.opened += by
            else -> cell.words += by
        }
        if (field != 2 || by > 0) activeDays.add(day)
    }
    var wordsInNotes = 0
    var wordsTyped = 0
    var storyWords = 0
    var strokes = 0
    var penMs = 0L
    var dwellMs = 0L
    val byWeekday = MutableList(7) { 0L }
    var notesMeasured = 0
    var cardTotal = 0; var cardDue = 0; var cardReviewed = 0; var cardReps = 0; var cardLapses = 0; var cardNotes = 0
    val rows = ArrayList<StatFileRow>(input.files.size)

    for (file in input.files) {
        val fact = input.facts[file.path]
        val kind = when (file.base) {
            StatBase.NOTE -> if (fact?.ink == true) StatKind.HANDWRITING else StatKind.MARKDOWN
            StatBase.PDF -> StatKind.PDF
            StatBase.STORY -> StatKind.STORY
            StatBase.IMAGE -> StatKind.IMAGE
            StatBase.MEDIA -> StatKind.MEDIA
        }
        counts[kind] = counts.getValue(kind) + 1
        bytesByKind[kind] = bytesByKind.getValue(kind) + file.size
        val subject = subjects.getOrPut(file.subject) { MutableSubject(file.subject, file.color) }
        subject.count += 1
        subject.bytes += file.size
        subject.kinds[kind] = subject.kinds.getValue(kind) + 1
        val ctime = fact?.stats?.createdAtMs ?: 0L
        rows += StatFileRow(file.path, file.name, kind, file.size, file.mtime, ctime, file.subject)
        bump(dayKeyOf(file.mtime, zone), 0)
        bump(dayKeyOf(ctime, zone), 1)
        if (fact != null) {
            wordsInNotes += fact.words
            subject.words += fact.words
            fact.cards?.let {
                cardTotal += it.total; cardDue += it.due; cardReviewed += it.reviewed
                cardReps += it.reps; cardLapses += it.lapses; cardNotes += 1
            }
            fact.stats?.let { stats ->
                wordsTyped += stats.wordsTyped
                strokes += stats.strokes
                penMs += stats.penMs
                if (stats.dwellMs > 0) {
                    dwellMs += stats.dwellMs
                    notesMeasured += 1
                    subject.dwellMs += stats.dwellMs
                    stats.dwellByWeekday.forEachIndexed { index, ms -> if (index < 7) byWeekday[index] += ms.coerceAtLeast(0) }
                }
                for (day in stats.activeDays) bump(day, 2)
            }
        }
        val modifiedDay = dayKeyOf(file.mtime, zone)
        for (stamp in input.history[file.path].orEmpty()) {
            val day = dayKeyOf(stamp, zone)
            if (day != null && day != modifiedDay) bump(day, 0)
        }
    }
    for (perDay in input.stories.values) {
        for ((day, words) in perDay) {
            if (words > 0) {
                storyWords += words
                bump(day, 3, words)
            }
        }
    }

    // Heatmap: Monday-first columns, ending with the current week.
    val monday = today.minusDays(((today.dayOfWeek.value - 1)).toLong())
    val start = monday.minusWeeks((STATS_HEATMAP_WEEKS - 1).toLong())
    val raw = ArrayList<Triple<String, Int, Int>>(STATS_HEATMAP_WEEKS * 7)
    for (index in 0 until STATS_HEATMAP_WEEKS * 7) {
        val key = start.plusDays(index.toLong()).toString()
        val cell = activity[key]
        val count = if (cell == null) 0 else cell.edited + cell.created + cell.opened + (if (cell.words > 0) 1 else 0)
        raw += Triple(key, count, cell?.words ?: 0)
    }
    val sortedCounts = raw.map { it.second }.sorted()
    val percentile = maxOf(1, sortedCounts.take(maxOf(1, Math.floor(raw.size * 0.95).toInt())).last())
    val cells = raw.map { (key, count, words) ->
        val future = key > todayKey
        StatHeatCell(key, count, if (future) 0 else level(count, percentile), future, words)
    }
    val weeks = (0 until 12).map { week ->
        val from = monday.minusWeeks((11 - week).toLong())
        var edited = 0
        var created = 0
        for (day in 0 until 7) {
            activity[from.plusDays(day.toLong()).toString()]?.let { edited += it.edited; created += it.created }
        }
        StatWeek(from.toString(), edited, created)
    }

    val school = input.homework?.let { schoolPicture(it, todayKey) }

    val subjectRows = subjects.values
        .map { StatSubject(it.name, it.color, it.count, it.bytes, it.words, it.dwellMs, it.kinds.toMap()) }
        .sortedWith(compareByDescending<StatSubject> { it.count }.thenBy(java.text.Collator.getInstance(java.util.Locale.GERMAN)) { it.name })
    val bytes = input.files.sumOf { it.size }
    return VaultStats(
        generatedAt = input.nowMs,
        totals = StatTotals(
            input.files.size, bytes, input.folders,
            counts.getValue(StatKind.MARKDOWN) + counts.getValue(StatKind.HANDWRITING) + counts.getValue(StatKind.PDF) + counts.getValue(StatKind.STORY),
        ),
        kinds = StatKind.values().associateWith { StatKindRow(counts.getValue(it), bytesByKind.getValue(it)) },
        subjects = subjectRows,
        largest = rows.sortedByDescending { it.size }.take(8),
        newest = rows.filter { it.ctime > 0 || it.mtime > 0 }.sortedByDescending { if (it.ctime > 0) it.ctime else it.mtime }.take(8),
        recent = rows.filter { it.mtime > 0 }.sortedByDescending { it.mtime }.take(8),
        activity = StatActivity(cells, weeks, statStreaks(activeDays, today), cells.sumOf { it.count }),
        writing = StatWriting(wordsInNotes, wordsTyped, storyWords, strokes, penMs),
        time = StatTime(
            dwellMs, byWeekday, notesMeasured,
            subjectRows.filter { it.dwellMs > 0 }.sortedByDescending { it.dwellMs }.take(6).map { StatTimeSubject(it.name, it.color, it.dwellMs) },
        ),
        cards = StatCards(
            cardTotal, cardDue, cardReviewed, cardReps, cardLapses, cardNotes,
            if (cardReps > 0) ((cardReps - cardLapses).toDouble() / cardReps).coerceIn(0.0, 1.0) else null,
        ),
        school = school,
        partialNotes = input.facts.values.count { it.partial },
    )
}

private class MutableSubject(val name: String, val color: String?) {
    var count = 0
    var bytes = 0L
    var words = 0
    var dwellMs = 0L
    val kinds = StatKind.values().associateWith { 0 }.toMutableMap()
}

private fun schoolPicture(tasks: List<HomeworkTask>, today: String): StatSchool {
    val work = tasks.filter { it.kind != "appointment" }
    val appointments = tasks.filter { it.kind == "appointment" }
    val bySubject = LinkedHashMap<String, IntArray>()
    var overdue = 0
    for (task in work) {
        val row = bySubject.getOrPut(task.subject.ifBlank { STATS_NO_HOMEWORK_SUBJECT }) { IntArray(3) }
        if (task.done) row[0] += 1
        else {
            row[1] += 1
            val due = task.dueDate
            if (due != null && due < today) {
                row[2] += 1
                overdue += 1
            }
        }
    }
    val upcoming = appointments
        .filter { !it.done && it.dueDate != null && it.dueDate >= today }
        .sortedBy { "${it.dueDate} ${it.dueTime.orEmpty()}" }
        .map { StatAppointment(it.title, it.subject, it.dueDate.orEmpty(), it.dueTime, EXAM_WORDS.containsMatchIn(it.title)) }
    return StatSchool(
        done = work.count { it.done },
        open = work.count { !it.done },
        overdue = overdue,
        bySubject = bySubject.map { (name, v) -> StatHomeworkSubject(name, v[0], v[1], v[2]) }.sortedByDescending { it.open + it.done },
        upcoming = upcoming.take(8),
        exams = upcoming.filter { it.exam }.take(5),
    )
}
