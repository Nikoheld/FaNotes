package ch.fasrv.fanotes.desk

import ch.fasrv.fanotes.famd.noteInkId
import ch.fasrv.fanotes.famd.parseFamd
import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.parseJson
import ch.fasrv.fanotes.vault.StoryFiles
import ch.fasrv.fanotes.vault.VaultEntry
import ch.fasrv.fanotes.vault.VaultIo
import ch.fasrv.fanotes.vault.noteHistoryStamps
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import java.time.Instant
import java.time.ZoneId

data class StatsProgress(val phase: String, val done: Int, val total: Int)

private const val CONCURRENCY = 4
private const val HISTORY_WINDOW_MS = 365L * 86_400_000L
private const val HISTORY_MAX_NOTES = 400
private const val STATS_TTL_MS = 5 * 60_000L
private val PROGRESS_FILE = Regex("^progress/[0-9a-z]{4,40}\\.json$")
private val WRITER = Regex("^[0-9a-z]{4,40}$")
private val IMAGE_EXT = setOf("png", "jpg", "jpeg", "webp", "gif", "svg")

/**
 * Reads the vault for the Statistik page. Everything is local and read-only. The work runs
 * on [Dispatchers.IO] with a few files in flight; cancelling the calling coroutine stops it
 * at the next file. Per-file facts are cached by size and mtime for the life of the loader.
 */
