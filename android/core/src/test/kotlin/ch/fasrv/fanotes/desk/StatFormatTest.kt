package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class StatFormatTest {
    @Test
    fun upcomingDatesFollowTheUiLanguage() {
        assertEquals("Mon, Nov 16", statDateLabel("2026-11-16", "en"))
        assertEquals("Fri, Dec 4", statDateLabel("2026-12-04", "en"))
        val german = statDateLabel("2026-11-16", "de")
        assertTrue(german.startsWith("Mo") && german.contains("16.") && german.contains("Nov"), german)
        assertTrue(!german.contains("Mon"), german)
    }

    @Test
    fun textThatIsNotADateComesBackUnchanged() {
        assertEquals("nächste Woche", statDateLabel("nächste Woche", "en"))
        assertEquals("", statDateLabel("", "de"))
    }

    @Test
    fun numbersUseTheSeparatorOfTheUiLanguage() {
        assertEquals("1,234", statCount(1234, "en"))
        assertEquals("1,234,567", statCount(1234567, "en"))
        assertEquals("1’234", statCount(1234, "de"))
        assertEquals("1’234’567", statCount(1234567, "de"))
        assertEquals("12", statCount(12, "en"))
        assertEquals("0", statCount(0, "de"))
    }
}
