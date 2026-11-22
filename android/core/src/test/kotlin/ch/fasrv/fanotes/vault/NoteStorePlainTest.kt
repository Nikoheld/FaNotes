package ch.fasrv.fanotes.vault

import ch.fasrv.fanotes.famd.applyLineEnding
import ch.fasrv.fanotes.famd.detectLineEnding
import ch.fasrv.fanotes.famd.toLf
import ch.fasrv.fanotes.ink.StrokePoint
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class NoteStorePlainTest {
    @Test
    fun lineEndingHelpersFollowTheDesktop() {
        assertEquals("lf", detectLineEnding("a\nb\n"))
        assertEquals("crlf", detectLineEnding("a\r\nb\r\n"))
        assertEquals("lf", detectLineEnding("a\r\nb\nc\n"))
        assertEquals("a\nb\nc", toLf("a\r\nb\rc"))
        assertEquals("a\r\nb\r\n", applyLineEnding("a\nb\n", "crlf"))
        assertEquals("a\nb\n", applyLineEnding("a\nb\n", "lf"))
    }

    @Test
    fun aPlainNoteStaysAPlainFileAndKeepsItsCrlf() {
        val root = Files.createTempDirectory("fanotes-plain")
        val file = root.resolve("Inbox/CRLF.md")
        Files.createDirectories(file.parent)
        Files.write(file, "# Titel\r\nZeile\r\n".toByteArray())
        val store = NoteStore(DirectoryVault(root))
        val note = store.readNote("Inbox/CRLF.md")
        assertEquals("# Titel\nZeile", note.markdown.trimEnd())
        assertFalse(note.markdown.contains('\r'))
        store.save(note, note.document, note.markdown + "\nNeu")
        assertEquals("# Titel\r\nZeile\r\nNeu\r\n", String(Files.readAllBytes(file)))
        assertFalse(Files.exists(root.resolve("Inbox/CRLF.famd")))
        assertFalse(Files.exists(root.resolve(".fanotes/assets")))
    }

    @Test
    fun newNotesAreOnlyMarkdown() {
        val root = Files.createTempDirectory("fanotes-new")
        val store = NoteStore(DirectoryVault(root))
        val path = store.createMarkdown("", "Welcome")
        assertTrue(Files.exists(root.resolve(path)))
        assertFalse(Files.exists(root.resolve("Welcome.famd")))
        assertEquals("# Welcome\n\n", String(Files.readAllBytes(root.resolve(path))))
    }

    @Test
    fun inkStillCreatesTheSidecarAndAnExistingSidecarKeepsBeingUpdated() {
        val root = Files.createTempDirectory("fanotes-ink")
        val store = NoteStore(DirectoryVault(root))
        val path = store.createMarkdown("", "Zeichnung")
        val note = store.readNote(path)
        val session = ch.fasrv.fanotes.ink.InkSession(note.document)
        session.beginStroke()
        session.addSample(StrokePoint(0.2, 0.3, 1.0, 0.8, 1.0, 2.0, "pen"))
        session.addSample(StrokePoint(0.4, 0.35, 20.0, 0.4, 0.0, 0.0, "pen"))
        session.endStroke(ch.fasrv.fanotes.ink.StrokeStyle(color = "#2457d6"), "2026-04-01T00:00:00.000Z")
        val saved = store.save(note, session.document, note.markdown)
        assertTrue(Files.exists(root.resolve("Zeichnung.famd")))
        store.save(saved, saved.document, saved.markdown + "Mehr")
        assertTrue(String(Files.readAllBytes(root.resolve("Zeichnung.famd"))).contains("Mehr"))
        assertTrue(store.readNote(path).markdown.contains("Mehr"))
    }
}