class VaultStatsLoader(
    private val io: VaultIo,
    private val zone: ZoneId = ZoneId.systemDefault(),
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private class Cached<T>(val signature: String, val value: T, val at: Long)

    private val facts = HashMap<String, Cached<NoteFacts>>()
    private val history = HashMap<String, Cached<List<String>>>()
    private val stories = HashMap<String, Cached<Map<String, Int>>>()

    @Synchronized
    fun clear() {
        facts.clear(); history.clear(); stories.clear()
    }

    /** Scans the tree, then fills in facts. [onUpdate] gets a complete result after each phase. */
    suspend fun load(force: Boolean = false, onUpdate: (VaultStats, StatsProgress) -> Unit): VaultStats = withContext(Dispatchers.IO) {
        if (force) clear()
        val now = clock()
        val colors = readFolderColors()
        val scan = scanVault(colors)
        currentCoroutineContext().ensureActive()
        val noteFacts = HashMap<String, NoteFacts>()
        val noteHistory = HashMap<String, List<String>>()
        val storyDays = HashMap<String, Map<String, Int>>()
        var homework: List<HomeworkTask>? = null
        fun snapshot() = aggregateVault(StatsInput(scan.files, scan.folders, synchronizedCopy(noteFacts), synchronizedCopy(noteHistory), synchronizedCopy(storyDays), homework, now, zone))
        var latest = snapshot()
        onUpdate(latest, StatsProgress("tree", 0, scan.files.size))

        homework = readHomework()
        latest = snapshot()

        val notes = scan.files.filter { it.base == StatBase.NOTE || it.base == StatBase.PDF }
            .filter { it.path != HOMEWORK_NOTE_PATH }
        val today = java.time.Instant.ofEpochMilli(now).atZone(zone).toLocalDate().toString()
        pool(notes) { file ->
            val fact = factsFor(file, scan.companions[file.path], today, now)
            if (fact != null) synchronized(noteFacts) { noteFacts[file.path] = fact }
        }
        latest = snapshot()
        onUpdate(latest, StatsProgress("notes", notes.size, notes.size))

        val recent = notes.filter { it.mtime >= now - HISTORY_WINDOW_MS }.sortedByDescending { it.mtime }.take(HISTORY_MAX_NOTES)
        pool(recent) { file ->
            val signature = "${file.mtime}:${file.size}"
            val cached = synchronized(this) { history[file.path] }
            val stamps = if (cached?.signature == signature) cached.value else {
                val read = noteHistoryStamps(io, file.path)
                synchronized(this) { history[file.path] = Cached(signature, read, now) }
                read
            }
            synchronized(noteHistory) { noteHistory[file.path] = stamps }
        }
        latest = snapshot()
        onUpdate(latest, StatsProgress("history", recent.size, recent.size))

        val storyFiles = scan.files.filter { it.base == StatBase.STORY }
        pool(storyFiles) { file ->
            val signature = "${file.mtime}"
            val cached = synchronized(this) { stories[file.path] }
            val days = if (cached?.signature == signature) cached.value else {
                val read = readStoryDays(file.path)
                synchronized(this) { stories[file.path] = Cached(signature, read, now) }
                read
            }
            synchronized(storyDays) { storyDays[file.path] = days }
        }
        latest = snapshot()
        onUpdate(latest, StatsProgress("done", scan.files.size, scan.files.size))
        latest
    }

    private fun <K, V> synchronizedCopy(map: HashMap<K, V>): Map<K, V> = synchronized(map) { HashMap(map) }

    /** Small pool: [CONCURRENCY] files at a time, a cancellation check between every batch. */
    private suspend fun <T> pool(items: List<T>, work: suspend (T) -> Unit) {
        for (batch in items.chunked(CONCURRENCY)) {
            currentCoroutineContext().ensureActive()
            coroutineScope {
                batch.map { item ->
                    async {
                        try {
                            work(item)
                        } catch (cancelled: CancellationException) {
                            throw cancelled
                        } catch (_: Exception) {
                            // One unreadable file must not hide the rest.
                        }
                    }
                }.awaitAll()
            }
        }
    }

    private fun readFolderColors(): Map<String, String> = try {
        io.read(FOLDER_COLORS_PATH)?.decodeToString()?.let(::parseFolderColors).orEmpty()
    } catch (_: Exception) {
        emptyMap()
    }

    private fun readHomework(): List<HomeworkTask>? = try {
        val bytes = io.read(HOMEWORK_NOTE_PATH)
        if (bytes == null) null else when (val loaded = loadHomeworkMarkdown(bytes.decodeToString())) {
            is NoteMarkdownLoad.Ready -> loaded.document.tasks
            NoteMarkdownLoad.Unreadable -> null
        }
    } catch (_: Exception) {
        null
    }

    private class Scan(val files: List<StatScanFile>, val folders: Int, val companions: Map<String, String>)

    /** Walks the vault: no dotfiles, a `.story` folder counts as one file, `Name.md`+`Name.famd` as one note. */
    private suspend fun scanVault(colors: Map<String, String>): Scan {
        val files = ArrayList<StatScanFile>()
        val companions = HashMap<String, String>()
        var folders = 0
        suspend fun walk(directory: String, subject: String?, color: String?) {
            currentCoroutineContext().ensureActive()
            val entries = io.list(directory).filter { !it.path.substringAfterLast('/').startsWith('.') }
            val loose = entries.filter { !it.directory }
            val byStem = loose.groupBy { it.path.substringBeforeLast('.', it.path).lowercase() }
            val consumed = HashSet<String>()
            for ((_, group) in byStem) {
                val md = group.firstOrNull { extOf(it.path) == "md" || extOf(it.path) == "markdown" }
                val famd = group.firstOrNull { extOf(it.path) == "famd" }
                val pdf = group.firstOrNull { extOf(it.path) == "pdf" }
                val name = (pdf ?: famd ?: md ?: continue)
                val parts = listOfNotNull(pdf, famd, md)
                // The first present file carries the facts: the PDF's companion, else the famd, else the Markdown.
                val base = if (pdf != null) StatBase.PDF else StatBase.NOTE
                val factPath = when {
                    famd != null -> famd.path
                    md != null -> md.path
                    else -> null
                }
                if (factPath != null) companions[name.path] = factPath
                files += StatScanFile(
                    path = name.path,
                    name = name.path.substringAfterLast('/'),
                    base = base,
                    size = parts.sumOf { it.size },
                    mtime = parts.maxOf { it.mtimeMs },
                    subject = subject ?: STATS_NO_SUBJECT,
                    color = color,
                )
                consumed += parts.map { it.path }
            }
            for (entry in loose) {
                if (entry.path in consumed) continue
                val ext = extOf(entry.path)
                if (ext == "tmp") continue
                files += StatScanFile(
                    entry.path, entry.path.substringAfterLast('/'),
                    if (ext in IMAGE_EXT) StatBase.IMAGE else StatBase.MEDIA,
                    entry.size, entry.mtimeMs, subject ?: STATS_NO_SUBJECT, color,
                )
            }
            for (entry in entries.filter { it.directory }) {
                if (StoryFiles.isStoryFolder(entry.path)) {
                    val inside = storyTotals(entry.path)
                    files += StatScanFile(
                        entry.path, entry.path.substringAfterLast('/'), StatBase.STORY,
                        inside.first, if (inside.second > 0) inside.second else entry.mtimeMs, subject ?: STATS_NO_SUBJECT, color,
                    )
                } else {
                    folders += 1
                    val top = subject == null
                    walk(entry.path, if (top) entry.path.substringAfterLast('/') else subject, if (top) colors[entry.path] else color)
                }
            }
        }
        walk("", null, null)
        return Scan(files, folders, companions)
    }

    private fun storyTotals(path: String): Pair<Long, Long> {
        var bytes = 0L
        var newest = 0L
        fun walk(directory: String, depth: Int) {
            if (depth > 6) return
            for (entry: VaultEntry in io.list(directory)) {
                if (entry.path.substringAfterLast('/').startsWith('.')) continue
                if (entry.directory) walk(entry.path, depth + 1)
                else {
                    bytes += entry.size
                    newest = maxOf(newest, entry.mtimeMs)
                }
            }
        }
        walk(path, 0)
        return bytes to newest
    }

    private fun extOf(path: String): String {
        val name = path.substringAfterLast('/')
        return if (name.contains('.')) name.substringAfterLast('.').lowercase() else ""
    }

    private fun factsFor(file: StatScanFile, factPath: String?, today: String, now: Long): NoteFacts? {
        val path = factPath ?: return null
        val signature = "${file.mtime}:${file.size}"
        val cached = synchronized(this) { facts[file.path] }
        if (cached != null && cached.signature == signature && now - cached.at < STATS_TTL_MS) return cached.value
        val text = io.read(path)?.decodeToString() ?: return null
        val value = factsFromNote(text, today)
        synchronized(this) { facts[file.path] = Cached(signature, value, now) }
        return value
    }

    private fun readStoryDays(storyPath: String): Map<String, Int> {
        val days = HashMap<String, Int>()
        for (relative in StoryFiles.list(io, storyPath).filter { PROGRESS_FILE.matches(it) }) {
            val raw = StoryFiles.read(io, "$storyPath/$relative") ?: continue
            for ((day, words) in storyProgressDays(raw)) days[day] = (days[day] ?: 0) + words.coerceAtLeast(0)
        }
        return days
    }
}

