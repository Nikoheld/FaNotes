package ch.fasrv.fanotes.desk

import ch.fasrv.fanotes.vault.DirectoryVault
import ch.fasrv.fanotes.vault.VaultEntry
import ch.fasrv.fanotes.vault.VaultHead
import ch.fasrv.fanotes.vault.VaultIo
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import java.io.Reader
import java.io.StringReader
import java.io.StringWriter
import java.io.Writer
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.attribute.FileTime
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** The Statistik loader's saved cache, its limits for huge notes, and its behaviour under cancellation and overlap. */
class VaultStatsCacheTest {
    private val utc: ZoneId = ZoneOffset.UTC
    private val now = Instant.parse("2026-11-15T12:00:00Z").toEpochMilli()
    private val dayMs = 86_400_000L

    private class MemoryStore : StatsCacheStore {
        @Volatile var text: String? = null
        val writes = AtomicInteger()
        override fun open(): Reader? = text?.let { StringReader(it) }
        override fun replace(write: (Writer) -> Unit) {
            val out = StringWriter()
            write(out)
            text = out.toString()
            writes.incrementAndGet()
        }
        override fun delete() { text = null }

        /** True when the saved cache holds the facts line of [path] (history lines are not facts). */
        fun hasFacts(path: String) = text.orEmpty().lines().any { it.startsWith("[\"f\",\"$path\"") }
    }

    /** Counts every read of a file, however it is asked for. */
    private class ReadCounter(private val inner: VaultIo) : VaultIo by inner {
        val reads = ConcurrentHashMap<String, Int>()
        override fun read(path: String): ByteArray? { reads.merge(path, 1, Int::plus); return inner.read(path) }
        override fun readHead(path: String, maxBytes: Int): VaultHead? { reads.merge(path, 1, Int::plus); return inner.readHead(path, maxBytes) }
        override fun readHead(entry: VaultEntry, maxBytes: Int): VaultHead? = readHead(entry.path, maxBytes)
    }

    private fun loader(io: VaultIo, store: StatsCacheStore? = null, at: Long = now, cap: Int = STATS_MAX_NOTE_BYTES) =
        VaultStatsLoader(io, { utc }, store, cap) { at }

    private fun write(root: Path, relative: String, text: String, mtime: Long = now - dayMs) {
        val target = root.resolve(relative)
        Files.createDirectories(target.parent)
        Files.write(target, text.toByteArray())
        Files.setLastModifiedTime(target, FileTime.fromMillis(mtime))
    }

    private fun vault(): Path {
        val root = Files.createTempDirectory("fanotes-stats-cache")
        write(root, "Mathe/Algebra.md", "# Algebra\n\nEins zwei drei")
        write(root, "Mathe/Karten.md", "# Karten\n\n<!-- fanotes-cards-v1 {\"cards\":[{\"id\":\"a\",\"front\":\"F1\",\"back\":\"B1\",\"due\":\"2026-11-15\",\"reps\":2,\"lapses\":1},{\"id\":\"b\",\"front\":\"F2\",\"back\":\"B2\",\"due\":\"2026-11-17\",\"reps\":0,\"lapses\":0}]} -->\n")
        write(root, "Notiz.md", "Lose Notiz hier")
        return root
    }

    private val factFiles = listOf("Mathe/Algebra.md", "Mathe/Karten.md", "Notiz.md")

    private fun <T> withVault(block: suspend CoroutineScope.(Path) -> T): T {
        val root = vault()
        try {
            return runBlocking { block(this, root) }
        } finally {
            root.toFile().deleteRecursively()
        }
    }

    // ---- the saved cache ----

    @Test
    fun savedFactsSurviveARestartAndNeverExpire() = withVault { root ->
        val store = MemoryStore()
        val firstIo = ReadCounter(DirectoryVault(root))
        val first = loader(firstIo, store).load { _, _ -> }
        assertEquals(factFiles.sorted(), firstIo.reads.keys.filter { it in factFiles }.sorted(), "the first run reads every note once")
        assertNotNull(store.text)

        // A new loader, a month later, as after the app was restarted: the notes are not read again.
        val secondIo = ReadCounter(DirectoryVault(root))
        val second = loader(secondIo, store, at = now + 30 * dayMs).load { _, _ -> }
        assertEquals(emptyList(), secondIo.reads.keys.filter { it in factFiles }, "unchanged notes come from the saved cache")
        assertEquals(first.writing, second.writing)
        assertEquals(first.totals, second.totals)
        assertEquals(1, store.writes.get(), "nothing changed, so nothing was written")
    }

