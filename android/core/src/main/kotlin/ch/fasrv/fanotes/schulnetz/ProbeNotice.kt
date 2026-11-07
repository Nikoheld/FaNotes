package ch.fasrv.fanotes.schulnetz

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.escapeJson
import ch.fasrv.fanotes.json.parseJson
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

fun isNotificationProbe(id: String): Boolean = id.startsWith("probe:")

/** Stable device id for probe rows. The raw push token is not stored. */
fun probeDeviceKey(token: String): String {
    if (token.isBlank()) return ""
    val digest = java.security.MessageDigest.getInstance("SHA-256").digest(token.toByteArray(Charsets.UTF_8))
    return digest.joinToString("") { "%02x".format(it) }.take(32)
}

/** School rows stay account-wide. A probe row is visible only to the addressed device. */
fun changeVisibleToDevice(id: String, device: String, deviceHash: String): Boolean {
    if (!isNotificationProbe(id)) return true
    return deviceHash.matches(Regex("^[a-f0-9]{32}$")) && device == deviceHash
}

/** `2026-11-07` becomes `07.11.2026`. */
fun formatProbeDay(isoDate: String): String {
    val match = Regex("""^(\d{4})-(\d{2})-(\d{2})""").find(isoDate.trim()) ?: return ""
    return "${match.groupValues[3]}.${match.groupValues[2]}.${match.groupValues[1]}"
}

private val probeClock: DateTimeFormatter = DateTimeFormatter.ofPattern("dd.MM.yyyy HH:mm:ss.SSS")

fun probeClockLabel(millis: Long, zone: ZoneId): String {
    if (millis <= 0L) return ""
    return Instant.ofEpochMilli(millis).atZone(zone).format(probeClock)
}

fun probeClockLabel(iso: String, zone: ZoneId): String {
    val instant = parseSchulnetzInstant(iso, zone) ?: return ""
    return instant.atZone(zone).format(probeClock)
}

/**
 * Keeps the Test label after hidden-grade redaction, puts the day back in
 * DD.MM.YYYY, and appends the server, receipt, and display clocks.
 */
fun stampProbeChange(
    change: SchulnetzChange,
    receivedAtMillis: Long,
    displayedAtMillis: Long,
    zone: ZoneId,
): SchulnetzChange {
    if (!isNotificationProbe(change.id)) return change
    val title = if (change.title.startsWith("Test:")) change.title else "Test: ${change.title}"
    val day = formatProbeDay(change.date)
    val base = if (day.isNotBlank() && !change.body.contains("Datum $day")) {
        if (change.body.isBlank()) "Datum $day" else "${change.body} · Datum $day"
    } else {
        change.body
    }
    val clocks = listOf(
        probeClockLabel(change.serverAt, zone).let { if (it.isBlank()) "" else "Server $it" },
        probeClockLabel(receivedAtMillis, zone).let { if (it.isBlank()) "" else "Empfangen $it" },
        probeClockLabel(displayedAtMillis, zone).let { if (it.isBlank()) "" else "Angezeigt $it" },
    ).filter { it.isNotBlank() }
    return change.copy(title = title, body = (listOf(base).filter { it.isNotBlank() } + clocks).joinToString("\n"))
}

fun probeLogLine(change: SchulnetzChange, receivedAtMillis: Long, displayedAtMillis: Long): String = buildString {
    append("{\"id\":").append(escapeJson(change.id))
    append(",\"title\":").append(escapeJson(change.title))
    append(",\"date\":").append(escapeJson(change.date))
    append(",\"serverAt\":").append(escapeJson(change.serverAt))
    append(",\"receivedAt\":").append(receivedAtMillis)
    append(",\"displayedAt\":").append(displayedAtMillis)
    append(",\"correlation\":").append(escapeJson(change.correlation))
    append(",\"sequence\":").append(change.sequence)
    append('}')
}

fun probeLogSummary(line: String, zone: ZoneId): String {
    val obj = runCatching { parseJson(line) as? JsonValue.Obj }.getOrNull() ?: return ""
    val title = obj.string("title").orEmpty().ifBlank { obj.string("id").orEmpty().substringAfterLast(':') }
    val date = formatProbeDay(obj.string("date").orEmpty())
    val sequence = obj.double("sequence")?.toInt() ?: 0
    val correlation = obj.string("correlation").orEmpty().takeIf { it.startsWith("probe:") }.orEmpty()
    val parts = listOf(
        title,
        date,
        if (sequence > 0) "Folge $sequence" else "",
        correlation,
        probeClockLabel(obj.string("serverAt").orEmpty(), zone).let { if (it.isBlank()) "" else "Server $it" },
        obj.double("receivedAt")?.toLong()?.let { probeClockLabel(it, zone) }?.let { if (it.isBlank()) "" else "Empfangen $it" }.orEmpty(),
        obj.double("displayedAt")?.toLong()?.let { probeClockLabel(it, zone) }?.let { if (it.isBlank()) "" else "Angezeigt $it" }.orEmpty(),
    ).filter { it.isNotBlank() }
    return parts.joinToString(" · ")
}
