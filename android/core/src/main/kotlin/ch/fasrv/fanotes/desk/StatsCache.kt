package ch.fasrv.fanotes.desk

import ch.fasrv.fanotes.json.JsonLimits
import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.escapeJson
import ch.fasrv.fanotes.json.parseJson
import java.io.BufferedReader
import java.io.File
import java.io.IOException
import java.io.Reader
import java.io.Writer
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.time.LocalDate

/**
 * The saved half of the Statistik page: what was read from each note, kept in app storage so that
 * opening the page again, or after the process was killed, does not read the vault again. An entry is
 * valid while the note's path, size and modification time are unchanged. There is no expiry: the one
 * thing that depends on the date, the number of cards due, is derived from stored due dates.
 *
 * The file is JSON Lines, one entry per line, so it is read and written one entry at a time and a
 * damaged line costs one note, not the cache:
 *
 * ```
 * {"format":"fanotes-stats-cache","version":1,"cap":4194304,"notes":812,"bytes":93123456,"at":1731628800000}
 * ["f","Mathe/Algebra.md",size,mtime,words,flags,cards,stats]
 * ["h","Mathe/Algebra.md",size,mtime,[snapshotMs,...]]
 * ["s","Roman.story",size,mtime,[["2026-11-14",250],...]]
 * ```
 *
 * `flags` is 1 for ink and 2 for a partial read. `cards` is `[total,reviewed,reps,lapses,[[due,count],...]]`
 * and `stats` is `[dwellMs,wordsTyped,strokes,penMs,createdAtMs,[7 weekday ms],[epochDay,...]]`.
 */
const val STATS_CACHE_VERSION = 1

private const val STATS_CACHE_FORMAT = "fanotes-stats-cache"
private const val MAX_CACHE_FILE_BYTES = 128L * 1024 * 1024
private val LINE_LIMITS = JsonLimits(maxDepth = 8, maxNodes = 400_000)

/** Where the saved cache lives. [FileStatsCacheStore] on the device, memory in tests. */
interface StatsCacheStore {
    /** The saved cache, or null when there is none. The caller closes it. */
    fun open(): Reader?

    /** Replaces the saved cache with what [write] produces; a reader never sees half of it. */
    fun replace(write: (Writer) -> Unit)

    fun delete()
}

/** A cache file next to the app's other private files. Written to a temporary file and moved into place. */
class FileStatsCacheStore(private val file: File) : StatsCacheStore {
    override fun open(): Reader? = try {
        if (file.isFile && file.length() <= MAX_CACHE_FILE_BYTES) file.inputStream().buffered().reader(Charsets.UTF_8) else null
    } catch (_: IOException) {
        null
    }

    override fun replace(write: (Writer) -> Unit) {
        val folder = file.absoluteFile.parentFile
        folder?.mkdirs()
        val temp = File(folder, file.name + ".tmp")
        try {
            temp.outputStream().buffered().writer(Charsets.UTF_8).use(write)
            try {
                Files.move(temp.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
            } catch (_: AtomicMoveNotSupportedException) {
                Files.move(temp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING)
            }
        } finally {
            temp.delete()
        }
    }

    override fun delete() {
        file.delete()
        File(file.path + ".tmp").delete()
    }
}

/** What one note's fact file said, independent of today's date. */
class StoredFacts(
    val words: Int,
    val ink: Boolean,
    val partial: Boolean,
    val cards: StoredCards?,
    val stats: FactStats?,
) {
    /** The facts the aggregation reads, with the number of cards due worked out for [today] (`yyyy-MM-dd`). */
    fun toNoteFacts(today: String) = NoteFacts(words, ink, cards?.summary(today), stats, partial)
}

/** Card totals and how many cards fall due on each day, so "due today" can be derived any day. */
class StoredCards(val total: Int, val reviewed: Int, val reps: Int, val lapses: Int, val dueByDay: List<DueCount>) {
    fun summary(today: String): CardSummary {
        var due = 0
        for (entry in dueByDay) if (entry.day <= today) due += entry.count
        return CardSummary(total, due, reviewed, reps, lapses)
    }
}

class DueCount(val day: String, val count: Int)

fun storedCards(cards: List<FlashCard>): StoredCards? {
    if (cards.isEmpty()) return null
    var reps = 0
    var lapses = 0
    var reviewed = 0
    val dueByDay = java.util.TreeMap<String, Int>()
    for (card in cards) {
        dueByDay.merge(card.due, 1, Int::plus)
        if (card.reps > 0) reviewed += 1
        reps += card.reps.coerceAtLeast(0)
        lapses += card.lapses.coerceAtLeast(0)
    }
    return StoredCards(cards.size, reviewed, reps, lapses, dueByDay.map { DueCount(it.key, it.value) })
}

/** A cached entry: valid for exactly this size and modification time of the note it was read from. */
class CachedFacts(val size: Long, val mtime: Long, val facts: StoredFacts)

/** Snapshot times (epoch ms) of a note's history, valid for the note's size and modification time. */
class CachedHistory(val size: Long, val mtime: Long, val stamps: List<Long>)

/** Words per day of a story project (summed over its devices), valid for its size and modification time. */
class CachedStory(val size: Long, val mtime: Long, val days: Map<String, Int>)

/** The last complete run, kept for the diagnostics report: grouped notes and all bytes. */
class StatsSummary(val notes: Long, val bytes: Long, val at: Long)

class StatsCacheData(
    val facts: MutableMap<String, CachedFacts> = HashMap(),
    val history: MutableMap<String, CachedHistory> = HashMap(),
    val stories: MutableMap<String, CachedStory> = HashMap(),
    var summary: StatsSummary? = null,
)

/**
 * Shares one string per day. A vault of 20,000 notes with up to 400 active days each would otherwise
 * hold millions of equal strings.
 */
class DayPool {
    private val names = HashMap<String, String>()
    private val epoch = HashMap<Long, String>()

