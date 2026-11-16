package ch.fasrv.fanotes.desk

import ch.fasrv.fanotes.famd.noteInkId
import ch.fasrv.fanotes.famd.parseFamd
import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.parseJson
import ch.fasrv.fanotes.vault.StoryFiles
import ch.fasrv.fanotes.vault.VaultEntry
import ch.fasrv.fanotes.vault.VaultIo
import ch.fasrv.fanotes.vault.historyDirectory
import ch.fasrv.fanotes.vault.historyStampsFromIndex
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import java.io.IOException
import java.time.Instant
import java.time.ZoneId
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

data class StatsProgress(val phase: String, val done: Int, val total: Int)

/** Notes up to this size are read whole and parsed. Bigger ones are counted from their first bytes and flagged partial. */
const val STATS_MAX_NOTE_BYTES = 4 * 1024 * 1024

/** Notes above this size are read one at a time, so a few of them cannot be in memory together. */
const val STATS_HEAVY_NOTE_BYTES = 512 * 1024

private const val CONCURRENCY = 4
private const val HISTORY_WINDOW_MS = 365L * 86_400_000L
private const val HISTORY_MAX_NOTES = 400
private const val HISTORY_INDEX_MAX_BYTES = 2 * 1024 * 1024
private const val FOLDER_COLORS_MAX_BYTES = 1024 * 1024
private const val PROGRESS_EVERY = 25
private val PROGRESS_FILE = Regex("^progress/[0-9a-z]{4,40}\\.json$")
private val WRITER = Regex("^[0-9a-z]{4,40}$")
private val IMAGE_EXT = setOf("png", "jpg", "jpeg", "webp", "gif", "svg")

/** Stands in for a note that did not fit in memory. It is shown as partial and never saved. */
private val UNREADABLE = StoredFacts(words = 0, ink = false, partial = true, cards = null, stats = null)

/**
 * Reads the vault for the Statistik page. Everything is local and read-only. The work runs on
 * [Dispatchers.IO] with a few files in flight; cancelling the calling coroutine stops it at the next
 * file.
 *
 * What was read from each note is kept in memory and, with a [cache] store, on disk, keyed by path,
 * size and modification time and never expiring. A second run, or one after the app was restarted,
 * only lists the vault and reads the notes that changed. The number of cards due is derived from the
 * stored due dates on every run, so it stays right without reading anything.
 *
 * One note never takes the app down: a note bigger than [maxNoteBytes] is counted from its first
 * bytes and flagged partial, notes above [STATS_HEAVY_NOTE_BYTES] are read one at a time, and a note
 * that still does not fit in memory is skipped. Two runs on one loader never overlap.
 */
