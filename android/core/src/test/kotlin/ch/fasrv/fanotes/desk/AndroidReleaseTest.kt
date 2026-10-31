package ch.fasrv.fanotes.desk

import java.io.ByteArrayOutputStream
import java.nio.file.Files
import java.nio.file.Path
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class AndroidReleaseTest {
    @Test
    fun englishFollowsTheDesktopCatalogAndLeavesNoteTextAlone() {
        val catalog = loadEnglishCatalogResource()
        assertTrue(catalog.size > 1000, "desktop en.json did not load")
        assertEquals("Add tag", translateChrome("Tag hinzufügen", "en", catalog))
        assertEquals("Keyboard", translateChrome("Tastatur", "en", catalog))
        assertEquals("Pen", translateChrome("Stift", "en", catalog))
        assertEquals("Dotted", translateChrome("Gepunktet", "en", catalog))
        assertEquals("Settings", translateChrome("Einstellungen", "en", catalog))
        assertEquals("New note", translateChrome("Neue Notiz", "en", catalog))
        assertEquals("Language", translateChrome("Sprache", "en", catalog))
        assertEquals("German", translateChrome("Deutsch", "en", catalog))
        assertEquals("Interface", translateChrome("Oberfläche", "en", catalog))
        assertEquals("Tag hinzufügen", translateChrome("Tag hinzufügen", "de", catalog))
        assertEquals("Im Text suchen …", translateChrome("Im Text suchen …", "en", catalog))
        assertEquals("Tag hinzufügen", presentNoteText("Tag hinzufügen"))
        assertEquals("en", resolveUiLanguage("en", listOf("de-CH", "de")))
        assertEquals("de", resolveUiLanguage("de", listOf("en-US")))
        assertEquals("de", resolveUiLanguage("system", listOf("en-US", "de-DE")))
        assertEquals("en", resolveUiLanguage("system", listOf("en-US", "fr-FR")))
        assertEquals("en", resolveUiLanguage(null, listOf("en")))
        assertEquals("English", statusBarLanguage("en", "en", catalog))
        assertEquals("Deutsch", statusBarLanguage("de", "de", catalog))
    }

    @Test
    fun aNoteKeepsOneToolbarAndOneStatusCenterOnATablet() {
        val rows = permanentRowsAboveCanvas()
        assertEquals(listOf("ribbon", "tabs", "toolbar"), rows)
        assertFalse(rows.any { it in retiredEditorRows() })
        assertFalse("tags" in rows || "paper" in rows || "search" in rows)
        val (width, height, dpi) = galaxyTabS6LiteFrame()
        assertTrue(isTabletFrame(width, height, dpi))
        assertTrue(editorSideInsetDp(width, height, dpi) > 0)
        val canvas = canvasHeightPx(width, height, dpi)
        val density = dpi / 160f
        val retired = retiredEditorRows().size * 48 * density
        assertTrue(canvas > height - ((rows.sumOf { chromeRowHeightDp(it) } + STATUS_BAR_DP) * density) - 1)
        assertTrue(canvas + retired > height - (rows.sumOf { chromeRowHeightDp(it) } + STATUS_BAR_DP) * density)
        assertEquals(statusLabelCenterDp(), statusLabelCenterDp())
        val centers = listOf("Leiste", "English", "Synchron", "Lokal & privat").map { statusLabelCenterDp() }
        assertEquals(1, centers.distinct().size)
        assertEquals(statusItemTopDp(), statusItemTopDp(STATUS_BUTTON_DP))
        assertEquals(listOf("mode", "text", "end"), editorToolbarSlots(textMode = true, pdfNote = false))
        assertEquals(listOf("mode", "ink", "end"), editorToolbarSlots(textMode = false, pdfNote = false))
        assertEquals(listOf("mode", "pdf", "end"), editorToolbarSlots(textMode = true, pdfNote = true))
        assertTrue("paper" in toolbarEndSlots(textMode = true, pdfNote = false))
        assertFalse("paper" in toolbarEndSlots(textMode = false, pdfNote = false))
        assertFalse("paper" in toolbarEndSlots(textMode = true, pdfNote = true))
        assertTrue(toolbarEndSlots(textMode = true, pdfNote = false).containsAll(listOf("tags", "search", "backup", "links")))
    }

    @Test
    fun committedInkStaysSharpAndAMoveSkipsUntouchedTiles() {
        val displayed = 3.4f
        val raster = committedRasterScale(displayed)
        assertTrue(raster >= displayed)
        assertTrue(raster > 1.75f)
        assertEquals(raster, nextCacheScale(0f, displayed))
        assertEquals(raster, nextCacheScale(1.75f, displayed))
        assertEquals(raster + 1f, nextCacheScale(raster + 1f, displayed))
        val side = tileBitmapSide(192, raster)
        assertTrue(side >= 192 * displayed)
        assertTrue(COMMITTED_INK_ANTIALIAS)
        assertFalse(inkMoveAllocatesFullPage)
        val touched = PageTile(0, 0)
        val untouched = PageTile(800, 800)
        val stroke = TileRect(10f, 10f, 40f, 40f)
        val rebuild = tilesToRebuild(listOf(touched, untouched), stroke, 192)
        assertEquals(setOf(touched), rebuild)
        assertFalse(untouched in rebuild)
    }

    @Test
    fun thePenRingFollowsTheStylusUntilItLeaves() {
        val hover = StylusSample(StylusPhase.HOVER, 10f, 12f)
        val down = StylusSample(StylusPhase.DOWN, 20f, 22f)
        val move = StylusSample(StylusPhase.MOVE, 30f, 32f)
        val up = StylusSample(StylusPhase.UP, 30f, 32f)
        val again = StylusSample(StylusPhase.HOVER, 40f, 42f)
        val leave = StylusSample(StylusPhase.LEAVE, 40f, 42f)
        assertEquals(PenRing(10f, 12f), penRing(listOf(hover)))
        assertEquals(PenRing(30f, 32f), penRing(listOf(hover, down, move)))
        assertEquals(PenRing(30f, 32f), penRing(listOf(hover, down, move, up)))
        assertEquals(PenRing(40f, 42f), penRing(listOf(hover, down, move, up, again)))
        assertNull(penRing(listOf(hover, down, move, up, again, leave)))
        val finger = StylusSample(StylusPhase.MOVE, 1f, 1f, stylus = false)
        assertEquals(PenRing(30f, 32f), penRing(listOf(move, finger)))
    }

    @Test
    fun aStylusMovesTheSliderWhileAFingerIsAlreadyDown() {
        val finger = SliderPointer(0, PointerKind.FINGER, down = true, fraction = 0.1f)
        val stylus = SliderPointer(1, PointerKind.STYLUS, down = true, fraction = 0.75f)
        val value = sliderValueFromPointers(1.2f, 14f, listOf(finger, stylus))
        assertEquals(1.2f + (14f - 1.2f) * 0.75f, value!!, 0.001f)
        assertEquals(1.2f + (14f - 1.2f) * 0.1f, sliderValueFromPointers(1.2f, 14f, listOf(finger))!!, 0.001f)
    }

    @Test
    fun darkThemesPaintTheWindowInsteadOfTheLightLaunchColors() {
        for (theme in listOf("dark", "midnight", "forest", "aurora")) {
            val chrome = windowChrome(theme, systemDark = false)
            assertFalse(windowChromeUsesLightLaunch(chrome), theme)
            assertTrue(chrome.dark)
            assertEquals(themePalette(theme, false).text, brandMarkColor(theme, false))
            assertEquals(themePalette(theme, false).background, chrome.window)
            assertEquals(themePalette(theme, false).background, chrome.statusBar)
            assertEquals(themePalette(theme, false).surface, chrome.navigationBar)
        }
        val system = windowChrome("system", systemDark = true)
        assertFalse(windowChromeUsesLightLaunch(system))
        assertEquals(brandMarkColor("dark", true), brandMarkColor("system", true))
    }

    @Test
    fun cancellationNeverBecomesAToast() {
        assertNull(userVisibleToast("StandaloneCoroutine was cancelled"))
        assertNull(userVisibleToast("Job was canceled"))
        assertNull(userVisibleFailure(kotlinx.coroutines.CancellationException("StandaloneCoroutine was cancelled"), "Speichern fehlgeschlagen."))
        assertEquals("Speichern fehlgeschlagen.", userVisibleFailure(IllegalStateException("Speichern fehlgeschlagen."), "andere"))
        assertEquals("Die Notiz konnte nicht geöffnet werden.", userVisibleFailure(IllegalStateException(), "Die Notiz konnte nicht geöffnet werden."))
        assertEquals("Netzwerk", userVisibleToast("Netzwerk"))
    }

    @Test
    fun everyDesktopCommandReachesTheSameNoteOutcome() {
        val source = desktopCommandsSource()
        val ids = Regex("""id:\s*'([^']+)'""")
            .findAll(source)
            .map { it.groupValues[1] }
            .distinct()
            .filterNot { it == "quit" || it.startsWith("addon:") }
            .toList()
        assertTrue(ids.size >= 40, "parsed ${ids.size} command ids")
        val palette = paletteCommands().map { it.id }.toSet()
        val extras = CommandExtras(
            pdfName = "Kapitel.pdf",
            onenoteBytes = oneNoteZip(),
            glyphBytes = glyphLine().toByteArray(Charsets.UTF_8),
            addonManifest = """{"id":"margin-notes","name":"Margin Notes","version":"1.2.0","api":1}""",
        )
        val before = sampleDeskWork()
        for (id in ids) {
            assertTrue(id in palette || normalizeDesktopCommand(id) in palette || id in paletteCommands(penOpen = true).map { it.id }, id)
            val after = applyDesktopCommand(before, id, extras)
            assertNotEquals(before, after, id)
            assertFalse(commandReportsUnavailable(after.message), "$id -> ${after.message}")
        }
        val latex = applyDesktopCommand(before, "export-latex", extras)
        assertTrue(latex.exports.single().text.contains("\\documentclass{article}"))
        assertTrue(latex.exports.single().text.contains("\\end{document}"))
        val onenote = applyDesktopCommand(before, "onenote-import", extras)
        assertTrue(onenote.notes.any { it.markdown.contains("<!-- fanotes-onenote:") })
        val empty = applyDesktopCommand(before, "onenote-import", extras.copy(onenoteBytes = "not html".toByteArray()))
        assertEquals(ONE_NOTE_EMPTY, empty.message)
        val picker = applyDesktopCommand(before, "onenote-import", extras.copy(onenoteBytes = null))
        assertEquals("onenote-picker", picker.platform)
        val glyphs = applyDesktopCommand(before, "glyphenwerk", extras)
        assertTrue(glyphs.glyphLabels.contains("q"))
        assertTrue("glyphenwerk" in glyphs.overlays)
        val addon = applyDesktopCommand(before, "addon-store", extras)
        assertEquals("margin-notes", addon.installedAddons.single().id)
        val field = applyDesktopCommand(before, "text-field", extras)
        assertTrue(field.markdown.contains(TEXT_FIELD_MARKER))
        assertTrue(field.textFieldPlacing)
        assertEquals(applyDesktopCommand(before, "pen", extras).penOpen, applyDesktopCommand(before, "drawing", extras).penOpen)
        assertNotEquals(before.markdown, applyDesktopCommand(before, "toggle-task", extras).markdown)
        assertTrue(applyDesktopCommand(before, "copy-wiki-link", extras).clipboard.startsWith("[["))
    }

    private fun desktopCommandsSource(): String {
        val candidates = listOf(
            Path.of("../../fanotes/src/App.tsx"),
            Path.of("fanotes/src/App.tsx"),
            Path.of("../fanotes/src/App.tsx"),
        )
        val found = candidates.firstOrNull { Files.exists(it) }
            ?: error("App.tsx not found from ${Path.of("").toAbsolutePath()}")
        return Files.readString(found)
    }

    private fun glyphLine(): String =
        """{"label_id":"custom-q","unicode":"q","strokes":[{"points":[{"x":0.2,"y":0.3,"pressure":0.4},{"x":0.6,"y":0.8}],"baseWidth":2.5}],"bbox_normalized":[0.2,0.3,0.4,0.5],"source_canvas":{"width":200,"height":80}}"""

    private fun oneNoteZip(): ByteArray {
        val html = "<html><head><title>Vorlesung</title></head><body><p>Seite</p></body></html>"
        val buffer = ByteArrayOutputStream()
        ZipOutputStream(buffer).use { zip ->
            zip.putNextEntry(ZipEntry("Vorlesung.html"))
            zip.write(html.toByteArray())
            zip.closeEntry()
        }
        return buffer.toByteArray()
    }
}
