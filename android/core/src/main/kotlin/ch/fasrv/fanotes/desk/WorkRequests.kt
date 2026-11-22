package ch.fasrv.fanotes.desk

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.escapeJson
import ch.fasrv.fanotes.json.parseJson
import ch.fasrv.fanotes.sync.SYNC_ORIGIN
import ch.fasrv.fanotes.sync.SyncHttpRequest
import ch.fasrv.fanotes.sync.SyncHttpResponse
import ch.fasrv.fanotes.sync.SyncSession
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import java.util.Base64
import kotlin.coroutines.coroutineContext

/**
 * Client for the owner-only work-request API ("Fehler & Wünsche", `fanotes-site/work-requests-api.mjs`).
 * Kotlin counterpart of `src/lib/workRequests.ts`: same labels, limits and live-update rules.
 */
const val WORK_REQUESTS_PATH = "/api/v1/requests"
const val WORK_REQUEST_POLL_MS = 5000L
const val WORK_REQUEST_TITLE_MAX = 120
const val WORK_REQUEST_DESCRIPTION_MAX = 4000
const val WORK_REQUEST_MESSAGE_MAX = 2000
const val WORK_REQUEST_SCREENSHOT_MAX_BYTES = 2 * 1024 * 1024
const val WORK_REQUEST_LOGS_MAX_BYTES = 256 * 1024

enum class WorkRequestKind(val wire: String) { Bug("bug"), Feature("feature") }

enum class WorkRequestPriority(val wire: String) { Low("low"), Normal("normal"), High("high") }

enum class WorkRequestStatus(val wire: String) {
    Queued("queued"), Picked("picked"), Working("working"), PrOpen("pr_open"),
    WaitingForYou("waiting_for_you"), Merged("merged"), Rejected("rejected"), Failed("failed");

    val terminal: Boolean get() = this == Merged || this == Rejected || this == Failed
}

enum class StatusTone { Neutral, Active, Attention, Success, Danger }

data class WorkRequestEvent(
    val seq: Long,
    val at: Long,
    val type: String,
    val message: String,
    val percent: Int?,
    val status: WorkRequestStatus?,
    val from: String?,
)

data class WorkRequestPr(val number: Int, val url: String, val ci: String?)

data class WorkRequest(
    val id: String,
    val kind: WorkRequestKind,
    val title: String,
    val description: String,
    val priority: WorkRequestPriority,
    val status: WorkRequestStatus,
    val percent: Int?,
    val step: String,
    val reason: String?,
    val pr: WorkRequestPr?,
    val approved: Boolean,
    val cancelled: Boolean,
    val createdAt: Long,
    val updatedAt: Long,
    val lastSeq: Long,
)

data class WorkRequestDetail(val request: WorkRequest, val events: List<WorkRequestEvent>)

class WorkRequestDraft(
    val kind: WorkRequestKind,
    val title: String,
    val description: String,
    val priority: WorkRequestPriority = WorkRequestPriority.Normal,
    /** PNG or JPEG bytes of the current screen. */
    val screenshot: ByteArray? = null,
    /** Recent diagnostic events from the bug-report buffer; sent as one JSON line each. */
    val logs: List<BugReportEvent>? = null,
    val version: String? = null,
    val platform: String? = null,
)

class WorkRequestError(val status: Int, message: String) : Exception(message)

data class StatusInfo(val label: String, val tone: StatusTone)

fun workRequestStatusInfo(status: WorkRequestStatus, cancelled: Boolean = false): StatusInfo {
    if (cancelled && status == WorkRequestStatus.Rejected) return StatusInfo("Abgebrochen", StatusTone.Neutral)
    return when (status) {
        WorkRequestStatus.Queued -> StatusInfo("In der Warteschlange", StatusTone.Neutral)
        WorkRequestStatus.Picked -> StatusInfo("Angenommen", StatusTone.Active)
        WorkRequestStatus.Working -> StatusInfo("In Arbeit", StatusTone.Active)
        WorkRequestStatus.PrOpen -> StatusInfo("Änderung bereit", StatusTone.Active)
        WorkRequestStatus.WaitingForYou -> StatusInfo("Wartet auf dich", StatusTone.Attention)
        WorkRequestStatus.Merged -> StatusInfo("Übernommen", StatusTone.Success)
        WorkRequestStatus.Rejected -> StatusInfo("Abgelehnt", StatusTone.Danger)
        WorkRequestStatus.Failed -> StatusInfo("Fehlgeschlagen", StatusTone.Danger)
    }
}

