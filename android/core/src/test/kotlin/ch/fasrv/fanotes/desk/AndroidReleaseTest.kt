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
        assertEquals(before.markdown, field.markdown)
        assertEquals(before.notes, field.notes)
        assertFalse(field.markdown.contains("fanotes-text-field"))
        assertTrue(field.textFieldPlacing)
        assertFalse(field.linkPlacing)
        val disarmed = applyDesktopCommand(field, "text-field", extras)
        assertFalse(disarmed.textFieldPlacing)
        assertEquals(field.markdown, disarmed.markdown)
        val needsNote = applyDesktopCommand(before.copy(openPath = null), "text-field", extras)
        assertEquals(TEXT_FIELD_NEEDS_NOTE, needsNote.message)
        assertFalse(needsNote.textFieldPlacing)
        val syncSettings = applyDesktopCommand(before, "sync-settings", extras)
        assertEquals("sync", syncSettings.settingsSection)
        assertEquals("sync", settingsSectionToOpen(syncSettings.settingsSection))
        val settings = applyDesktopCommand(syncSettings, "settings", extras)
        assertNull(settings.settingsSection)
        assertEquals("appearance", settingsSectionToOpen(settings.settingsSection))
        assertEquals(applyDesktopCommand(before, "pen", extras).penOpen, applyDesktopCommand(before, "drawing", extras).penOpen)
        assertNotEquals(before.markdown, applyDesktopCommand(before, "toggle-task", extras).markdown)
        assertTrue(applyDesktopCommand(before, "copy-wiki-link", extras).clipboard.startsWith("[["))
    }

    @Test
    fun oneNoteSectionUsesTheDesktopConverter() {
        val fixture = oneNoteSectionBytes()
        val before = sampleDeskWork()
        val imported = applyDesktopCommand(
            before,
            "onenote-import",
            CommandExtras(onenoteBytes = fixture, onenoteName = "New Section 1.one"),
        )
        val digest = sha256Hex(fixture).take(24)
        val created = imported.notes.filter { note -> before.notes.none { it.path == note.path } }
        assertFalse(commandReportsUnavailable(imported.message), imported.message)
        assertNotEquals(ONE_NOTE_EMPTY, imported.message)
        assertTrue(
            created.any { note ->
                note.path.endsWith("Test Page.md") &&
                    note.markdown.contains("# Test Page") &&
                    note.markdown.contains("<!-- fanotes-onenote:$digest -->")
            },
            "message=${imported.message} notes=${created.joinToString { it.path }}",
        )
        assertTrue(created.none { it.path.endsWith("New Section 1.md") })

        val packed = ByteArrayOutputStream()
        ZipOutputStream(packed).use { zip ->
            zip.putNextEntry(ZipEntry("New Section 1.one"))
            zip.write(fixture)
            zip.closeEntry()
        }
        val zipBytes = packed.toByteArray()
        val fromZip = applyDesktopCommand(
            before,
            "onenote-import",
            CommandExtras(onenoteBytes = zipBytes, onenoteName = "Notebook.zip"),
        )
        val zipDigest = sha256Hex(zipBytes).take(24)
        val zipNotes = fromZip.notes.filter { note -> before.notes.none { it.path == note.path } }
        assertNotEquals(ONE_NOTE_EMPTY, fromZip.message)
        assertFalse(commandReportsUnavailable(fromZip.message), fromZip.message)
        assertTrue(
            zipNotes.any { note ->
                note.path.endsWith("Test Page.md") && note.markdown.contains("<!-- fanotes-onenote:$zipDigest -->")
            },
            "message=${fromZip.message} notes=${zipNotes.joinToString { it.path }}",
        )

        val broken = applyDesktopCommand(
            before,
            "onenote-import",
            CommandExtras(
                onenoteBytes = fixture,
                onenoteName = "New Section 1.one",
                one2htmlPath = "/bin/false",
                sevenZipPath = "/bin/false",
            ),
        )
        assertNotEquals(ONE_NOTE_EMPTY, broken.message)
        assertTrue(broken.message?.contains("beschädigt") == true, broken.message)
        assertEquals(before.notes, broken.notes)
    }

    @Test
    fun androidArm64OneNoteToolsAreThePinnedBionicBinaries() {
        val one2html = shippedArmTool("libone2html.so")
        val sevenZip = shippedArmTool("lib7za.so")
        assertAndroidArm64Tool(one2html, ONE2HTML_ANDROID_ARM64_SHA256)
        assertAndroidArm64Tool(sevenZip, SEVENZIP_ANDROID_ARM64_SHA256)
        assertNotEquals(ONE2HTML_SHA256, sha256Hex(Files.readAllBytes(one2html)))
        assertNotEquals(SEVENZIP_SHA256, sha256Hex(Files.readAllBytes(sevenZip)))
        val linuxOne = linuxOneNoteTool("one2html")
        val linuxZip = linuxOneNoteTool("7za")
        assertEquals(ONE2HTML_SHA256, sha256Hex(Files.readAllBytes(linuxOne)))
        assertEquals(SEVENZIP_SHA256, sha256Hex(Files.readAllBytes(linuxZip)))
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

    private fun oneNoteSectionBytes(): ByteArray {
        val candidates = listOf(
            Path.of("../../fanotes/scripts/fixtures/onenote/New Section 1.one"),
            Path.of("fanotes/scripts/fixtures/onenote/New Section 1.one"),
            Path.of("../fanotes/scripts/fixtures/onenote/New Section 1.one"),
        )
        val found = candidates.firstOrNull { Files.exists(it) }
            ?: error("OneNote fixture not found from ${Path.of("").toAbsolutePath()}")
        return Files.readAllBytes(found)
    }

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

    private fun shippedArmTool(name: String): Path {
        val candidates = listOf(
            Path.of("../app/src/main/jniLibs/arm64-v8a").resolve(name),
            Path.of("android/app/src/main/jniLibs/arm64-v8a").resolve(name),
            Path.of("../../android/app/src/main/jniLibs/arm64-v8a").resolve(name),
        )
        return candidates.firstOrNull { Files.isRegularFile(it) }
            ?: error("$name not found from ${Path.of("").toAbsolutePath()}")
    }

    private fun linuxOneNoteTool(name: String): Path {
        val candidates = listOf(
            Path.of("../../fanotes/resources/onenote/linux").resolve(name),
            Path.of("fanotes/resources/onenote/linux").resolve(name),
            Path.of("../fanotes/resources/onenote/linux").resolve(name),
        )
        return candidates.firstOrNull { Files.isRegularFile(it) }
            ?: error("$name not found from ${Path.of("").toAbsolutePath()}")
    }

    private fun assertAndroidArm64Tool(path: Path, expectedHash: String) {
        val bytes = Files.readAllBytes(path)
        assertEquals(expectedHash, sha256Hex(bytes), path.toString())
        assertEquals(0x7f, bytes[0].toInt() and 0xff)
        assertEquals('E'.code, bytes[1].toInt() and 0xff)
        assertEquals('L'.code, bytes[2].toInt() and 0xff)
        assertEquals('F'.code, bytes[3].toInt() and 0xff)
        assertEquals(2, bytes[4].toInt() and 0xff)
        assertEquals(1, bytes[5].toInt() and 0xff)
        val machine = (bytes[18].toInt() and 0xff) or ((bytes[19].toInt() and 0xff) shl 8)
        assertEquals(183, machine)
        val interpreter = elfInterpreter(bytes)
        assertTrue(interpreter.contains("linker64"), interpreter)
        assertFalse(interpreter.contains("ld-linux"), interpreter)
        val text = String(bytes, Charsets.ISO_8859_1)
        assertFalse(text.contains("ld-linux-x86-64"))
        assertFalse(text.contains("libc++_shared.so"))
    }

    private fun elfInterpreter(bytes: ByteArray): String {
        fun u16(offset: Int): Int =
            (bytes[offset].toInt() and 0xff) or ((bytes[offset + 1].toInt() and 0xff) shl 8)
        fun u64(offset: Int): Long {
            var value = 0L
            for (index in 0 until 8) {
                value = value or ((bytes[offset + index].toLong() and 0xff) shl (8 * index))
            }
            return value
        }
        val phoff = u64(32).toInt()
        val phentsize = u16(54)
        val phnum = u16(56)
        for (index in 0 until phnum) {
            val offset = phoff + index * phentsize
            val type = u64(offset).toInt()
            if (type != 3) continue
            val fileOffset = u64(offset + 8).toInt()
            val fileSize = u64(offset + 32).toInt()
            return bytes.copyOfRange(fileOffset, fileOffset + fileSize).toString(Charsets.UTF_8).trimEnd('\u0000')
        }
        error("PT_INTERP missing")
    }
}
