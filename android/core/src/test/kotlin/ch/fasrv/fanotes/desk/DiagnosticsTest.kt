package ch.fasrv.fanotes.desk

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.parseJson
import ch.fasrv.fanotes.json.stringify
import kotlinx.coroutines.runBlocking
import java.io.IOException
import java.net.UnknownHostException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Runs the desktop vectors (`fanotes/scripts/check-diagnostics.mjs`) against the Kotlin port. */
class DiagnosticsTest {
    private val desktop = DiagnosticsContext(vaultPath = "/home/anna/Notizen", homeDir = "/home/anna", userName = "anna")
    private val app = DiagnosticsApp(version = "1.2.3", platform = "android", arch = "arm64-v8a", language = "de")

    @Test
    fun scrubberMatchesTheDesktopOutputOnGoldenVectors() {
        val resource = DiagnosticsTest::class.java.classLoader!!.getResourceAsStream("diagnostics-vectors.json")!!
        val root = parseJson(resource.bufferedReader(Charsets.UTF_8).readText()) as JsonValue.Obj
        fun context(name: String): DiagnosticsContext {
            val c = root.obj("context")!!.obj(name)!!
            return DiagnosticsContext(c.string("vaultPath").orEmpty(), c.string("homeDir").orEmpty(), c.string("userName").orEmpty())
        }
        val vectors = root.array("scrub")!!.items.map { it as JsonValue.Obj }
        assertTrue(vectors.size >= 80)
        for (vector in vectors) {
            val input = vector.string("input")!!
            val actual = scrubText(input, context(vector.string("context")!!), vector.double("max")!!.toInt())
            assertEquals(vector.string("expected"), actual, "scrub differs for ${input.take(60)}")
        }
        for (vector in root.array("hashes")!!.items.map { it as JsonValue.Obj }) {
            assertEquals(vector.string("expected"), hashText(vector.string("input")!!), "hash differs for ${vector.string("input")}")
        }
    }

    @Test
    fun scrubberKeepsTheDesktopRegressionCorpusClean() {
        val corpus = listOf(
            "Notiz „Scheidung Anwalt Müller“ konnte nicht gespeichert werden" to listOf("Scheidung", "Anwalt", "Müller"),
            "Titel \"Scheidung\" fehlt" to listOf("Scheidung"),
            "Titel 'Gehalt 2026' fehlt" to listOf("Gehalt"),
            "Titel «Chemo» fehlt" to listOf("Chemo"),
            "Titel ‚Chemo‘ fehlt" to listOf("Chemo"),
            "Titel “Chemo” fehlt" to listOf("Chemo"),
            "Privat/Krankheit/Befund.md" to listOf("Privat", "Krankheit", "Befund"),
            "Ordner Privat/Krankheit" to listOf("Privat", "Krankheit"),
            "Ordner Privat\\Krankheit" to listOf("Privat", "Krankheit"),
            "open C:\\Users\\Anna Müller\\Documents\\Befund Krebs.pdf failed" to listOf("Anna", "Müller", "Befund", "Krebs", "Documents"),
            "load %2Fhome%2Fanna%2FNotizen%2FKrankheit.md now" to listOf("anna", "Krankheit", "Notizen"),
            "load %252Fhome%252Fanna%252FKrankheit.md now" to listOf("anna", "Krankheit"),
            "ENOENT: open /home/anna/Notizen/Mathe/Klausur Analysis.md" to listOf("anna", "Notizen", "Mathe", "Klausur", "Analysis"),
            "failed C:\\Users\\Bob\\Docs\\Geheim.pdf for anna@example.com" to listOf("Bob", "Geheim", "example.com", "anna"),
            "GET https://user:pw@nas.privat.example.org/vault/abc?token=abc123 failed" to listOf("user", "pw", "nas", "privat", "abc123", "example.org"),
            "connect 192.168.1.20:8080 refused" to listOf("192.168", "8080"),
            "connect [2001:db8::1]:443 refused" to listOf("2001", "db8"),
            "peer fe80::1 gone and 2001:0db8:85a3:0000:0000:8a2e:0370:7334" to listOf("fe80", "8a2e"),
            "aws AKIAIOSFODNN7EXAMPLE used" to listOf("AKIAIOSFODNN7EXAMPLE"),
            "key sk-abc123def456ghi789 used" to listOf("sk-abc123"),
            "jwt eyJhbGciOi.eyJzdWIiOiIx.sig used" to listOf("eyJhbGciOi", "eyJzdWIiOiIx"),
            "pairing code 483-921-770 shown" to listOf("483-921-770"),
            "password: hunter2 and more words\nnext line ok" to listOf("hunter2", "more words"),
            "token = abcdef ghi" to listOf("abcdef"),
            "mail anna@localhost bounced" to listOf("anna", "localhost"),
            "Authorization: Bearer abcdefghijklmnop1234567890" to listOf("abcdefghijklmnop"),
            "id 0123456789abcdef0123456789abcdef01234567" to listOf("0123456789abcdef"),
            "Mathe Notizen.md konnte nicht gespeichert werden" to listOf("Mathe Notizen", ".md"),
            "anna hat Anna gesehen" to listOf("anna", "Anna"),
        )
        for ((line, words) in corpus) {
            val clean = scrubText(line, desktop)
            for (word in words) assertFalse(clean.lowercase().contains(word.lowercase()), "\"$word\" leaked from \"$line\" -> \"$clean\"")
        }
        assertTrue(scrubText("x".repeat(2000)).length <= 300)
        assertEquals(1000, scrubText("wort ".repeat(300), DiagnosticsContext(), 1000).length.coerceAtMost(1000))
    }

