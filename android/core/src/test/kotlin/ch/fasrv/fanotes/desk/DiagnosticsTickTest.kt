package ch.fasrv.fanotes.desk

import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** The periodic diagnostics check must cost nothing while it has nothing to do, and never walk the vault. */
class DiagnosticsTickTest {
    private val app = DiagnosticsApp(version = "1.2.3", platform = "android", arch = "arm64-v8a", language = "de")

    private class Memory : DiagnosticsStorage {
        val values = HashMap<String, String>()
        var reads = 0
        override fun get(key: String): String? { reads += 1; return values[key] }
        override fun put(key: String, value: String?) { if (value == null) values.remove(key) else values[key] = value }
    }

    private class Wire : DiagnosticsTransport {
        val posts = ArrayList<String>()
        override suspend fun post(url: String, json: String): Boolean { posts += json; return true }
        override suspend fun delete(url: String): Boolean = true
    }

    @Test
    fun withBothTogglesOffNothingIsAskedReadOrSent() = runBlocking {
        val storage = Memory()
        val wire = Wire()
        val client = DiagnosticsClient(storage, wire, { app }, { 1_800_000_000_000L })
        client.configure(DiagnosticsConsent(usage = false, logs = false))
        assertFalse(client.enabled())
        assertFalse(client.dailyDue())
        var asked = 0
        assertFalse(client.runDailyCheck { asked += 1; VaultFigures(10, 10) })
        assertEquals(0, asked, "the vault figures are not even requested")
        assertEquals(0, wire.posts.size)
        assertEquals(0, storage.reads, "not even a preference is read")
    }

    @Test
    fun aDueReportAsksForTheFiguresOnceAndSendsTheirBuckets() = runBlocking {
        val storage = Memory()
        val wire = Wire()
        var clock = 1_800_000_000_000L
        val client = DiagnosticsClient(storage, wire, { app }, { clock })
        client.configure(DiagnosticsConsent(usage = true))
        assertTrue(client.enabled())
        assertTrue(client.dailyDue())
        var asked = 0
        assertTrue(client.runDailyCheck { asked += 1; VaultFigures(812, 93L * 1024 * 1024) })
        assertEquals(1, asked)
        assertEquals(1, wire.posts.size)
        assertTrue(wire.posts.single().contains("\"notes\":500"), "812 notes fall in the 500 bucket")
        assertTrue(wire.posts.single().contains("\"sizeMb\":50"), "93 MB falls in the 50 bucket")

        // Sent a minute ago: not due, so the figures are not asked for again and nothing is sent.
        clock += 60_000
        assertFalse(client.dailyDue())
        assertFalse(client.runDailyCheck { asked += 1; VaultFigures(1, 1) })
        assertEquals(1, asked)
        assertEquals(1, wire.posts.size)

        clock += 24 * 3_600_000L
        assertTrue(client.dailyDue())
        assertTrue(client.runDailyCheck { asked += 1; null })
        assertEquals(2, asked, "due again after a day; unknown figures keep the last ones")
        assertTrue(wire.posts.last().contains("\"notes\":500"))
    }

    @Test
    fun logsAloneAreEnoughToRunTheCheck() = runBlocking {
        val client = DiagnosticsClient(Memory(), Wire(), { app }, { 1_800_000_000_000L })
        client.configure(DiagnosticsConsent(logs = true))
        assertTrue(client.enabled())
        assertTrue(client.runDailyCheck { VaultFigures(1, 1) })
    }

    @Test
    fun figuresComeFromWhatIsAlreadyKnownInOrder() {
        val current = StatsSummary(notes = 5, bytes = 50, at = 3)
        val saved = StatsSummary(notes = 6, bytes = 60, at = 2)
        assertEquals(5L, diagnosticsFigures(current, saved, treeNotes = 9)!!.notes, "this session's statistics first")
        assertEquals(60L, diagnosticsFigures(null, saved, treeNotes = 9)!!.bytes, "then the saved ones")
        val tree = assertNotNull(diagnosticsFigures(null, null, treeNotes = 9))
        assertEquals(9L, tree.notes)
        assertEquals(0L, tree.bytes, "the tree knows the count but no size")
        assertNull(diagnosticsFigures(null, null, treeNotes = 0))
    }
}