    @Synchronized
    fun intern(day: String): String = names.getOrPut(day) { day }

    @Synchronized
    fun ofEpochDay(day: Long): String = epoch.getOrPut(day) { intern(LocalDate.ofEpochDay(day).toString()) }
}

fun writeStatsCache(store: StatsCacheStore, data: StatsCacheData, maxNoteBytes: Int) {
    store.replace { out ->
        val summary = data.summary
        out.write("{\"format\":\"$STATS_CACHE_FORMAT\",\"version\":$STATS_CACHE_VERSION,\"cap\":$maxNoteBytes")
        if (summary != null) out.write(",\"notes\":${summary.notes},\"bytes\":${summary.bytes},\"at\":${summary.at}")
        out.write("}\n")
        val line = StringBuilder(256)
        for ((path, entry) in data.facts) {
            line.setLength(0)
            appendFacts(line, path, entry)
            out.append(line).append('\n')
        }
        for ((path, entry) in data.history) {
            line.setLength(0)
            line.append("[\"h\",").append(escapeJson(path)).append(',').append(entry.size).append(',').append(entry.mtime).append(",[")
            entry.stamps.forEachIndexed { index, stamp -> if (index > 0) line.append(','); line.append(stamp) }
            line.append("]]")
            out.append(line).append('\n')
        }
        for ((path, entry) in data.stories) {
            line.setLength(0)
            line.append("[\"s\",").append(escapeJson(path)).append(',').append(entry.size).append(',').append(entry.mtime).append(",[")
            var first = true
            for ((day, words) in entry.days) {
                if (!first) line.append(',')
                first = false
                line.append('[').append(escapeJson(day)).append(',').append(words).append(']')
            }
            line.append("]]")
            out.append(line).append('\n')
        }
    }
}

private fun appendFacts(line: StringBuilder, path: String, entry: CachedFacts) {
    val facts = entry.facts
    line.append("[\"f\",").append(escapeJson(path)).append(',').append(entry.size).append(',').append(entry.mtime)
    line.append(',').append(facts.words).append(',').append((if (facts.ink) 1 else 0) or (if (facts.partial) 2 else 0)).append(',')
    val cards = facts.cards
    if (cards == null) line.append("null") else {
        line.append('[').append(cards.total).append(',').append(cards.reviewed).append(',').append(cards.reps).append(',').append(cards.lapses).append(",[")
        cards.dueByDay.forEachIndexed { index, due ->
            if (index > 0) line.append(',')
            line.append('[').append(escapeJson(due.day)).append(',').append(due.count).append(']')
        }
        line.append("]]")
    }
    line.append(',')
    val stats = facts.stats
    if (stats == null) line.append("null") else {
        line.append('[').append(stats.dwellMs).append(',').append(stats.wordsTyped).append(',').append(stats.strokes).append(',').append(stats.penMs)
        line.append(',').append(stats.createdAtMs).append(",[")
        stats.dwellByWeekday.forEachIndexed { index, ms -> if (index > 0) line.append(','); line.append(ms) }
        line.append("],[")
        var first = true
        for (day in stats.activeDays) {
            // A string that is no calendar day (the page file is hand-edited) never counted for anything.
            val epochDay = try { LocalDate.parse(day).toEpochDay() } catch (_: Exception) { continue }
            if (!first) line.append(',')
            first = false
            line.append(epochDay)
        }
        line.append("]]")
    }
    line.append(']')
}

/**
 * The saved cache, or null when there is none or it is not ours (another version). A line that does
 * not parse is skipped, so one damaged entry only means that note is read again. Entries stored with
 * another read cap are dropped when they were partial, because the new cap may read them whole.
 */
fun readStatsCache(store: StatsCacheStore, maxNoteBytes: Int, days: DayPool = DayPool()): StatsCacheData? {
    val source = store.open() ?: return null
    return try {
        val reader = source as? BufferedReader ?: BufferedReader(source)
        val header = parseHeader(reader.readLine() ?: return null) ?: return null
        val sameCap = header.double("cap")?.toLong() == maxNoteBytes.toLong()
        val data = StatsCacheData(summary = summaryOf(header))
        while (true) {
            val line = reader.readLine() ?: break
            if (line.isEmpty()) continue
            try {
                decodeLine(line, data, days, keepPartial = sameCap)
            } catch (_: Exception) {
                // One damaged entry: that note is simply read again.
            }
        }
        data
    } catch (_: IOException) {
        null
    } finally {
        try { source.close() } catch (_: IOException) { }
    }
}

/** The totals of the last complete run, from the first line of the cache only. */
fun readStatsSummary(store: StatsCacheStore): StatsSummary? {
    val source = store.open() ?: return null
    return try {
        summaryOf(parseHeader(BufferedReader(source).readLine() ?: return null) ?: return null)
    } catch (_: IOException) {
        null
    } finally {
        try { source.close() } catch (_: IOException) { }
    }
}

private fun parseHeader(line: String): JsonValue.Obj? {
    val header = try { parseJson(line, LINE_LIMITS) as? JsonValue.Obj } catch (_: Exception) { null } ?: return null
    if (header.string("format") != STATS_CACHE_FORMAT) return null
    if (header.double("version")?.toInt() != STATS_CACHE_VERSION) return null
    return header
}

private fun summaryOf(header: JsonValue.Obj): StatsSummary? {
    val notes = header.double("notes") ?: return null
    val bytes = header.double("bytes") ?: return null
    return StatsSummary(notes.toLong(), bytes.toLong(), header.double("at")?.toLong() ?: 0L)
}

private fun JsonValue.Arr.num(index: Int): Double = (items[index] as JsonValue.Num).value
private fun JsonValue.Arr.long(index: Int): Long = num(index).toLong()
private fun JsonValue.Arr.int(index: Int): Int = num(index).toInt()
private fun JsonValue.Arr.text(index: Int): String = (items[index] as JsonValue.Str).value
private fun JsonValue.Arr.list(index: Int): JsonValue.Arr = items[index] as JsonValue.Arr

private fun decodeLine(line: String, data: StatsCacheData, days: DayPool, keepPartial: Boolean) {
    val row = parseJson(line, LINE_LIMITS) as? JsonValue.Arr ?: return
    when (row.text(0)) {
        "f" -> {
            val flags = row.int(5)
            val partial = flags and 2 != 0
            if (partial && !keepPartial) return
            val cards = (row.items[6] as? JsonValue.Arr)?.let { c ->
                StoredCards(c.int(0), c.int(1), c.int(2), c.int(3), c.list(4).items.map { d -> d as JsonValue.Arr; DueCount(d.text(0), d.int(1)) })
            }
            val stats = (row.items[7] as? JsonValue.Arr)?.let { s ->
                FactStats(
                    dwellMs = s.long(0),
                    wordsTyped = s.int(1),
                    strokes = s.int(2),
                    penMs = s.long(3),
                    activeDays = s.list(6).items.map { days.ofEpochDay((it as JsonValue.Num).value.toLong()) },
                    dwellByWeekday = s.list(5).items.map { (it as JsonValue.Num).value.toLong() },
                    createdAtMs = s.long(4),
                )
            }
            data.facts[row.text(1)] = CachedFacts(row.long(2), row.long(3), StoredFacts(row.int(4), flags and 1 != 0, partial, cards, stats))
        }
        "h" -> data.history[row.text(1)] = CachedHistory(row.long(2), row.long(3), row.list(4).items.map { (it as JsonValue.Num).value.toLong() })
        "s" -> {
            val perDay = LinkedHashMap<String, Int>()
            for (item in row.list(4).items) {
                val pair = item as JsonValue.Arr
                perDay[days.intern(pair.text(0))] = pair.int(1)
            }
            data.stories[row.text(1)] = CachedStory(row.long(2), row.long(3), perDay)
        }
    }
}
