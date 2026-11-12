package ch.fasrv.fanotes.sync

import ch.fasrv.fanotes.desk.HOMEWORK_NOTE_PATH
import ch.fasrv.fanotes.desk.HomeworkDocument
import ch.fasrv.fanotes.desk.HomeworkTask
import ch.fasrv.fanotes.desk.parseHomeworkMarkdown
import ch.fasrv.fanotes.desk.serializeHomeworkMarkdown
import ch.fasrv.fanotes.famd.MAX_SYNC_DOCUMENT_BYTES
import ch.fasrv.fanotes.famd.emptyFamdPayload
import ch.fasrv.fanotes.famd.serializeFamd
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.jsonString
import ch.fasrv.fanotes.json.parseJson
import kotlinx.coroutines.runBlocking
import java.nio.charset.StandardCharsets
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class SyncEngineTest {
    @Test
    fun passwordChangeKeepsNotesAndDeletingTheAccountSignsOut() = runBlocking {
        val server = MemorySyncServer()
        val host = MemoryHost("vault")
        val engine = engine(SyncApi(server), host, "Tablet")
        try {
            engine.register("ada@example.com", "correct horse")
            host.put("Notes/Hello.md", "Hello\n".encodeToByteArray(), 1_000)
            engine.syncNow()
            var rejected = false
            try {
                engine.changePassword("wrong password", "brand new secret")
            } catch (_: Exception) {
                rejected = true
            }
            assertTrue(rejected)
            assertEquals(SyncStatus.IDLE, engine.state.value.status)
            engine.changePassword("correct horse", "brand new secret")
            assertTrue(engine.state.value.log.any { it.text.contains("Passwort geändert") })
            val otherHost = MemoryHost("other")
            val other = engine(SyncApi(server), otherHost, "Other")
            try {
                var oldRejected = false
                try {
                    other.login("ada@example.com", "correct horse")
                } catch (_: Exception) {
                    oldRejected = true
                }
                assertTrue(oldRejected)
                other.login("ada@example.com", "brand new secret")
                other.syncNow()
                assertEquals("Hello\n", otherHost.read("Notes/Hello.md").decodeToString())
            } finally {
                other.close()
            }
            var deleteRejected = false
            try {
                engine.deleteAccount("correct horse")
            } catch (_: Exception) {
                deleteRejected = true
            }
            assertTrue(deleteRejected)
            assertEquals(SyncStatus.IDLE, engine.state.value.status)
            engine.deleteAccount("brand new secret")
            assertEquals(SyncStatus.SIGNED_OUT, engine.state.value.status)
            assertTrue(engine.state.value.log.any { it.text.contains("gelöscht") })
        } finally {
            engine.close()
        }
    }

    @Test
    fun twoDevicesRoundTripAndKeepBothSidesOfAConflict() = runBlocking {
        val server = MemorySyncServer()
        val apiA = SyncApi(server)
        val apiB = SyncApi(server)
        val hostA = MemoryHost("vault-a")
        val hostB = MemoryHost("vault-b")
        val engineA = engine(apiA, hostA, "Tablet A")
        val engineB = engine(apiB, hostB, "Tablet B")
        try {
            engineA.register("ada@example.com", "correct horse")
            hostA.put("Notes/Hello.md", "Hello from A\n".encodeToByteArray(), 1_000)
            engineA.syncNow()
            engineB.login("ada@example.com", "correct horse")
            engineB.syncNow()
            assertEquals("Hello from A\n", hostB.read("Notes/Hello.md").decodeToString())

            hostA.put("Notes/Hello.md", "Hello from A revised\n".encodeToByteArray(), 2_000)
            hostB.put("Notes/Hello.md", "Hello from B\n".encodeToByteArray(), 3_000)
            engineA.syncNow()
            engineB.syncNow()
            engineA.syncNow()

            assertEquals("Hello from A revised\n", hostB.read("Notes/Hello.md").decodeToString())
            assertTrue(hostB.files.keys.any { it.contains("Konflikt") && it.endsWith(".md") })
            assertTrue(hostA.files.keys.any { it.contains("Konflikt") })
            assertEquals(SyncStatus.IDLE, engineA.state.value.status)
            assertEquals(SyncStatus.IDLE, engineB.state.value.status)
        } finally {
            engineA.close()
            engineB.close()
        }
    }

    @Test
    fun conflictingHomeworkFilesMergeTaskByTaskWithoutAConflictCopy() = runBlocking {
        val server = MemorySyncServer()
        val hostA = MemoryHost("vault-a")
        val hostB = MemoryHost("vault-b")
        val engineA = engine(SyncApi(server), hostA, "Kanti+")
        val engineB = engine(SyncApi(server), hostB, "FaNotes")
        fun doc(vararg tasks: HomeworkTask) = serializeHomeworkMarkdown(HomeworkDocument(tasks.toList())).encodeToByteArray()
        fun hw(id: String, done: Boolean, at: String) = HomeworkTask(id, id, done = done, createdAt = "2026-10-01T00:00:00Z", updatedAt = at)
        try {
            engineA.register("ada@example.com", "correct horse")
            hostA.put(HOMEWORK_NOTE_PATH, doc(hw("x", false, "2026-10-01T10:00:00Z"), hw("y", false, "2026-10-01T10:00:00Z")), 1_000)
            engineA.syncNow()
            engineB.login("ada@example.com", "correct horse")
            engineB.syncNow()
            // A (Kanti+) ticks x later; B (FaNotes) ticks y later than A's y and adds z.
            hostA.put(HOMEWORK_NOTE_PATH, doc(hw("x", true, "2026-10-02T10:00:00Z"), hw("y", false, "2026-10-01T10:00:00Z")), 2_000)
            hostB.put(HOMEWORK_NOTE_PATH, doc(hw("x", false, "2026-10-01T10:00:00Z"), hw("y", true, "2026-10-02T09:00:00Z"), hw("z", false, "2026-10-02T09:00:00Z")), 3_000)
            engineA.syncNow()
            engineB.syncNow()
            engineA.syncNow()
            engineB.syncNow()
            for (host in listOf(hostA, hostB)) {
                val tasks = parseHomeworkMarkdown(host.read(HOMEWORK_NOTE_PATH).decodeToString()).tasks.associateBy { it.id }
                assertEquals(setOf("x", "y", "z"), tasks.keys)
                assertTrue(tasks.getValue("x").done)
                assertTrue(tasks.getValue("y").done)
            }
            assertTrue(hostA.files.keys.none { it.contains("Konflikt") })
            assertTrue(hostB.files.keys.none { it.contains("Konflikt") })
            assertTrue(engineA.state.value.conflicts.isEmpty() && engineB.state.value.conflicts.isEmpty())
        } finally {
            engineA.close()
            engineB.close()
        }
    }

    @Test
    fun aTimestampOnlySaveIsNotUploaded() = runBlocking {
        val server = MemorySyncServer()
        val apiA = SyncApi(server)
        val apiB = SyncApi(server)
        val hostA = MemoryHost("vault-a")
        val hostB = MemoryHost("vault-b")
        val engineA = engine(apiA, hostA, "Tablet A")
        val engineB = engine(apiB, hostB, "Tablet B")
        try {
            engineA.register("ada@example.com", "correct horse")
            val first = noteFamd("2026-01-01T00:00:00.000Z")
            val shifted = noteFamd("2026-02-02T00:00:00.000Z")
            hostA.put("Notizen/Seite.famd", first.encodeToByteArray(), 1_000)
            engineA.syncNow()
            engineB.login("ada@example.com", "correct horse")
            engineB.syncNow()
            val kept = hostB.read("Notizen/Seite.famd")
            hostA.put("Notizen/Seite.famd", shifted.encodeToByteArray(), 2_000)
            engineA.syncNow()
            engineB.syncNow()
            assertTrue(hostB.read("Notizen/Seite.famd").contentEquals(kept))
            assertTrue(kept.decodeToString().contains("\"points\""))
        } finally {
            engineA.close()
            engineB.close()
        }
    }

    @Test
    fun aBlankLocalNoteIsRestoredAndKeptBesideTheOriginal() = runBlocking {
        val server = MemorySyncServer()
        val apiA = SyncApi(server)
        val apiB = SyncApi(server)
        val hostA = MemoryHost("vault-a")
        val hostB = MemoryHost("vault-b")
        val engineA = engine(apiA, hostA, "Tablet A")
        val engineB = engine(apiB, hostB, "Tablet B")
        try {
            engineA.register("ada@example.com", "correct horse")
            val note = noteFamd("2026-01-01T00:00:00.000Z")
            val blank = serializeFamd("", emptyFamdPayload("2026-03-03T00:00:00.000Z"))
            assertTrue(note.length > blank.length + 64)
            hostA.put("Notizen/Seite.famd", note.encodeToByteArray(), 1_000)
            engineA.syncNow()
            engineB.login("ada@example.com", "correct horse")
            engineB.syncNow()
            hostB.put("Notizen/Seite.famd", blank.encodeToByteArray(), 2_000)
            engineB.syncNow()
            assertTrue(hostB.read("Notizen/Seite.famd").decodeToString().contains("\"points\""))
            assertTrue(hostB.files.keys.any { it.contains("Konflikt") && it.contains("Seite") })
            engineA.syncNow()
            assertTrue(hostA.read("Notizen/Seite.famd").decodeToString().contains("\"points\""))
        } finally {
            engineA.close()
            engineB.close()
        }
    }

    @Test
    fun aStaleBaseRevisionIsRejected() = runBlocking {
        val server = MemorySyncServer()
        val host = MemoryHost("vault")
        val api = SyncApi(server)
        val engine = engine(api, host, "Tablet")
        try {
            engine.register("ada@example.com", "correct horse")
            val secrets = parseJson(host.readSecrets()!!) as JsonValue.Obj
            val session = SyncSession(
                secrets.string("accountId")!!,
                secrets.string("deviceId")!!,
                secrets.string("token")!!,
                secrets.string("expiresAt")!!,
                secrets.string("email")!!,
            )
            val id = "11".repeat(32)
            val first = ByteArray(64) { 7 }
            val meta = "bWVldG1ldG1ldG1ldG1ldG1ldG1ldG1ldA=="
            api.upload(session, id, 0, meta, sha256Hex(first), first)
            val second = ByteArray(64) { 8 }
            val rejected = try {
                api.upload(session, id, 0, meta, sha256Hex(second), second)
                null
            } catch (error: SyncApiError) {
                error
            }
            assertEquals(409, rejected?.status)
            val downloaded = api.download(session, id) as DownloadResult.Blob
            assertTrue(downloaded.bytes.contentEquals(first))
        } finally {
            engine.close()
        }
    }

    @Test
    fun aMissingFileIsRestoredUnlessTheDeleteWasExplicit() = runBlocking {
        val server = MemorySyncServer()
        val hostA = MemoryHost("vault-a")
        val hostB = MemoryHost("vault-b")
        val engineA = engine(SyncApi(server), hostA, "Tablet A")
        val engineB = engine(SyncApi(server), hostB, "Tablet B")
        try {
            engineA.register("ada@example.com", "correct horse")
            val note = noteFamd("2026-01-01T00:00:00.000Z").encodeToByteArray()
            hostA.put("Notizen/Seite.famd", note, 1_000)
            engineA.syncNow()
            engineB.login("ada@example.com", "correct horse")
            engineB.syncNow()
            synchronized(hostA.files) { hostA.files.remove("Notizen/Seite.famd") }
            engineA.syncNow()
            assertTrue(hostA.read("Notizen/Seite.famd").contentEquals(note))
            engineB.syncNow()
            assertTrue(hostB.read("Notizen/Seite.famd").contentEquals(note))
            synchronized(hostA.files) { hostA.files.remove("Notizen/Seite.famd") }
            engineA.markDeleted("Notizen/Seite.famd")
            engineA.syncNow()
            engineB.syncNow()
            assertTrue(synchronized(hostB.files) { hostB.files["Notizen/Seite.famd"] == null })
        } finally {
            engineA.close()
            engineB.close()
        }
    }

    @Test
    fun aTruncatedLocalNoteIsNotUploaded() = runBlocking {
        val server = MemorySyncServer()
        val hostA = MemoryHost("vault-a")
        val hostB = MemoryHost("vault-b")
        val engineA = engine(SyncApi(server), hostA, "Tablet A")
        val engineB = engine(SyncApi(server), hostB, "Tablet B")
        try {
            engineA.register("ada@example.com", "correct horse")
            val note = ByteArray(8000) { 9 }
            hostA.put("Bilder/Scan.png", note, 1_000)
            engineA.syncNow()
            engineB.login("ada@example.com", "correct horse")
            engineB.syncNow()
            hostA.put("Bilder/Scan.png", ByteArray(40) { 1 }, 2_000)
            engineA.syncNow()
            assertTrue(hostA.read("Bilder/Scan.png").contentEquals(note))
            engineB.syncNow()
            assertTrue(hostB.read("Bilder/Scan.png").contentEquals(note))
        } finally {
            engineA.close()
            engineB.close()
        }
    }

    @Test
    fun applyRemoteOomPausesWithoutLosingLocalNotesOrAdvancingTheCursor() = runBlocking {
        val server = MemorySyncServer()
        val hostA = MemoryHost("memory-a")
        val hostB = MemoryHost("memory-b")
        val diagnostics = mutableListOf<String>()
        val engineA = engine(SyncApi(server), hostA, "A")
        val engineB = SyncEngine(SyncApi(server), SyncEngineOptions(automatic = { false }, onDiagnostic = { line ->
            diagnostics += line
        }))
        engineB.attach(hostB)
        try {
            engineA.register("memory@example.com", "synthetic passphrase")
            hostA.put("Notes/synthetic.famd", noteFamd("2026-01-01T00:00:00Z").encodeToByteArray(), 1_000)
            engineA.syncNow()
            engineB.login("memory@example.com", "synthetic passphrase")
            engineB.syncNow()
            val original = hostB.read("Notes/synthetic.famd")
            val stateBefore = hostB.readState("memory-b")
            val schoolCache = "synthetic last good snapshot".encodeToByteArray()
            hostB.put(".fanotes/schulnetz/snapshot.json", schoolCache, 1_000)
            val changed = noteFamd("2026-02-01T00:00:00Z").replace("# Seite", "# Changed")
            hostA.put("Notes/synthetic.famd", changed.encodeToByteArray(), 2_000)
            engineA.syncNow()
            hostB.failWritesWithOom = true
            engineB.syncNow()
            assertEquals(SyncStatus.PAUSED, engineB.state.value.status)
            assertEquals(stateBefore, hostB.readState("memory-b"))
            kotlin.test.assertContentEquals(original, hostB.read("Notes/synthetic.famd"))
            kotlin.test.assertContentEquals(schoolCache, hostB.read(".fanotes/schulnetz/snapshot.json"))
            assertTrue(diagnostics.none { it.contains("synthetic.famd") || it.contains("Changed") || it.contains("example.com") })
            hostB.failWritesWithOom = false
            engineB.syncNow("timer") // No automatic retry loop under memory pressure.
            assertEquals(SyncStatus.PAUSED, engineB.state.value.status)
            kotlin.test.assertContentEquals(schoolCache, hostB.read(".fanotes/schulnetz/snapshot.json"))
            engineB.syncNow("resume")
            assertEquals(SyncStatus.IDLE, engineB.state.value.status)
            kotlin.test.assertContentEquals(changed.encodeToByteArray(), hostB.read("Notes/synthetic.famd"))
            assertTrue(diagnostics.any { it.contains("depth=") && it.contains("deepCopyDepth=0") })
        } finally {
            engineA.close()
            engineB.close()
        }
    }

    @Test
    fun aTransientOutOfMemoryDoesNotPauseOrShowTheBanner() = runBlocking {
        val server = MemorySyncServer()
        val hostA = MemoryHost("spike-a")
        val hostB = MemoryHost("spike-b")
        val engineA = engine(SyncApi(server), hostA, "A")
        val engineB = engine(SyncApi(server), hostB, "B")
        try {
            engineA.register("memory@example.com", "synthetic passphrase")
            hostA.put("Notes/synthetic.famd", noteFamd("2026-01-01T00:00:00Z").encodeToByteArray(), 1_000)
            engineA.syncNow()
            engineB.login("memory@example.com", "synthetic passphrase")
            engineB.syncNow()
            val original = hostB.read("Notes/synthetic.famd")
            val stateBefore = hostB.readState("spike-b")
            val changed = noteFamd("2026-02-01T00:00:00Z").replace("# Seite", "# Changed")
            hostA.put("Notes/synthetic.famd", changed.encodeToByteArray(), 2_000)
            engineA.syncNow()
            hostB.failWritesWithOom = true
            engineB.syncNow()
            assertEquals(SyncStatus.IDLE, engineB.state.value.status)
            assertEquals(null, engineB.state.value.error)
            assertEquals(stateBefore, hostB.readState("spike-b"))
            kotlin.test.assertContentEquals(original, hostB.read("Notes/synthetic.famd"))
        } finally {
            hostB.failWritesWithOom = false
            engineA.close()
            engineB.close()
        }
    }

    @Test
    fun openingTheAppClearsAMemoryPauseAndAppliesTheRemoteNote() = runBlocking {
        val server = MemorySyncServer()
        val hostA = MemoryHost("resume-a")
        val hostB = MemoryHost("resume-b")
        val engineA = engine(SyncApi(server), hostA, "A")
        val engineB = SyncEngine(SyncApi(server), SyncEngineOptions(automatic = { false }))
        engineB.attach(hostB)
        try {
            engineA.register("memory@example.com", "synthetic passphrase")
            hostA.put("Notes/synthetic.famd", noteFamd("2026-01-01T00:00:00Z").encodeToByteArray(), 1_000)
            engineA.syncNow()
            engineB.login("memory@example.com", "synthetic passphrase")
            engineB.syncNow()
            val changed = noteFamd("2026-02-01T00:00:00Z").replace("# Seite", "# Changed")
            hostA.put("Notes/synthetic.famd", changed.encodeToByteArray(), 2_000)
            engineA.syncNow()
            hostB.failWritesWithOom = true
            engineB.syncNow()
            assertEquals(SyncStatus.PAUSED, engineB.state.value.status)
            hostB.failWritesWithOom = false
            engineB.resumeAutomaticSync()
            withTimeout(5_000) {
                while (engineB.state.value.status != SyncStatus.IDLE) delay(10)
            }
            kotlin.test.assertContentEquals(changed.encodeToByteArray(), hostB.read("Notes/synthetic.famd"))
        } finally {
            hostB.failWritesWithOom = false
            engineA.close()
            engineB.close()
        }
    }

    @Test
    fun anOversizedNoteIsSkippedWithoutPausingOrDroppingItsSibling() = runBlocking {
        val server = MemorySyncServer()
        val hostA = MemoryHost("cap-a")
        val hostB = MemoryHost("cap-b")
        val engineA = engine(SyncApi(server), hostA, "A")
        val engineB = engine(SyncApi(server), hostB, "B")
        val kept = noteFamd("2026-03-01T00:00:00Z").encodeToByteArray()
        val huge = noteFamd("2026-03-02T00:00:00Z").encodeToByteArray()
        try {
            engineA.register("memory@example.com", "synthetic passphrase")
            hostA.put("Notes/ok.famd", kept, 1_000)
            hostA.put("Notes/huge.famd", huge, 1_000)
            hostA.reportedSizes["Notes/huge.famd"] = MAX_SYNC_DOCUMENT_BYTES.toLong() + 1
            engineA.syncNow()
            assertEquals(SyncStatus.IDLE, engineA.state.value.status)
            assertTrue(engineA.state.value.error?.contains("memory is low") != true)
            kotlin.test.assertContentEquals(huge, hostA.read("Notes/huge.famd"))
            engineB.login("memory@example.com", "synthetic passphrase")
            engineB.syncNow()
            assertEquals(SyncStatus.IDLE, engineB.state.value.status)
            kotlin.test.assertContentEquals(kept, hostB.read("Notes/ok.famd"))
            assertTrue("Notes/huge.famd" !in hostB.files)
        } finally {
            engineA.close()
            engineB.close()
        }
    }

    @Test
    fun aBlankGuestNoteSyncsWithoutPausingOrExpandingInk() = runBlocking {
        val server = MemorySyncServer()
        val hostA = MemoryHost("guest-a")
        val hostB = MemoryHost("guest-b")
        val engineA = engine(SyncApi(server), hostA, "A")
        val engineB = engine(SyncApi(server), hostB, "B")
        val blank = serializeFamd("", emptyFamdPayload("2026-11-06T00:00:00Z"), "v2")
        val reused = serializeFamd(
            "Gast",
            emptyFamdPayload("2026-11-06T00:00:00Z").put("ink", JsonValue.Obj().put("strokes", JsonValue.Arr())),
            "v2",
        )
        try {
            engineA.register("guest-sync@example.com", "synthetic passphrase")
            hostA.put("Notes/guest-blank.famd", blank.encodeToByteArray(), 1_000)
            hostA.put("Notes/guest-reused.famd", reused.encodeToByteArray(), 1_000)
            engineA.syncNow()
            engineB.login("guest-sync@example.com", "synthetic passphrase")
            engineB.syncNow()
            assertEquals(SyncStatus.IDLE, engineA.state.value.status)
            assertEquals(SyncStatus.IDLE, engineB.state.value.status)
            kotlin.test.assertContentEquals(blank.encodeToByteArray(), hostB.read("Notes/guest-blank.famd"))
            kotlin.test.assertContentEquals(reused.encodeToByteArray(), hostB.read("Notes/guest-reused.famd"))
            assertTrue(!blank.contains("\"points\"") && !reused.contains("\"points\""))
        } finally {
            engineA.close()
            engineB.close()
        }
    }

    @Test
    fun aLocalNoteOverAnOldTombstoneIsRecreatedOnceAndThenStaysQuiet() = runBlocking {
        val server = MemorySyncServer()
        val hostA = MemoryHost("tomb-a")
        val hostB = MemoryHost("tomb-b")
        val engineA = engine(SyncApi(server), hostA, "Tablet A")
        val engineB = engine(SyncApi(server), hostB, "Tablet B")
        try {
            engineA.register("ada@example.com", "correct horse")
            hostA.put("Notes/Old.md", "Old note from A\n".encodeToByteArray(), 1_000)
            engineA.syncNow()
            synchronized(hostA.files) { hostA.files.remove("Notes/Old.md") }
            engineA.markDeleted("Notes/Old.md")
            engineA.syncNow()
            hostA.put("Notes/Later.md", "Written after the delete\n".encodeToByteArray(), 2_000)
            engineA.syncNow()
            // B kept the note from before it signed in. Its first pull passes the tombstone
            // (no path, so nothing to match) and moves the cursor beyond it.
            val kept = "Kept on B and never deleted here\n".encodeToByteArray()
            hostB.put("Notes/Old.md", kept, 3_000)
            val before = server.callCount()
            engineB.login("ada@example.com", "correct horse")
            engineB.syncNow()
            val puts = server.callsSince(before).filter { it.method == "PUT" }
            val rejected = puts.single { it.status == 409 }
            assertEquals("0", rejected.ifMatch)
            val retries = puts.filter { it.fileId == rejected.fileId }
            assertEquals(listOf(409, 200), retries.map { it.status })
            assertTrue(retries.last().ifMatch != "0")

            val mark = server.callCount()
            engineB.syncNow()
            val next = server.callsSince(mark)
            assertTrue(next.none { it.status == 409 })
            assertTrue(next.none { it.method == "PUT" })
            assertEquals(SyncStatus.IDLE, engineB.state.value.status)

            engineA.syncNow()
            kotlin.test.assertContentEquals(kept, hostA.read("Notes/Old.md"))
            assertEquals("Written after the delete\n", hostB.read("Notes/Later.md").decodeToString())
        } finally {
            engineA.close()
            engineB.close()
        }
    }

    @Test
    fun aRefusedUploadBecomesAConflictCopyAndIsNotSentAgain() = runBlocking {
        // Once with `reason`, once as an older server that only sends the entry.
        for (legacy in listOf(false, true)) {
            val server = MemorySyncServer().apply { legacyConflicts = legacy }
            val host = MemoryHost("guard-$legacy")
            val engine = engine(SyncApi(server), host, "Tablet")
            try {
                engine.register("ada@example.com", "correct horse")
                val full = "Eine Zeile mit Inhalt.\n".repeat(60).encodeToByteArray()
                host.put("Notes/Lang.md", full, 1_000)
                engine.syncNow()
                val shorter = "Eine Zeile mit Inhalt.\n".encodeToByteArray()
                host.put("Notes/Lang.md", shorter, 2_000)
                server.refuseOverwrites = true
                val before = server.callCount()
                engine.syncNow()
                val first = server.callsSince(before)
                val refused = first.single { it.method == "PUT" && it.status == 409 }
                assertEquals(1, first.count { it.method == "PUT" && it.fileId == refused.fileId }, "legacy=$legacy")
                kotlin.test.assertContentEquals(full, host.read("Notes/Lang.md"))
                val copy = synchronized(host.files) { host.files.keys.single { it.startsWith("Notes/Lang (Konflikt") } }
                kotlin.test.assertContentEquals(shorter, host.read(copy))
                assertTrue(engine.state.value.conflicts.any { it.path == "Notes/Lang.md" && it.copyPath == copy })

                val mark = server.callCount()
                engine.syncNow()
                val second = server.callsSince(mark)
                assertTrue(second.none { it.method == "PUT" && it.fileId == refused.fileId }, "legacy=$legacy")
                assertTrue(second.none { it.status == 409 }, "legacy=$legacy")
                // The conflict copy is a new file, so the guard has nothing to protect and it uploads.
                assertEquals(1, second.count { it.method == "PUT" && it.status == 200 && it.ifMatch == "0" })
                kotlin.test.assertContentEquals(full, host.read("Notes/Lang.md"))
                assertEquals(SyncStatus.IDLE, engine.state.value.status)
            } finally {
                engine.close()
            }
        }
    }

    @Test
    fun aNewerEntryBelowTheCursorIsAppliedWhenTheUploadIsRejected() = runBlocking {
        val server = MemorySyncServer()
        val hostA = MemoryHost("stale-a")
        val hostB = MemoryHost("stale-b")
        val engineA = engine(SyncApi(server), hostA, "Tablet A")
        val engineB = engine(SyncApi(server), hostB, "Tablet B")
        try {
            engineA.register("ada@example.com", "correct horse")
            hostA.put("Notes/Shared.md", "First version\n".encodeToByteArray(), 1_000)
            engineA.syncNow()
            engineB.login("ada@example.com", "correct horse")
            engineB.syncNow()
            assertEquals("First version\n", hostB.read("Notes/Shared.md").decodeToString())
            val edit = server.callCount()
            hostA.put("Notes/Shared.md", "Second version from A\n".encodeToByteArray(), 2_000)
            engineA.syncNow()
            val sharedId = server.callsSince(edit).single { it.method == "PUT" && it.status == 200 }.fileId!!
            hostA.put("Notes/Other.md", "A later note\n".encodeToByteArray(), 2_500)
            engineA.syncNow()
            // B's pull lists only the later note, so its cursor moves past A's edit without applying it.
            server.hiddenIds = setOf(sharedId)
            engineB.syncNow()
            server.hiddenIds = emptySet()
            assertEquals("A later note\n", hostB.read("Notes/Other.md").decodeToString())
            assertEquals("First version\n", hostB.read("Notes/Shared.md").decodeToString())
            engineB.syncNow()
            assertEquals("First version\n", hostB.read("Notes/Shared.md").decodeToString())

            hostB.put("Notes/Shared.md", "Edited on B\n".encodeToByteArray(), 3_000)
            val before = server.callCount()
            engineB.syncNow()
            val first = server.callsSince(before)
            assertEquals(1, first.count { it.method == "PUT" && it.status == 409 })
            assertEquals("Second version from A\n", hostB.read("Notes/Shared.md").decodeToString())
            val copy = synchronized(hostB.files) { hostB.files.keys.single { it.startsWith("Notes/Shared (Konflikt") } }
            assertEquals("Edited on B\n", hostB.read(copy).decodeToString())
            assertTrue(engineB.state.value.conflicts.any { it.path == "Notes/Shared.md" && it.copyPath == copy })

            val mark = server.callCount()
            engineB.syncNow()
            assertTrue(server.callsSince(mark).none { it.status == 409 })
            engineA.syncNow()
            assertEquals("Second version from A\n", hostA.read("Notes/Shared.md").decodeToString())
            assertEquals("Edited on B\n", hostA.read(copy).decodeToString())
        } finally {
            engineA.close()
            engineB.close()
        }
    }

    @Test
    fun aDamagedRemoteBlobIsSkippedWhileTheRestOfThePullAndThePushRun() = runBlocking {
        val server = MemorySyncServer()
        val hostA = MemoryHost("damaged-a")
        val hostB = MemoryHost("damaged-b")
        val engineA = engine(SyncApi(server), hostA, "Tablet A")
        val engineB = engine(SyncApi(server), hostB, "Tablet B")
        suspend fun skippedIds(): List<String> {
            val state = parseJson(hostB.readState("damaged-b")!!) as JsonValue.Obj
            return state.array("skipped")?.items.orEmpty().mapNotNull { (it as? JsonValue.Obj)?.string("id") }
        }
        try {
            engineA.register("ada@example.com", "correct horse")
            hostA.put("Notes/Base.md", "Base note\n".encodeToByteArray(), 1_000)
            engineA.syncNow()
            engineB.login("ada@example.com", "correct horse")
            engineB.syncNow()
            val badUpload = server.callCount()
            hostA.put("Notes/Bad.md", "This blob arrives damaged\n".encodeToByteArray(), 2_000)
            engineA.syncNow()
            val badId = server.callsSince(badUpload).single { it.method == "PUT" && it.status == 200 }.fileId!!
            hostA.put("Notes/Good.md", "This one arrives intact\n".encodeToByteArray(), 2_500)
            engineA.syncNow()

            server.damagedIds = setOf(badId)
            hostB.put("Notes/Base.md", "Edited on B\n".encodeToByteArray(), 3_000)
            val before = server.callCount()
            engineB.syncNow()
            val cycle = server.callsSince(before)
            // The damaged entry did not stop the cycle: the next entry and the local edit both went through.
            assertEquals(SyncStatus.IDLE, engineB.state.value.status)
            assertEquals(null, engineB.state.value.error)
            assertEquals("This one arrives intact\n", hostB.read("Notes/Good.md").decodeToString())
            assertTrue(synchronized(hostB.files) { "Notes/Bad.md" !in hostB.files })
            assertEquals(1, cycle.count { it.method == "PUT" && it.status == 200 })
            assertTrue(badId in skippedIds())
            assertTrue(engineB.state.value.log.any { it.level == "warn" && it.text.contains("retried") })
            // A later pull retries it from the skip list; still damaged, it stays there and is not logged again.
            val warnings = engineB.state.value.log.count { it.level == "warn" }
            engineB.syncNow()
            assertTrue(badId in skippedIds())
            assertEquals(warnings, engineB.state.value.log.count { it.level == "warn" })
            engineA.syncNow()
            assertEquals("Edited on B\n", hostA.read("Notes/Base.md").decodeToString())

            server.damagedIds = emptySet()
            engineB.syncNow()
            assertEquals("This blob arrives damaged\n", hostB.read("Notes/Bad.md").decodeToString())
            assertTrue(badId !in skippedIds())
            assertEquals(SyncStatus.IDLE, engineB.state.value.status)
        } finally {
            engineA.close()
            engineB.close()
        }
    }

    private fun noteFamd(updatedAt: String): String {
        val ink = JsonValue.Obj()
        ink.put("updatedAt", jsonString(updatedAt))
        val stroke = JsonValue.Obj()
        val points = JsonValue.Arr()
        repeat(24) { index ->
            val point = JsonValue.Obj()
            point.put("x", ch.fasrv.fanotes.json.jsonNumber(index.toDouble()))
            point.put("y", ch.fasrv.fanotes.json.jsonNumber(1.0))
            points.items.add(point)
        }
        stroke.put("points", points)
        ink.put("strokes", JsonValue.Arr(mutableListOf(stroke)))
        val payload = emptyFamdPayload(updatedAt)
        payload.put("ink", ink)
        payload.put("updatedAt", jsonString(updatedAt))
        return serializeFamd("# Seite\n\n${"Wort ".repeat(40)}", payload)
    }

    private fun engine(api: SyncApi, host: MemoryHost, name: String): SyncEngine {
        val engine = SyncEngine(api, SyncEngineOptions(platform = "android", deviceName = { name }, automatic = { true }))
        engine.attach(host)
        return engine
    }
}

