package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class SearchKeysTest {
    @Test
    fun arrowsWalkTheSearchHitsAndReturnToTheField() {
        assertEquals(0, searchResultMove(-1, 3, true))
        assertEquals(-1, searchResultMove(-1, 3, false))
        assertEquals(1, searchResultMove(0, 3, true))
        assertEquals(-1, searchResultMove(0, 3, false))
        assertEquals(0, searchResultMove(2, 3, true))
        assertEquals(1, searchResultMove(2, 3, false))
        assertEquals(-1, searchResultMove(0, 0, true))
        assertEquals(14, SEARCH_TITLE_SP)
        assertEquals("IM GESAMTEN VAULT", SEARCH_EYEBROW)
        assertEquals("Finde alles wieder", SEARCH_EMPTY_TITLE)
        assertEquals(70, SEARCH_RESULT_MIN_DP)
        assertEquals(7, SEARCH_RESULT_RADIUS_DP)
        assertEquals(9, SEARCH_RESULT_PAD_DP)
        assertEquals(6, SEARCH_RESULT_GAP_DP)
        assertEquals(8, SEARCH_BADGE_RADIUS_DP)
        assertEquals(5, SEARCH_BADGE_PAD_X_DP)
        assertEquals(2, SEARCH_BADGE_PAD_Y_DP)
        assertEquals(20, SEARCH_PATH_INSET_DP)
        assertEquals(50, SEARCH_EMPTY_PAD_TOP_DP)
        assertEquals(34, SEARCH_FOOTER_DP)
        assertEquals(0.09f, SEARCH_RULE_ALPHA)
        assertEquals("Suche schließen", SEARCH_CLOSE)
        assertEquals("Text, Dateinamen, Handschrift …", SEARCH_PLACEHOLDER)
        assertEquals("Ergebnis wählen", SEARCH_CHOOSE)
        assertEquals(5, SEARCH_KBD_RADIUS_DP)
    }

    @Test
    fun thePanelFloatsOverTheSidebar() {
        assertEquals(286, searchPanelWidthDp(null))
        assertEquals(sidebarWidthDp("320"), searchPanelWidthDp("320"))
        assertEquals(210, searchPanelWidthDp("40"))
        assertEquals(430, searchPanelWidthDp("900"))
        assertEquals(16, SEARCH_SHADOW_X_DP)
        assertEquals(32, SEARCH_SHADOW_BLUR_DP)
        assertEquals(0.14f, SEARCH_SHADOW_ALPHA)
        assertTrue(workspaceKeepsNoteChrome("search"))
    }

    @Test
    fun theSearchPanelShadowIsOffsetToTheRight() {
        val shadow = searchPanelShadow()
        assertEquals(16, shadow.xDp)
        assertEquals(0, shadow.yDp)
        assertEquals(32, shadow.blurDp)
        assertEquals(0.14f, shadow.alpha)
        assertTrue(shadow.xDp != 0)
        val reach = searchShadowReach(shadow)
        assertEquals(16, reach.leftDp)
        assertEquals(32, reach.topDp)
        assertEquals(48, reach.rightDp)
        assertEquals(32, reach.bottomDp)
        assertTrue(reach.rightDp > reach.leftDp)
        val frame = checkNotNull(searchShadowFrame(400f, 900f, 2f))
        assertEquals(64f, frame.blurPx)
        assertEquals(32f, frame.shapeLeftPx - frame.padPx)
        assertEquals(0f, frame.shapeTopPx - frame.padPx)
        assertEquals(0x24000000, frame.color)
        assertEquals(0x24000000, searchShadowColor(0.14f))
        assertTrue(frame.shapeRightPx + frame.blurPx < frame.bitmapWidthPx)
        assertTrue(searchShadowFavorsRight(frame, 400f))
        val centered = frame.copy(shapeLeftPx = frame.padPx, shapeRightPx = frame.padPx + 400f)
        assertTrue(!searchShadowFavorsRight(centered, 400f))
    }
}