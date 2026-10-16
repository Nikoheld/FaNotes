package ch.fasrv.fanotes.sync

import java.time.ZoneOffset
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class SyncDeviceTest {
    @Test
    fun seenLabelsMatchTheDesktopDeviceRow() {
        assertEquals("noch nie", syncDeviceSeenLabel(null, ZoneOffset.UTC))
        assertEquals("noch nie", syncDeviceSeenLabel("", ZoneOffset.UTC))
        assertEquals("unbekannt", syncDeviceSeenLabel("gestern", ZoneOffset.UTC))
        assertEquals("15. Okt. 2026, 12:00", syncDeviceSeenLabel("2026-10-15T12:00:00Z", ZoneOffset.UTC))
        assertEquals("Tablet · dieses Gerät", syncDeviceTitle("Tablet", true))
        assertEquals("Laptop", syncDeviceTitle("Laptop", false))
        assertFalse(syncDeviceCanSignOut(true))
        assertTrue(syncDeviceCanSignOut(false))
        assertTrue(syncDeviceIsPhone("web"))
        assertTrue(syncDeviceIsPhone("browser-preview"))
        assertFalse(syncDeviceIsPhone("android"))
        val log = listOf(
            SyncLogEntry("2026-10-15T12:00:00Z", "info", "eins"),
            SyncLogEntry("2026-10-15T12:01:00Z", "warn", "zwei"),
            SyncLogEntry("2026-10-15T12:02:00Z", "error", "drei"),
        )
        assertEquals(listOf("drei", "zwei", "eins"), visibleSyncLog(log).map { it.text })
        assertEquals("3 Einträge", syncLogToggleLabel(3, false))
        assertEquals("Einklappen", syncLogToggleLabel(3, true))
        assertEquals("soft", syncLogTone("info"))
        assertEquals("warning", syncLogTone("warn"))
        assertEquals("danger", syncLogTone("error"))
        assertEquals(40, SYNC_LOG_VISIBLE)
        assertEquals(240, SYNC_LOG_MAX_DP)
        assertEquals(110, SYNC_LOG_TIME_DP)
    }
}
