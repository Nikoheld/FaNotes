package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ThemePaletteTest {
    @Test
    fun palettesMatchTheDesktopStylesheet() {
        assertEquals("#191919", themePalette(null, systemDark = true).background)
        assertEquals("#ffffff", themePalette("system", systemDark = false).background)
        assertEquals("#37352f", themePalette("light", systemDark = true).text)
        assertEquals("#17181b", themePalette("midnight", false).background)
        assertEquals("#171a18", themePalette("forest", false).background)
        assertEquals("#18181c", themePalette("aurora", false).background)
        assertEquals("#fbfaf7", themePalette("sepia", true).background)
        assertEquals("#f4f1ea", themePalette("sepia", true).surface)
        assertEquals("#ff8d90", themePalette("midnight", false).danger)
        assertEquals("#c03543", themePalette("sepia", false).danger)
        assertTrue(themePalette("forest", false).dark)
        assertFalse(themePalette("sepia", true).dark)
        assertEquals("light", themePalette("linen", systemDark = false).id)
        assertTrue(themeChoiceSelected(null, "system"))
        assertTrue(themeChoiceSelected("aurora", "aurora"))
        assertFalse(themeChoiceSelected("dark", "system"))
        assertEquals(7, THEME_CHOICES.size)
    }
}
