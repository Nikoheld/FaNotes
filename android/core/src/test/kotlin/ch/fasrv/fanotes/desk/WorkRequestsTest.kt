package ch.fasrv.fanotes.desk

import ch.fasrv.fanotes.sync.SyncHttpRequest
import ch.fasrv.fanotes.sync.SyncHttpResponse
import ch.fasrv.fanotes.sync.SyncSession
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Fixtures under `resources/work-requests` were recorded from the real server module
 * (`fanotes-site/work-requests-api.mjs`, temp FANOTES_REQUESTS_DIR, owner allow-list) by driving it over HTTP.
 */
class WorkRequestsTest {
    private fun fixture(name: String): String =
        checkNotNull(javaClass.getResource("/work-requests/$name")) { name }.readText(Charsets.UTF_8)

    private val session = SyncSession("a".repeat(32), "device", "token-1", "", "x@y.z")
    private val featureId = Regex("\"id\":\"(r[0-9a-f]{16})\"").find(fixture("detail-merged.json"))!!.groupValues[1]

    private fun json(status: Int, body: String) = SyncHttpResponse(status, mapOf("Content-Type" to "application/json"), body.toByteArray())

    /** Replays fixtures; records every request. */
    private class Fake(val responder: (SyncHttpRequest) -> SyncHttpResponse) : WorkRequestsTransport {
        val streams = ArrayDeque<Pair<WorkStreamResult, List<String>>>()
        val requests = ArrayList<SyncHttpRequest>()
        override suspend fun execute(request: SyncHttpRequest): SyncHttpResponse { requests.add(request); return responder(request) }
        override suspend fun stream(request: SyncHttpRequest, onText: suspend (String) -> Unit): WorkStreamResult {
            requests.add(request)
            val (result, chunks) = streams.removeFirst()
            if (result.status in 200..299) for (chunk in chunks) onText(chunk)
            return result
        }
    }

    private val sse = WorkStreamResult(200, "text/event-stream; charset=utf-8")

    @Test
    fun parsesRecordedServerResponses() {
        assertTrue(parseWorkRequestCapabilities(fixture("capabilities-enabled.json")))
        assertFalse(parseWorkRequestCapabilities(fixture("capabilities-denied.json")))
        val list = parseWorkRequestList(fixture("list.json"))
        assertEquals(1, list.size)
        val working = parseWorkRequestDetail(fixture("detail-working.json"))
        assertEquals(WorkRequestKind.Feature, working.kind)
        assertEquals(WorkRequestPriority.High, working.priority)
        assertEquals(WorkRequestStatus.Working, working.status)
        assertEquals(70, working.percent)
        assertEquals("Tests laufen", working.step)
        assertNull(working.pr)
        val waiting = parseWorkRequestDetail(fixture("detail-waiting.json"))
        assertEquals(WorkRequestStatus.WaitingForYou, waiting.status)
        assertEquals(42, waiting.pr?.number)
        assertEquals("bestanden", workRequestCiLabel(waiting.pr?.ci))
        assertTrue(canApproveWorkRequest(waiting.status, waiting.approved))
        val merged = parseWorkRequestDetail(fixture("detail-merged.json"))
        assertTrue(merged.approved)
        assertTrue(merged.status.terminal)
        assertFalse(canCancelWorkRequest(merged.status))
        assertNull(workRequestProgressPercent(merged, emptyList()))
        val cancelled = parseWorkRequestDetail(fixture("detail-cancelled.json"))
        assertTrue(cancelled.cancelled)
        assertEquals("Abgebrochen", workRequestStatusInfo(cancelled.status, cancelled.cancelled).label)
        assertEquals(WorkRequestKind.Bug, cancelled.kind)
    }

    @Test
    fun labelsFollowTheDesktopPanel() {
        assertEquals("bestanden", workRequestCiLabel("success"))
        assertEquals("fehlgeschlagen", workRequestCiLabel("failure"))
        assertEquals("läuft", workRequestCiLabel("pending"))
        assertEquals("ausstehend", workRequestCiLabel("weird"))
        assertNull(workRequestCiLabel(null))
        assertEquals("Wartet auf dich", workRequestStatusInfo(WorkRequestStatus.WaitingForYou).label)
        assertEquals("Abgelehnt", workRequestStatusInfo(WorkRequestStatus.Rejected).label)
        assertEquals(WorkRequestStatus.Queued, normalizeWorkRequestStatus("nonsense"))
        assertNull(parseWorkRequest(parseJsonForTest("""{"id":"r","pr":{"number":7,"url":"javascript:alert(1)"}}""")).pr)
    }

    private fun parseJsonForTest(text: String) = ch.fasrv.fanotes.json.parseJson(text)

