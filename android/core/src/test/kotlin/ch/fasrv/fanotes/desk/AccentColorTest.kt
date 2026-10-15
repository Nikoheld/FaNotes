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
        assertEquals("#2a6f97", paperAccentReadable("#2a6f97"))
        assertEquals("#707175", ensureReadableColor("#eeeeee", PAPER_CONTRAST_SURFACES))
        assertEquals("#846f3b", paperAccentReadable("#ba9b4a"))
        assertEquals("#ab5d10", paperAccentReadable("#d9730d"))
        assertEquals("#707176", ensureReadableColor("#ffffff", PAPER_CONTRAST_SURFACES))
        assertEquals(0xFF2A6F97.toInt(), paperAccentReadableArgb(0xFF2A6F97.toInt()))
        assertEquals(0xFF846F3B.toInt(), paperAccentReadableArgb(0xFFBA9B4A.toInt()))
        assertEquals("#fafbfc", paperTableFill("#2a6f97"))
        assertEquals("#295f80", paperCodeInk("#2a6f97"))
        assertEquals("#6f5f39", paperCodeInk("#ba9b4a"))
        assertEquals("#8e5117", paperCodeInk("#d9730d"))
        assertEquals(0xFF295F80.toInt(), paperCodeInkArgb(0xFF2A6F97.toInt()))
        val readable = paperAccentReadableArgb(0xFF2A6F97.toInt())
        val underline = paperLinkUnderlineArgb(readable)
        assertEquals(readable and 0x00FFFFFF, underline and 0x00FFFFFF)
        assertEquals(kotlin.math.round(255 * 0.38).toInt(), underline ushr 24)
        assertEquals(3f, paperLinkUnderlineOffset(16f))
        assertEquals(6f, paperLinkUnderlineOffset(32f))
        assertEquals(750, PAPER_STRONG_WEIGHT)
    }
}