fun normalizeWorkRequestStatus(value: String?): WorkRequestStatus =
    WorkRequestStatus.entries.firstOrNull { it.wire == value } ?: WorkRequestStatus.Queued

fun canCancelWorkRequest(status: WorkRequestStatus) = !status.terminal
fun canMessageWorkRequest(status: WorkRequestStatus) = !status.terminal
fun canApproveWorkRequest(status: WorkRequestStatus, approved: Boolean = false) =
    status == WorkRequestStatus.WaitingForYou && !approved

fun workRequestCiLabel(ci: String?): String? = when (ci) {
    null, "" -> null
    "success" -> "bestanden"
    "failure" -> "fehlgeschlagen"
    "pending" -> "läuft"
    else -> "ausstehend"
}

private fun JsonValue.Obj.pct(key: String): Int? =
    double(key)?.takeIf { it.isFinite() }?.let { Math.round(it).toInt().coerceIn(0, 100) }

private fun JsonValue.Obj.long(key: String): Long = double(key)?.takeIf { it.isFinite() }?.toLong() ?: 0L

fun parseWorkRequest(raw: JsonValue?): WorkRequest {
    val r = raw as? JsonValue.Obj ?: JsonValue.Obj()
    val prRaw = r.obj("pr")
    val prNumber = prRaw?.double("number")?.toInt() ?: 0
    val prUrl = prRaw?.string("url") ?: ""
    return WorkRequest(
        id = r.string("id") ?: "",
        kind = if (r.string("type") == "feature") WorkRequestKind.Feature else WorkRequestKind.Bug,
        title = r.string("title") ?: "",
        description = r.string("description") ?: "",
        priority = WorkRequestPriority.entries.firstOrNull { it.wire == r.string("priority") } ?: WorkRequestPriority.Normal,
        status = normalizeWorkRequestStatus(r.string("status")),
        percent = r.pct("percent"),
        step = r.string("step") ?: "",
        reason = r.string("reason")?.ifEmpty { null },
        // Only https links are ever opened.
        pr = if (prRaw != null && prNumber > 0 && prUrl.startsWith("https://")) WorkRequestPr(prNumber, prUrl, prRaw.string("ci")?.ifEmpty { null }) else null,
        approved = r.bool("approved") == true,
        cancelled = r.bool("cancelled") == true,
        createdAt = r.long("createdAt"),
        updatedAt = r.long("updatedAt"),
        lastSeq = r.long("lastSeq"),
    )
}

fun parseWorkRequestEvent(raw: JsonValue?): WorkRequestEvent {
    val e = raw as? JsonValue.Obj ?: JsonValue.Obj()
    val status = WorkRequestStatus.entries.firstOrNull { it.wire == e.string("status") }
    return WorkRequestEvent(
        seq = e.long("seq"), at = e.long("at"), type = e.string("type") ?: "progress",
        message = e.string("text") ?: "", percent = e.pct("percent"), status = status, from = e.string("from")?.ifEmpty { null },
    )
}

/** German timeline line for one server event; null for events that are not worth showing. */
fun describeWorkRequestEvent(event: WorkRequestEvent): String? = when {
    event.type == "progress" -> event.message.ifEmpty { null }
    event.type == "message" -> "Nachricht an Claude: ${event.message}"
    event.type == "approved" -> "Übernahme freigegeben"
    event.type == "status" && event.status != null -> "Status: ${workRequestStatusInfo(event.status).label}"
    else -> null
}

fun parseWorkRequestList(text: String): List<WorkRequest> {
    val items = when (val root = parseJson(text)) {
        is JsonValue.Arr -> root.items
        is JsonValue.Obj -> root.array("requests")?.items ?: emptyList()
        else -> emptyList()
    }
    return items.map { parseWorkRequest(it) }.filter { it.id.isNotEmpty() }.sortedByDescending { it.createdAt }
}