    @Test
    fun anEditedNoteIsTheOnlyOneReadAgain() = withVault { root ->
        val store = MemoryStore()
        loader(DirectoryVault(root), store).load { _, _ -> }
        write(root, "Notiz.md", "Lose Notiz hier mit mehr Wörtern", mtime = now - 1000)

        val io = ReadCounter(DirectoryVault(root))
        val stats = loader(io, store).load { _, _ -> }
        assertEquals(mapOf("Notiz.md" to 1), io.reads.filterKeys { it in factFiles })
        assertEquals(4 + 1 + 6, stats.writing.wordsInNotes, "Algebra 4, Karten 1, Notiz now 6")
    }

    @Test
    fun cardsDueAreWorkedOutOnEveryRunFromTheSavedDates() = withVault { root ->
        val store = MemoryStore()
        val first = loader(DirectoryVault(root), store).load { _, _ -> }
        assertEquals(1, first.cards.due, "one card is due on the 15th")

        val io = ReadCounter(DirectoryVault(root))
        val later = loader(io, store, at = now + 2 * dayMs).load { _, _ -> }
        assertNull(io.reads["Mathe/Karten.md"], "no read for a new day")
        assertEquals(2, later.cards.due, "both are due on the 17th")
    }

    @Test
    fun noteGoneFromTheVaultLeavesTheCache() = withVault { root ->
        val store = MemoryStore()
        loader(DirectoryVault(root), store).load { _, _ -> }
        assertTrue(store.text!!.contains("\"Notiz.md\""))
        Files.delete(root.resolve("Notiz.md"))
        loader(DirectoryVault(root), store).load { _, _ -> }
        assertFalse(store.text!!.contains("\"Notiz.md\""))
        assertTrue(store.text!!.contains("\"Mathe/Algebra.md\""))
    }

    @Test
    fun aDamagedLineCostsOneNoteAndAnotherVersionCostsTheCache() = withVault { root ->
        val store = MemoryStore()
        loader(DirectoryVault(root), store).load { _, _ -> }
        val lines = store.text!!.lines().filter { it.isNotEmpty() }
        val damaged = lines.map { if (it.contains("\"Notiz.md\"")) it.take(18) else it } + "garbage" + "[\"f\"]"
        store.text = damaged.joinToString("\n") + "\n"

        val io = ReadCounter(DirectoryVault(root))
        loader(io, store).load { _, _ -> }
        assertEquals(mapOf("Notiz.md" to 1), io.reads.filterKeys { it in factFiles })

        store.text = store.text!!.replace("\"version\":$STATS_CACHE_VERSION", "\"version\":${STATS_CACHE_VERSION + 1}")
        val other = ReadCounter(DirectoryVault(root))
        loader(other, store).load { _, _ -> }
        assertEquals(factFiles.sorted(), other.reads.keys.filter { it in factFiles }.sorted(), "a cache of another version is not trusted")
    }

    @Test
    fun forceReadsEverythingAgainAndStillSaves() = withVault { root ->
        val store = MemoryStore()
        val io = ReadCounter(DirectoryVault(root))
        val shared = loader(io, store)
        shared.load { _, _ -> }
        shared.load(force = true) { _, _ -> }
        assertEquals(factFiles.associateWith { 2 }, io.reads.filterKeys { it in factFiles })

        val third = ReadCounter(DirectoryVault(root))
        loader(third, store).load { _, _ -> }
        assertEquals(emptyList(), third.reads.keys.filter { it in factFiles })
    }

    @Test
    fun theSummaryOfTheLastRunIsInTheFirstLine() = withVault { root ->
        val store = MemoryStore()
        assertNull(readStatsSummary(store))
        val stats = loader(DirectoryVault(root), store).load { _, _ -> }
        val summary = assertNotNull(readStatsSummary(store))
        assertEquals(stats.totals.notes.toLong(), summary.notes)
        assertEquals(stats.totals.bytes, summary.bytes)
        assertEquals(now, summary.at)
    }

