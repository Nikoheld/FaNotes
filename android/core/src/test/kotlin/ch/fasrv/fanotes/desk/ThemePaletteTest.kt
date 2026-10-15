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
        assertEquals("#2f2f2f", themePalette("dark", true).panelStrong)
        assertEquals("#ffffff", themePalette("light", false).panelStrong)
        assertEquals("#2a2c31", themePalette("midnight", false).panelStrong)
        assertEquals("#2a2f2c", themePalette("forest", false).panelStrong)
        assertEquals("#2c2c33", themePalette("aurora", false).panelStrong)
        assertEquals("#fffdf8", themePalette("sepia", false).panelStrong)
        assertEquals("#5dcc78", themePalette("dark", true).success)
        assertEquals("#e7b34a", themePalette("dark", true).warning)
        assertEquals("#b3b3ae", themePalette("dark", true).muted)
        assertEquals("#1f7a48", themePalette("light", false).success)
        assertEquals("#8a5a12", themePalette("light", false).warning)
        assertEquals("#5e5c57", themePalette("light", false).muted)
        assertEquals("#b0b2b8", themePalette("midnight", false).muted)
        assertEquals("#aeb5b0", themePalette("forest", false).muted)
        assertEquals("#afafb7", themePalette("aurora", false).muted)
        assertEquals("#615c54", themePalette("sepia", false).muted)
        assertEquals("#cfcfca", themePalette("dark", true).soft)
        assertEquals("#4e4c47", themePalette("light", false).soft)
        assertEquals("#c8c9ce", themePalette("midnight", false).soft)
        assertEquals("#c6ccc8", themePalette("forest", false).soft)
        assertEquals("#c7c7ce", themePalette("aurora", false).soft)
        assertEquals("#514d46", themePalette("sepia", false).soft)
        assertEquals("#1f7a48", themePalette("sepia", false).success)
        assertTrue(themePalette("forest", false).dark)
        assertFalse(themePalette("sepia", true).dark)
        assertEquals("light", themePalette("linen", systemDark = false).id)
        assertTrue(themeChoiceSelected(null, "system"))
        assertTrue(themeChoiceSelected("aurora", "aurora"))
        assertFalse(themeChoiceSelected("dark", "system"))
        assertEquals(7, THEME_CHOICES.size)
    }
}
