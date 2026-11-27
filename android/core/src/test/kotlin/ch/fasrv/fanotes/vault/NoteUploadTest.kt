package ch.fasrv.fanotes.vault

import ch.fasrv.fanotes.famd.companionPath
import java.io.ByteArrayInputStream
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class NoteUploadTest {
    private fun root(): Path = Files.createTempDirectory("fanotes-upload")
    private fun put(root: Path, path: String, text: String = "x") {
        val target = root.resolve(path)
        Files.createDirectories(target.parent)
        Files.write(target, text.toByteArray())
    }
    private fun bytes(text: String) = ByteArrayInputStream(text.toByteArray())
    private fun flat(nodes: List<VaultNode>): List<VaultNode> = nodes.flatMap { if (it.kind == NoteKind.FOLDER) flat(it.children) else listOf(it) }

    @Test
    fun anUploadKeepsItsNameMadeSafe() {
        val root = root()
        val store = NoteStore(DirectoryVault(root))
        assertEquals("Fach/Bericht Final.docx", store.importFile("Fach", "Bericht:Final.docx", bytes("a"), 100))
        assertEquals("a", Files.readString(root.resolve("Fach/Bericht Final.docx")))
        assertEquals("evil.zip", store.importFile("", "../../evil.zip", bytes("b"), 100))
        assertEquals("archive.tar.gz", store.importFile("", "archive.tar.gz", bytes("c"), 100))
        assertEquals("Makefile", store.importFile("", "Makefile", bytes("d"), 100))
    }

    @Test
    fun aTakenNameIsNumberedCaseInsensitively() {
        val root = root()
        put(root, "Ordner/Folien.PPTX")
        val store = NoteStore(DirectoryVault(root))
        assertEquals("Ordner/folien 2.pptx", store.importFile("Ordner", "folien.pptx", bytes("n"), 100))
        assertEquals("Ordner/Folien 3.pptx", store.importFile("Ordner", "Folien.pptx", bytes("n"), 100))
        assertEquals("Ordner/Folien.PPTX", root.relativize(root.resolve("Ordner/Folien.PPTX")).toString())
    }

    @Test
    fun anUploadedMarkdownNeverTakesTheNameOfANotesFamily() {
        val root = root()
        put(root, "Buch.pdf")
        val store = NoteStore(DirectoryVault(root))
        // A `.famd` beside a PDF is its companion: the upload gets another name instead of becoming it.
        assertEquals("Buch 2.famd", store.importFile("", "Buch.famd", bytes("x"), 100))
        assertEquals("Buch 3.md", store.importFile("", "Buch.md", bytes("x"), 100))
    }

    @Test
    fun aTooLargeFileLeavesNothingBehind() {
        val root = root()
        val store = NoteStore(DirectoryVault(root))
        assertFailsWith<FileTooLargeException> { store.importFile("Ordner", "gross.zip", bytes("0123456789"), 5) }
        assertFalse(Files.exists(root.resolve("Ordner/gross.zip")))
        val leftovers = Files.list(root.resolve("Ordner")).use { it.count() }
        assertEquals(0L, leftovers)
        assertEquals("ok.zip", store.importFile("Ordner", "ok.zip", bytes("12345"), 5).substringAfterLast('/'))
    }

    @Test
    fun aTempFileIsRefusedAndALongNameFitsTheFileSystem() {
        val store = NoteStore(DirectoryVault(root()))
        assertFailsWith<IllegalArgumentException> { store.importFile("", "x.tmp", bytes("x"), 10) }
        val long = "ä".repeat(300) + ".docx"
        val path = store.importFile("", long, bytes("x"), 10)
        assertTrue(path.toByteArray().size <= 255)
        assertTrue(path.endsWith(".docx"))
    }

    @Test
    fun uploadedFilesAppearAsFileAndHiddenOnesStayHidden() {
        val root = root()
        put(root, "Note.md", "# n\n")
        put(root, "Note.famd")
        put(root, "Buch.pdf")
        put(root, "Buch.famd")
        put(root, "Ordner/.keep", "")
        put(root, "Ordner/.versteckt.docx")
        put(root, ".verborgen/geheim.docx")
        put(root, ".fanotes/state.json")
        put(root, "Ordner/~\$Entwurf.docx")
        put(root, "Ordner/.~lock.Entwurf.docx#")
        put(root, "Ordner/Thumbs.db")
        put(root, "Ordner/desktop.ini")
        put(root, "Ordner/Sync.tmp")
        put(root, "Ordner/Bericht.docx")
        put(root, "Ordner/Daten.ZIP")
        val nodes = flat(NoteStore(DirectoryVault(root)).tree(includeFiles = true))
        assertEquals(setOf("Note.md", "Buch.pdf", "Ordner/Bericht.docx", "Ordner/Daten.ZIP"), nodes.map { it.path }.toSet())
        assertEquals(setOf(NoteKind.FILE), nodes.filter { it.path.startsWith("Ordner/") }.map { it.kind }.toSet())
        // Without includeFiles nothing new shows.
        assertEquals(setOf("Note.md", "Buch.pdf"), flat(NoteStore(DirectoryVault(root)).tree()).map { it.path }.toSet())
    }

    @Test
    fun aFamdBesideANoteStaysACompanionAndALoneOneStaysANote() {
        val root = root()
        put(root, "A.md", "# a\n"); put(root, "A.famd")
        put(root, "B.markdown", "# b\n"); put(root, "B.famd")
        put(root, "C.pdf"); put(root, "C.famd")
        put(root, "Allein.famd")
        val nodes = flat(NoteStore(DirectoryVault(root)).tree(includeFiles = true))
        assertEquals(setOf("A.md", "B.markdown", "C.pdf", "Allein.famd"), nodes.map { it.path }.toSet())
        assertTrue(nodes.none { it.kind == NoteKind.FILE })
    }

    @Test
    fun aFileIsNotANoteAndNotCounted() {
        assertFalse(NoteKind.FILE.isNote)
        val root = root()
        put(root, "a.docx")
        assertEquals(0, censusNotes(NoteStore(DirectoryVault(root)).tree(includeFiles = true)).notes)
        assertEquals(NoteKind.FILE, listedFileKind("a.docx"))
        assertNull(listedFileKind(".a.docx"))
        assertEquals(NoteKind.IMAGE, listedFileKind("a.PNG"))
    }

    @Test
    fun theDefaultStreamWriteRefusesAnOversizeStream() {
        val written = HashMap<String, ByteArray>()
        val io = object : VaultIo by DirectoryVault(root()) {
            override fun write(path: String, bytes: ByteArray) { written[path] = bytes }
            override fun writeStream(path: String, input: java.io.InputStream, maxBytes: Long): Long {
                val data = readBounded(input, maxBytes); write(path, data); return data.size.toLong()
            }
        }
        assertEquals(3L, io.writeStream("a", bytes("abc"), 3))
        assertFailsWith<FileTooLargeException> { io.writeStream("b", bytes("abcd"), 3) }
        assertFalse(written.containsKey("b"))
    }

    @Test
    fun companionPathHelperStillMapsTheSidecar() {
        assertEquals("Ordner/Buch.famd", companionPath("Ordner/Buch.pdf", ".famd"))
    }
}
