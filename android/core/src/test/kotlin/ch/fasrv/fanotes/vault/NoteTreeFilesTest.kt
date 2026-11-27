package ch.fasrv.fanotes.vault

import ch.fasrv.fanotes.famd.MAX_SYNC_DOCUMENT_BYTES
import ch.fasrv.fanotes.famd.companionPath
import ch.fasrv.fanotes.famd.emptyFamdPayload
import ch.fasrv.fanotes.famd.serializeFamd
import ch.fasrv.fanotes.json.JsonValue
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class NoteTreeFilesTest {
    private fun vault(): java.nio.file.Path {
        val root = Files.createTempDirectory("fanotes-files")
        fun file(path: String, text: String = "x") {
            val target = root.resolve(path)
            Files.createDirectories(target.parent)
            Files.write(target, text.toByteArray())
        }
        file("Note.md", "# Note\n")
        file("Buch.pdf")
        file("Bilder/Foto.JPG")
        file("Bilder/icon.svg")
        file("Bilder/anim.Gif")
        file("Audio/lied.mp3")
        file("Audio/aufnahme.M4A")
        file("Video/clip.webm")
        file("Video/film.mp4")
        file("Misc/data.zip")
        file("Misc/notes.txt")
        file("Geschichte.story/story.json", "{}")
        return root
    }

    private fun flat(nodes: List<VaultNode>): List<VaultNode> = nodes.flatMap { if (it.kind == NoteKind.FOLDER) flat(it.children) else listOf(it) }

    @Test
    fun theDefaultTreeKeepsOnlyNotesAndStories() {
        val kinds = flat(NoteStore(DirectoryVault(vault())).tree()).map { it.kind }.toSet()
        assertEquals(setOf(NoteKind.MARKDOWN, NoteKind.PDF, NoteKind.STORY), kinds)
    }

    @Test
    fun aPdfsHandwritingCompanionIsNotListedAsASecondNote() {
        val root = vault()
        Files.write(root.resolve("Buch.famd"), "x".toByteArray())
        Files.write(root.resolve("Note.famd"), "x".toByteArray())
        Files.write(root.resolve("Skizze.famd"), "x".toByteArray())
        val nodes = flat(NoteStore(DirectoryVault(root)).tree(includeFiles = true))
        assertEquals(listOf("Buch.pdf"), nodes.filter { it.name == "Buch" }.map { it.path })
        assertEquals(listOf("Note.md"), nodes.filter { it.name == "Note" }.map { it.path })
        // A handwriting note of its own still shows.
        assertEquals(listOf("Skizze.famd"), nodes.filter { it.name == "Skizze" }.map { it.path })
    }

    @Test
    fun includeFilesListsMediaByCaseInsensitiveExtensionAndOtherUserFilesAsFile() {
        val nodes = flat(NoteStore(DirectoryVault(vault())).tree(includeFiles = true)).associateBy { it.name }
        assertEquals(NoteKind.IMAGE, nodes.getValue("Foto.JPG").kind)
        assertEquals(NoteKind.IMAGE, nodes.getValue("icon.svg").kind)
        assertEquals(NoteKind.IMAGE, nodes.getValue("anim.Gif").kind)
        assertEquals(NoteKind.AUDIO, nodes.getValue("lied.mp3").kind)
        assertEquals(NoteKind.AUDIO, nodes.getValue("aufnahme.M4A").kind)
        assertEquals(NoteKind.VIDEO, nodes.getValue("clip.webm").kind)
        assertEquals(NoteKind.VIDEO, nodes.getValue("film.mp4").kind)
        assertEquals(NoteKind.STORY, nodes.getValue("Geschichte").kind)
        assertEquals(NoteKind.FILE, nodes.getValue("data.zip").kind)
        assertEquals(NoteKind.FILE, nodes.getValue("notes.txt").kind)
    }

    @Test
    fun onlyMarkdownAndPdfAreNotes() {
        assertEquals(setOf(NoteKind.MARKDOWN, NoteKind.PDF), NoteKind.values().filter { it.isNote }.toSet())
    }

    @Test
    fun mediaAndStoriesAreNeverReadAsNotes() {
        val store = NoteStore(DirectoryVault(vault()))
        for (path in listOf("Bilder/Foto.JPG", "Audio/lied.mp3", "Video/clip.webm", "Geschichte.story")) {
            assertFailsWith<IllegalArgumentException>(path) { store.readNote(path) }
        }
    }

    @Test
    fun renamingAMediaFileKeepsItsExtensionAndAStoryItsSuffix() {
        assertEquals("Bilder/Neu.JPG", renamedVaultPath("Bilder/Foto.JPG", "Neu", folder = false))
        assertEquals("Bilder/Neu.JPG", renamedVaultPath("Bilder/Foto.JPG", "Neu.jpg", folder = false))
        assertEquals("Audio/Lied 2.mp3", renamedVaultPath("Audio/lied.mp3", "Lied 2", folder = false))
        assertEquals("Neu.story", renamedVaultPath("Geschichte.story", "Neu", folder = true))
        assertEquals("Neu.story", renamedVaultPath("Geschichte.story", "Neu.story", folder = true))
    }

    @Test
    fun mediaMoveAndTrashLikeAnyFile() {
        val root = vault()
        val store = NoteStore(DirectoryVault(root))
        assertEquals("Audio/clip.webm", store.moveEntry("Video/clip.webm", "Audio"))
        assertTrue(Files.exists(root.resolve("Audio/clip.webm")))
        store.trashEntry("Audio/lied.mp3", "t1", "2026-01-01T00:00:00.000Z")
        assertFalse(Files.exists(root.resolve("Audio/lied.mp3")))
        assertEquals("Audio/lied.mp3", store.restoreTrash("t1"))
        assertTrue(Files.exists(root.resolve("Audio/lied.mp3")))
    }

    @Test
    fun censusCountsNotesAndStoriesButNotMedia() {
        val census = censusNotes(NoteStore(DirectoryVault(vault())).tree(includeFiles = true))
        assertEquals(3, census.notes)
    }

    @Test
    fun sizeIsMinusOneForAMissingFile() {
        val io = DirectoryVault(vault())
        assertEquals(1L, io.size("Note.md").coerceAtMost(1L))
        assertEquals(-1L, io.size("nope.md"))
        assertEquals(-1L, io.size("Bilder"))
    }

    // --- An oversized or too complex sidecar -------------------------------------------------

    private fun sidecarNote(root: java.nio.file.Path, payload: JsonValue.Obj): NoteStore {
        Files.write(root.resolve("Big.md"), "Hello text\n".toByteArray())
        Files.write(root.resolve("Big.famd"), serializeFamd("Hello text\n", payload).toByteArray())
        return NoteStore(DirectoryVault(root))
    }

    @Test
    fun aSidecarOverTheCapOpensWithoutInkAndRefusesToSave() {
        val root = Files.createTempDirectory("fanotes-big")
        sidecarNote(root, emptyFamdPayload("2026-01-01T00:00:00.000Z"))
        val inner = DirectoryVault(root)
        val io = object : VaultIo by inner {
            override fun size(path: String): Long = if (path.endsWith(".famd")) MAX_SYNC_DOCUMENT_BYTES + 1L else inner.size(path)
        }
        val store = NoteStore(io, noteReadLimit = { MAX_SYNC_DOCUMENT_BYTES.toLong() })
        val note = store.readNote("Big.md")
        assertTrue(note.inkTooLarge)
        // A phone with room for it decodes the same file.
        assertFalse(NoteStore(io, noteReadLimit = { MAX_SYNC_DOCUMENT_BYTES * 2L }).readNote("Big.md").inkTooLarge)
        assertTrue(note.document.strokes.isEmpty())
        assertEquals("Hello text", note.markdown.trim())
        val error = assertFailsWith<IllegalStateException> { store.save(note, note.document, "changed") }
        assertEquals(INK_TOO_LARGE_MESSAGE, error.message)
    }

    @Test
    fun aSidecarThatHitsTheJsonLimitCountsAsTooLarge() {
        val root = Files.createTempDirectory("fanotes-deep")
        // Written by hand: the writer itself refuses a document this deep.
        val deep = "[".repeat(200) + "]".repeat(200)
        val json = """{"schema":"fanotes-famd-v1","updatedAt":"2026-01-01T00:00:00.000Z","ink":{"deep":$deep},"worksheets":[]}"""
        Files.write(root.resolve("Big.md"), "Hello text\n".toByteArray())
        Files.write(root.resolve("Big.famd"), "Hello text\n\n<!-- fanotes-famd:v1 chars=${json.length} -->\n$json\n".toByteArray())
        val store = NoteStore(DirectoryVault(root))
        val note = store.readNote("Big.md")
        assertTrue(note.inkTooLarge)
        assertTrue(note.document.strokes.isEmpty())
        assertFailsWith<IllegalStateException> { store.save(note, note.document, "x") }
        // The sidecar on disk is untouched.
        assertTrue(Files.size(root.resolve("Big.famd")) > 0)
    }

    @Test
    fun anOrdinaryNoteIsNotTooLarge() {
        val root = Files.createTempDirectory("fanotes-ok")
        val store = sidecarNote(root, emptyFamdPayload("2026-01-01T00:00:00.000Z"))
        assertFalse(store.readNote("Big.md").inkTooLarge)
        assertNull(companionPath("a.pdf", ".famd").takeIf { it.isEmpty() })
    }
}
