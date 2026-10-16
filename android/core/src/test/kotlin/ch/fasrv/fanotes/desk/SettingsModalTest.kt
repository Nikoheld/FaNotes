package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
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

    @Test
    fun theSettingsRowsStackAt760() {
        val narrow = settingsContentLayout(760)
        assertEquals(15, narrow.scrollPadTopDp)
        assertEquals(16, narrow.scrollPadXDp)
        assertEquals(28, narrow.scrollPadBottomDp)
        assertEquals(15, SETTINGS_SCROLL_NARROW_PAD_TOP_DP)
        assertEquals(16, SETTINGS_SCROLL_NARROW_PAD_X_DP)
        assertEquals(28, SETTINGS_SCROLL_NARROW_PAD_BOTTOM_DP)
        assertEquals(9, narrow.rowGapDp)
        assertEquals(9, SETTING_ROW_STACK_GAP_DP)
        assertEquals(16, narrow.headerPadXDp)
        assertTrue(narrow.rowsStack)
        assertFalse(narrow.headingIconVisible)
        assertTrue(settingsContentStacks(760))
        assertTrue(settingsContentStacks(400))
        assertTrue(settingsContentLayout(0).rowsStack)
        val wide = settingsContentLayout(761)
        assertFalse(wide.rowsStack)
        assertFalse(settingsContentStacks(761))
        assertFalse(settingsContentStacks(800))
        assertTrue(wide.headingIconVisible)
        assertEquals(25, wide.headerPadXDp)
        assertEquals(19, wide.scrollPadTopDp)
        assertEquals(25, wide.scrollPadXDp)
        assertEquals(34, wide.scrollPadBottomDp)
        assertEquals(22, wide.rowGapDp)
        assertEquals(settingsNavCollapses(760), settingsContentStacks(760))
        assertEquals(settingsNavCollapses(761), settingsContentStacks(761))
    }

    @Test
    fun theSettingsRangeFillsTheRowAt760() {
        assertTrue(settingsRangeFillsWidth(760))
        assertTrue(settingsRangeFillsWidth(400))
        assertTrue(settingsRangeFillsWidth(0))
        assertFalse(settingsRangeFillsWidth(761))
        assertFalse(settingsRangeFillsWidth(800))
        assertEquals(settingsContentStacks(760), settingsRangeFillsWidth(760))
        assertEquals(settingsContentStacks(761), settingsRangeFillsWidth(761))
    }

    @Test
    fun theWideRangeSettingIsA220RowBesideItsValue() {
        assertEquals(220, RANGE_SETTING_WIDTH_DP)
        assertEquals(90, RANGE_SETTING_TRACK_MIN_DP)
        assertEquals(57, RANGE_SETTING_VALUE_WIDTH_DP)
        assertEquals(27, RANGE_SETTING_VALUE_HEIGHT_DP)
        assertEquals(6, RANGE_SETTING_VALUE_RADIUS_DP)
        assertEquals(1, RANGE_SETTING_VALUE_BORDER_DP)
        assertEquals(12, RANGE_SETTING_VALUE_SP)
        assertEquals(10, RANGE_SETTING_GAP_DP)
        assertNotEquals(360, RANGE_SETTING_WIDTH_DP)
        assertTrue(RANGE_SETTING_TRACK_MIN_DP + RANGE_SETTING_GAP_DP + RANGE_SETTING_VALUE_WIDTH_DP <= RANGE_SETTING_WIDTH_DP)
        assertFalse(settingsRangeFillsWidth(761))
        assertTrue(settingsRangeFillsWidth(760))
    }

    @Test
    fun theSettingsHeadingIconShowsAbove760() {
        assertEquals(38, SETTINGS_HEADING_ICON_DP)
        assertEquals(11, SETTINGS_HEADING_ICON_RADIUS_DP)
        assertEquals(17, SETTINGS_HEADING_ICON_GLYPH_DP)
        assertEquals(11, SETTINGS_HEADING_GAP_DP)
        assertTrue(settingsContentLayout(761).headingIconVisible)
        assertTrue(settingsContentLayout(800).headingIconVisible)
        assertFalse(settingsContentLayout(760).headingIconVisible)
        assertFalse(settingsContentLayout(400).headingIconVisible)
        assertFalse(settingsContentLayout(0).headingIconVisible)
    }
}