private class MemoryHost(private val id: String) : SyncHost {
    val files = linkedMapOf<String, Pair<ByteArray, Long>>()
    val reportedSizes = mutableMapOf<String, Long>()
    var failWritesWithOom = false
    private var secrets: String? = null
    private var state: String? = null

    fun put(path: String, bytes: ByteArray, mtime: Long) = synchronized(files) {
        files[path] = bytes to mtime
    }

    override suspend fun vaultId() = id
    override suspend fun scan() = synchronized(files) {
        files.map { (path, value) -> SyncScanEntry(path, reportedSizes[path] ?: value.first.size.toLong(), value.second) }
    }
    override suspend fun read(path: String) = synchronized(files) {
        files[path]?.first ?: throw NoSuchElementException(path)
    }
    override suspend fun write(path: String, bytes: ByteArray, mtimeMs: Long): SyncScanEntry = synchronized(files) {
        if (failWritesWithOom) throw OutOfMemoryError("synthetic")
        files[path] = bytes to mtimeMs
        SyncScanEntry(path, bytes.size.toLong(), mtimeMs)
    }
    override suspend fun remove(path: String) {
        synchronized(files) { files.remove(path) }
    }
    override suspend fun readState(vaultId: String) = state
    override suspend fun writeState(vaultId: String, json: String?) { state = json }
    override suspend fun readSecrets() = secrets
    override suspend fun writeSecrets(json: String?) { secrets = json }
}

