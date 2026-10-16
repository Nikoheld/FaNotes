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
        assertEquals("geöffnet", paletteNoteMark(active = true, selected = true))
        assertEquals("geöffnet", paletteNoteMark(active = true, selected = false))
        assertEquals("⇧↵", paletteNoteMark(active = false, selected = true))
        assertEquals("", paletteNoteMark(active = false, selected = false))
        assertEquals(12, PALETTE_RADIUS_DP)
        assertEquals(620, PALETTE_MAX_DP)
        assertEquals(570, PALETTE_MAX_HEIGHT_DP)
        assertEquals(51, PALETTE_SEARCH_DP)
        assertEquals(15, PALETTE_SEARCH_SP)
        assertEquals(43, PALETTE_ROW_DP)
        assertEquals(40, PALETTE_NOTE_DP)
        assertEquals(29, PALETTE_ICON_DP)
        assertEquals(30, PALETTE_FOOTER_DP)
        assertEquals(0.1f, PALETTE_GROUP_TRACKING)
        assertEquals(0.13f, PALETTE_TOP_FRACTION)
        assertEquals(130, paletteTopDp(1000))
        assertEquals(104, paletteTopDp(800))
        assertEquals(0, paletteTopDp(0))
        assertEquals(0x590F0F0F, PALETTE_SCRIM)
    }

    @Test
    fun thePaletteShadowIsOffsetDownward() {
        assertEquals(0, PALETTE_SHADOW_X_DP)
        assertEquals(16, PALETTE_SHADOW_Y_DP)
        assertEquals(70, PALETTE_SHADOW_BLUR_DP)
        assertEquals(0.16f, PALETTE_SHADOW_ALPHA)
        val shadow = palettePanelShadow()
        assertEquals(0, shadow.xDp)
        assertEquals(16, shadow.yDp)
        assertEquals(70, shadow.blurDp)
        assertEquals(0.16f, shadow.alpha)
        assertTrue(shadow.yDp != 0)
        val reach = paletteShadowReach(shadow)
        assertEquals(70, reach.leftDp)
        assertEquals(54, reach.topDp)
        assertEquals(70, reach.rightDp)
        assertEquals(86, reach.bottomDp)
        assertEquals(reach.leftDp, reach.rightDp)
        assertTrue(reach.bottomDp > reach.topDp)
        val frame = checkNotNull(paletteShadowFrame(400f, 300f, 2f))
        assertEquals(140f, frame.blurPx)
        assertEquals(0f, frame.shapeLeftPx - frame.padPx)
        assertEquals(32f, frame.shapeTopPx - frame.padPx)
        assertTrue(frame.shapeTopPx - frame.padPx != 0f)
        assertEquals(0x29000000, frame.color)
        assertEquals(0x29000000, paletteShadowColor(0.16f))
        assertTrue(frame.shapeBottomPx + frame.blurPx < frame.bitmapHeightPx)
        assertTrue(paletteShadowFavorsDown(frame, 300f))
        val flat = frame.copy(shapeTopPx = frame.padPx, shapeBottomPx = frame.padPx + 300f)
        assertTrue(!paletteShadowFavorsDown(flat, 300f))
        assertTrue(paletteShadowFrame(0f, 300f, 2f) == null)
    }

    @Test
    fun commandsKeepTheDesktopGroupsDetailsAndSearchWords() {
        val commands = paletteCommands()
        assertEquals("Dateien", commands.first { it.id == "new-note" }.group)
        assertEquals("Ctrl N", commands.first { it.id == "new-note" }.shortcut)
        assertEquals("Markdown-Datei im Standardordner", commands.first { it.id == "new-note" }.detail)
        assertEquals("Unterordner anlegen", commands.first { it.id == "subfolder" }.label)
        assertTrue(paletteCommandMatches(commands.first { it.id == "import-pdf" }, "pdf viewer"))
        assertTrue(paletteCommandMatches(commands.first { it.id == "history" }, "version"))
        assertFalse(paletteCommandMatches(commands.first { it.id == "new-note" }, "kalender"))
        assertEquals("Zur Tastatur wechseln", paletteCommands(penOpen = true).first { it.id == "pen" }.label)
        assertEquals("Untereinander anordnen", paletteCommands(splitRows = false).first { it.id == "split-orient" }.label)
        assertEquals("Nebeneinander anordnen", paletteCommands(splitRows = true).first { it.id == "split-orient" }.label)
        assertEquals("Fokusmodus verlassen", paletteCommands(focus = true).first { it.id == "focus" }.label)
        assertEquals("Vorlagen", commands.first { it.id == "template-protocol" }.group)
        assertEquals("Vorlage: Protokoll", commands.first { it.id == "template-protocol" }.label)
        assertTrue(commands.any { it.id == "reveal" && it.group == "Dateien" })
        assertTrue(commands.any { it.id == "sync-settings" && it.label == "Sync einrichten" })
        assertEquals("Werkzeuge", commands.first { it.id == "text-hand" }.group)
        assertTrue(paletteCommandMatches(commands.first { it.id == "text-hand" }, "glyphenwerk"))
        val opener = commands.first { it.id == "quick-open" }
        assertEquals("Notiz öffnen …", opener.label)
        assertEquals("Navigation", opener.group)
        assertEquals("Ctrl O", opener.shortcut)
        assertEquals("Schnell zu einer Notiz springen", opener.detail)
        assertTrue(paletteCommandMatches(opener, "switcher"))
    }
}