    @Test
    fun androidPathsAndNamesAreScrubbed() {
        val context = DiagnosticsContext(vaultPath = "/storage/emulated/0/Documents/MeinVault", homeDir = "/data/user/0/ch.fasrv.fanotes", userName = "")
        val clean = scrubText("Fehler in /storage/emulated/0/Documents/MeinVault/Mathe/Klausur.md und MeinVault", context)
        assertFalse(clean.contains("MeinVault") || clean.contains("Klausur") || clean.contains("Mathe"), clean)
    }

    @Test
    fun androidPathsWithSpacesContentUrisAndEmailsAreScrubbed() {
        val plain = listOf(
            "Fehler in /storage/emulated/0/Meine Geheime Notizen/Mathe Klausur.md beim Lesen",
            "Open failed: /sdcard/Alte Tagebuecher/Eintrag eins.md",
            "Open failed: /sdcard0/Familie Mueller/Brief.md",
            "ENOENT /data/user/0/ch.fasrv.fanotes/files/Mein Vault/Privat Krank/x.md",
            "Zugriff auf content://com.android.externalstorage.documents/tree/primary%3ADocuments%2FMein%20Tagebuch%20Anna/document/x failed",
            "tree/primary%3ADokumente%2FScheidung%20Anwalt Fehler",
            "Kontakt anna.muster@example.org oder Anna+Test@mail.example.ch",
        )
        val banned = listOf("Geheime", "Notizen", "Klausur", "Tagebuecher", "Eintrag", "Mueller", "Familie", "Privat", "Krank", "Tagebuch", "Scheidung", "Anwalt", "Dokumente", "anna.muster", "example", "Mathe")
        for (line in plain) {
            val clean = scrubText(line)
            for (word in banned) assertFalse(clean.contains(word, ignoreCase = true), "$word leaked: $clean")
        }
    }

    @Test
    fun contextFeedsSafTreeDisplayNameAndDeviceNames() {
        val tree = "content://com.android.externalstorage.documents/tree/primary%3ADocuments%2FMein%20Schulheft"
        val context = DiagnosticsContext(
            vaultPath = "/storage/emulated/0/Documents/Mein Schulheft",
            homeDir = "/data/user/0/ch.fasrv.fanotes",
            extraPaths = listOf(tree),
            extraNames = listOf("Mein Schulheft", "Pixel Tablet", "Annas Tablet"),
        )
        val clean = scrubText("Fehler $tree und Mein Schulheft auf Pixel Tablet von Annas Tablet, Ordner Mein Schulheft/Sek", context)
        for (word in listOf("Schulheft", "Pixel", "Annas", "Documents")) assertFalse(clean.contains(word), "$word leaked: $clean")
    }

