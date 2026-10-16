package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals

class SettingsModalTest {
    @Test
    fun theSettingsCardMatchesTheDesktopModal() {
        assertEquals(SettingsModalSize(1080, 760, 12), settingsModalSize(1600, 1200))
        assertEquals(SettingsModalSize(760, 736, 12), settingsModalSize(800, 800))
        assertEquals(SettingsModalSize(760, 800, 0), settingsModalSize(760, 800))
        assertEquals(SettingsModalSize(400, 700, 0), settingsModalSize(400, 700))
    }
}
