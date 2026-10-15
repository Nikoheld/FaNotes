package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class AccentColorTest {
    @Test
    fun accentsStayOnTheDesktopPaletteAndPickReadableText() {
        assertEquals("#2a6f97", normalizeAccent(null))
        assertEquals("#2a6f97", normalizeAccent("blue"))
        assertEquals("#d9730d", normalizeAccent("#D9730D"))
        assertEquals(null, parseAccent("#d97"))
        assertEquals(7, ACCENT_COLORS.size)
        assertTrue(ACCENT_COLORS.contains(DEFAULT_ACCENT))
        assertFalse(accentNeedsDarkText("#2a6f97"))
        assertTrue(accentNeedsDarkText("#d9730d"))
        assertTrue(accentNeedsDarkText("#ba9b4a"))
        assertTrue(accentNeedsDarkText("#ffffff"))
        assertEquals(ACCENT_LIGHT_INK, accentInk("#2a6f97"))
        assertEquals(ACCENT_DARK_INK, accentInk("#d9730d"))
        assertEquals(DEFAULT_ACCENT_SECONDARY, normalizeAccentSecondary(null))
        assertEquals("#9065b0", normalizeAccentSecondary("#9065B0"))
        assertEquals(DEFAULT_ACCENT_SECONDARY, normalizeAccentSecondary("nope"))
    }
}