    @Test
    fun errorsLeaveAsClassCodeFramesAndHashOnly() {
        val thrown = IllegalStateException("Fehler beim Öffnen von Mein Tagebuch „Scheidung“ in /home/anna/Notizen/Privat/Krankheit.md")
        val described = describeError(thrown, desktop)
        assertEquals("InvalidStateError", described.errorClass)
        assertEquals("ILLEGAL_STATE", described.code)
        assertTrue(described.frames.isNotEmpty() && described.frames.size <= 3)
        assertTrue(described.frames.all { APP_FRAME.matches(it.file) && it.line > 0 }, "only ch.fasrv.fanotes frames: ${described.frames}")
        assertTrue(ERROR_HASH.matches(described.hash))
        assertEquals(describeError(RuntimeException("x 12 \"a\"")).hash, describeError(RuntimeException("x 99 \"b\"")).hash, "digits and quoted parts do not split a group")
        assertNotEquals(hashText("a"), hashText("b"))
        assertEquals("NetworkError", describeError(UnknownHostException("fanotes.example")).errorClass)
        assertEquals("Error", describeError(IOException("disk")).errorClass)
        assertEquals("Error", describeError(object : RuntimeException("AnwaltMuellerError") {}).errorClass, "unknown error types collapse to Error")
        assertTrue(describeError(thrown).errorClass in ERROR_CLASSES)

        val payload = buildDiagnosticsPayload(DiagnosticsConsent(logs = true), newInstallId(), app, logs = listOf(LogEntry(1_700_000_123_456, described)), context = desktop)!!
        val text = payload.stringify()
        for (word in listOf("anna", "Notizen", "Tagebuch", "Scheidung", "Krankheit", "Fehler beim")) assertFalse(text.contains(word), "payload leaks $word")
        val entry = (payload.array("logs")!!.items.single() as JsonValue.Obj)
        assertEquals(listOf("at", "class", "code", "frames", "hash"), entry.fields.keys.toList(), "a log entry has no message field")
        assertEquals(1_700_000_123_000, entry.double("at")!!.toLong())
    }

    @Test
    fun framesOutsideTheAppAreDropped() {
        val foreign = IllegalStateException("x").apply {
            stackTrace = arrayOf(
                StackTraceElement("okhttp3.internal.Foo", "run", "Foo.kt", 10),
                StackTraceElement("ch.fasrv.fanotes.vault.NoteStore\$save\$1", "invoke", "NoteStore.kt", 42),
                StackTraceElement("ch.fasrv.fanotes.desk.Bar", "a", "Bar.kt", -1),
                StackTraceElement("ch.fasrv.fanotesevil.Baz", "a", "Baz.kt", 7),
                StackTraceElement("ch.fasrv.fanotes.sync.SyncEngine", "b", "SyncEngine.kt", 11),
                StackTraceElement("ch.fasrv.fanotes.ink.InkModel", "c", "InkModel.kt", 12),
                StackTraceElement("ch.fasrv.fanotes.ink.Fourth", "d", "Fourth.kt", 13),
            )
        }
        assertEquals(
            listOf("ch.fasrv.fanotes.vault.NoteStore" to 42, "ch.fasrv.fanotes.sync.SyncEngine" to 11, "ch.fasrv.fanotes.ink.InkModel" to 12),
            appFrames(foreign).map { it.file to it.line },
        )
    }

