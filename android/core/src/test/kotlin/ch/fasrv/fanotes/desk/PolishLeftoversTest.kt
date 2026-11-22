package ch.fasrv.fanotes.desk

import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class PolishLeftoversTest {
    private val day = LocalDate.of(2026, 11, 22)

    @Test
    fun calendarLabelsFollowTheUiLanguage() {
        val before = ChromeText.language
        try {
            ChromeText.language = "de"
            assertEquals("Sonntag, 22. November 2026", calendarDayLabel(day))
            assertEquals("Sonntag, 22. November", calendarHeading("day", day))
            ChromeText.language = "en"
            assertEquals("Sunday, 22 November 2026", calendarDayLabel(day))
            assertEquals("Sunday, 22 November", calendarHeading("day", day))
            assertEquals("November 2026", calendarHeading("month", day))
        } finally {
            ChromeText.language = before
        }
    }

    @Test
    fun restoredTrailReachesNeighbouringTabs() {
        val trail = restoredNoteTrail(listOf("a.md", "b.md", "c.md"), "b.md")
        assertEquals(listOf("a.md", "c.md", "b.md"), trail.entries)
        assertTrue(canGoBack(trail))
        assertFalse(canGoForward(trail))
        assertFalse(canGoBack(restoredNoteTrail(listOf("a.md"), "a.md")))
    }

    @Test
    fun settingsDropTheCssSectionOnAndroid() {
        assertTrue(SETTINGS_NAV.none { it.id == "advanced" })
        assertTrue(SETTINGS_SEARCH_ITEMS.none { it.section == "advanced" })
        assertEquals("appearance", settingsSectionToOpen("advanced"))
    }
}
