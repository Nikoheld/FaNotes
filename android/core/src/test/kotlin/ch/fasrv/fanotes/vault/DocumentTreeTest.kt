package ch.fasrv.fanotes.vault

import java.io.ByteArrayInputStream
import java.io.IOException
import java.io.InputStream
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * [DocumentTree] is the read side of the Android vault. These tests count provider calls, because the
 * old per-name lookup made one read cost a call for every sibling of the file.
 */
class DocumentTreeTest {
    /** A provider with directories of children and files by document id, counting what it is asked. */
    private class Provider : DocumentSource {
        val directories = HashMap<String, MutableList<DocumentChild>>()
        val files = HashMap<String, ByteArray>()
        val listings = ArrayList<String>()
        val opens = ArrayList<String>()
        var failListings = false

        fun dir(parent: String, id: String, name: String) {
            directories.getOrPut(parent) { ArrayList() } += DocumentChild(id, name, directory = true, file = false, size = 0, mtimeMs = 5)
            directories.getOrPut(id) { ArrayList() }
        }

        fun file(parent: String, id: String, name: String, bytes: ByteArray = ByteArray(0), mime: Boolean = true) {
            directories.getOrPut(parent) { ArrayList() } += DocumentChild(id, name, directory = false, file = mime, size = bytes.size.toLong(), mtimeMs = 7)
            files[id] = bytes
        }

        override fun children(directoryId: String): List<DocumentChild> {
            listings += directoryId
            if (failListings) throw IOException("provider is gone")
            return directories[directoryId]?.toList() ?: throw IOException("no such directory $directoryId")
        }

        override fun open(documentId: String): InputStream? {
            opens += documentId
            return files[documentId]?.let { ByteArrayInputStream(it) }
        }
    }

    private fun crowded(): Provider {
        val provider = Provider()
        provider.dir("root", "d1", "Mathe")
        provider.dir("d1", "d2", "Analysis")
        repeat(500) { provider.file("d2", "f$it", "note-$it.md", "text $it".toByteArray()) }
        provider.file("root", "top", "Notiz.md", "oben".toByteArray())
        return provider
    }

    @Test
    fun aReadCostsOneListingPerPathSegmentWhateverTheFolderSize() {
        val provider = crowded()
        val tree = DocumentTree(provider, "root")
        assertEquals("text 250", tree.read("Mathe/Analysis/note-250.md")!!.decodeToString())
        assertEquals(listOf("root", "d1", "d2"), provider.listings, "three listings for three segments, not 500 name lookups")
        assertEquals(listOf("f250"), provider.opens)
    }

    @Test
    fun existsAndMtimeNeedOnlyTheListings() {
        val provider = crowded()
        val tree = DocumentTree(provider, "root")
        assertNotNull(tree.find("Notiz.md"))
        assertEquals(7, tree.find("Mathe/Analysis/note-3.md")!!.mtimeMs)
        assertNull(tree.find("Mathe/Analysis/missing.md"))
        assertNull(tree.find("Mathe/Notiz.md"))
        assertNull(tree.find("Notiz.md/inside"), "a file is not a folder")
        assertTrue(provider.opens.isEmpty())
    }

    @Test
    fun anEntryOpensByItsHandleWithoutLookingTheFolderUp() {
        val provider = crowded()
        val tree = DocumentTree(provider, "root")
        val entry = tree.list("Mathe/Analysis").first { it.path.endsWith("note-42.md") }
        provider.listings.clear()
        val head = tree.readHead(entry, 1000)!!
        assertEquals("text 42", head.bytes.decodeToString())
        assertTrue(head.complete)
        assertEquals(emptyList(), provider.listings, "the handle is enough")
        assertEquals(listOf("f42"), provider.opens)
    }

    @Test
    fun aListingByHandleIsOneQueryAndCarriesHandlesForTheNextLevel() {
        val provider = crowded()
        val tree = DocumentTree(provider, "root")
        val top = tree.list("")
        assertEquals(listOf("Mathe", "Notiz.md"), top.map { it.path }.sorted())
        provider.listings.clear()
        val mathe = top.first { it.path == "Mathe" }
        val inside = tree.list(mathe)
        assertEquals(listOf("d1"), provider.listings)
        assertEquals(listOf("Mathe/Analysis"), inside.map { it.path })
        assertTrue(inside.single().directory)
        assertEquals("d2", inside.single().handle)
    }

