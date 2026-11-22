package ch.fasrv.fanotes.vault

import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** A PDF belongs to one `.famd` only (desktop `companionPaths`); a same-name `.md` is another note. */
class NoteCompanionsTest {
    private val pdfBytes = byteArrayOf(0x25, 0x50, 0x44, 0x46, 0x2d)

    private fun vault(): Pair<DirectoryVault, NoteStore> {
        val directory = DirectoryVault(Files.createTempDirectory("fanotes-companions"))
        return directory to NoteStore(directory)
    }

    @Test
    fun importingAPdfNextToAMarkdownNoteOfTheSameNameDoesNotShareItsSidecar() {
        val (vault, store) = vault()
        val md = store.createMarkdown("", "Blatt")
        val famdBefore = vault.read("Blatt.famd")!!.decodeToString()
        val pdf = store.importUniquePdf("", "Blatt.pdf", pdfBytes)
        assertEquals("Blatt 2.pdf", pdf)
        assertEquals(famdBefore, vault.read("Blatt.famd")!!.decodeToString())
        assertTrue(vault.exists(md))
        assertFailsWith<IllegalStateException> { store.importPdf("", "Blatt.pdf", pdfBytes) }
    }

    @Test
    fun deletingAPdfKeepsASameNameMarkdownNote() {
        val (vault, store) = vault()
        val pdf = store.importPdf("", "Buch.pdf", pdfBytes)
        vault.write("Buch.md", "# Eigene Notiz\n".encodeToByteArray())
        store.delete(pdf)
        assertFalse(vault.exists("Buch.pdf"))
        assertFalse(vault.exists("Buch.famd"))
        assertTrue(vault.exists("Buch.md"))
    }

    @Test
    fun trashingAndMovingAPdfLeaveASameNameMarkdownNoteAlone() {
        val (vault, store) = vault()
        val pdf = store.importPdf("", "Buch.pdf", pdfBytes)
        vault.write("Buch.md", "# Eigene Notiz\n".encodeToByteArray())
        vault.mkdir("Ordner")
        store.moveEntry(pdf, "Ordner")
        assertTrue(vault.exists("Ordner/Buch.pdf"))
        assertTrue(vault.exists("Buch.md"))
        store.trashEntry("Ordner/Buch.pdf", "t1", "2026-11-22T10:00:00.000Z")
        assertTrue(vault.exists("Buch.md"))
    }

    @Test
    fun deletingADotMarkdownNoteKeepsASameNameMdNote() {
        val (vault, store) = vault()
        vault.write("Z.markdown", "a\n".encodeToByteArray())
        vault.write("Z.md", "b\n".encodeToByteArray())
        store.delete("Z.markdown")
        assertTrue(vault.exists("Z.md"))
    }
}

class WorksheetImportNameTest {
    private val png = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3)

    @Test
    fun aTakenNameLeavesNoWorksheetFileBehindAndNeverTakesAPdfSidecar() {
        val directory = DirectoryVault(Files.createTempDirectory("fanotes-sheet"))
        val store = NoteStore(directory)
        store.importWorksheetNote("", "Foto.png", png, "image/png")
        val before = directory.walkFiles().map { it.path }.toSet()
        assertFailsWith<IllegalStateException> { store.importWorksheetNote("", "Foto.png", png, "image/png") }
        assertEquals(before, directory.walkFiles().map { it.path }.toSet())
        store.importPdf("", "Blatt.pdf", byteArrayOf(0x25, 0x50, 0x44, 0x46, 0x2d))
        val famd = directory.read("Blatt.famd")!!.decodeToString()
        assertFailsWith<IllegalStateException> { store.importWorksheetNote("", "Blatt.png", png, "image/png") }
        assertEquals(famd, directory.read("Blatt.famd")!!.decodeToString())
    }
}