    @Test
    fun parsesTheRecordedEventStreamInAnyChunking() {
        val text = fixture("events.sse")
        for (size in listOf(1, 7, 64, text.length)) {
            val parser = SseParser()
            val messages = text.chunked(size).flatMap { parser.feed(it) }
            assertEquals(listOf(1L, 2, 3, 4, 5, 6, 7, 8, 9), messages.map { parseWorkRequestEvent(parseJsonForTest(it.data)).seq }, "chunk $size")
            assertEquals("1", messages.first().id)
            assertEquals("progress", messages[3].event)
        }
        val crlf = SseParser().feed(text.replace("\n", "\r\n"))
        assertEquals(9, crlf.size)
        val events = SseParser().feed(text).map { parseWorkRequestEvent(parseJsonForTest(it.data)) }
        assertEquals("Tests laufen", describeWorkRequestEvent(events[3]))
        assertEquals(70, events[3].percent)
        assertEquals("Nachricht an Claude: Bitte auch Hellmodus.", describeWorkRequestEvent(events[6]))
        assertEquals("Übernahme freigegeben", describeWorkRequestEvent(events[7]))
        assertEquals("Status: Übernommen", describeWorkRequestEvent(events[8]))
        assertEquals(70, workRequestProgressPercent(parseWorkRequestDetail(fixture("detail-working.json")), events.take(5)))
    }

    @Test
    fun capabilitiesAndErrorsMapLikeTheDesktopClient() = runBlocking {
        val denied = Fake { json(200, fixture("capabilities-denied.json")) }
        assertFalse(WorkRequestsClient(denied, { session }).capabilities())
        val forbidden = Fake { json(403, fixture("error-403.json")) }
        assertFalse(WorkRequestsClient(forbidden, { session }).capabilities())
        assertFalse(WorkRequestsClient(Fake { json(200, fixture("capabilities-enabled.json")) }, { null }).capabilities())
        val enabled = Fake { json(200, fixture("capabilities-enabled.json")) }
        assertTrue(WorkRequestsClient(enabled, { session }).capabilities())
        val sent = enabled.requests.single()
        assertEquals("https://fanotes.fasrv.ch/api/v1/requests/capabilities", sent.url)
        assertEquals("Bearer token-1", sent.headers["Authorization"])
        assertEquals("a".repeat(32), sent.headers["X-FaNotes-Account"])
        val list = Fake { json(403, fixture("error-403.json")) }
        val error = assertFailsWith<WorkRequestError> { WorkRequestsClient(list, { session }).list() }
        assertEquals(403, error.status)
        assertEquals("Diese Funktion ist nicht verfügbar.", error.message)
        val unreachable = Fake { throw java.io.IOException("down") }
        assertEquals(0, assertFailsWith<WorkRequestError> { WorkRequestsClient(unreachable, { session }).list() }.status)
        assertEquals(401, assertFailsWith<WorkRequestError> { WorkRequestsClient(enabled, { null }).list() }.status)
    }

