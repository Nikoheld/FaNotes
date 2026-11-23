package ch.fasrv.fanotes.companion

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** Three days before the server's sign-in ends, Connections shows the date so it can be renewed in time. */
const val SIGN_IN_WARN_MS = 3L * 24 * 60 * 60 * 1000

/** The local end date ("7.12.") when the server's sign-in ends within [SIGN_IN_WARN_MS] of [nowMs], else null. */
fun signInExpiresSoon(expiresAt: String, nowMs: Long, zone: ZoneId = ZoneId.of("Europe/Zurich")): String? {
    val end = runCatching { Instant.parse(expiresAt) }.getOrNull() ?: return null
    val left = end.toEpochMilli() - nowMs
    if (left <= 0 || left > SIGN_IN_WARN_MS) return null
    return DateTimeFormatter.ofPattern("d.M.").format(end.atZone(zone))
}
