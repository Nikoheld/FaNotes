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
    }
}