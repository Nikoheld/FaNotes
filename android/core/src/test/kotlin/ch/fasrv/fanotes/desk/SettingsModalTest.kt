package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class SettingsModalTest {
    @Test
    fun theSettingsCardMatchesTheDesktopModal() {
        assertEquals(SettingsModalSize(1080, 760, 12), settingsModalSize(1600, 1200))
        assertEquals(SettingsModalSize(760, 736, 12), settingsModalSize(800, 800))
        assertEquals(SettingsModalSize(760, 800, 0), settingsModalSize(760, 800))
        assertEquals(SettingsModalSize(400, 700, 0), settingsModalSize(400, 700))
    }

    @Test
    fun theSettingsNavCollapsesToIconsAt760() {
        assertEquals(76, SETTINGS_NAV_NARROW_DP)
        assertEquals(8, SETTINGS_NAV_NARROW_PAD_X_DP)
        assertEquals(5, SETTINGS_NAV_NARROW_BUTTON_PAD_DP)
        assertEquals(9, SETTINGS_NAV_GROUP_GAP_DP)
        assertEquals(2, SETTINGS_NAV_ITEM_GAP_DP)
        assertEquals(16, SETTINGS_NAV_ICON_DP)
        assertEquals(15, SETTINGS_RESULT_ICON_DP)
        assertTrue(settingsNavCollapses(760))
        assertTrue(settingsNavCollapses(400))
        assertTrue(settingsNavCollapses(0))
        assertFalse(settingsNavCollapses(761))
        assertFalse(settingsNavCollapses(800))
        assertEquals(0, settingsModalSize(760, 800).radiusDp)
        assertEquals(12, settingsModalSize(761, 800).radiusDp)
    }
}