/** Facts from the text of a `.md` or `.famd` note. */
fun factsFromNote(content: String, today: String): NoteFacts {
    val parsed = parseFamd(content)
    val payload = parsed.payload
    val raw = payload?.obj("pageStats")
    val stats = if (raw == null) null else parsePageStats(raw, 0L)
    val typing = raw?.obj("typing")?.double("wordsTyped")?.toInt()?.coerceAtLeast(0) ?: 0
    val hasInk = (stats?.inkStrokes ?: 0) > 0 || noteInkId(parsed.markdown) != null
    return NoteFacts(
        words = countWords(parsed.markdown),
        ink = hasInk,
        cards = summarizeCards(parseStoredCards(parsed.markdown), today),
        stats = stats?.let {
            FactStats(
                dwellMs = it.dwellMs,
                wordsTyped = maxOf(typing, it.document.wordsAdded),
                strokes = it.inkStrokes,
                penMs = it.inkPenDownMs,
                activeDays = it.activeDays,
                dwellByWeekday = it.dwellByWeekday,
                createdAtMs = runCatching { Instant.parse(it.createdAt).toEpochMilli() }.getOrDefault(0L),
            )
        },
    )
}

/** `progress/<writer>.json` of a story: day -> words written that day on that device. */
fun storyProgressDays(json: String): Map<String, Int> {
    val root = try { parseJson(json) as? JsonValue.Obj } catch (_: Exception) { null } ?: return emptyMap()
    if (root.string("format") != "fanotes-story-progress-v1") return emptyMap()
    if (root.string("writer")?.let { WRITER.matches(it) } != true) return emptyMap()
    val days = root.obj("days") ?: return emptyMap()
    val out = LinkedHashMap<String, Int>()
    for ((day, value) in days.fields.entries.toList().takeLast(4000)) {
        val entry = value as? JsonValue.Obj ?: continue
        val words = entry.double("words") ?: continue
        if (!DAY_RE.matches(day) || entry.double("start") == null || !words.isFinite()) continue
        out[day] = Math.round(words).toInt()
    }
    return out
}

private val DAY_RE = Regex("^\\d{4}-\\d{2}-\\d{2}$")
