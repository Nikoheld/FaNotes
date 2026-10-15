package ch.fasrv.fanotes.vault

import ch.fasrv.fanotes.famd.noteInkId
import ch.fasrv.fanotes.famd.parseFamd
import ch.fasrv.fanotes.ink.StrokePoint
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class NoteStoreTest {
    @Test
    fun markdownAndInkSurviveAReload() {
        val root = Files.createTempDirectory("fanotes-vault")
        val vault = DirectoryVault(root)
        val store = NoteStore(vault)
        val path = store.createMarkdown("", "Lecture")
        val note = store.readNote(path)
        val session = ch.fasrv.fanotes.ink.InkSession(note.document)
        session.beginStroke()
        session.addSample(StrokePoint(0.2, 0.3, 1.0, 0.8, 1.0, 2.0, "pen"))
        session.addSample(StrokePoint(0.4, 0.35, 20.0, 0.4, 0.0, 0.0, "pen"))
        session.endStroke(ch.fasrv.fanotes.ink.StrokeStyle(color = "#2457d6"), "2026-04-01T00:00:00.000Z")
        store.save(note, session.document, "A line of text\n")
        val again = store.readNote(path)
        assertTrue(again.markdown.trim().startsWith("A line of text"))
        assertEquals(again.inkId, noteInkId(again.markdown))
        assertEquals(1, again.document.strokes.size)
        assertEquals("#2457d6", again.document.strokes[0].color)
        assertEquals(0.8, again.document.strokes[0].points[0].pressure)
        val famd = parseFamd(vault.read(path.replace(".md", ".famd"))!!.decodeToString())
        assertTrue(famd.markdown.trim().startsWith("A line of text"))
        assertTrue(vault.exists(".fanotes/assets/${again.inkId}.json"))
        val tree = store.tree()
        assertEquals(listOf("Lecture"), tree.map { it.name })
    }

    @Test
    fun deleteWorksheetRemovesItsImageAndRefusesAPathOutsideTheFolder() {
        val root = Files.createTempDirectory("fanotes-sheets")
        val vault = DirectoryVault(root)
        val store = NoteStore(vault)
        val png = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)
        val kept = store.storeImageWorksheet("Bleibt.png", png, "image/png")
        val dropped = store.storeImageWorksheet("Weg.png", png, "image/png")
        val record = ".fanotes/worksheets/${dropped.id}.json"
        val escaped = vault.read(record)!!.decodeToString().replace(
            ".fanotes/worksheets/${dropped.id}.png",
            "../keep.txt",
        )
        vault.write(record, escaped.encodeToByteArray())
        vault.write("keep.txt", byteArrayOf(9))
        store.deleteWorksheet(dropped.id)
        assertFalse(vault.exists(record))
        assertTrue(vault.exists(".fanotes/worksheets/${dropped.id}.png"))
        assertTrue(vault.exists("keep.txt"))
        assertTrue(vault.exists(".fanotes/worksheets/${kept.id}.png"))
        store.deleteWorksheet(kept.id)
        assertFalse(vault.exists(".fanotes/worksheets/${kept.id}.json"))
        assertFalse(vault.exists(".fanotes/worksheets/${kept.id}.png"))
    }

    @Test
    fun aPdfWorksheetNoteStoresTheDesktopPdfRecord() {
        val root = Files.createTempDirectory("fanotes-pdf-sheet")
        val store = NoteStore(DirectoryVault(root))
        val path = store.importWorksheetNote("", "Blatt.pdf", "%PDF-1.4".encodeToByteArray(), "application/pdf", "lines")
        val note = store.readNote(path)
        assertEquals("Blatt", note.title)
        assertEquals(listOf(note.worksheets.single()), note.worksheets)
        val record = DirectoryVault(root).read(".fanotes/worksheets/${note.worksheets.single()}.json")!!.decodeToString()
        assertTrue(record.contains("\"kind\":\"pdf\"") || record.contains("\"kind\": \"pdf\""))
        assertTrue(record.contains(".pdf"))
        assertEquals("lines", note.document.paperStyle)
    }
}