    @Test
    fun walkingTheVaultIsOneListingPerFolder() {
        val provider = crowded()
        val files = DocumentTree(provider, "root").walkFiles()
        assertEquals(501, files.size)
        assertEquals(setOf("root", "d1", "d2"), provider.listings.toSet())
        assertEquals(3, provider.listings.size, "each folder is listed once")
        assertTrue(files.none { it.directory })
        assertEquals("Mathe/Analysis/note-0.md", files.first { it.path.endsWith("note-0.md") }.path)
    }

    @Test
    fun aStaleHandleFallsBackToThePath() {
        val provider = Provider()
        provider.dir("root", "d1", "Mathe")
        provider.file("d1", "new-id", "Algebra.md", "frisch".toByteArray())
        val tree = DocumentTree(provider, "root")
        // The entry was listed when the file still had another id (it was replaced in the meantime).
        val stale = VaultEntry("Mathe/Algebra.md", directory = false, size = 6, mtimeMs = 1, handle = "old-id")
        assertEquals("frisch", tree.readHead(stale, 100)!!.bytes.decodeToString())

        val staleFolder = VaultEntry("Mathe", directory = true, size = 0, mtimeMs = 1, handle = "old-folder")
        assertEquals(listOf("Mathe/Algebra.md"), tree.list(staleFolder).map { it.path })
    }

    @Test
    fun aFileThatIsGoneIsNullAndAFolderThatIsGoneIsEmpty() {
        val provider = crowded()
        val tree = DocumentTree(provider, "root")
        assertNull(tree.read("Mathe/weg.md"))
        assertNull(tree.readHead("weg.md", 10))
        assertEquals(emptyList(), tree.list("Mathe/weg"))
        assertEquals(emptyList(), tree.list("Notiz.md"), "a file has no children")
        val goneEntry = VaultEntry("Mathe/weg.md", directory = false, size = 1, mtimeMs = 1, handle = "nope")
        assertNull(tree.readHead(goneEntry, 10))
    }

    @Test
    fun aFolderAndAFileWithoutATypeAreNotReadAsFiles() {
        val provider = Provider()
        provider.dir("root", "d1", "Ordner")
        provider.file("root", "x", "ohne-typ", "abc".toByteArray(), mime = false)
        val tree = DocumentTree(provider, "root")
        assertNull(tree.read("Ordner"))
        assertNull(tree.read("ohne-typ"))
        val untyped = tree.list("").first { it.path == "ohne-typ" }
        assertEquals(0, untyped.size, "an untyped document reports no size, like DocumentFile.length")
        assertNull(tree.readHead(tree.list("").first { it.path == "Ordner" }, 10))
    }

    @Test
    fun aListingThatFailsIsAnErrorNotAnEmptyVault() {
        val provider = crowded()
        provider.failListings = true
        val tree = DocumentTree(provider, "root")
        assertFailsWith<IOException> { tree.walkFiles() }
        assertFailsWith<IOException> { tree.list("") }
        assertFailsWith<IOException> { tree.read("Notiz.md") }
    }

    @Test
    fun aHeadSaysWhetherTheFileIsLonger() {
        val provider = Provider()
        provider.file("root", "a", "exact.md", ByteArray(10) { 1 })
        provider.file("root", "b", "longer.md", ByteArray(11) { 2 })
        provider.file("root", "c", "empty.md", ByteArray(0))
        val tree = DocumentTree(provider, "root")
        val exact = tree.readHead("exact.md", 10)!!
        assertTrue(exact.complete)
        assertEquals(10, exact.bytes.size)
        val longer = tree.readHead("longer.md", 10)!!
        assertFalse(longer.complete)
        assertContentEquals(ByteArray(10) { 2 }, longer.bytes)
        val empty = tree.readHead("empty.md", 10)!!
        assertTrue(empty.complete)
        assertEquals(0, empty.bytes.size)
    }
}