class VaultStatsLoader(
    private val io: VaultIo,
    /** Read once per run, so a changed device time zone applies from the next run on. */
    private val zone: () -> ZoneId = { ZoneId.systemDefault() },
    private val cache: StatsCacheStore? = null,
    private val maxNoteBytes: Int = STATS_MAX_NOTE_BYTES,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    constructor(io: VaultIo, zone: ZoneId, clock: () -> Long = System::currentTimeMillis) :
        this(io, { zone }, null, STATS_MAX_NOTE_BYTES, clock)

    private val lock = Any()
    private val facts = HashMap<String, CachedFacts>()
    private val history = HashMap<String, CachedHistory>()
    private val stories = HashMap<String, CachedStory>()
    private var summary: StatsSummary? = null
    private var restored = false
    private var dirty = false
    private val days = DayPool()
    private val loadLock = Mutex()
    private val heavyGate = Semaphore(1)

    /** Forgets everything, in memory and on disk: the next run reads every note. */
    fun clear() {
        synchronized(lock) {
            facts.clear(); history.clear(); stories.clear()
            summary = null
            restored = true
            dirty = false
        }
        cache?.delete()
    }

    /**
     * Scans the tree, then fills in facts. [onUpdate] gets a complete result after each phase;
     * [onProgress] gets a count now and then while the tree and the notes are read. Neither is called
     * once the caller was cancelled. A run that starts while another one is still going waits for it.
     */
    suspend fun load(
        force: Boolean = false,
        onProgress: (StatsProgress) -> Unit = {},
        onUpdate: (VaultStats, StatsProgress) -> Unit,
    ): VaultStats = loadLock.withLock {
        withContext(Dispatchers.IO) { execute(force, onProgress, onUpdate) }
    }

    /** What one run has seen, so the cache can be pruned and saved even when the run is cancelled. */
    private class Seen {
        var notePaths: Set<String>? = null
        var historyPaths: Set<String>? = null
        var storyPaths: Set<String>? = null
        var complete = false
    }

    private suspend fun execute(force: Boolean, onProgress: (StatsProgress) -> Unit, onUpdate: (VaultStats, StatsProgress) -> Unit): VaultStats {
        if (force) clear() else restore()
        val seen = Seen()
        try {
            return collect(seen, onProgress, onUpdate)
        } finally {
            // Also after a cancel: what was read so far is worth keeping.
            withContext(NonCancellable) { persist(seen) }
        }
    }

    private suspend fun collect(seen: Seen, onProgress: (StatsProgress) -> Unit, onUpdate: (VaultStats, StatsProgress) -> Unit): VaultStats {
        val now = clock()
        val zoneNow = zone()
        val today = Instant.ofEpochMilli(now).atZone(zoneNow).toLocalDate().toString()
        val colors = readFolderColors()
        val scan = scanVault(colors, onProgress)
        currentCoroutineContext().ensureActive()
        val noteFacts = HashMap<String, NoteFacts>()
        val noteHistory = HashMap<String, List<Long>>()
        val storyDays = HashMap<String, Map<String, Int>>()
        var homework: List<HomeworkTask>? = null
        fun snapshot() = aggregateVault(StatsInput(scan.files, scan.folders, synchronizedCopy(noteFacts), synchronizedCopy(noteHistory), synchronizedCopy(storyDays), homework, now, zoneNow))
        var latest = snapshot()
        emit(onUpdate, latest, StatsProgress("tree", 0, scan.files.size))

        homework = readHomework()
        latest = snapshot()

        val notes = scan.files.filter { it.base == StatBase.NOTE || it.base == StatBase.PDF }
            .filter { it.path != HOMEWORK_NOTE_PATH }
        seen.notePaths = notes.mapTo(HashSet()) { it.path }
        val finished = AtomicInteger()
        pool(notes) { file ->
            val stored = factsFor(file, scan.companions[file.path])
            if (stored != null) synchronized(noteFacts) { noteFacts[file.path] = stored.toNoteFacts(today) }
            val count = finished.incrementAndGet()
            if (count % PROGRESS_EVERY == 0) report(onProgress, StatsProgress("notes", count, notes.size))
        }
        latest = snapshot()
        emit(onUpdate, latest, StatsProgress("notes", notes.size, notes.size))

        val recent = notes.filter { it.mtime >= now - HISTORY_WINDOW_MS }.sortedByDescending { it.mtime }.take(HISTORY_MAX_NOTES)
        val folders = lazy { historyFolders() }
        val historyKnown = AtomicBoolean(true)
        pool(recent) { file ->
            val stamps = historyFor(file, folders)
            if (stamps == null) historyKnown.set(false) else synchronized(noteHistory) { noteHistory[file.path] = stamps }
        }
        if (historyKnown.get()) seen.historyPaths = recent.mapTo(HashSet()) { it.path }
        latest = snapshot()
        emit(onUpdate, latest, StatsProgress("history", recent.size, recent.size))

        val storyFiles = scan.files.filter { it.base == StatBase.STORY }
        pool(storyFiles) { file ->
            val cached = synchronized(lock) { stories[file.path] }
            val perDay = if (cached != null && cached.size == file.size && cached.mtime == file.mtime) cached.days else {
                val read = readStoryDays(file.path)
                synchronized(lock) { stories[file.path] = CachedStory(file.size, file.mtime, read); dirty = true }
                read
            }
            synchronized(storyDays) { storyDays[file.path] = perDay }
        }
        seen.storyPaths = storyFiles.mapTo(HashSet()) { it.path }
        latest = snapshot()
        synchronized(lock) {
            val before = summary
            val notesCount = latest.totals.notes.toLong()
            if (before == null || before.notes != notesCount || before.bytes != latest.totals.bytes) dirty = true
            summary = StatsSummary(notesCount, latest.totals.bytes, now)
        }
        seen.complete = true
        emit(onUpdate, latest, StatsProgress("done", scan.files.size, scan.files.size))
        return latest
    }

    private fun <K, V> synchronizedCopy(map: HashMap<K, V>): Map<K, V> = synchronized(map) { HashMap(map) }

    private suspend fun emit(onUpdate: (VaultStats, StatsProgress) -> Unit, stats: VaultStats, progress: StatsProgress) {
        currentCoroutineContext().ensureActive()
        onUpdate(stats, progress)
    }

    private suspend fun report(onProgress: (StatsProgress) -> Unit, progress: StatsProgress) {
        currentCoroutineContext().ensureActive()
        onProgress(progress)
    }

    /**
     * Runs [work] for every item with [CONCURRENCY] workers that take the next item as soon as they
     * are free, so one slow file holds up one worker and not a batch. Cancellation is checked before
     * each item.
     */
    private suspend fun <T> pool(items: List<T>, work: suspend (T) -> Unit) {
        if (items.isEmpty()) return
        val next = AtomicInteger(0)
        coroutineScope {
            repeat(minOf(CONCURRENCY, items.size)) {
                launch {
                    while (true) {
                        ensureActive()
                        val index = next.getAndIncrement()
                        if (index >= items.size) break
                        try {
                            work(items[index])
                        } catch (cancelled: CancellationException) {
                            throw cancelled
                        } catch (_: Exception) {
                            // One unreadable file must not hide the rest.
                        } catch (_: OutOfMemoryError) {
                            // Nor must one that does not fit in memory.
                        }
                    }
                }
            }
        }
    }

    private fun restore() {
        val store = cache ?: return
        synchronized(lock) {
            if (restored) return
            restored = true
        }
        val data = try {
            readStatsCache(store, maxNoteBytes, days)
        } catch (_: Exception) {
            null
        } ?: return
        synchronized(lock) {
            facts.putAll(data.facts)
            history.putAll(data.history)
            stories.putAll(data.stories)
            summary = data.summary
        }
    }

    /** Drops what the vault no longer has (after a complete run) and writes the cache when it changed. */
    private fun persist(seen: Seen) {
        val store = cache ?: return
        val data = synchronized(lock) {
            if (seen.complete) {
                seen.notePaths?.let { if (facts.keys.retainAll(it)) dirty = true }
                seen.historyPaths?.let { if (history.keys.retainAll(it)) dirty = true }
                seen.storyPaths?.let { if (stories.keys.retainAll(it)) dirty = true }
            }
            if (!dirty) return
            dirty = false
            StatsCacheData(HashMap(facts), HashMap(history), HashMap(stories), summary)
        }
        try {
            writeStatsCache(store, data, maxNoteBytes)
        } catch (_: Exception) {
            // Best effort: the next run reads again what was not saved.
            synchronized(lock) { dirty = true }
        }
    }

    private fun readSmall(path: String, limit: Int): ByteArray? {
        val head = io.readHead(path, limit) ?: return null
        return if (head.complete) head.bytes else null
    }

    private fun readFolderColors(): Map<String, String> = try {
        readSmall(FOLDER_COLORS_PATH, FOLDER_COLORS_MAX_BYTES)?.decodeToString()?.let(::parseFolderColors).orEmpty()
    } catch (_: Exception) {
        emptyMap()
    }

    private fun readHomework(): List<HomeworkTask>? = try {
        val bytes = readSmall(HOMEWORK_NOTE_PATH, maxNoteBytes)
        if (bytes == null) null else when (val loaded = loadHomeworkMarkdown(bytes.decodeToString())) {
            is NoteMarkdownLoad.Ready -> loaded.document.tasks
            NoteMarkdownLoad.Unreadable -> null
        }
    } catch (_: Exception) {
        null
    }

    private class Scan(val files: List<StatScanFile>, val folders: Int, val companions: Map<String, VaultEntry>)

    /** Walks the vault: no dotfiles, a `.story` folder counts as one file, `Name.md`+`Name.famd` as one note. */
    private suspend fun scanVault(colors: Map<String, String>, onProgress: (StatsProgress) -> Unit): Scan {
        val files = ArrayList<StatScanFile>()
        val companions = HashMap<String, VaultEntry>()
        var folders = 0
        suspend fun walk(listing: List<VaultEntry>, subject: String?, color: String?) {
            currentCoroutineContext().ensureActive()
            val entries = listing.filter { !it.path.substringAfterLast('/').startsWith('.') }
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
                val factEntry = famd ?: md
                if (factEntry != null) companions[name.path] = factEntry
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
            report(onProgress, StatsProgress("tree", files.size, 0))
            for (entry in entries.filter { it.directory }) {
                if (StoryFiles.isStoryFolder(entry.path)) {
                    val inside = storyTotals(entry)
                    files += StatScanFile(
                        entry.path, entry.path.substringAfterLast('/'), StatBase.STORY,
                        inside.first, if (inside.second > 0) inside.second else entry.mtimeMs, subject ?: STATS_NO_SUBJECT, color,
                    )
                } else {
                    folders += 1
                    val top = subject == null
                    // The listing goes by the entry's own handle, so a provider does not look the path up again.
                    walk(io.list(entry), if (top) entry.path.substringAfterLast('/') else subject, if (top) colors[entry.path] else color)
                }
            }
        }
        walk(io.list(""), null, null)
        return Scan(files, folders, companions)
    }

    private fun storyTotals(story: VaultEntry): Pair<Long, Long> {
        var bytes = 0L
        var newest = 0L
        fun walk(directory: VaultEntry, depth: Int) {
            if (depth > 6) return
            for (entry in io.list(directory)) {
                if (entry.path.substringAfterLast('/').startsWith('.')) continue
                if (entry.directory) walk(entry, depth + 1)
                else {
                    bytes += entry.size
                    newest = maxOf(newest, entry.mtimeMs)
                }
            }
        }
        walk(story, 0)
        return bytes to newest
    }

    private fun extOf(path: String): String {
        val name = path.substringAfterLast('/')
        return if (name.contains('.')) name.substringAfterLast('.').lowercase() else ""
    }

    /** The saved facts when the note is unchanged, else the note is read (at most [maxNoteBytes] of it) and saved. */
    private suspend fun factsFor(file: StatScanFile, entry: VaultEntry?): StoredFacts? {
        if (entry == null) return null
        synchronized(lock) { facts[file.path] }?.let { if (it.size == file.size && it.mtime == file.mtime) return it.facts }
        val read = try {
            if (entry.size > STATS_HEAVY_NOTE_BYTES) heavyGate.withPermit { readFacts(entry) } else readFacts(entry)
        } catch (_: OutOfMemoryError) {
            // Not saved: with more memory free the note may read fine next time.
            return UNREADABLE
        } ?: return null
        val stored = read.sharingDays(days)
        synchronized(lock) {
            facts[file.path] = CachedFacts(file.size, file.mtime, stored)
            dirty = true
        }
        return stored
    }

    private fun readFacts(entry: VaultEntry): StoredFacts? {
        val head = io.readHead(entry, maxNoteBytes) ?: return null
        val text = head.bytes.decodeToString()
        return if (head.complete) storedFactsFromNote(text) else partialFactsFromHead(text)
    }

    /** Snapshot times of a note, from the saved ones when the note is unchanged. Null when the history cannot be listed. */
    private fun historyFor(file: StatScanFile, folders: Lazy<Map<String, VaultEntry>?>): List<Long>? {
        synchronized(lock) { history[file.path] }?.let { if (it.size == file.size && it.mtime == file.mtime) return it.stamps }
        val directories = folders.value ?: return null
        val stamps = readHistoryStamps(file.path, directories)
        synchronized(lock) {
            history[file.path] = CachedHistory(file.size, file.mtime, stamps)
            dirty = true
        }
        return stamps
    }

    /** The history folders of the vault, listed once: a note without one needs no further read. */
    private fun historyFolders(): Map<String, VaultEntry>? = try {
        io.list(historyDirectory("x").substringBeforeLast('/')).filter { it.directory }.associateBy { it.path.substringAfterLast('/') }
    } catch (_: IOException) {
        null
    }

    private fun readHistoryStamps(notePath: String, folders: Map<String, VaultEntry>): List<Long> {
        val folder = folders[historyDirectory(notePath).substringAfterLast('/')] ?: return emptyList()
        val index = io.list(folder).firstOrNull { !it.directory && it.path.substringAfterLast('/') == "index.json" } ?: return emptyList()
        val head = io.readHead(index, HISTORY_INDEX_MAX_BYTES)?.takeIf { it.complete } ?: return emptyList()
        return historyStampsFromIndex(head.bytes.decodeToString()).mapNotNull { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() }
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

private fun StoredFacts.sharingDays(pool: DayPool): StoredFacts {
    val own = stats ?: return this
    if (own.activeDays.isEmpty()) return this
    return StoredFacts(words, ink, partial, cards, own.copy(activeDays = own.activeDays.map { pool.intern(it) }))
}

/** Facts from the text of a `.md` or `.famd` note. */
fun factsFromNote(content: String, today: String): NoteFacts = storedFactsFromNote(content).toNoteFacts(today)

/**
 * What a whole `.md` or `.famd` note says. The ink points stay packed (statistics never use them), and a
 * payload that cannot be parsed falls back to the Markdown in front of it, flagged partial.
 */
fun storedFactsFromNote(content: String): StoredFacts {
    val parsed = try {
        parseFamd(content, unpackPoints = false)
    } catch (_: Exception) {
        return partialFactsFromHead(content)
    }
    val payload = parsed.payload
    val raw = payload?.obj("pageStats")
    val stats = if (raw == null) null else parsePageStats(raw, 0L)
    val typing = raw?.obj("typing")?.double("wordsTyped")?.toInt()?.coerceAtLeast(0) ?: 0
    val hasInk = (stats?.inkStrokes ?: 0) > 0 || noteInkId(parsed.markdown) != null
    return StoredFacts(
        words = countWords(parsed.markdown),
        ink = hasInk,
        partial = false,
        cards = storedCards(parseStoredCards(parsed.markdown)),
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

/**
 * Facts from the front of a note that was too big to read whole, or whose payload cannot be used: the
 * Markdown up to the famd header. The words are a lower bound and there are no page statistics.
 */
fun partialFactsFromHead(text: String): StoredFacts {
    val token = text.indexOf("fanotes-famd:")
    val cut = if (token < 0) -1 else text.lastIndexOf("<!--", token).let { if (it < 0) token else it }
    val markdown = if (cut >= 0) text.substring(0, cut) else text
    return StoredFacts(
        words = countWords(markdown),
        ink = noteInkId(markdown) != null,
        partial = true,
        cards = storedCards(parseStoredCards(markdown)),
        stats = null,
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