/**
 * In-memory stand-in for `fanotes-site/sync-api.mjs`: revisions, If-Match and tombstones.
 * The auth key is compared directly; the real server scrypts it again, which does not change the client.
 */
private class MemorySyncServer : SyncTransport {
    private val accounts = linkedMapOf<String, Account>()
    private val sessions = linkedMapOf<String, String>()
    private val calls = mutableListOf<Call>()

    /** A server from before `reason` and `X-FaNotes-Rejected`: the 409 carries only the entry. */
    @Volatile var legacyConflicts = false

    /** The size guard refuses every PUT over a live entry, as for a blank or collapsed body. */
    @Volatile var refuseOverwrites = false

    /** `/changes` leaves these files out but still moves `nextSince` past them, as for a lost entry. */
    @Volatile var hiddenIds: Set<String> = emptySet()

    /** Downloads of these files arrive with one flipped byte, so the blob fails its checksum. */
    @Volatile var damagedIds: Set<String> = emptySet()

    data class Call(val method: String, val fileId: String?, val ifMatch: String?, val status: Int)

    fun callCount() = synchronized(this) { calls.size }

    fun callsSince(mark: Int) = synchronized(this) { calls.drop(mark) }

    override suspend fun execute(request: SyncHttpRequest): SyncHttpResponse = synchronized(this) {
        val path = request.url.substringAfter("/api/v1/sync")
        val response = route(path, request)
        calls += Call(
            request.method,
            path.takeIf { it.startsWith("/files/") }?.removePrefix("/files/"),
            header(request, "If-Match"),
            response.status,
        )
        response
    }

