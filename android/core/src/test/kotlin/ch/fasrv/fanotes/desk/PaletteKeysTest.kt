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
        val opener = commands.first { it.id == "quick-open" }
        assertEquals("Notiz öffnen …", opener.label)
        assertEquals("Navigation", opener.group)
        assertEquals("Ctrl O", opener.shortcut)
        assertEquals("Schnell zu einer Notiz springen", opener.detail)
        assertTrue(paletteCommandMatches(opener, "switcher"))
    }
}