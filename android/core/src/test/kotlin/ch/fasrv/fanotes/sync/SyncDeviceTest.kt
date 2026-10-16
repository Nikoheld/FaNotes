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
        assertEquals("Die beiden neuen Passwörter stimmen nicht überein.", syncPasswordChangeError("abcdefghij", "abcdefghjk"))
        assertEquals("Das Passwort braucht mindestens 10 Zeichen.", syncPasswordChangeError("short", "short"))
        assertEquals(null, syncPasswordChangeError("brand new secret", "brand new secret"))
        val rows = conflictDiffRows("A", "A\nB")
        assertEquals(listOf("same" to "A", "added" to "B"), rows.map { it.kind to it.text })
        assertEquals("+", conflictDiffMark("added"))
        assertEquals("-", conflictDiffMark("removed"))
        assertEquals(" ", conflictDiffMark("same"))
        assertEquals("Serverfassung behalten", conflictChoiceLabel("remote"))
        assertEquals("Lokale Fassung behalten", conflictChoiceLabel("local"))
        assertEquals("Zusammenführen", conflictChoiceLabel("both"))
        assertEquals(80, CONFLICT_DIFF_LIMIT)
        assertEquals("Synchron", syncStatusLabel(SyncPublicState(status = SyncStatus.IDLE)))
        assertEquals("Sync-Fehler", syncStatusLabel(SyncPublicState(status = SyncStatus.ERROR)))
        assertEquals("Offline – wartet auf Verbindung", syncStatusLabel(SyncPublicState(status = SyncStatus.OFFLINE)))
        assertEquals("Holt 1/2", syncStatusLabel(SyncPublicState(status = SyncStatus.SYNCING, progress = SyncProgress("pull", 1, 2))))
        assertEquals("Synchronisiert …", syncStatusLabel(SyncPublicState(status = SyncStatus.SYNCING)))
        assertEquals("0 B", syncByteLabel(0))
        assertEquals("1 KB", syncByteLabel(1024))
        assertEquals("1.5 MB", syncByteLabel(3L * 512L * 1024L))
        assertEquals("1.00 GB", syncByteLabel(1024L * 1024L * 1024L))
        assertEquals(50, syncUsagePercent(50, 100))
        assertEquals(100, syncUsagePercent(250, 100))
        assertEquals(0, syncUsagePercent(10, 0))
        assertEquals("3 Dateien · 1 KB von 1.00 GB", syncUsageLabel(3, 1024, 1024L * 1024L * 1024L))
    }
}