    private fun route(path: String, request: SyncHttpRequest): SyncHttpResponse {
        val account = accountFor(request)
        return try {
            when {
                path == "/prelogin" && request.method == "POST" -> prelogin(request)
                path == "/register" && request.method == "POST" -> register(request)
                path == "/login" && request.method == "POST" -> login(request)
                path == "/password" && request.method == "POST" -> changePassword(requireNotNull(account), request)
                path == "/account" && request.method == "DELETE" -> deleteAccount(requireNotNull(account), request)
                path == "/changes" || path.startsWith("/changes?") -> {
                    val since = path.substringAfter("since=", "0").toLong()
                    changes(requireNotNull(account), since)
                }
                path.startsWith("/files/") && request.method == "GET" -> download(requireNotNull(account), path.removePrefix("/files/"))
                path.startsWith("/files/") && request.method == "PUT" -> upload(requireNotNull(account), path.removePrefix("/files/"), request)
                path.startsWith("/files/") && request.method == "DELETE" -> remove(requireNotNull(account), path.removePrefix("/files/"), request)
                else -> json(404, """{"error":"not found"}""")
            }
        } catch (error: Exception) {
            json(500, """{"error":${ch.fasrv.fanotes.json.escapeJson(error.message ?: "error")}}""")
        }
    }