    @Test
    fun theCacheFormatKeepsEveryFieldAndOddPaths() {
        val store = MemoryStore()
        val odd = "Ordner \"Q\"/tab\there\nnew\\line/日本語 😀.md"
        val data = StatsCacheData(summary = StatsSummary(7, 9_000, 11))
        data.facts[odd] = CachedFacts(
            12, 34,
            StoredFacts(
                words = 5, ink = true, partial = true,
                cards = StoredCards(3, 2, 7, 1, listOf(DueCount("2026-11-10", 2), DueCount("2026-12-01", 1))),
                stats = FactStats(
                    dwellMs = 90_000, wordsTyped = 8, strokes = 12, penMs = 4_000,
                    activeDays = listOf("2026-11-08", "2026-11-09"), dwellByWeekday = listOf(0, 90_000, 0, 0, 0, 0, 0), createdAtMs = 1_700_000_000_000,
                ),
            ),
        )
        data.facts["plain.md"] = CachedFacts(1, 2, StoredFacts(0, false, false, null, null))
        data.history[odd] = CachedHistory(12, 34, listOf(1_700_000_000_000, 1_700_000_100_000))
        data.stories["Roman.story"] = CachedStory(5, 6, linkedMapOf("2026-11-14" to 250, "2026-11-13" to 0))
        writeStatsCache(store, data, maxNoteBytes = 1000)

        val back = assertNotNull(readStatsCache(store, maxNoteBytes = 1000))
        val facts = assertNotNull(back.facts[odd])
        assertEquals(12, facts.size)
        assertEquals(34, facts.mtime)
        assertTrue(facts.facts.ink && facts.facts.partial)
        assertEquals(5, facts.facts.words)
        assertEquals(listOf("2026-11-10" to 2, "2026-12-01" to 1), facts.facts.cards!!.dueByDay.map { it.day to it.count })
        assertEquals(data.facts.getValue(odd).facts.stats, facts.facts.stats)
        assertNull(back.facts.getValue("plain.md").facts.cards)
        assertNull(back.facts.getValue("plain.md").facts.stats)
        assertEquals(listOf(1_700_000_000_000, 1_700_000_100_000), back.history.getValue(odd).stamps)
        assertEquals(mapOf("2026-11-14" to 250, "2026-11-13" to 0), back.stories.getValue("Roman.story").days)
        assertEquals(9_000, back.summary!!.bytes)

        // Another read cap drops what was only partly read, since the new cap may read it whole.
        val other = assertNotNull(readStatsCache(store, maxNoteBytes = 2000))
        assertNull(other.facts[odd])
        assertNotNull(other.facts["plain.md"])
    }

    @Test
    fun cardsDueFromStoredDatesMatchTheDirectCount() {
        val cards = listOf("2026-11-01", "2026-11-15", "2026-11-15", "zzz", "").mapIndexed { index, due ->
            FlashCard(id = "c$index", front = "f$index", back = "b", due = due, reps = index % 3, lapses = index % 2)
        }
        val stored = assertNotNull(storedCards(cards))
        for (today in listOf("2026-10-31", "2026-11-01", "2026-11-15", "2026-11-16", "9999-12-31")) {
            val direct = cards.count { it.due <= today }
            assertEquals(direct, stored.summary(today).due, "due on $today")
        }
        assertNull(storedCards(emptyList()))
    }

    @Test
    fun theFileStoreReplacesTheCacheAtomicallyAndToleratesAMissingFile() {
        val folder = Files.createTempDirectory("fanotes-cache-store")
        try {
            val file = folder.resolve("nested/cache.jsonl").toFile()
            val store = FileStatsCacheStore(file)
            assertNull(store.open(), "nothing saved yet")
            store.replace { it.write("first\n") }
            assertEquals("first", store.open()!!.use { it.readText().trim() })
            // A write that fails keeps the old file and leaves no temporary file behind.
            assertFailsWith<IllegalStateException> { store.replace { out -> out.write("half"); error("boom") } }
            assertEquals("first", store.open()!!.use { it.readText().trim() })
            assertEquals(listOf("cache.jsonl"), file.parentFile.list()!!.sorted())
            store.delete()
            assertNull(store.open())
        } finally {
            folder.toFile().deleteRecursively()
        }
    }

