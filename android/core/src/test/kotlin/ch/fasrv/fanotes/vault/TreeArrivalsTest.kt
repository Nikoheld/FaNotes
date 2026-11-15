package ch.fasrv.fanotes.vault

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class TreeArrivalsTest {
    private fun note(path: String, m: Long = 1) = VaultNode(path.substringAfterLast('/'), path, NoteKind.MARKDOWN, m)
    private fun folder(path: String, vararg kids: VaultNode) = VaultNode(path.substringAfterLast('/'), path, NoteKind.FOLDER, 1, kids.toList())

    @Test
    fun diffFindsAddedRemovedAndChanged() {
        val before = listOf(folder("Physik", note("Physik/a.md"), note("Physik/b.md")))
        val after = listOf(folder("Physik", note("Physik/a.md", 2), note("Physik/c.md")))
        val change = diffTrees(before, after)
        assertEquals(listOf("Physik/c.md"), change.added)
        assertEquals(listOf("Physik/b.md"), change.removed)
        assertEquals(listOf("Physik/a.md"), change.changed)
        assertTrue(diffTrees(before, before).isEmpty)
    }

    @Test
    fun arrivalsKeepOldMarksDropOpenedAndVanished() {
        val next = listOf(note("a.md"), note("b.md"), note("c.md"))
        val change = TreeChange(added = listOf("c.md"), removed = emptyList(), changed = emptyList())
        val marks = updateArrivals(setOf("a.md", "gone.md", "b.md"), change, next, opened = "b.md", suppress = false)
        assertEquals(setOf("a.md", "c.md"), marks)
    }

    @Test
    fun ownWritesAreNotMarked() {
        val next = listOf(note("a.md"))
        val change = TreeChange(listOf("a.md"), emptyList(), emptyList())
        assertEquals(emptySet(), updateArrivals(emptySet(), change, next, null, suppress = true))
    }

    @Test
    fun foldersGetMarkedAndMessageNamesTheFolder() {
        assertEquals(setOf("A/B/x.md", "A/B", "A"), withParentFolders(setOf("A/B/x.md")))
        assertEquals("3 neue Dateien in Physik", arrivalMessage(listOf("Physik/a.md", "Physik/b.md", "Physik/c.md")))
        assertEquals("1 neue Datei", arrivalMessage(listOf("x.md")))
        assertEquals("2 neue Dateien", arrivalMessage(listOf("A/x.md", "B/y.md")))
        assertNull(arrivalMessage(emptyList()))
    }
}