    private fun prelogin(request: SyncHttpRequest): SyncHttpResponse {
        val email = (parseJson(request.body!!.decodeToString()) as JsonValue.Obj).string("email")
        val account = accounts.values.firstOrNull { it.email == email }
        val kdf = account?.kdf ?: SyncKdf(KDF_ALGORITHM, 600_000, "BwcHBwcHBwcHBwcHBwcHBw==")
        return json(200, """{"kdf":{"algorithm":"${kdf.algorithm}","iterations":${kdf.iterations},"salt":${ch.fasrv.fanotes.json.escapeJson(kdf.salt)}}}""")
    }

    private fun register(request: SyncHttpRequest): SyncHttpResponse {
        val body = parseJson(request.body!!.decodeToString()) as JsonValue.Obj
        val email = body.string("email") ?: error("email")
        if (accounts.values.any { it.email == email }) return json(409, """{"error":"exists"}""")
        val kdf = body.obj("kdf")!!
        val wrap = body.obj("vaultKeyWrap")!!
        val account = Account(
            id = UUID.randomUUID().toString(),
            email = email,
            authKey = body.string("authKey")!!,
            kdf = SyncKdf(kdf.string("algorithm")!!, kdf.double("iterations")!!.toInt(), kdf.string("salt")!!),
            wrap = SyncKeyWrap(wrap.string("iv")!!, wrap.string("data")!!),
        )
        accounts[account.id] = account
        val device = openDevice(account, body.obj("device")?.string("name") ?: "device")
        return json(201, """{"accountId":"${account.id}","deviceId":"${device.id}","token":"${device.token}","expiresAt":"2099-01-01T00:00:00.000Z","revision":0}""")
    }

