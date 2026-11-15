package ch.fasrv.fanotes.desk

import ch.fasrv.fanotes.famd.serializeFamd
import ch.fasrv.fanotes.json.jsonArray
import ch.fasrv.fanotes.json.jsonNumber
import ch.fasrv.fanotes.json.jsonObject
import ch.fasrv.fanotes.json.jsonString
import ch.fasrv.fanotes.vault.DirectoryVault
import ch.fasrv.fanotes.vault.recordNoteHistory
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.attribute.FileTime
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class VaultStatsTest {
    private val zone: ZoneId = ZoneOffset.UTC
    private val now = LocalDate.of(2026, 11, 15).atTime(12, 0).toInstant(ZoneOffset.UTC).toEpochMilli()

    private fun day(offset: Long, hour: Int = 10) = LocalDate.of(2026, 11, 15).minusDays(offset).atTime(hour, 0).toInstant(ZoneOffset.UTC).toEpochMilli()

    private fun write(root: Path, relative: String, text: String, mtime: Long) {
        val target = root.resolve(relative)
        Files.createDirectories(target.parent)
        Files.write(target, text.toByteArray())
        Files.setLastModifiedTime(target, FileTime.fromMillis(mtime))
    }

    private fun handwritten(markdown: String, strokes: Int, dwellMs: Long, createdIso: String, days: List<String>): String {
        val stats = emptyPageStats(now).copy(
            createdAt = createdIso, dwellMs = dwellMs, inkStrokes = strokes, inkPenDownMs = 4_000,
            activeDays = days, dwellByWeekday = listOf(0, dwellMs, 0, 0, 0, 0, 0),
        )
        val payload = jsonObject("schema" to jsonString("fanotes-famd-v1"), "updatedAt" to jsonString("2026-11-10T08:00:00Z"), "pageStats" to pageStatsJson(stats).put("dwellByWeekday", jsonArray(*stats.dwellByWeekday.map { jsonNumber(it.toDouble()) }.toTypedArray())))
        return serializeFamd(markdown, payload)
    }

    private fun vault(): Path {
        val root = Files.createTempDirectory("fanotes-stats")
        write(root, ".fanotes/folder-colors.json", serializeFolderColors(mapOf("Mathe" to "#c4554d")), day(1))
        write(root, "Mathe/Algebra.md", "# Algebra\n\nEins zwei drei **vier** [fünf](http://x) <!-- hidden words -->\n```\ncode block ignored\n```\n", day(0))
        write(root, "Mathe/Skizze.famd", handwritten("# Skizze\n\nsechs sieben\n", strokes = 12, dwellMs = 90_000, createdIso = "2026-11-08T09:00:00Z", days = listOf("2026-11-08", "2026-11-09", "2026-11-10")), day(3))
        write(root, "Mathe/Analysis/Grenzwerte.md", "Ein Wort", day(40))
        write(root, "Mathe/Karten.md", "# Karten\n\n<!-- fanotes-cards-v1 {\"cards\":[{\"id\":\"a\",\"front\":\"F1\",\"back\":\"B1\",\"due\":\"2026-11-10\",\"reps\":3,\"lapses\":1},{\"id\":\"b\",\"front\":\"F2\",\"back\":\"B2\",\"due\":\"2026-12-01\",\"reps\":0,\"lapses\":0}]} -->\n", day(2))
        write(root, "Deutsch/Gedicht.pdf", "%PDF-1.4 fake", day(5))
        write(root, "Deutsch/Gedicht.famd", handwritten("", strokes = 0, dwellMs = 30_000, createdIso = "2026-11-01T09:00:00Z", days = listOf("2026-11-01")), day(5))
        write(root, "Roman.story/manuscript/kap1.md", "x".repeat(2000), day(1))
        write(root, "Roman.story/progress/abcd12.json", """{"format":"fanotes-story-progress-v1","writer":"abcd12","days":{"2026-11-14":{"start":100,"words":250},"2026-11-13":{"start":0,"words":-5},"bad":{"start":1,"words":9}},"updatedAt":"2026-11-14T10:00:00Z"}""", day(1))
        write(root, "Roman.story/progress/efgh34.json", """{"format":"fanotes-story-progress-v1","writer":"efgh34","days":{"2026-11-14":{"start":0,"words":50}},"updatedAt":"2026-11-14T10:00:00Z"}""", day(1))
        write(root, "Notiz.md", "Lose Notiz hier", day(0, 11))
        write(root, "Skizze.png", "png", day(9))
        write(root, ".hidden.md", "never counted", day(0))
        val homework = """{"tasks":[
            {"id":"1","title":"Aufgaben 1-5","subject":"Mathe","dueDate":"2026-11-10","done":false,"kind":"homework"},
            {"id":"2","title":"Text lesen","subject":"Deutsch","dueDate":"2026-11-20","done":false,"kind":"homework"},
            {"id":"3","title":"Vokabeln","subject":"Mathe","dueDate":"2026-11-01","done":true,"kind":"homework"},
            {"id":"4","title":"Mathe Klausur","subject":"Mathe","dueDate":"2026-11-18","dueTime":"08:00","done":false,"kind":"appointment"},
            {"id":"5","title":"Elternabend","subject":"","dueDate":"2026-11-16","done":false,"kind":"appointment"},
            {"id":"6","title":"Vergangener Test","subject":"Mathe","dueDate":"2026-11-01","done":false,"kind":"appointment"}]}"""
        write(root, HOMEWORK_NOTE_PATH, "# Hausaufgaben\n\n<!-- fanotes-homework-v1\n$homework\n-->\n", day(0))
        return root
    }

    @Test
    fun aggregatesASyntheticVault() = runBlocking {
        val root = vault()
        try {
            val io = DirectoryVault(root)
            recordNoteHistory(io, "Mathe/Algebra.md", "old text", createdAt = "2026-10-02T08:00:00.000Z")
            val updates = mutableListOf<StatsProgress>()
            val stats = VaultStatsLoader(io, zone) { now }.load { _, progress -> updates += progress }
            assertEquals(listOf("tree", "notes", "history", "done"), updates.map { it.phase })

            // Files: Algebra, Skizze, Grenzwerte, Karten, Gedicht(pdf+famd), Roman.story, Notiz, png, Hausaufgaben
            assertEquals(9, stats.totals.files)
            assertEquals(3, stats.totals.folders, "Mathe, Mathe/Analysis, Deutsch; the story and .fanotes are not folders")
            assertEquals(1, stats.kinds.getValue(StatKind.HANDWRITING).count)
            assertEquals(1, stats.kinds.getValue(StatKind.PDF).count)
            assertEquals(1, stats.kinds.getValue(StatKind.STORY).count)
            assertEquals(1, stats.kinds.getValue(StatKind.IMAGE).count)
            assertEquals(5, stats.kinds.getValue(StatKind.MARKDOWN).count)
            assertEquals(8, stats.totals.notes)
            assertTrue(stats.kinds.getValue(StatKind.STORY).bytes > 2000)

            val mathe = stats.subjects.first { it.name == "Mathe" }
            assertEquals("#c4554d", mathe.color)
            assertEquals(4, mathe.count)
            assertNull(stats.subjects.first { it.name == "Deutsch" }.color)
            assertEquals(STATS_NO_SUBJECT, stats.subjects.first { it.name == STATS_NO_SUBJECT }.name)
            assertEquals(listOf(STATS_NO_SUBJECT, "Mathe", "Deutsch"), stats.subjects.map { it.name }, "most files first, ties by name")

            // Words (headings count): Algebra 6, Skizze 3, Grenzwerte 2, Karten 1 (+ marker is a comment), Notiz 3, Hausaufgaben not read
            assertEquals(6 + 3 + 2 + 1 + 3, stats.writing.wordsInNotes)
            assertEquals(300, stats.writing.storyWords, "250 + 50 over two devices; a negative day counts as 0")
            assertEquals(12, stats.writing.strokes)
            assertEquals(8_000, stats.writing.penMs)
            assertEquals(120_000, stats.time.dwellMs)
            assertEquals(2, stats.time.notesMeasured)
            assertEquals("Mathe", stats.time.bySubject.first().name)
            assertEquals(120_000, stats.time.byWeekday[1])

            assertEquals(2, stats.cards.total)
            assertEquals(1, stats.cards.due)
            assertEquals(1, stats.cards.reviewed)
            assertEquals(2.0 / 3.0, stats.cards.retention!!, 1e-9)

            val school = assertNotNull(stats.school)
            assertEquals(1, school.done)
            assertEquals(2, school.open)
            assertEquals(1, school.overdue)
            assertEquals(listOf("2026-11-16", "2026-11-18"), school.upcoming.map { it.date })
            assertEquals(listOf("Mathe Klausur"), school.exams.map { it.title })
            assertEquals(listOf("Mathe" to 2, "Deutsch" to 1), school.bySubject.map { it.name to it.done + it.open })

            assertEquals("Notiz.md", stats.recent.first().name)
            assertEquals(StatKind.STORY, stats.largest.first().kind)
            assertEquals("Skizze.famd", stats.newest.first { it.kind == StatKind.HANDWRITING }.name)

            // Heatmap: 53 weeks, Monday first, today's cell is active, history adds an October day.
            assertEquals(STATS_HEATMAP_WEEKS * 7, stats.activity.cells.size)
            assertEquals(LocalDate.of(2026, 11, 15).minusDays(6).minusWeeks(52), LocalDate.parse(stats.activity.cells.first().date))
            assertEquals(java.time.DayOfWeek.MONDAY, LocalDate.parse(stats.activity.cells.first().date).dayOfWeek)
            val todayCell = stats.activity.cells.first { it.date == "2026-11-15" }
            assertTrue(todayCell.count > 0 && todayCell.level > 0)
            assertEquals("2026-11-15", stats.activity.cells.last().date, "a Sunday ends the grid, so no future cell")
            assertTrue(stats.activity.cells.first { it.date == "2026-10-02" }.count > 0, "note history snapshot")
            assertEquals(300, stats.activity.cells.first { it.date == "2026-11-14" }.words)
            assertEquals(12, stats.activity.weeks.size)
        } finally {
            root.toFile().deleteRecursively()
        }
    }

    @Test
    fun countsWordsLikeTheDesktop() {
        assertEquals(0, countWords(""))
        assertEquals(4, countWords("# Titel\n\n- eins **zwei** [drei](http://a.b/c) ![x](y.png)\n<!-- c w -->"))
        assertEquals(3, countWords("don’t stop me ```a b c```"))
    }

    @Test
    fun streaksSkipAnEmptyToday() {
        val today = LocalDate.of(2026, 11, 15)
        val days = setOf("2026-11-14", "2026-11-13", "2026-11-12", "2026-11-01", "2026-11-02")
        val streak = statStreaks(days, today)
        assertEquals(StatStreak(current = 3, longest = 3, activeDays = 5), streak)
        assertEquals(0, statStreaks(setOf("2026-11-10"), today).current)
    }

    @Test
    fun cancellingStopsTheLoad() {
        val root = vault()
        try {
            runBlocking {
                val loader = VaultStatsLoader(DirectoryVault(root), zone) { now }
                val job = async { loader.load { _, progress -> if (progress.phase == "tree") throw CancellationException("leave") } }
                assertFailsWith<CancellationException> { job.await() }
            }
        } finally {
            root.toFile().deleteRecursively()
        }
    }

    @Test
    fun secondLoadReusesCachedFacts() = runBlocking {
        val root = vault()
        try {
            val io = DirectoryVault(root)
            var clockMs = now
            val reads = mutableMapOf<String, Int>()
            val counting = object : ch.fasrv.fanotes.vault.VaultIo by io {
                override fun read(path: String): ByteArray? { reads[path] = (reads[path] ?: 0) + 1; return io.read(path) }
            }
            val loader = VaultStatsLoader(counting, zone) { clockMs }
            val first = loader.load { _, _ -> }
            clockMs += 1_000
            val second = loader.load { _, _ -> }
            assertEquals(1, reads["Mathe/Algebra.md"], "unchanged notes are not read again")
            assertEquals(first.writing.wordsInNotes, second.writing.wordsInNotes)
            loader.load(force = true) { _, _ -> }
            assertEquals(2, reads["Mathe/Algebra.md"])
        } finally {
            root.toFile().deleteRecursively()
        }
    }

    @Test
    fun emptyVaultHasNoSchoolAndNoActivity() = runBlocking {
        val root = Files.createTempDirectory("fanotes-stats-empty")
        try {
            val stats = VaultStatsLoader(DirectoryVault(root), zone) { now }.load { _, _ -> }
            assertEquals(0, stats.totals.files)
            assertNull(stats.school)
            assertEquals(0, stats.activity.total)
            assertNull(stats.cards.retention)
        } finally {
            root.toFile().deleteRecursively()
        }
    }
}
