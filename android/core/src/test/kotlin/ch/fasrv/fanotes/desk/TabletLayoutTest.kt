package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class TabletLayoutTest {
    @Test
    fun widthClassesFollowTheMaterialBreakpoints() {
        assertEquals(WidthClass.COMPACT, widthClass(599))
        assertEquals(WidthClass.MEDIUM, widthClass(600))
        assertEquals(WidthClass.MEDIUM, widthClass(839))
        assertEquals(WidthClass.EXPANDED, widthClass(840))
    }

    @Test
    fun touchLayerIsAutomaticBelowExpandedAndOverridable() {
        assertTrue(touchLarge(null, 800))
        assertFalse(touchLarge(null, 1280))
        assertTrue(touchLarge("on", 1280))
        assertFalse(touchLarge("off", 500))
    }

    @Test
    fun desktopMetricsStayPinnedAndTouchMetricsReachFortyEightDp() {
        val desk = TouchMetrics(false)
        assertEquals(RIBBON_HEIGHT_DP, desk.ribbonHeightDp)
        assertEquals(RIBBON_BUTTON_DP, desk.ribbonButtonDp)
        assertEquals(STATUS_BAR_DP, desk.statusBarDp)
        assertEquals(NOTE_TAB_CLOSE_DP, desk.tabCloseHitDp)
        assertEquals(SPLIT_DIVIDER_DP, desk.dividerHitDp)
        assertEquals(36, desk.treeRowHeightDp(36))
        val touch = TouchMetrics(true)
        listOf(
            touch.ribbonButtonDp, touch.navHeightDp, touch.tabCloseHitDp, touch.statusChipDp,
            touch.menuRowDp, touch.sidebarActionDp, touch.dividerHitDp, touch.treeRowHeightDp(27),
        ).forEach { assertTrue(it >= TOUCH_MIN_DP, "target $it dp") }
        assertTrue(touch.ribbonHeightDp >= touch.ribbonButtonDp)
        assertTrue(touch.statusBarDp >= touch.statusChipDp)
        assertEquals(RIBBON_BUTTON_DP, touch.ribbonButtonVisualDp)
        assertEquals(SPLIT_DIVIDER_DP, touch.dividerVisualDp)
        assertEquals(60, touch.treeRowHeightDp(60))
    }

    @Test
    fun expandedKeepsTheDesktopLayoutAndNarrowWidthsUseADrawer() {
        val wide = adaptivePanels(WidthClass.EXPANDED, false, true, sidebarOpen = true, drawerOpen = false, inspectorOpen = true, outlineEnabled = true)
        assertEquals(SidebarMode.PINNED, wide.sidebarMode)
        assertTrue(wide.sidebarVisible)
        assertTrue(wide.inspectorInline)
        assertFalse(wide.inspectorOverlay)

        val medium = adaptivePanels(WidthClass.MEDIUM, false, true, sidebarOpen = true, drawerOpen = false, inspectorOpen = true, outlineEnabled = true)
        assertEquals(SidebarMode.DRAWER, medium.sidebarMode)
        assertFalse(medium.sidebarVisible)
        assertFalse(medium.inspectorInline)
        assertTrue(medium.inspectorOverlay)
        assertTrue(medium.noteVisible)

        val open = adaptivePanels(WidthClass.COMPACT, false, true, sidebarOpen = false, drawerOpen = true, inspectorOpen = false, outlineEnabled = true)
        assertTrue(open.sidebarVisible)
        assertTrue(open.noteVisible)

        val focus = adaptivePanels(WidthClass.MEDIUM, true, true, true, true, true, true)
        assertFalse(focus.sidebarVisible)
        assertFalse(focus.inspectorOverlay)
        val other = adaptivePanels(WidthClass.EXPANDED, false, false, true, true, true, true)
        assertFalse(other.sidebarVisible)
        assertFalse(other.inspectorInline)
    }

    @Test
    fun drawerWidthIsCappedByTheWindow() {
        assertEquals(286, drawerWidthDp(800, 286))
        assertEquals(240, drawerWidthDp(800, 210))
        assertEquals(272, drawerWidthDp(320, 430))
        assertEquals(1, drawerWidthDp(0, 300))
    }

    @Test
    fun splitOrientationFollowsTheAvailableSpaceUnlessSet() {
        assertTrue(splitRowsFor("rows", 1400, 800))
        assertFalse(splitRowsFor("columns", 500, 900))
        assertFalse(splitRowsFor(null, 1100, 700))
        assertTrue(splitRowsFor(null, 700, 600))
        assertTrue(splitRowsFor(null, 800, 1100))
        assertFalse(splitRowsFor(null, 728, 600))
        assertFalse(splitRowsFor("", 1000, 700))
    }

    @Test
    fun draggedWidthsStayInsideTheSettingRange() {
        assertEquals(300, clampSidebarDp(300.7f))
        assertEquals(210, clampSidebarDp(-500f))
        assertEquals(430, clampSidebarDp(900f))
        assertEquals(220, clampPanelDp(10f))
        assertEquals(430, clampPanelDp(900f))
        assertEquals(sidebarWidthDp("300"), clampSidebarDp(300f))
        assertEquals(rightPanelWidthDp("300"), clampPanelDp(300f))
        assertEquals(16, panelHandleHitDp(false))
        assertTrue(panelHandleHitDp(true) > panelHandleHitDp(false))
        assertEquals(24, TouchMetrics(true).dividerLayoutDp)
        assertEquals(SPLIT_DIVIDER_DP, TouchMetrics(false).dividerLayoutDp)
    }
}
