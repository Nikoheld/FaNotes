package ch.fasrv.fanotes.vault

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class NoteCensusTest {
    @Test
    fun foldersNestAndDeskFilesStayOutOfTheCount() {
        val tree = listOf(
            VaultNode("Schule", "Schule", NoteKind.FOLDER, 1, listOf(
                VaultNode("Mathe", "Schule/Mathe.md", NoteKind.MARKDOWN, 2),
                VaultNode("Alt", "Schule/Alt", NoteKind.FOLDER, 3, listOf(
                    VaultNode("Probe", "Schule/Alt/Probe.famd", NoteKind.MARKDOWN, 4),
                )),
            )),
            VaultNode("Hausaufgaben", "Hausaufgaben.md", NoteKind.MARKDOWN, 5),
            VaultNode("Blatt", "Blatt.pdf", NoteKind.PDF, 6),
        )
        val census = censusNotes(tree, setOf("Hausaufgaben.md"))
        assertEquals(3, census.notes)
        assertEquals(2, census.folders)
        assertEquals(1, census.perFolder["Schule"])
        assertEquals(1, census.perFolder["Schule/Alt"])
        assertEquals(1, census.perFolder["/"])
        assertEquals(listOf("Schule", "Hausaufgaben.md", "Blatt.pdf"), folderChildren(tree, "").map { it.path })
        assertEquals(listOf("Schule/Mathe.md", "Schule/Alt"), folderChildren(tree, "Schule").map { it.path })
        assertTrue(folderExists(tree, "Schule/Alt"))
        assertFalse(folderExists(tree, "Fehlt"))
    }
}
