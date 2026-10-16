package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals

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
}