    private fun changePassword(account: Account, request: SyncHttpRequest): SyncHttpResponse {
        val body = parseJson(request.body!!.decodeToString()) as JsonValue.Obj
        if (body.string("authKey") != account.authKey) return json(401, """{"error":"unauthorized"}""")
        val kdf = body.obj("kdf") ?: return json(400, """{"error":"kdf"}""")
        val wrap = body.obj("vaultKeyWrap") ?: return json(400, """{"error":"wrap"}""")
        account.authKey = body.string("newAuthKey") ?: return json(400, """{"error":"auth"}""")
        account.kdf = SyncKdf(kdf.string("algorithm") ?: "", kdf.double("iterations")?.toInt() ?: 0, kdf.string("salt") ?: "")
        account.wrap = SyncKeyWrap(wrap.string("iv") ?: "", wrap.string("data") ?: "")
        return json(200, "{}")
    }

    private fun deleteAccount(account: Account, request: SyncHttpRequest): SyncHttpResponse {
        val body = parseJson(request.body!!.decodeToString()) as JsonValue.Obj
        if (body.string("authKey") != account.authKey) return json(401, """{"error":"unauthorized"}""")
        accounts.remove(account.id)
        sessions.entries.removeAll { it.value == account.id }
        return json(200, "{}")
    }

