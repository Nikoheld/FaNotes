package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class PaletteKeysTest {
    @Test
    fun arrowsStayInsideThePaletteList() {
        assertEquals(1, paletteMove(0, 5, 1))
        assertEquals(4, paletteMove(4, 5, 1))
        assertEquals(0, paletteMove(0, 5, -1))
        assertEquals(4, paletteMove(0, 5, 8))
        assertEquals(0, paletteMove(3, 5, -8))
        assertEquals(0, paletteMove(2, 0, 1))
        assertTrue(paletteOpensInSplit("note", true))
        assertFalse(paletteOpensInSplit("note", false))
        assertFalse(paletteOpensInSplit("command", true))
    }
}