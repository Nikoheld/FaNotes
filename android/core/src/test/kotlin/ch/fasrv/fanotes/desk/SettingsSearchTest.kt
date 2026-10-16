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
        assertEquals("settings-zoom", searchSettings("zoom limit").single { it.label == "Zoom-Limit" }.target)
        assertEquals("settings-typography", searchSettings("Größe").single { it.label == "Schriften & Textgrößen" }.target)
        assertEquals("settings-note-backup", searchSettings("Backup").single().target)
        assertEquals("experimental", searchSettings("Backup").single().section)
        assertEquals("drawing", searchSettings("Handschrift").single { it.label == "Papier & Stift" }.section)
        assertTrue(searchSettings("GlyphenWerk").isEmpty())
        assertTrue(searchSettings("OneNote").isEmpty())
        assertTrue(searchSettings("vim modus").isEmpty())
        assertTrue(searchSettings("keinbegriff xyz").isEmpty())
        assertTrue(SETTINGS_SEARCH_ITEMS.none { it.label.contains("GlyphenWerk") })
        assertEquals(listOf("Aussehen & Schreiben", "Stift & Arbeitsbereich", "FaNotes & System"), settingsNavGroups().map { it.first })
        assertEquals("Darstellung", settingsNavGroups().first().second.first().label)
        assertEquals("Farben, Schriften und Dichte", SETTINGS_NAV.first { it.id == "appearance" }.detail)
        assertEquals("Stift & Erkennung", SETTINGS_NAV.first { it.id == "drawing" }.label)
        assertEquals("Dateien & Vault", SETTINGS_NAV.first { it.id == "files" }.label)
        assertEquals(43, SETTINGS_NAV_ROW_DP)
        assertEquals(9, SETTINGS_NAV_RADIUS_DP)
        assertEquals(650, SETTINGS_NAV_LABEL_WEIGHT)
        assertEquals(750, SETTINGS_NAV_GROUP_WEIGHT)
        assertEquals(0.08f, SETTINGS_NAV_GROUP_TRACKING)
    }
}
