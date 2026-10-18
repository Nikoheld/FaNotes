package ch.fasrv.fanotes.vault

import ch.fasrv.fanotes.desk.NoteLinkMark
import ch.fasrv.fanotes.desk.dropFolderColors
import ch.fasrv.fanotes.desk.noteLinksJson
import ch.fasrv.fanotes.desk.parseNoteLinkMarks
import ch.fasrv.fanotes.famd.safeWorksheetSource
import ch.fasrv.fanotes.famd.worksheetIdsFromMarkdown
import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.deepCopy
import ch.fasrv.fanotes.json.parseJson
import ch.fasrv.fanotes.ink.StrokePoint
import java.nio.file.Files
import java.time.LocalDate
import java.time.LocalTime
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class NoteTrashTest {
    @Test
    fun trashingANoteHidesItAndRestoreBringsTheInkBack() {
        val (vault, store) = vault("fanotes-trash")
        val path = store.createMarkdown("Math", "Algebra")
        val note = store.readNote(path)
        val session = ch.fasrv.fanotes.ink.InkSession(note.document)
        session.beginStroke()
        session.addSample(StrokePoint(0.2, 0.3, 1.0, 0.8, 0.0, 0.0, "pen"))
        session.endStroke(ch.fasrv.fanotes.ink.StrokeStyle(color = "#2457d6"), "2026-10-16T12:00:00.000Z")
        store.save(note, session.document, "Eine Zeile\n")
        val inkId = store.readNote(path).inkId
        val item = store.trashEntry(path, "note-1", "2026-10-16T12:00:00.000Z")
        assertEquals("Algebra", item.name)
        assertEquals(listOf("note-1"), store.listTrash().map { it.id })
        assertFalse(vault.exists(path))
        assertFalse(vault.exists(".fanotes/assets/$inkId.json"))
        assertTrue(vault.exists(".fanotes/trash/note-1/$path"))
        assertTrue(noteNames(store).none { it == "Algebra" })
        val restored = store.restoreTrash("note-1")
        assertEquals(path, restored)
        val again = store.readNote(restored)
        assertTrue(again.markdown.contains("Eine Zeile"))
        assertEquals(inkId, again.inkId)
        assertEquals("#2457d6", again.document.strokes.single().color)
        assertTrue(vault.exists(".fanotes/assets/$inkId.json"))
        assertTrue(store.listTrash().isEmpty())
    }

    @Test
    fun aTakenNameComesBackBesideTheNewNote() {
        val (_, store) = vault("fanotes-trash-clash")
        val path = store.createMarkdown("", "Lecture")
        store.trashEntry(path, "note-2", "2026-10-16T12:00:00.000Z")
        store.createMarkdown("", "Lecture")
        val restored = store.restoreTrash("note-2")
        assertEquals("Lecture 2.md", restored)
        assertEquals(listOf("Lecture", "Lecture 2"), store.tree().map { it.name }.sorted())
    }

    @Test
    fun aFolderRoundTripsAndEmptyingRemovesIt() {
        val (vault, store) = vault("fanotes-trash-folder")
        store.createFolder("", "Schule")
        store.createMarkdown("Schule", "Aufgabe")
        store.trashEntry("Schule", "folder-1", "2026-10-16T12:00:00.000Z")
        assertTrue(store.tree().none { it.name == "Schule" })
        assertFalse(vault.exists("Schule/Aufgabe.md"))
        store.restoreTrash("folder-1")
        assertEquals(listOf("Aufgabe"), store.tree().single { it.name == "Schule" }.children.map { it.name })
        store.trashEntry("Schule", "folder-2", "2026-10-16T12:05:00.000Z")
        store.emptyTrash()
        assertTrue(store.listTrash().isEmpty())
        assertTrue(store.tree().none { it.name == "Schule" })
        assertFalse(vault.exists("Schule/Aufgabe.md"))
        store.purgeTrash("missing")
        assertFailsWith<IllegalArgumentException> { store.restoreTrash("folder-2") }
    }

    @Test
    fun aCopyKeepsTheTextAndGetsItsOwnInkAndWorksheet() {
        val (vault, store) = vault("fanotes-copy")
        val png = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)
        val path = store.importWorksheetNote("", "Blatt.png", png, "image/png")
        val note = store.readNote(path)
        val session = ch.fasrv.fanotes.ink.InkSession(note.document)
        session.beginStroke()
        session.addSample(StrokePoint(0.1, 0.2, 1.0, 0.5, 0.0, 0.0, "pen"))
        session.endStroke(ch.fasrv.fanotes.ink.StrokeStyle(), "2026-10-16T12:00:00.000Z")
        store.save(note, session.document, note.markdown)
        val original = store.readNote(path)
        val sheet = worksheetIdsFromMarkdown(original.markdown).single()
        val copy = store.duplicateNote(path)
        val second = store.duplicateNote(path)
        val copied = store.readNote(copy)
        assertEquals("Blatt Kopie.md", copy)
        assertEquals("Blatt Kopie 2.md", second)
        assertTrue(copied.markdown.contains("Blatt"))
        assertTrue(copied.inkId != original.inkId)
        assertEquals(1, copied.document.strokes.size)
        val copiedSheet = worksheetIdsFromMarkdown(copied.markdown).single()
        assertTrue(copiedSheet != sheet)
        assertTrue(vault.exists(".fanotes/worksheets/$sheet.png"))
        assertTrue(vault.exists(".fanotes/worksheets/$copiedSheet.png"))
        assertTrue(vault.exists(".fanotes/assets/${original.inkId}.json"))
        assertTrue(vault.exists(".fanotes/assets/${copied.inkId}.json"))
        assertFailsWith<IllegalArgumentException> { store.duplicateNote("Fehlt.md") }
        val linked = store.readNote(path)
        val payload = (linked.payload.deepCopy() as JsonValue.Obj).also {
            it.put("noteLinks", noteLinksJson(listOf(NoteLinkMark("nl-old", path, "Andere.md", 0.2, 0.4))))
        }
        store.save(linked.copy(payload = payload), linked.document, linked.markdown)
        val again = store.duplicateNote(path)
        val marks = parseNoteLinkMarks(store.readNote(again).payload)
        assertEquals("Andere.md", marks.single().targetPath)
        assertEquals(again, marks.single().sourcePath)
        assertTrue(marks.single().id != "nl-old")
        val pdf = store.importPdf("", "Buch.pdf", byteArrayOf(0x25, 0x50, 0x44, 0x46))
        val refused = assertFailsWith<IllegalArgumentException> { store.duplicateNote(pdf) }
        assertEquals(PDF_DUPLICATE_REFUSED, refused.message)
    }

    @Test
    fun namesStampsAndFolderColoursFollowTheComfortRules() {
        assertEquals("Algebra Kopie", duplicatePreferredStem("Algebra"))
        assertEquals("Algebra Kopie", duplicatePreferredStem("Algebra Kopie"))
        assertEquals("Algebra Kopie", duplicatePreferredStem("Algebra Kopie 2"))
        assertEquals("Algebra Kopie", duplicatePreferredStem("Algebra Copy"))
        assertEquals("[[Algebra]]", wikiLinkForNote("Math/Algebra.md"))
        assertEquals(" 2026-10-16 16:19", stampToInsert("Wort", "2026-10-16 16:19"))
        assertEquals("2026-10-16 16:19", stampToInsert("Wort\n", "2026-10-16 16:19"))
        assertEquals(listOf("b.md"), recentNotePaths(listOf("a.md", "b.md", "a.md"), { true }, skip = "a.md"))
        assertEquals(emptySet(), nextExpandedFolders(setOf("Math"), listOf("Math", "Physik")))
        assertEquals(setOf("Math"), nextExpandedFolders(emptySet(), listOf("Math")))
        assertEquals("Lecture 2.md", restoredVaultPath("Lecture.md", folder = false) { it == "Lecture.md" })
        assertEquals("Math/Algebra.md", restoredVaultPath("Math/Algebra.md", folder = false) { false })
        assertEquals(".fanotes/assets/ink.json", remapRestoredFile("Math/Algebra.md", "Math/Algebra 2.md", ".fanotes/assets/ink.json"))
        assertEquals("Math/Algebra 2.famd", remapRestoredFile("Math/Algebra.md", "Math/Algebra 2.md", "Math/Algebra.famd"))
        assertEquals("2026-10-16 16:19", noteDateStamp(LocalDate.parse("2026-10-16"), LocalTime.of(16, 19), "YYYY-MM-DD"))
        assertEquals("16.10.2026 16:19", noteDateStamp(LocalDate.parse("2026-10-16"), LocalTime.of(16, 19), "DD.MM.YYYY"))
        assertEquals("Heute\n\n2026-10-16 16:19\n", insertNoteStamp("Heute\n", "2026-10-16 16:19"))
        assertEquals("2026-10-16 16:19\n", insertNoteStamp("", "2026-10-16 16:19"))
        assertEquals(mapOf("Physik" to "#112233"), dropFolderColors(mapOf("Schule" to "#abcdef", "Schule/Mathe" to "#445566", "Physik" to "#112233"), "Schule"))
        assertEquals("2 Einträge endgültig löschen?", trashEmptyMessage(2))
    }

    @Test
    fun duplicatingANoteKeepsWorksheetBytesWhenTheIdIsAlsoInThePath() {
        val (vault, store) = vault("fanotes-copy-worksheet-id")
        val png = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)
        val card = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 1, 2, 3, 4)
        val card2 = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 5, 6, 7, 8)
        writeWorksheet(vault, "png", "Bild", png)
        writeWorksheet(vault, "card", "Karte", card)
        writeWorksheet(vault, "card-2", "Karte 2", card2)
        vault.write(
            "Tafel.md",
            """
            # Tafel

            <!-- fanotes-worksheet:png -->

            <!-- fanotes-worksheet:card -->
            <!-- fanotes-worksheet:card-2 -->
            """.trimIndent().plus("\n").encodeToByteArray(),
        )
        val copy = store.duplicateNote("Tafel.md")
        val copied = store.readNote(copy)
        val ids = worksheetIdsFromMarkdown(copied.markdown)
        assertEquals(listOf("png", "card", "card-2").size, ids.size)
        assertEquals(png.toList(), worksheetBytes(vault, ids[0]))
        assertEquals(card.toList(), worksheetBytes(vault, ids[1]))
        assertEquals(card2.toList(), worksheetBytes(vault, ids[2]))
        assertEquals(png.toList(), vault.read(".fanotes/worksheets/png.png")!!.toList())
        assertTrue(ids.none { it == "png" || it == "card" || it == "card-2" })
    }

    private fun writeWorksheet(vault: DirectoryVault, id: String, title: String, bytes: ByteArray) {
        val source = ".fanotes/worksheets/$id.png"
        val record = ".fanotes/worksheets/$id.json"
        vault.write(source, bytes)
        vault.write(
            record,
            """
            {"schemaVersion":1,"id":"$id","title":"$title","kind":"image","mimeType":"image/png","sourceRelativePath":"$source","dataRelativePath":"$record","createdAt":"2026-10-16T12:00:00.000Z","updatedAt":"2026-10-16T12:00:00.000Z","textBoxes":[],"highlights":[]}
            """.trimIndent().encodeToByteArray(),
        )
    }

    private fun worksheetBytes(vault: DirectoryVault, id: String): List<Byte> {
        val record = parseJson(vault.read(".fanotes/worksheets/$id.json")!!.decodeToString()) as JsonValue.Obj
        val source = safeWorksheetSource(id, record.string("sourceRelativePath"))
        assertTrue(source != null, id)
        return vault.read(source!!)!!.toList()
    }

    private fun vault(name: String): Pair<DirectoryVault, NoteStore> {
        val directory = DirectoryVault(Files.createTempDirectory(name))
        return directory to NoteStore(directory)
    }

    private fun noteNames(store: NoteStore): List<String> {
        val names = mutableListOf<String>()
        fun walk(nodes: List<VaultNode>) {
            for (node in nodes) {
                if (node.kind == NoteKind.FOLDER) walk(node.children) else names += node.name
            }
        }
        walk(store.tree())
        return names
    }
}
