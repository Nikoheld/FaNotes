package ch.fasrv.fanotes.schulnetz

import java.time.Instant
import java.time.ZoneId

/** Re-register the same token once a day so a dropped server copy comes back. */
const val FCM_TOKEN_REFRESH_MS = 24L * 60L * 60L * 1000L

/**
 * Upload whenever this device has a token and an account, FaNotes or guest.
 * A successful upload of the same pair waits until [FCM_TOKEN_REFRESH_MS].
 */
fun fcmTokenNeedsUpload(
    token: String,
    accountId: String,
    sentToken: String,
    sentAccountId: String,
    sentAtMillis: Long,
    nowMillis: Long,
    disconnected: Boolean,
): Boolean {
    if (disconnected) return false
    if (token.isBlank() || accountId.isBlank()) return false
    if (token != sentToken || accountId != sentAccountId || sentAtMillis <= 0L) return true
    return nowMillis - sentAtMillis >= FCM_TOKEN_REFRESH_MS
}

enum class WidgetSpan { SMALL, MEDIUM, LARGE }

/** Portrait uses the smaller width and the taller height. Landscape swaps them. */
fun widgetSizeDp(minWidth: Int, maxWidth: Int, minHeight: Int, maxHeight: Int, portrait: Boolean): Pair<Int, Int> {
    val width = if (portrait) minWidth else maxWidth
    val height = if (portrait) maxHeight else minHeight
    return (if (width > 0) width else 180) to (if (height > 0) height else 110)
}

/** Short or narrow cells stay compact. A tall wide cell lists the following lessons. */
fun widgetSpan(widthDp: Int, heightDp: Int): WidgetSpan = when {
    widthDp < 180 || heightDp < 100 -> WidgetSpan.SMALL
    widthDp >= 250 && heightDp >= 180 -> WidgetSpan.LARGE
    else -> WidgetSpan.MEDIUM
}

/** Lessons that have not ended, soonest first. Cancelled lessons are skipped. */
fun upcomingLessons(events: List<AgendaEvent>, now: Instant, zone: ZoneId = ZoneId.of("Europe/Zurich"), limit: Int = 4): List<AgendaEvent> {
    if (limit <= 0) return emptyList()
    return events.mapNotNull { event ->
        val end = event.endsAt(zone) ?: return@mapNotNull null
        if (end.isBefore(now) || event.isCancelled()) null else event
    }.sortedBy { it.startsAt(zone) ?: Instant.EPOCH }.take(limit)
}