    @Test
    fun payloadSchemaAndConsent() {
        val installId = newInstallId()
        assertTrue(INSTALL_ID.matches(installId))
        assertNotEquals(installId, newInstallId(), "ids are random")
        val described = describeError(IllegalStateException("boom"))
        val usage = DiagnosticsUsage(
            counters = mapOf("tool.pen" to 7, "My Secret Note" to 3, "view.statistics" to 1),
            errors = mapOf(errorGroupKey(described) to 2, "Boom in /home/anna/x/y.md for anna@example.com" to 5),
            startupMs = 1234, vaultNotes = 137, vaultBytes = 83L * 1024 * 1024,
        )
        val logs = listOf(LogEntry(1_700_000_123_456, described))
        val both = buildDiagnosticsPayload(DiagnosticsConsent(true, true), installId, app, usage, logs, context = desktop)!!
        assertEquals(1.0, both.double("schemaVersion"))
        assertEquals(listOf("schemaVersion", "kind", "installId", "sentAt", "app", "usage", "logs"), both.fields.keys.toList())
        val counters = both.obj("usage")!!.obj("counters")!!
        assertEquals(listOf("tool.pen", "view.statistics"), counters.fields.keys.toList(), "free-form counter names are dropped")
        assertEquals(listOf(errorGroupKey(described)), both.obj("usage")!!.obj("errors")!!.fields.keys.toList(), "free-text error keys are dropped")
        assertEquals(100.0, both.obj("usage")!!.obj("vault")!!.double("notes"))
        assertEquals(50.0, both.obj("usage")!!.obj("vault")!!.double("sizeMb"))
        assertEquals(1200.0, both.obj("usage")!!.obj("perf")!!.double("startupMs"))
        assertEquals("android", both.obj("app")!!.string("platform"))
        for (word in listOf("anna", "example.com", "Secret", "boom")) assertFalse(both.stringify().contains(word), "payload leaks $word")

        val usageOnly = buildDiagnosticsPayload(DiagnosticsConsent(usage = true), installId, app, usage, logs, context = desktop)!!
        assertTrue(usageOnly.obj("usage") != null && usageOnly["logs"] == null)
        val logsOnly = buildDiagnosticsPayload(DiagnosticsConsent(logs = true), installId, app, usage, logs, context = desktop)!!
        assertTrue(logsOnly["logs"] != null && logsOnly["usage"] == null)

        val manual = buildDiagnosticsPayload(
            DiagnosticsConsent(), installId, app, logs = logs, manual = true, context = desktop,
            comment = "Crash when mail me@x.org opens /home/anna/a.md in \"Gehalt 2026\" at Privat/Krankheit",
        )!!
        assertEquals("report", manual.string("kind"))
        assertNull(manual["usage"])
        val manualText = manual.stringify()
        for (word in listOf("me@x.org", "anna", "Gehalt", "Krankheit")) assertFalse(manualText.contains(word), "comment leaks $word")
        val long = buildDiagnosticsPayload(DiagnosticsConsent(), installId, app, logs = emptyList(), manual = true, comment = "Beschreibung ${"wort ".repeat(180)}")!!
        assertTrue(long.string("comment")!!.length > 800, "the comment keeps up to 1000 characters")
        assertEquals(0, long.array("logs")!!.items.size)

        // Off means nothing.
        assertNull(buildDiagnosticsPayload(DiagnosticsConsent(false, false), installId, app, usage, logs, context = desktop))
        assertNull(buildDiagnosticsPayload(DiagnosticsConsent(), installId, app, usage, logs, context = desktop))
        assertNull(buildDiagnosticsPayload(DiagnosticsConsent(true, true), "not-an-id", app, usage, logs))
        val now = System.currentTimeMillis()
        assertFalse(dailySendDue(DiagnosticsConsent(false, false), 0))
        assertTrue(dailySendDue(DiagnosticsConsent(usage = true), 0))
        assertFalse(dailySendDue(DiagnosticsConsent(usage = true), now - 3_600_000, now), "at most once a day")
        assertTrue(dailySendDue(DiagnosticsConsent(logs = true), now - 25 * 3_600_000L, now))
    }

    private class Memory : DiagnosticsStorage {
        val values = HashMap<String, String>()
        override fun get(key: String) = values[key]
        override fun put(key: String, value: String?) { if (value == null) values.remove(key) else values[key] = value }
    }

    private class Wire(var ok: Boolean = true) : DiagnosticsTransport {
        val posts = ArrayList<Pair<String, String>>()
        val deletes = ArrayList<String>()
        override suspend fun post(url: String, json: String): Boolean { posts += url to json; return ok }
        override suspend fun delete(url: String): Boolean { deletes += url; return ok }
    }

