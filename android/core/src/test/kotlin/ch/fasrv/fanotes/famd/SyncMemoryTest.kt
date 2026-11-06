package ch.fasrv.fanotes.famd

import ch.fasrv.fanotes.json.*
import kotlin.test.*

class SyncMemoryTest {
    @Test fun cyclesDepthAndExpandingAliasesAreRejectedBeforeCopying() {
        val cycle = JsonValue.Obj()
        cycle.put("self", cycle)
        assertFailsWith<JsonLimitException> { cycle.deepCopy() }
        assertFailsWith<JsonLimitException> { cycle.stringify() }
        var tree: JsonValue = jsonNull()
        repeat(80) { tree = jsonArray(tree) }
        assertFailsWith<JsonLimitException> { tree.deepCopy() }
        assertFailsWith<JsonLimitException> { parseJson("[".repeat(80) + "0" + "]".repeat(80)) }
        var dag: JsonValue = jsonNull()
        repeat(22) { dag = jsonArray(dag, dag) }
        assertFailsWith<JsonLimitException> { dag.deepCopy() }
        assertFailsWith<JsonLimitException> { parseJson("[0,0,0]", JsonLimits(maxNodes = 3)) }
    }

    @Test fun largePackedInkRemainsPackedDuringIdentityAndStatsMerge() {
        // 100k points would allocate hundreds of thousands of maps if sync unpacked them.
        val packed = "!".repeat(45 * 100_000)
        val stroke = jsonObject("famdPts" to jsonString(packed), "famdPtr" to jsonString("pen"))
        val payload = emptyFamdPayload("2026-01-01T00:00:00Z")
        payload.put("ink", jsonObject("strokes" to jsonArray(stroke), "updatedAt" to jsonString("original")))
        payload.put("pageStats", jsonObject("local" to jsonNumber(7.0)))
        val source = serializeFamd("", payload, "v2").encodeToByteArray()
        var nodes = 0
        val identity = identitySyncBytes("Synthetic.famd", source) { nodes = it.nodes }!!
        assertTrue(nodes < 30, "Point maps must not be expanded")
        assertEquals(NoteSyncKind.PRESENT, noteSyncKind("Synthetic.famd", source))
        val canonical = canonicalSyncBytes("Synthetic.famd", source)
        assertFalse(canonical.decodeToString().contains("pageStats"))
        val merged = withLocalPageStats(canonical, source, "Synthetic.famd")
        assertTrue(merged.decodeToString().contains("pageStats"))
        val stored = parseFamd(merged.decodeToString(), unpackPoints = false).payload!!
        assertEquals(packed, (stored.obj("ink")!!.array("strokes")!!.items.single() as JsonValue.Obj).string("famdPts"))
        assertContentEquals(identity, identitySyncBytes("Synthetic.famd", merged))
        assertEquals("original", payload.obj("ink")!!.string("updatedAt"))
    }

    @Test fun packedSyncStillValidatesBlocksWithoutExpandingThem() {
        val payload = emptyFamdPayload("2026-01-01T00:00:00Z")
        for (packed in listOf("!", "z".repeat(45), "w".repeat(45))) {
            payload.put("ink", jsonObject("strokes" to jsonArray(jsonObject("famdPts" to jsonString(packed)))))
            val source = serializeFamd("", payload, "v2").encodeToByteArray()
            assertEquals(NoteSyncKind.UNREADABLE, noteSyncKind("Synthetic.famd", source))
            assertNull(identitySyncBytes("Synthetic.famd", source))
        }
    }

    @Test fun knownAndChunkedResponsesCannotAllocatePastTheirBudget() {
        val bytes = ByteArray(8192)
        assertFailsWith<SyncDocumentLimitException> {
            ch.fasrv.fanotes.sync.readSyncResponseBody(bytes.inputStream(), 8192, maxBytes = 4096)
        }
        assertFailsWith<SyncDocumentLimitException> {
            ch.fasrv.fanotes.sync.readSyncResponseBody(bytes.inputStream(), -1, maxBytes = 4096)
        }
        assertContentEquals(bytes, ch.fasrv.fanotes.sync.readSyncResponseBody(bytes.inputStream(), -1, maxBytes = 8192))
    }

