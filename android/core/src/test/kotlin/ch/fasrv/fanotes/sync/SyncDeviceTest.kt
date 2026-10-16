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
    }
}
