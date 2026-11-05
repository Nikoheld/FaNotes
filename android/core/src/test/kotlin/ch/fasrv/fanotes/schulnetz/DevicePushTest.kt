package ch.fasrv.fanotes.schulnetz

import java.time.Instant
import java.time.ZoneId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class DevicePushTest {
    private val guest = "a".repeat(32)
    private val fanotes = "b".repeat(32)
    private val token = "deviceToken:APA91bExampleValue0001"
    private val zone = ZoneId.of("Europe/Zurich")

    @Test
    fun `a token uploads for a guest and a FaNotes account and then waits a day`() {
        val now = 1_700_000_000_000L
        assertFalse(fcmTokenNeedsUpload("", guest, "", "", 0L, now, false))
        assertFalse(fcmTokenNeedsUpload(token, guest, "", "", 0L, now, true))
        assertTrue(fcmTokenNeedsUpload(token, guest, "", "", 0L, now, false))
        assertTrue(fcmTokenNeedsUpload(token, fanotes, token, guest, now, now + 1_000L, false))
        assertFalse(fcmTokenNeedsUpload(token, guest, token, guest, now, now + 60_000L, false))
        assertTrue(fcmTokenNeedsUpload(token, guest, token, guest, now, now + FCM_TOKEN_REFRESH_MS, false))
    }

    @Test
    fun `widget size follows the cell and portrait uses the tall side`() {
        assertEquals(180 to 110, widgetSizeDp(0, 0, 0, 0, true))
        assertEquals(110 to 140, widgetSizeDp(110, 280, 70, 140, true))
        assertEquals(280 to 70, widgetSizeDp(110, 280, 70, 140, false))
        assertEquals(WidgetSpan.SMALL, widgetSpan(110, 140))
        assertEquals(WidgetSpan.SMALL, widgetSpan(300, 80))
        assertEquals(WidgetSpan.MEDIUM, widgetSpan(180, 110))
        assertEquals(WidgetSpan.LARGE, widgetSpan(250, 180))
    }

    @Test
    fun `upcoming lessons skip a cancelled or finished one`() {
        val now = Instant.parse("2026-11-04T08:30:00Z")
        val finished = lesson("done", "2026-11-04T07:00:00Z", "2026-11-04T07:45:00Z")
        val current = lesson("now", "2026-11-04T08:00:00Z", "2026-11-04T08:45:00Z")
        val cancelled = lesson("off", "2026-11-04T09:00:00Z", "2026-11-04T09:45:00Z", status = "cancelled")
        val later = lesson("next", "2026-11-04T10:00:00Z", "2026-11-04T10:45:00Z")
        assertEquals(listOf("now", "next"), upcomingLessons(listOf(later, cancelled, finished, current), now, zone, 4).map { it.id })
        assertEquals(listOf("now"), upcomingLessons(listOf(current, later), now, zone, 1).map { it.id })
    }

    private fun lesson(id: String, start: String, end: String, status: String = "") =
        AgendaEvent(id, start, end, "Math", "", "A1", listOf("Nord"), "math", "Mathematik", status, "lesson", "", "")
}
