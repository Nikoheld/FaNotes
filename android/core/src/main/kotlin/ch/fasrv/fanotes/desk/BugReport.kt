package ch.fasrv.fanotes.desk

import ch.fasrv.fanotes.json.escapeJson
import ch.fasrv.fanotes.json.jsNumber
import java.net.URI
import kotlin.math.floor

/** Five minutes of diagnostics sent only to the FaNotes host. Matches `bugReport.ts`. */
const val BUG_REPORT_WINDOW_MS = 5 * 60 * 1000L
const val BUG_REPORT_MAX_EVENTS = 900
const val BUG_REPORT_MAX_BODY_BYTES = 256 * 1024
const val BUG_REPORT_PEN_SAMPLE_MS = 400L
const val BUG_REPORT_HOST = "fanotes.fasrv.ch"
const val BUG_REPORT_ORIGIN = "https://$BUG_REPORT_HOST"
const val BUG_REPORT_PATH = "/api/v1/bug-report"

data class BugReportEvent(
    val at: Long,
    val kind: String,
    val noteId: String? = null,
    val x: Double? = null,
    val y: Double? = null,
    val pointerType: String? = null,
    val tool: String? = null,
    val version: String? = null,
    val platform: String? = null,
    val message: String? = null,
)

data class BugReportPayload(
    val description: String,
    val events: List<BugReportEvent>,
    val version: String,
    val platform: String,
    val sentAt: Long,
)

data class BugReportRequest(
    val url: String,
    val host: String,
    val body: BugReportPayload,
    val json: String,
)

class BugReportLog(private val windowMs: Long = BUG_REPORT_WINDOW_MS) {
    private val events = ArrayList<BugReportEvent>()
    private var lastPenAt: Long? = null

    fun record(event: BugReportEvent, now: Long = event.at): List<BugReportEvent> {
        events += event
        replace(pruneBugReportWindow(events, now, windowMs))
        return events.toList()
    }

    /** Pen samples closer than 400 ms are dropped so five minutes fit the event cap. */
    fun recordPen(event: BugReportEvent, now: Long = event.at): List<BugReportEvent> {
        val previous = lastPenAt
        if (previous != null && now - previous < BUG_REPORT_PEN_SAMPLE_MS) return events.toList()
        lastPenAt = now
        return record(event, now)
    }

    fun snapshot(now: Long = System.currentTimeMillis()): List<BugReportEvent> {
        replace(pruneBugReportWindow(events, now, windowMs))
        return events.toList()
    }

    private fun replace(next: List<BugReportEvent>) {
        events.clear()
        events.addAll(next)
    }
}

fun pruneBugReportWindow(events: List<BugReportEvent>, now: Long, windowMs: Long = BUG_REPORT_WINDOW_MS): List<BugReportEvent> {
    val cutoff = now - windowMs
    val kept = events.filter { it.at >= cutoff && it.at <= now }
    return if (kept.size > BUG_REPORT_MAX_EVENTS) kept.takeLast(BUG_REPORT_MAX_EVENTS) else kept
}

fun compactCoord(value: Double): Double = floor(value * 10_000.0 + 0.5) / 10_000.0

fun bugReportSubmitTarget(origin: String = BUG_REPORT_ORIGIN): Pair<String, String> {
    try {
        val parsed = URI(origin)
        if (parsed.host == BUG_REPORT_HOST && parsed.scheme == "https") {
            return "$BUG_REPORT_ORIGIN$BUG_REPORT_PATH" to BUG_REPORT_HOST
        }
    } catch (_: Exception) {
        // A bad origin still reports to the shipped host.
    }
    return "$BUG_REPORT_ORIGIN$BUG_REPORT_PATH" to BUG_REPORT_HOST
}

fun buildBugReportPayload(
    description: String,
    events: List<BugReportEvent>,
    version: String,
    platform: String,
    now: Long = System.currentTimeMillis(),
): BugReportPayload = BugReportPayload(
    description = description.trim(),
    events = pruneBugReportWindow(events, now),
    version = version,
    platform = platform,
    sentAt = now,
)

fun buildBugReportRequest(
    description: String,
    events: List<BugReportEvent>,
    version: String,
    platform: String,
    now: Long = System.currentTimeMillis(),
    origin: String = BUG_REPORT_ORIGIN,
): BugReportRequest {
    val (url, host) = bugReportSubmitTarget(origin)
    val body = buildBugReportPayload(description, events, version, platform, now)
    return BugReportRequest(url, host, body, bugReportJson(body))
}

fun bugReportJson(payload: BugReportPayload): String {
    val events = payload.events.joinToString(",") { eventJson(it) }
    return buildString {
        append("{\"schemaVersion\":1,\"description\":")
        append(escapeJson(payload.description))
        append(",\"events\":[")
        append(events)
        append("],\"version\":")
        append(escapeJson(payload.version))
        append(",\"platform\":")
        append(escapeJson(payload.platform))
        append(",\"sentAt\":")
        append(payload.sentAt)
        append('}')
    }
}

private fun eventJson(event: BugReportEvent): String = buildString {
    append("{\"at\":")
    append(event.at)
    append(",\"kind\":")
    append(escapeJson(event.kind))
    field("noteId", event.noteId)
    numberField("x", event.x)
    numberField("y", event.y)
    field("pointerType", event.pointerType)
    field("tool", event.tool)
    field("version", event.version)
    field("platform", event.platform)
    field("message", event.message)
    append('}')
}

private fun StringBuilder.field(name: String, value: String?) {
    if (value == null) return
    append(",\"")
    append(name)
    append("\":")
    append(escapeJson(value))
}

private fun StringBuilder.numberField(name: String, value: Double?) {
    if (value == null || !value.isFinite()) return
    append(",\"")
    append(name)
    append("\":")
    append(jsNumber(value))
}