fun parseWorkRequestDetail(text: String): WorkRequest {
    val root = parseJson(text)
    return parseWorkRequest((root as? JsonValue.Obj)?.get("request") ?: root)
}

fun parseWorkRequestCapabilities(text: String): Boolean =
    (parseJson(text) as? JsonValue.Obj)?.bool("enabled") == true

/** Bar value: the latest event's percent, else a fixed value per status. */
fun workRequestProgressPercent(request: WorkRequest, events: List<WorkRequestEvent>): Int? {
    if (request.status.terminal) return null
    for (i in events.indices.reversed()) events[i].percent?.let { return it }
    val byStatus = mapOf(WorkRequestStatus.Queued to 0, WorkRequestStatus.Picked to 5, WorkRequestStatus.PrOpen to 90, WorkRequestStatus.WaitingForYou to 95)
    return request.percent ?: byStatus[request.status]
}

enum class DraftProblem { Title, Description, Screenshot, Logs }

fun workRequestLogsText(logs: List<BugReportEvent>): String = logs.joinToString("\n") { eventJson(it) }

private fun isImage(bytes: ByteArray): Boolean {
    val png = bytes.size > 8 && bytes[0] == 0x89.toByte() && bytes[1] == 0x50.toByte() && bytes[2] == 0x4e.toByte() && bytes[3] == 0x47.toByte()
    val jpeg = bytes.size > 3 && bytes[0] == 0xFF.toByte() && bytes[1] == 0xD8.toByte() && bytes[2] == 0xFF.toByte()
    return png || jpeg
}

fun validateWorkRequestDraft(draft: WorkRequestDraft): DraftProblem? {
    val title = draft.title.trim()
    if (title.isEmpty() || title.length > WORK_REQUEST_TITLE_MAX) return DraftProblem.Title
    val description = draft.description.trim()
    if (description.isEmpty() || description.length > WORK_REQUEST_DESCRIPTION_MAX) return DraftProblem.Description
    draft.screenshot?.let { if (!isImage(it) || it.size > WORK_REQUEST_SCREENSHOT_MAX_BYTES) return DraftProblem.Screenshot }
    draft.logs?.let { if (workRequestLogsText(it).toByteArray(Charsets.UTF_8).size > WORK_REQUEST_LOGS_MAX_BYTES) return DraftProblem.Logs }
    return null
}

fun workRequestDraftProblemText(problem: DraftProblem): String = when (problem) {
    DraftProblem.Title -> "Bitte gib einen Titel an (höchstens $WORK_REQUEST_TITLE_MAX Zeichen)."
    DraftProblem.Description -> "Bitte beschreibe die Anfrage (höchstens $WORK_REQUEST_DESCRIPTION_MAX Zeichen)."
    DraftProblem.Screenshot -> "Der Screenshot ist zu gross oder hat ein unbekanntes Format."
    DraftProblem.Logs -> "Die Protokolle sind zu gross, um sie anzuhängen."
}

/** POST body of a new request; the screenshot goes as raw base64 and the logs as JSON lines. */
fun workRequestCreateJson(draft: WorkRequestDraft): String = buildString {
    append("{\"type\":").append(escapeJson(draft.kind.wire))
    append(",\"title\":").append(escapeJson(draft.title.trim()))
    append(",\"description\":").append(escapeJson(draft.description.trim()))
    append(",\"priority\":").append(escapeJson(draft.priority.wire))
    draft.screenshot?.let { append(",\"screenshot\":").append(escapeJson(Base64.getEncoder().encodeToString(it))) }
    draft.logs?.takeIf { it.isNotEmpty() }?.let { append(",\"logs\":").append(escapeJson(workRequestLogsText(it))) }
    draft.version?.let { append(",\"version\":").append(escapeJson(it)) }
    draft.platform?.let { append(",\"platform\":").append(escapeJson(it)) }
    append('}')
}

data class SseMessage(val id: String?, val event: String, val data: String)