    private fun login(request: SyncHttpRequest): SyncHttpResponse {
        val body = parseJson(request.body!!.decodeToString()) as JsonValue.Obj
        val email = body.string("email")
        val account = accounts.values.firstOrNull { it.email == email && it.authKey == body.string("authKey") }
            ?: return json(401, """{"error":"unauthorized"}""")
        val device = openDevice(account, body.obj("device")?.string("name") ?: "device")
        return json(200, """{"accountId":"${account.id}","deviceId":"${device.id}","token":"${device.token}","expiresAt":"2099-01-01T00:00:00.000Z","kdf":{"algorithm":"${account.kdf.algorithm}","iterations":${account.kdf.iterations},"salt":${ch.fasrv.fanotes.json.escapeJson(account.kdf.salt)}},"vaultKeyWrap":{"iv":${ch.fasrv.fanotes.json.escapeJson(account.wrap.iv)},"data":${ch.fasrv.fanotes.json.escapeJson(account.wrap.data)}},"revision":${account.revision}}""")
    }

    private fun changes(account: Account, since: Long): SyncHttpResponse {
        val entries = account.files.values.filter { it.revision > since }.sortedBy { it.revision }
        val page = entries.take(500)
        val next = page.lastOrNull()?.revision ?: account.revision
        val body = page.filter { it.id !in hiddenIds }.joinToString(",", prefix = "[", postfix = "]") { entryJson(it).removePrefix("\"entry\":") }
        return json(200, """{"revision":${account.revision},"entries":$body,"more":${entries.size > page.size},"nextSince":$next}""")
    }

