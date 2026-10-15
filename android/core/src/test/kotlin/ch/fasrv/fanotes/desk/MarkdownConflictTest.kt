package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class MarkdownConflictTest {
    @Test
    fun bothKeepsRemoteAndAppendsNewLocalParagraphs() {
        val merged = resolveMarkdownConflict("A\n\nB\n", "B\n\nC\n", "both")
        assertEquals("A\n\nB\n\nC\n", merged)
        assertEquals("A\n\nB\n", resolveMarkdownConflict("A\r\n\r\nB\n", "C\n", "remote"))
        assertEquals("C\n", resolveMarkdownConflict("A\n", "C\n", "local"))
    }

    @Test
    fun folderColorsRoundTripInDesktopOrder() {
        val text = serializeFolderColors(mapOf("Schule" to "#2A6F97", "Arbeit" to "#c4554d"))
        val parsed = parseFolderColors(text)
        assertEquals("#2a6f97", parsed["Schule"])
        assertEquals("#c4554d", parsed["Arbeit"])
        assertEquals(mapOf("Schule" to "#337ea9"), withFolderColor(parsed, "Schule", "#337EA9").filterKeys { it == "Schule" })
        assertEquals(false, withFolderColor(parsed, "Schule", null).containsKey("Schule"))
        val moved = remapFolderColors(parsed, "Schule", "Archiv/Schule")
        assertEquals("#2a6f97", moved["Archiv/Schule"])
        assertEquals(false, moved.containsKey("Schule"))
        assertEquals("#c4554d", moved["Arbeit"])
        assertEquals(parsed, remapFolderColors(parsed, "Schule", "Schule"))
    }

    @Test
    fun theFolderMenuUsesTheDesktopSwatches() {
        assertEquals(10, FOLDER_COLOR_CHOICES.size)
        assertEquals("#6b7280", FOLDER_COLOR_CHOICES.first())
        assertEquals("#787774", FOLDER_COLOR_CHOICES.last())
        assertEquals("Darstellung", FOLDER_COLOR_MENU)
        assertEquals("Standardfarbe", FOLDER_COLOR_CLEAR)
        assertEquals("#11131a", accentInk("#ba9b4a"))
        assertEquals("#ffffff", accentInk("#2a6f97"))
        assertTrue(FOLDER_COLOR_CHOICES.all { accentInk(it) == "#11131a" || accentInk(it) == "#ffffff" })
        assertEquals(620, FOLDER_NAME_WEIGHT)
        assertEquals(mixColors("#c4554d", "#37352f", 0.54), folderNameInk("#C4554D", "#2a6f97", "#37352f"))
        assertEquals(mixColors("#2a6f97", "#ededec", 0.54), folderNameInk(null, "#2a6f97", "#ededec"))
        assertEquals(mixColors("#2a6f97", "#37352f", 0.54), folderNameInk("nope", "blue", "#37352f"))
    }
}