/** Incremental Server-Sent-Events parser: feed arbitrary text chunks, get complete messages. */
class SseParser {
    private val buffer = StringBuilder()
    private var id: String? = null
    private var event = "message"
    private val data = ArrayList<String>()

    fun feed(chunk: String): List<SseMessage> {
        buffer.append(chunk)
        val out = ArrayList<SseMessage>()
        while (true) {
            var end = -1
            for (i in 0 until buffer.length) {
                val c = buffer[i]
                if (c == '\n' || c == '\r') { end = i; break }
            }
            if (end < 0) break
            // A trailing CR may be the first half of CRLF; wait for the next chunk.
            if (buffer[end] == '\r' && end + 1 == buffer.length) break
            val line = buffer.substring(0, end)
            val skip = if (buffer[end] == '\r' && buffer[end + 1] == '\n') 2 else 1
            buffer.delete(0, end + skip)
            handle(line)?.let { out.add(it) }
        }
        return out
    }

    private fun handle(line: String): SseMessage? {
        if (line.isEmpty()) {
            val message = if (data.isEmpty()) null else SseMessage(id, event, data.joinToString("\n"))
            event = "message"; data.clear()
            return message
        }
        if (line.startsWith(":")) return null
        val colon = line.indexOf(':')
        val field = if (colon < 0) line else line.substring(0, colon)
        var value = if (colon < 0) "" else line.substring(colon + 1)
        if (value.startsWith(" ")) value = value.substring(1)
        when (field) {
            "id" -> id = value
            "event" -> event = value
            "data" -> data.add(value)
        }
        return null
    }
}

data class WorkStreamResult(val status: Int, val contentType: String?)

interface WorkRequestsTransport {
    suspend fun execute(request: SyncHttpRequest): SyncHttpResponse

    /**
     * Opens a streaming GET and hands each decoded text chunk to [onText] until the server closes the stream or
     * [onText] throws. Returns the HTTP status and content type; throws on network failure. A non-2xx answer must
     * not call [onText]. Cancelling the coroutine must close the connection.
     */
    suspend fun stream(request: SyncHttpRequest, onText: suspend (String) -> Unit): WorkStreamResult
}

private class StreamFinished : Exception()