    @Test
    fun historyStampsComeFromAnIndexTextAndNothingElse() {
        val index = """{"format":"fanotes-history-v1","snapshots":[{"id":"a-1","createdAt":"2026-10-02T08:00:00.000Z","bytes":3,"tier":"week","ext":".md"},{"id":"b-2","createdAt":"2026-10-03T08:00:00.000Z","bytes":4}],"path":"x.md"}"""
        assertEquals(listOf("2026-10-02T08:00:00.000Z", "2026-10-03T08:00:00.000Z"), ch.fasrv.fanotes.vault.historyStampsFromIndex(index))
        assertEquals(emptyList(), ch.fasrv.fanotes.vault.historyStampsFromIndex("not json"))
        assertEquals(emptyList(), ch.fasrv.fanotes.vault.historyStampsFromIndex("""{"format":"other","snapshots":[{"id":"a","createdAt":"x"}]}"""))
    }

    // ---- limits ----

    @Test
    fun aNoteBeyondTheCapIsCountedFromItsHeadAndFlagged() = withVault { root ->
        write(root, "Gross.md", "wort ".repeat(20_000))
        val io = ReadCounter(DirectoryVault(root))
        val store = MemoryStore()
        val stats = loader(io, store, cap = 2048).load { _, _ -> }
        assertEquals(1, stats.partialNotes)
        // 2048 bytes of "wort " are 409 whole words and one cut one; the other notes count in full.
        assertEquals(410 + 4 + 1 + 3, stats.writing.wordsInNotes)
        assertEquals(1, io.reads["Gross.md"], "read once, and only its head")

        val again = loader(ReadCounter(DirectoryVault(root)), store, cap = 2048).load { _, _ -> }
        assertEquals(1, again.partialNotes, "still flagged from the saved cache")
    }

    @Test
    fun aHugeFamdKeepsItsMarkdownAndItsInkMarker() = withVault { root ->
        val json = "{\"schema\":\"fanotes-famd-v1\",\"updatedAt\":\"2026-11-10T08:00:00Z\",\"ink\":null,\"worksheets\":[],\"textFields\":[\"${"x".repeat(9000)}\"]}"
        write(root, "Skizze.famd", "# Skizze\n\nsechs sieben\n<!-- fanotes-ink:abc123 -->\n\n<!-- fanotes-famd:v1 chars=${json.length} -->\n$json\n")
        val stats = loader(DirectoryVault(root), cap = 2048).load { _, _ -> }
        assertEquals(1, stats.partialNotes)
        assertEquals(1, stats.kinds.getValue(StatKind.HANDWRITING).count, "the ink marker is in the readable front")
        assertEquals(3 + 4 + 1 + 3, stats.writing.wordsInNotes, "Skizze counts its Markdown only: Skizze, sechs, sieben")
    }

    @Test
    fun aPayloadThatCannotBeParsedFallsBackToTheMarkdownAndIsNotReadAgain() = withVault { root ->
        write(root, "Kaputt.famd", "Vorne eins zwei\n\n<!-- fanotes-famd:v2 chars=40 crc=00000000 -->\n{not json}\n")
        val store = MemoryStore()
        val stats = loader(DirectoryVault(root), store).load { _, _ -> }
        assertEquals(1, stats.partialNotes)
        assertEquals(3, stats.writing.wordsInNotes - (4 + 1 + 3), "Vorne eins zwei")

        val io = ReadCounter(DirectoryVault(root))
        loader(io, store).load { _, _ -> }
        assertNull(io.reads["Kaputt.famd"], "a failure is saved with the note's signature, not retried every time")
    }

    @Test
    fun runningOutOfMemoryOnOneNoteSkipsItAndKeepsTheRest() = withVault { root ->
        val failing = AtomicBoolean(true)
        val flaky = object : VaultIo by DirectoryVault(root) {
            override fun readHead(entry: VaultEntry, maxBytes: Int): VaultHead? {
                if (failing.get() && entry.path == "Notiz.md") throw OutOfMemoryError("test")
                return DirectoryVault(root).readHead(entry.path, maxBytes)
            }
        }
        val store = MemoryStore()
        val shared = loader(flaky, store)
        val first = shared.load { _, _ -> }
        assertEquals(1, first.partialNotes)
        assertEquals(4 + 1, first.writing.wordsInNotes)
        assertFalse(store.hasFacts("Notiz.md"), "memory pressure is not saved as the note's answer")
        assertTrue(store.hasFacts("Mathe/Algebra.md"))

        failing.set(false)
        val second = shared.load { _, _ -> }
        assertEquals(0, second.partialNotes)
        assertEquals(4 + 1 + 3, second.writing.wordsInNotes)
    }

