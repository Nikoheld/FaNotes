package ch.fasrv.fanotes.desk

import ch.fasrv.fanotes.json.escapeJson
import ch.fasrv.fanotes.json.jsNumber
import java.net.URI
import kotlin.math.floor
import kotlin.math.min
import kotlin.math.roundToInt

/** Five minutes of diagnostics sent only to the FaNotes host. Matches `bugReport.ts`. */
const val BUG_REPORT_WINDOW_MS = 5 * 60 * 1000L
const val BUG_REPORT_MAX_EVENTS = 900
const val BUG_REPORT_MAX_BODY_BYTES = 256 * 1024
const val BUG_REPORT_PEN_SAMPLE_MS = 400L
const val BUG_REPORT_HOST = "fanotes.fasrv.ch"
const val BUG_REPORT_ORIGIN = "https://$BUG_REPORT_HOST"
const val BUG_REPORT_PATH = "/api/v1/bug-report"

/** Desktop bug-report card after the later chrome pass: 12px corners, 24×80 shadow, 520×94vw. */
const val BUG_REPORT_MAX_DP = 520
const val BUG_REPORT_WIDTH_FRACTION = 0.94f
const val BUG_REPORT_MAX_HEIGHT_DP = 640
const val BUG_REPORT_HEIGHT_FRACTION = 0.9f
const val BUG_REPORT_RADIUS_DP = 12
const val BUG_REPORT_SHADOW_Y_DP = 24
const val BUG_REPORT_SHADOW_BLUR_DP = 80
const val BUG_REPORT_SHADOW_ALPHA = 0.16f
const val BUG_REPORT_HEADER_PAD_TOP_DP = 16
const val BUG_REPORT_HEADER_PAD_X_DP = 18
const val BUG_REPORT_HEADER_PAD_BOTTOM_DP = 14
const val BUG_REPORT_HEADER_GAP_DP = 12
const val BUG_REPORT_HEADING_GAP_DP = 11
const val BUG_REPORT_TITLE_SP = 16
const val BUG_REPORT_DETAIL_SP = 12
const val BUG_REPORT_DETAIL_GAP_DP = 4
const val BUG_REPORT_ICON_DP = 18
const val BUG_REPORT_ICON_NUDGE_DP = 2
const val BUG_REPORT_CLOSE_DP = 30
const val BUG_REPORT_CLOSE_ICON_DP = 16
const val BUG_REPORT_CLOSE_RADIUS_DP = 6
const val BUG_REPORT_BODY_GAP_DP = 12
const val BUG_REPORT_BODY_PAD_TOP_DP = 18
const val BUG_REPORT_BODY_PAD_X_DP = 20
const val BUG_REPORT_BODY_PAD_BOTTOM_DP = 22
const val BUG_REPORT_LABEL_SP = 12
const val BUG_REPORT_FIELD_MIN_DP = 140
const val BUG_REPORT_FIELD_RADIUS_DP = 10
const val BUG_REPORT_FIELD_PAD_Y_DP = 10
const val BUG_REPORT_FIELD_PAD_X_DP = 12
const val BUG_REPORT_FIELD_SP = 13
const val BUG_REPORT_MAX_CHARS = 2000
const val BUG_REPORT_ACTION_GAP_DP = 8
const val BUG_REPORT_BUTTON_DP = 31
const val BUG_REPORT_BUTTON_RADIUS_DP = 6
const val BUG_REPORT_BUTTON_PAD_DP = 12
const val BUG_REPORT_BUTTON_SP = 12
const val BUG_REPORT_BUTTON_GAP_DP = 7
const val BUG_REPORT_BUTTON_ICON_DP = 15
const val BUG_REPORT_DISABLED_ALPHA = 0.45f
const val BUG_REPORT_PLACEHOLDER = "Kurz beschreiben, z. B. Stift springt nach oben beim Schreiben."
const val BUG_REPORT_TITLE = "Fehler melden"
const val BUG_REPORT_DETAIL = "Die letzten fünf Minuten (Stift, Notiz, Werkzeug) werden automatisch angehängt und nur an fanotes.fasrv.ch geschickt."
const val BUG_REPORT_LABEL = "Was ist passiert?"
const val BUG_REPORT_SEND = "Bericht senden"
const val BUG_REPORT_SENDING = "Wird gesendet …"
const val BUG_REPORT_CANCEL = "Abbrechen"

fun bugReportSendLabel(busy: Boolean): String = if (busy) BUG_REPORT_SENDING else BUG_REPORT_SEND

/** Send stays quiet until there is a description and the request is not already in flight. */
fun bugReportCanSend(description: String, busy: Boolean): Boolean = !busy && description.trim().isNotEmpty()

fun bugReportCardWidthDp(windowWidthDp: Int): Int {
    val fraction = (windowWidthDp.coerceAtLeast(0) * BUG_REPORT_WIDTH_FRACTION).roundToInt()
    return min(BUG_REPORT_MAX_DP, fraction)
}

fun bugReportMaxHeightDp(windowHeightDp: Int): Int {
    val fraction = (windowHeightDp.coerceAtLeast(0) * BUG_REPORT_HEIGHT_FRACTION).roundToInt()
    return min(BUG_REPORT_MAX_HEIGHT_DP, fraction)
}

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
