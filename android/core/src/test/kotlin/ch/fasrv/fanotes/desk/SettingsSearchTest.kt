package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class SettingsSearchTest {
    @Test
    fun settingsSearchMatchesEveryWordAndFoldsAccents() {
        assertEquals(emptyList(), searchSettings("   "))
        assertEquals("grosse", normalizeSettingsSearch("Größe"))
        assertEquals("grossen", normalizeSettingsSearch("Größen"))
        assertTrue(searchSettings("Größe").any { it.label == "Schriften & Textgrößen" })
        assertEquals("editor", searchSettings("zoom limit").single { it.label == "Zoom-Limit" }.section)
        assertEquals("experimental", searchSettings("Backup").single().section)
        assertEquals("drawing", searchSettings("Handschrift").single { it.label == "Papier & Stift" }.section)
        assertTrue(searchSettings("GlyphenWerk").isEmpty())
        assertTrue(searchSettings("OneNote").isEmpty())
        assertTrue(searchSettings("vim modus").isEmpty())
        assertTrue(searchSettings("keinbegriff xyz").isEmpty())
        assertTrue(SETTINGS_SEARCH_ITEMS.none { it.label.contains("GlyphenWerk") })
    }
}