    @Test
    fun clientSendsNothingWhileOff() = runBlocking {
        val storage = Memory()
        val wire = Wire()
        var clock = 1_800_000_000_000L
        val client = DiagnosticsClient(storage, wire, { app }, { clock })
        client.configure(DiagnosticsConsent(false, false))
        client.recordFeature("tool.pen")
        client.recordError(IllegalStateException("x"))
        assertFalse(client.sendDailyIfDue())
        assertEquals(0, wire.posts.size, "nothing is sent while off")
        assertNull(client.preview())
        client.flush()
        assertFalse(storage.values.containsKey(DIAGNOSTICS_KEY_COUNTERS))

        client.configure(DiagnosticsConsent(usage = true))
        client.recordFeature("tool.pen"); client.recordFeature("not a valid name!")
        client.recordError(IllegalStateException("x"))
        assertEquals(listOf("tool.pen"), client.preview()!!.obj("usage")!!.obj("counters")!!.fields.keys.toList())
        assertNull(client.preview()!!["logs"], "the log ring is not sent without the logs toggle")
        assertTrue(client.sendDailyIfDue())
        assertEquals(1, wire.posts.size)
        assertEquals("https://fanotes.fasrv.ch/api/v1/diagnostics", wire.posts[0].first)
        assertFalse(client.sendDailyIfDue(), "a second call within a day does not send")
        clock += 3_600_000
        assertFalse(client.sendDailyIfDue())
        assertEquals(1, wire.posts.size)
        clock += 24 * 3_600_000L
        client.recordFeature("tool.eraser")
        assertTrue(client.sendDailyIfDue(), "due again after a day")

        // A failed post is not marked as sent.
        wire.ok = false
        clock += 25 * 3_600_000L
        client.recordFeature("tool.pen")
        assertFalse(client.sendDailyIfDue())
        wire.ok = true
        assertTrue(client.sendDailyIfDue())

        // Explicit report while both toggles are off.
        client.configure(DiagnosticsConsent(false, false))
        val before = wire.posts.size
        assertTrue(client.sendLogsNow("hi mail me@x.org"))
        assertEquals(before + 1, wire.posts.size)
        assertFalse(wire.posts.last().second.contains("me@x.org"))
        assertTrue(wire.posts.last().second.contains("\"kind\":\"report\""))
    }

    @Test
    fun switchingOffWipesAndDeleteRenewsTheId() = runBlocking {
        val storage = Memory()
        val wire = Wire()
        val ids = ArrayDeque(listOf("a".repeat(32), "b".repeat(32), "c".repeat(32)))
        val client = DiagnosticsClient(storage, wire, { app }, { 1_800_000_000_000L }, { ids.removeFirst() })
        client.configure(DiagnosticsConsent(usage = true))
        client.recordFeature("tool.pen")
        client.flush()
        assertTrue(storage.values.containsKey(DIAGNOSTICS_KEY_COUNTERS))
        assertEquals("a".repeat(32), client.installId())
        client.configure(DiagnosticsConsent(false, false))
        assertFalse(storage.values.containsKey(DIAGNOSTICS_KEY_COUNTERS), "turning the toggles off deletes the local counters")

        assertEquals("b".repeat(32), client.rotateInstallId())
        assertTrue(client.deleteMyData())
        assertEquals(listOf("https://fanotes.fasrv.ch/api/v1/diagnostics/" + "b".repeat(32)), wire.deletes)
        assertEquals("c".repeat(32), client.installId(), "a successful delete renews the id")
        wire.ok = false
        assertFalse(client.deleteMyData())
        assertEquals("c".repeat(32), client.installId(), "a failed delete keeps the id so it can be retried")
    }

    @Test
    fun previewIsPrettyPrintedLikeJsonStringify() {
        val client = DiagnosticsClient(Memory(), Wire(), { app }, { 1_800_000_000_000L }, { "d".repeat(32) })
        val text = client.previewText("hi")
        assertTrue(text.startsWith("{\n  \"daily\": {\n    \"schemaVersion\": 1,"), text.take(80))
        assertNotNull(parseJson(text))
        assertTrue(text.contains("\"report\": {"))
    }
}