    @Test fun resourceLimitsAreNotRetriedAsOfflineNetworkFailures() = kotlinx.coroutines.runBlocking {
        var attempts = 0
        val api = ch.fasrv.fanotes.sync.SyncApi(ch.fasrv.fanotes.sync.SyncTransport {
            attempts += 1
            throw SyncDocumentLimitException()
        })
        assertFailsWith<SyncDocumentLimitException> {
            api.changes(ch.fasrv.fanotes.sync.SyncSession("account", "device", "token", "", "synthetic@example.com"), 0)
        }
        assertEquals(1, attempts)
    }

    @Test fun limitsAbortInsteadOfTreatingAnUnsafeDocumentAsMissingOrBlank() {
        assertFailsWith<SyncDocumentLimitException> { requireSyncDocumentBudget("Synthetic.famd", MAX_SYNC_DOCUMENT_BYTES.toLong() + 1) }
        val json = "{\"schema\":\"fanotes-famd-v1\",\"ink\":" + "[".repeat(80) + "0" + "]".repeat(80) + "}"
        val source = "<!-- fanotes-famd:v1 chars=${json.length} -->\n$json\n".encodeToByteArray()
        assertFailsWith<JsonLimitException> { identitySyncBytes("Synthetic.famd", source) }
        assertFailsWith<JsonLimitException> { canonicalSyncBytes("Synthetic.famd", source) }
        assertFailsWith<JsonLimitException> { noteSyncKind("Synthetic.famd", source) }
    }

    @Test fun aModestDocumentIsAllowedWhenTheHeapHasNoRoom() {
        assertEquals(SyncBudget.ALLOW, syncDocumentBudget(48_000, 0))
        assertEquals(SyncBudget.ALLOW, syncDocumentBudget(MODEST_SYNC_DOCUMENT_BYTES.toLong(), 0))
        assertEquals(SyncBudget.REJECT, syncDocumentBudget(MODEST_SYNC_DOCUMENT_BYTES.toLong() + 1, 1))
        assertEquals(
            SyncBudget.ALLOW,
            syncDocumentBudget(MODEST_SYNC_DOCUMENT_BYTES.toLong() + 1, (MODEST_SYNC_DOCUMENT_BYTES + 1L) * SYNC_DOCUMENT_HEADROOM),
        )
        assertEquals(SyncBudget.REJECT, syncDocumentBudget(MAX_SYNC_DOCUMENT_BYTES.toLong() + 1, Long.MAX_VALUE / 4))
        assertEquals(SyncBudget.REJECT, syncDocumentBudget(-1, Long.MAX_VALUE / 4))
        requireSyncDocumentBudget("Synthetic.famd", MODEST_SYNC_DOCUMENT_BYTES.toLong())
        requireSyncDocumentBudget("Notes/plain.txt", -1)
        val hard = assertFailsWith<SyncDocumentLimitException> {
            requireSyncDocumentBudget("Synthetic.famd", MAX_SYNC_DOCUMENT_BYTES.toLong() + 1)
        }
        assertFalse(hard.transient)
    }

    @Test fun aBlankOrGuestDocumentSkipsPackedInk() {
        val blankPayload = emptyFamdPayload("2026-11-06T00:00:00Z")
        val blank = serializeFamd("", blankPayload, "v2").encodeToByteArray()
        assertFalse(inkHasMarks(blankPayload))
        assertEquals(NoteSyncKind.BLANK, noteSyncKind("Notes/guest.famd", blank))
        val blankIdentity = identitySyncBytes("Notes/guest.famd", blank)
        assertNotNull(blankIdentity)
        assertFalse(blankIdentity.decodeToString().contains("\"points\""))
        val reusedPayload = emptyFamdPayload("2026-11-06T00:00:00Z")
        reusedPayload.put("ink", jsonObject("strokes" to jsonArray(), "updatedAt" to jsonString("2026-11-06T00:00:00Z")))
        assertFalse(inkHasMarks(reusedPayload))
        val reused = serializeFamd("", reusedPayload, "v2").encodeToByteArray()
        assertEquals(NoteSyncKind.BLANK, noteSyncKind("Notes/guest.famd", reused))
        assertNotNull(identitySyncBytes("Notes/guest.famd", reused))
        assertFalse(reused.decodeToString().contains("\"points\""))
        assertFalse(reused.decodeToString().contains("famdPts"))
    }
}