class WorkRequestsClient(
    private val transport: WorkRequestsTransport,
    private val session: suspend () -> SyncSession?,
    private val origin: String = SYNC_ORIGIN,
) {
    private suspend fun headers(extra: Map<String, String> = emptyMap()): Map<String, String> {
        val active = session() ?: throw WorkRequestError(401, "Nicht angemeldet.")
        return linkedMapOf("Authorization" to "Bearer ${active.token}", "X-FaNotes-Account" to active.accountId) + extra
    }

    private fun failure(response: SyncHttpResponse): WorkRequestError {
        var message = "Der Server antwortete mit ${response.status}."
        runCatching {
            ((parseJson(response.body.toString(Charsets.UTF_8)) as? JsonValue.Obj)?.string("error"))?.let { message = it }
        }
        return WorkRequestError(response.status, message)
    }

    private suspend fun call(method: String, path: String, body: String? = null): SyncHttpResponse {
        val extra = if (body != null) mapOf("Content-Type" to "application/json") else emptyMap()
        val request = SyncHttpRequest(method, "$origin$WORK_REQUESTS_PATH$path", headers(extra), body?.toByteArray(Charsets.UTF_8))
        val response = try {
            transport.execute(request)
        } catch (error: CancellationException) {
            throw error
        } catch (error: WorkRequestError) {
            throw error
        } catch (error: Exception) {
            throw WorkRequestError(0, "Der Server ist nicht erreichbar.")
        }
        if (response.status !in 200..299) throw failure(response)
        return response
    }

    private fun text(response: SyncHttpResponse) = response.body.toString(Charsets.UTF_8)

    /** True when the signed-in account may use work requests. Any failure counts as "not allowed". */
    suspend fun capabilities(): Boolean =
        try { parseWorkRequestCapabilities(text(call("GET", "/capabilities"))) } catch (error: CancellationException) { throw error } catch (error: Exception) { false }

    suspend fun create(draft: WorkRequestDraft): WorkRequest {
        validateWorkRequestDraft(draft)?.let { throw WorkRequestError(400, workRequestDraftProblemText(it)) }
        return parseWorkRequestDetail(text(call("POST", "", workRequestCreateJson(draft))))
    }

    suspend fun list(): List<WorkRequest> = parseWorkRequestList(text(call("GET", "")))
    suspend fun detail(id: String): WorkRequest = parseWorkRequestDetail(text(call("GET", "/${enc(id)}")))
    suspend fun approve(id: String) { call("POST", "/${enc(id)}/approve", "{}") }
    suspend fun cancel(id: String) { call("POST", "/${enc(id)}/cancel", "{}") }
    suspend fun message(id: String, text: String) {
        val body = text.trim()
        if (body.isEmpty() || body.length > WORK_REQUEST_MESSAGE_MAX) throw WorkRequestError(400, "Bitte schreibe eine kurze Nachricht.")
        call("POST", "/${enc(id)}/messages", "{\"text\":${escapeJson(body)}}")
    }

    private fun enc(id: String) = java.net.URLEncoder.encode(id, "UTF-8").replace("+", "%20")

    /**
     * Live progress for one request until it reaches a terminal status (or the caller cancels). The server pushes SSE
     * from `/:id/events`, replayed from Last-Event-ID; every batch of events extends the timeline and triggers a
     * detail refresh, so the status is always server truth. A stream that ends early is reopened with Last-Event-ID;
     * when it cannot be opened, polling every [pollMs] takes over (the timeline is then derived from `step`).
     */
    suspend fun observe(
        id: String,
        onUpdate: (WorkRequestDetail) -> Unit,
        onError: (Throwable) -> Unit = {},
        pollMs: Long = WORK_REQUEST_POLL_MS,
        reopenDelayMs: Long = 500,
    ) {
        val events = ArrayList<WorkRequestEvent>()
        var lastSeq = 0L
        var lastStep = ""
        suspend fun refresh(): Boolean {
            try {
                val fresh = detail(id)
                // Polling cannot see single events: derive a progress line when the step changed.
                if (fresh.step.isNotEmpty() && fresh.step != lastStep && events.none { it.message == fresh.step }) {
                    events.add(WorkRequestEvent(-(events.size + 1).toLong(), fresh.updatedAt, "progress", fresh.step, fresh.percent, null, null))
                }
                lastStep = fresh.step
                onUpdate(WorkRequestDetail(fresh, events.toList()))
                return fresh.status.terminal
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                onError(error)
                return false
            }
        }
        suspend fun readStream(): Boolean {
            val parser = SseParser()
            val request = SyncHttpRequest(
                "GET", "$origin$WORK_REQUESTS_PATH/${enc(id)}/events",
                headers(buildMap { put("Accept", "text/event-stream"); if (lastSeq > 0) put("Last-Event-ID", lastSeq.toString()) }), null,
            )
            var done = false
            val result = try {
                transport.stream(request) { chunk ->
                    var changed = false
                    for (message in parser.feed(chunk)) {
                        val parsed = runCatching { parseWorkRequestEvent(parseJson(message.data)) }.getOrNull() ?: continue
                        if (parsed.seq <= lastSeq) continue
                        lastSeq = parsed.seq
                        events.add(parsed)
                        changed = true
                    }
                    // Real events replace lines that were derived from the request while polling.
                    if (changed) events.removeAll { it.seq < 0 }
                    if (changed && refresh()) { done = true; throw StreamFinished() }
                }
            } catch (finished: StreamFinished) {
                return true
            }
            if (result.status !in 200..299 || result.contentType?.contains("text/event-stream", ignoreCase = true) != true) {
                throw WorkRequestError(result.status, "no stream")
            }
            return done
        }
        if (refresh()) return
        try {
            for (attempt in 0 until 20) {
                coroutineContext.ensureActive()
                if (readStream()) return
                delay(reopenDelayMs)
                if (refresh()) return
            }
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            // The stream cannot be used: fall through to polling.
        }
        while (true) {
            delay(pollMs)
            if (refresh()) return
        }
    }
}