    @Test
    fun bigNotesAreReadOneAtATime() = withVault { root ->
        repeat(4) { write(root, "gross-$it.md", "wort ".repeat(120_000)) } // 600 kB each
        val active = AtomicInteger()
        val peak = AtomicInteger()
        val slow = object : VaultIo by DirectoryVault(root) {
            override fun readHead(entry: VaultEntry, maxBytes: Int): VaultHead? {
                if (entry.size <= STATS_HEAVY_NOTE_BYTES) return DirectoryVault(root).readHead(entry.path, maxBytes)
                peak.accumulateAndGet(active.incrementAndGet()) { a, b -> maxOf(a, b) }
                try {
                    Thread.sleep(40)
                    return DirectoryVault(root).readHead(entry.path, maxBytes)
                } finally {
                    active.decrementAndGet()
                }
            }
        }
        val stats = loader(slow).load { _, _ -> }
        assertEquals(1, peak.get(), "at most one big note in memory at a time")
        assertEquals(4 * 120_000 + 4 + 1 + 3, stats.writing.wordsInNotes)
    }

    // ---- cancellation and overlap ----

    @Test
    fun cancellingStopsAtTheNextNoteAndReportsNothingAfterwards() = withVault { root ->
        repeat(40) { write(root, "n-%02d.md".format(it), "eins zwei drei $it") }
        val blocked = CountDownLatch(4)
        val release = CountDownLatch(1)
        val inner = ReadCounter(DirectoryVault(root))
        val blocking = object : VaultIo by inner {
            override fun readHead(entry: VaultEntry, maxBytes: Int): VaultHead? {
                if (entry.path.startsWith("n-")) {
                    blocked.countDown()
                    release.await(10, TimeUnit.SECONDS)
                }
                return inner.readHead(entry, maxBytes)
            }
        }
        val store = MemoryStore()
        val cancelled = AtomicBoolean(false)
        val lateReports = AtomicInteger()
        val job = async(Dispatchers.Default) {
            loader(blocking, store).load(onProgress = { if (cancelled.get()) lateReports.incrementAndGet() }) { _, _ ->
                if (cancelled.get()) lateReports.incrementAndGet()
            }
        }
        assertTrue(blocked.await(10, TimeUnit.SECONDS), "four reads are in flight")
        cancelled.set(true)
        job.cancel()
        release.countDown()
        job.join()

        assertTrue(job.isCancelled)
        assertEquals(0, lateReports.get(), "a cancelled run reports nothing")
        val read = inner.reads.keys.count { it.startsWith("n-") }
        assertTrue(read in 4..8, "it stopped after the reads already in flight, not after all 40 (read $read)")
        assertTrue(store.text!!.contains("\"n-"), "what was read is kept for the next run")
    }

    @Test
    fun twoRunsOnOneLoaderNeverOverlap() = withVault { root ->
        val gate = CountDownLatch(1)
        val first = AtomicBoolean(true)
        val inRoot = AtomicInteger()
        val peak = AtomicInteger()
        val inner = DirectoryVault(root)
        val slow = object : VaultIo by inner {
            override fun list(directory: String): List<VaultEntry> {
                if (directory.isNotEmpty()) return inner.list(directory)
                peak.accumulateAndGet(inRoot.incrementAndGet()) { a, b -> maxOf(a, b) }
                try {
                    if (first.compareAndSet(true, false)) gate.await(10, TimeUnit.SECONDS)
                    return inner.list(directory)
                } finally {
                    inRoot.decrementAndGet()
                }
            }
        }
        val shared = loader(slow)
        val one = async(Dispatchers.Default) { shared.load { _, _ -> } }
        while (inRoot.get() == 0) delay(5)
        val two = async(Dispatchers.Default) { shared.load(force = true) { _, _ -> } }
        delay(150)
        assertEquals(1, inRoot.get(), "the second run waits instead of listing the vault at the same time")
        gate.countDown()
        val a = one.await()
        val b = two.await()
        assertEquals(1, peak.get())
        assertEquals(a.writing, b.writing)
        assertEquals(a.totals, b.totals)
    }

    // ---- time zone and clock skew ----

