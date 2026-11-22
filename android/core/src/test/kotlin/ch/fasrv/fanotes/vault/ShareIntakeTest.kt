package ch.fasrv.fanotes.vault

import ch.fasrv.fanotes.desk.NoteTextField
import ch.fasrv.fanotes.desk.parseNoteTextFields
import ch.fasrv.fanotes.desk.writeNoteTextFields
import ch.fasrv.fanotes.famd.FAMD_EXTENSION
import ch.fasrv.fanotes.famd.companionPath
import ch.fasrv.fanotes.famd.parseFamd
import ch.fasrv.fanotes.famd.serializeFamd
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ShareIntakeTest {
    @Test
    fun kindsFollowTheMimeTypeThenTheName() {
        assertEquals(IncomingKind.PDF, incomingKind("Blatt.pdf", "application/octet-stream"))
        assertEquals(IncomingKind.PDF, incomingKind(null, "application/pdf"))
        assertEquals(IncomingKind.IMAGE, incomingKind("IMG_1.HEIC", null))
        assertEquals(IncomingKind.IMAGE, incomingKind(null, "image/jpeg"))
        assertEquals(IncomingKind.MARKDOWN, incomingKind("notiz.md", "application/octet-stream"))
        assertEquals(IncomingKind.MARKDOWN, incomingKind(null, "text/plain; charset=utf-8"))
        assertEquals(IncomingKind.UNSUPPORTED, incomingKind("film.mp4", "video/mp4"))
    }

    @Test
    fun namesAreSafeAndCarryTheRightExtension() {
        assertEquals("Arbeitsblatt 3.pdf", incomingFileName("Downloads/Arbeitsblatt 3.pdf", "application/pdf", IncomingKind.PDF))
        assertEquals("Geteiltes PDF.pdf", incomingFileName(null, "application/pdf", IncomingKind.PDF))
        assertEquals("Geteiltes Bild 2.png", incomingFileName("", "image/png", IncomingKind.IMAGE, index = 1))
        assertEquals("Foto.jpg", incomingFileName("Foto.jpg", "image/jpeg", IncomingKind.IMAGE))
        assertEquals("Bericht.md", incomingFileName("Bericht.txt", "text/plain", IncomingKind.MARKDOWN))
        assertEquals("ab.pdf", incomingFileName("a<b>:.pdf", null, IncomingKind.PDF))
        assertEquals("Geteilte Notiz.md", incomingFileName("..", null, IncomingKind.MARKDOWN))
    }

    @Test
    fun sharedTextAndSummariesReadNaturally() {
        assertEquals("Zeile\nzwei", incomingMarkdownText("﻿Zeile\r\nzwei".encodeToByteArray()))
        assertEquals("Link" to "# Link\n\nhttps://example.org\n", sharedTextNote(" Link ", " https://example.org "))
        assertEquals("Geteilter Text", sharedTextNote(null, "x").first)
        assertEquals("1 Datei importiert.", incomingSummary(1, 0, 0))
        assertEquals("2 Dateien importiert. 1 nicht unterstützt (PDF, Bilder, Markdown). 1 zu gross.", incomingSummary(2, 1, 1))
    }

    @Test
    fun aSharedMarkdownFileBecomesANumberedNote() {
        val root = Files.createTempDirectory("fanotes-share")
        val store = NoteStore(DirectoryVault(root))
        val first = store.importMarkdownNote("Eingang", "Bericht.md", "# Bericht\n\nInhalt\n")
        val second = store.importMarkdownNote("Eingang", "Bericht.md", "")
        assertEquals("Eingang/Bericht.md", first)
        assertEquals("Eingang/Bericht 2.md", second)
        assertEquals("# Bericht\n\nInhalt\n", store.readNote(first).markdown.substringBefore("<!--").trimEnd() + "\n")
        assertTrue(store.readNote(second).markdown.startsWith("# Bericht 2"))
    }

    @Test
    fun aSaveMergesTextBoxesTheDesktopWroteMeanwhile() {
        val root = Files.createTempDirectory("fanotes-boxes")
        val vault = DirectoryVault(root)
        val store = NoteStore(vault)
        val path = store.createMarkdown("", "Boxen")
        val mine = NoteTextField("tf-mine", 1, 0.1, 0.1, 0.3, "von hier", 16, updatedAt = 1_000L)
        val opened = store.readNote(path)
        val withMine = opened.copy(payload = writeNoteTextFields(opened.payload, listOf(mine)))
        val saved = store.save(withMine, withMine.document, withMine.markdown, "2026-11-18T10:00:00.000Z", textFieldBase = emptyList())
        val base = parseNoteTextFields(saved.payload.array("textFields"))
        assertEquals(listOf("tf-mine"), base.map { it.id })

        // The desktop adds a box to the file (through sync) while the note stays open here.
        val famd = companionPath(path, FAMD_EXTENSION)
        val disk = parseFamd(vault.read(famd)!!.decodeToString())
        val desktopBox = NoteTextField("tf-desk", 1, 0.5, 0.5, 0.3, "vom Desktop", 16, updatedAt = 2_000L)
        vault.write(famd, serializeFamd(disk.markdown, writeNoteTextFields(disk.payload!!, base + desktopBox), "v1").encodeToByteArray())

        // This device edits its own box and saves: the desktop box stays.
        val edited = saved.copy(payload = writeNoteTextFields(saved.payload, listOf(mine.copy(text = "geändert", updatedAt = 3_000L))))
        val merged = store.save(edited, edited.document, edited.markdown, "2026-11-18T10:01:00.000Z", textFieldBase = base)
        val boxes = parseNoteTextFields(merged.payload.array("textFields"))
        assertEquals(listOf("tf-mine" to "geändert", "tf-desk" to "vom Desktop"), boxes.map { it.id to it.text })
        assertEquals(boxes, parseNoteTextFields(store.readNote(path).payload.array("textFields")))
    }
}

class IncomingUriGuardTest {
    private val own = setOf("ch.fasrv.fanotes.files")

    @kotlin.test.Test
    fun onlyForeignContentUrisAreRead() {
        kotlin.test.assertTrue(isAcceptableIncomingUri("content", "com.android.providers.media.documents", own))
        kotlin.test.assertFalse(isAcceptableIncomingUri("file", "", own))
        kotlin.test.assertFalse(isAcceptableIncomingUri(null, null, own))
        kotlin.test.assertFalse(isAcceptableIncomingUri("content", "ch.fasrv.fanotes.files", own))
        kotlin.test.assertFalse(isAcceptableIncomingUri("content", "CH.FASRV.FANOTES.FILES", own))
        kotlin.test.assertFalse(isAcceptableIncomingUri("content", "x@ch.fasrv.fanotes.files", own))
        kotlin.test.assertFalse(isAcceptableIncomingUri("content", null, own))
    }
}
