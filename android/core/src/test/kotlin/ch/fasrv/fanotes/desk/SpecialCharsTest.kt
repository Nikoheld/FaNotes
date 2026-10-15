package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class SpecialCharsTest {
    @Test
    fun invisibleCharactersBecomeTheDesktopPlaceholder() {
        val note = "a\u200Bb\u0000\nc\t\u00ADd"
        val marks = specialCharMarks(note)
        assertEquals(listOf(1, 3, 7), marks.map { it.index })
        assertEquals("\u2022", marks[0].placeholder)
        assertEquals("\u2400", marks[1].placeholder)
        assertEquals("\u2022", marks[2].placeholder)
        assertEquals("\u2407", specialCharMarks("\u0007").single().placeholder)
        assertEquals("\u241B", specialCharMarks("\u001B").single().placeholder)
        assertTrue(specialCharMarks("Hallo\n\t").isEmpty())
        assertEquals(SPECIAL_CHAR_ARGB, 0xFFFF0000.toInt())
    }
}