    @Test
    fun createSendsTheDocumentedBody() = runBlocking {
        val fake = Fake { json(201, fixture("create-response.json")) }
        val client = WorkRequestsClient(fake, { session })
        val png = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3)
        val created = client.create(
            WorkRequestDraft(
                WorkRequestKind.Feature, "  Dunkles Thema ", "Bitte.", WorkRequestPriority.High, png,
                listOf(BugReportEvent(at = 1, kind = "app", message = "hi")), "1.2.3", "android",
            ),
        )
        assertEquals(WorkRequestStatus.Queued, created.status)
        val request = fake.requests.single()
        assertEquals("POST", request.method)
        assertEquals("application/json", request.headers["Content-Type"])
        val body = parseJsonForTest(request.body!!.toString(Charsets.UTF_8)) as ch.fasrv.fanotes.json.JsonValue.Obj
        assertEquals("feature", body.string("type"))
        assertEquals("Dunkles Thema", body.string("title"))
        assertEquals("high", body.string("priority"))
        assertEquals("android", body.string("platform"))
        assertEquals(java.util.Base64.getEncoder().encodeToString(png), body.string("screenshot"))
        assertTrue(body.string("logs")!!.startsWith("{\"at\":1,\"kind\":\"app\""))
        assertFailsWith<WorkRequestError> { client.create(WorkRequestDraft(WorkRequestKind.Bug, " ", "x")) }
        assertFailsWith<WorkRequestError> { client.create(WorkRequestDraft(WorkRequestKind.Bug, "t", "x", screenshot = byteArrayOf(1, 2, 3, 4, 5, 6, 7, 8, 9))) }
        assertEquals(DraftProblem.Logs, validateWorkRequestDraft(WorkRequestDraft(WorkRequestKind.Bug, "t", "d", logs = listOf(BugReportEvent(1, "x", message = "x".repeat(300 * 1024))))))
        assertEquals(1, fake.requests.size)
    }

    @Test
    fun actionsHitTheRightEndpoints() = runBlocking {
        val fake = Fake { json(200, "{}") }
        val client = WorkRequestsClient(fake, { session })
        client.approve(featureId); client.cancel(featureId); client.message(featureId, " Hallo ")
        assertEquals(
            listOf("/$featureId/approve", "/$featureId/cancel", "/$featureId/messages"),
            fake.requests.map { it.url.substringAfter("/api/v1/requests") },
        )
        assertEquals("{\"text\":\"Hallo\"}", fake.requests[2].body!!.toString(Charsets.UTF_8))
        assertFailsWith<WorkRequestError> { client.message(featureId, "  ") }
    }

    @Test
    fun observeStreamsEventsAndResumesWithLastEventId() = runBlocking {
        val full = fixture("events.sse")
        val firstPart = full.substringBefore("id: 4") // events 1..3
        val details = ArrayDeque(listOf("detail-working.json", "detail-working.json", "detail-working.json", "detail-merged.json"))
        val fake = Fake({ json(200, fixture(details.removeFirst())) })
        fake.streams.add(sse to listOf(firstPart))
        fake.streams.add(sse to listOf(fixture("events-after-3.sse")))
        val updates = ArrayList<WorkRequestDetail>()
        withTimeout(10_000) { WorkRequestsClient(fake, { session }).observe(featureId, { updates.add(it) }, pollMs = 10, reopenDelayMs = 1) }
        val streamRequests = fake.requests.filter { it.url.endsWith("/events") }
        assertEquals(2, streamRequests.size)
        assertNull(streamRequests[0].headers["Last-Event-ID"])
        assertEquals("3", streamRequests[1].headers["Last-Event-ID"])
        assertEquals("text/event-stream", streamRequests[0].headers["Accept"])
        val last = updates.last()
        assertEquals(WorkRequestStatus.Merged, last.request.status)
        assertEquals((1L..9L).toList(), last.events.map { it.seq })
        assertTrue(last.events.mapNotNull(::describeWorkRequestEvent).contains("Tests laufen"))
    }

    @Test
    fun observeFallsBackToPollingWhenTheStreamCannotBeOpened() = runBlocking {
        val details = ArrayDeque(listOf("detail-working.json", "detail-working.json", "detail-waiting.json", "detail-merged.json"))
        val fake = Fake({ request -> if (request.url.endsWith("/events")) error("not used") else json(200, fixture(if (details.size > 1) details.removeFirst() else details.first())) })
        repeat(20) { fake.streams.add(WorkStreamResult(502, "text/html") to emptyList()) }
        val statuses = ArrayList<WorkRequestStatus>()
        val detailsSeen = ArrayList<WorkRequestDetail>()
        withTimeout(10_000) { WorkRequestsClient(fake, { session }).observe(featureId, { statuses.add(it.request.status); detailsSeen.add(it) }, pollMs = 5, reopenDelayMs = 1) }
        assertEquals(WorkRequestStatus.Merged, statuses.last())
        assertTrue(WorkRequestStatus.WaitingForYou in statuses)
        // The step line is derived from the request while no events are visible.
        assertTrue(detailsSeen.any { detail -> detail.events.any { it.message == "Tests laufen" } })
        val polled = fake.requests.count { !it.url.endsWith("/events") }
        // Polling stops after the terminal status.
        Thread.sleep(40)
        assertEquals(polled, fake.requests.count { !it.url.endsWith("/events") })
    }

    @Test
    fun observeSkipsStreamForFinishedRequests() = runBlocking {
        val fake = Fake({ json(200, fixture("detail-cancelled.json")) })
        val updates = ArrayList<WorkRequestDetail>()
        withTimeout(5_000) { WorkRequestsClient(fake, { session }).observe("x", { updates.add(it) }) }
        assertEquals(1, updates.size)
        assertEquals(1, fake.requests.size)
    }

    @Test
    fun commandPaletteShortcutAndEscapeReachThePanel() {
        assertEquals("work-requests", deskShortcut(ctrl = true, shift = true, alt = false, meta = false, key = "b"))
        assertNull(deskShortcut(ctrl = true, shift = false, alt = false, meta = false, key = "b"))
        assertTrue(paletteCommands().any { it.id == "work-requests" })
        assertFalse(paletteCommands(workRequests = false).any { it.id == "work-requests" })
        assertEquals("work-requests", escapeDismisses(EscapeLayer(workRequests = true, palette = true)))
        val work = applyDesktopCommand(DeskWork(), "work-requests", CommandExtras())
        assertTrue("work-requests" in work.overlays)
        assertNull(work.message)
    }
}