    private fun download(account: Account, id: String): SyncHttpResponse {
        val entry = account.files[id] ?: return json(404, """{"error":"missing"}""")
        if (entry.deleted) {
            return SyncHttpResponse(204, mapOf("x-fanotes-revision" to entry.revision.toString(), "x-fanotes-deleted" to "1"), ByteArray(0))
        }
        return SyncHttpResponse(
            200,
            mapOf(
                "x-fanotes-revision" to entry.revision.toString(),
                "x-fanotes-meta" to entry.meta.orEmpty(),
                "x-fanotes-sha256" to entry.sha256.orEmpty(),
            ),
            if (id in damagedIds) entry.blob.copyOf().also { it[it.size / 2] = (it[it.size / 2].toInt() xor 0x5a).toByte() } else entry.blob,
        )
    }

    private fun upload(account: Account, id: String, request: SyncHttpRequest): SyncHttpResponse {
        val base = header(request, "If-Match")?.trim('"')?.toLongOrNull() ?: return json(428, """{"error":"if-match"}""")
        val current = account.files[id]
        val currentRevision = current?.revision ?: 0L
        if (currentRevision != base) return conflict(current, id, "stale")
        val declared = header(request, "X-FaNotes-Sha256") ?: return json(400, """{"error":"sha"}""")
        val body = request.body ?: ByteArray(0)
        if (sha256Hex(body) != declared) return json(400, """{"error":"checksum"}""")
        val blank = when (header(request, "X-FaNotes-Blank")) {
            "1" -> true
            "0" -> false
            else -> null
        }
        val clear = header(request, "X-FaNotes-Clear") == "1"
        val refused = refuseOverwrites && !clear && current != null && !current.deleted
        if (refused || rejectsBlank(current, body.size, blank, clear)) return conflict(current, id, "guard")
        account.revision += 1
        val entry = FileEntry(id, account.revision, false, body.size.toLong(), declared, header(request, "X-FaNotes-Meta"), body)
        account.files[id] = entry
        return json(200, """{"revision":${entry.revision}}""")
    }

    private fun remove(account: Account, id: String, request: SyncHttpRequest): SyncHttpResponse {
        if (header(request, "X-FaNotes-Delete") != "1") return json(428, """{"error":"explicit"}""")
        val base = header(request, "If-Match")?.trim('"')?.toLongOrNull() ?: return json(428, """{"error":"if-match"}""")
        val current = account.files[id]
        if ((current?.revision ?: 0L) != base) return conflict(current, id, "stale")
        account.revision += 1
        account.files[id] = FileEntry(id, account.revision, true, 0, null, null, ByteArray(0))
        return json(200, """{"revision":${account.revision}}""")
    }

    /** Same body as fanotes-site: the current entry, and `reason` plus a header on a guard refusal. */
    private fun conflict(current: FileEntry?, id: String, reason: String): SyncHttpResponse {
        val entry = current ?: FileEntry(id, 0, true, 0, null, null, ByteArray(0))
        val entryBody = entryJson(entry).removePrefix("\"entry\":")
        if (legacyConflicts) return json(409, """{"error":"conflict","entry":$entryBody}""")
        val headers = mutableMapOf("content-type" to "application/json")
        if (reason == "guard") headers["X-FaNotes-Rejected"] = "guard"
        return SyncHttpResponse(409, headers, """{"error":"conflict","reason":"$reason","entry":$entryBody}""".toByteArray(StandardCharsets.UTF_8))
    }

    private fun openDevice(account: Account, name: String): Device {
        val device = Device(UUID.randomUUID().toString(), name, UUID.randomUUID().toString())
        account.devices += device
        sessions[device.token] = account.id
        return device
    }

    private fun accountFor(request: SyncHttpRequest): Account? {
        val token = header(request, "Authorization")?.removePrefix("Bearer ")?.trim() ?: return null
        val id = sessions[token] ?: return null
        return accounts[id]
    }

    private fun entryJson(entry: FileEntry): String {
        val sha = entry.sha256?.let { ch.fasrv.fanotes.json.escapeJson(it) } ?: "null"
        val meta = entry.meta?.let { ch.fasrv.fanotes.json.escapeJson(it) } ?: "null"
        return """"entry":{"id":"${entry.id}","revision":${entry.revision},"deleted":${entry.deleted},"size":${entry.size},"sha256":$sha,"meta":$meta,"updatedAt":null,"deviceId":null}"""
    }

    private fun json(status: Int, body: String) = SyncHttpResponse(status, mapOf("content-type" to "application/json"), body.toByteArray(StandardCharsets.UTF_8))

    private fun header(request: SyncHttpRequest, name: String) =
        request.headers.entries.firstOrNull { it.key.equals(name, ignoreCase = true) }?.value

    /**
     * Same rule as `rejectsBlankOverwrite` in fanotes-site: a blank, empty, or collapsed body does
     * not replace a real note unless the editor cleared it. Short notes are not judged by size.
     */
    private fun rejectsBlank(current: FileEntry?, nextSize: Int, blank: Boolean?, clear: Boolean): Boolean {
        if (clear || current == null || current.deleted || current.size <= 28L) return false
        if (blank == true) return true
        if (nextSize <= 28) return true
        return current.size >= 4096L && (nextSize <= 1024 || nextSize * 4 < current.size)
    }

    private class Account(
        val id: String,
        val email: String,
        var authKey: String,
        var kdf: SyncKdf,
        var wrap: SyncKeyWrap,
        var revision: Long = 0,
        val files: LinkedHashMap<String, FileEntry> = linkedMapOf(),
        val devices: MutableList<Device> = mutableListOf(),
    )

    private class Device(val id: String, val name: String, val token: String)
    private class FileEntry(
        val id: String,
        val revision: Long,
        val deleted: Boolean,
        val size: Long,
        val sha256: String?,
        val meta: String?,
        val blob: ByteArray,
    )
}