    @Test
    fun theTimeZoneIsReadOnEveryRun() = runBlocking {
        val root = Files.createTempDirectory("fanotes-stats-zone")
        try {
            val at = Instant.parse("2026-11-16T12:00:00Z").toEpochMilli()
            write(root, "Notiz.md", "eins", mtime = Instant.parse("2026-11-16T09:00:00Z").toEpochMilli())
            var zone: ZoneId = ZoneOffset.UTC
            val shared = VaultStatsLoader(DirectoryVault(root), { zone }, null, STATS_MAX_NOTE_BYTES) { at }
            fun editedDay(stats: VaultStats) = stats.activity.cells.first { it.count > 0 }.date

            assertEquals("2026-11-16", editedDay(shared.load { _, _ -> }))
            zone = ZoneId.of("America/Adak") // UTC-10: 23:00 the evening before
            assertEquals("2026-11-15", editedDay(shared.load { _, _ -> }))
            zone = ZoneId.of("Pacific/Kiritimati") // UTC+14: 23:00 the same day, and "today" is already the 17th
            val east = shared.load { _, _ -> }
            assertEquals("2026-11-16", editedDay(east))
            assertEquals("2026-11-22", east.activity.cells.last().date, "the 17th is a Tuesday, so the grid ends on Sunday the 22nd")
        } finally {
            root.toFile().deleteRecursively()
        }
    }

    @Test
    fun daysAfterTodayDoNotCountAsActivity() {
        val today = Instant.parse("2026-11-15T12:00:00Z").toEpochMilli()
        val noStats = FactStats(0, 0, 0, 0, listOf("2026-11-20", "2026-11-14"), List(7) { 0L })
        val files = listOf(
            StatScanFile("Zukunft.md", "Zukunft.md", StatBase.NOTE, 10, today + dayMs, "S", null), // a clock that runs ahead
            StatScanFile("Gestern.md", "Gestern.md", StatBase.NOTE, 10, today - dayMs, "S", null),
        )
        val facts = mapOf("Zukunft.md" to NoteFacts(1, false, null, noStats), "Gestern.md" to NoteFacts(1, false, null, null))
        val stats = aggregateVault(StatsInput(files, 0, facts, nowMs = today, zone = utc))
        assertEquals(StatStreak(current = 1, longest = 1, activeDays = 1), stats.activity.streak)
        assertEquals(2, stats.activity.total, "only the 14th counts: one edit and one page day")
    }

    @Test
    fun dayKeysFollowTheZoneAcrossMidnightAndDst() {
        fun key(iso: String, zone: String) = dayKeyOf(Instant.parse(iso).toEpochMilli(), ZoneId.of(zone))
        assertEquals("2026-11-14", key("2026-11-14T23:59:59Z", "UTC"))
        assertEquals("2026-11-15", key("2026-11-15T00:00:01Z", "UTC"))
        // New York falls back on 1 November 2026 at 06:00 UTC: both 01:30s belong to the 1st.
        assertEquals("2026-11-01", key("2026-11-01T05:30:00Z", "America/New_York"))
        assertEquals("2026-11-01", key("2026-11-01T06:30:00Z", "America/New_York"))
        assertEquals("2026-11-01", key("2026-11-02T04:59:00Z", "America/New_York"))
        assertEquals("2026-11-02", key("2026-11-02T05:01:00Z", "America/New_York"))
        assertEquals("2026-11-16", key("2026-11-15T10:00:00Z", "Pacific/Kiritimati"))
        assertEquals("2026-11-14", key("2026-11-15T09:59:00Z", "America/Adak"))
    }

    // ---- history by handle ----

    @Test
    fun historyIsFoundThroughTheHistoryFolderListingOnce() = withVault { root ->
        val io = DirectoryVault(root)
        ch.fasrv.fanotes.vault.recordNoteHistory(io, "Mathe/Algebra.md", "old text", createdAt = "2026-10-02T08:00:00.000Z")
        val lists = ConcurrentHashMap<String, Int>()
        val counting = object : VaultIo by io {
            override fun list(directory: String): List<VaultEntry> { lists.merge(directory, 1, Int::plus); return io.list(directory) }
        }
        val stats = loader(counting).load { _, _ -> }
        assertEquals(1, lists[".fanotes/history"], "the history folder is listed once for all notes")
        assertTrue(stats.activity.cells.first { it.date == "2026-10-02" }.count > 0)
    }
}
