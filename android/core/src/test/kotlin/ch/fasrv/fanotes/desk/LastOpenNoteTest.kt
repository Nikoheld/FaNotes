package ch.fasrv.fanotes.desk

import ch.fasrv.fanotes.vault.NoteKind
import ch.fasrv.fanotes.vault.VaultNode
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class LastOpenNoteTest {
    @Test
    fun savedPathWinsAndAMissingPathFallsBack() {
        val paths = collectNotePaths(
            listOf(
                VaultNode("Willkommen", "Willkommen.md", NoteKind.MARKDOWN, 0),
                VaultNode(
                    "Faecher",
                    "Faecher",
                    NoteKind.FOLDER,
                    0,
                    listOf(
                        VaultNode("Beispiel", "Faecher/Beispiel.md", NoteKind.MARKDOWN, 0),
                        VaultNode("Physik", "Faecher/Physik.md", NoteKind.MARKDOWN, 0),
                    ),
                ),
            ),
        )
        assertEquals(listOf("Willkommen.md", "Faecher/Beispiel.md", "Faecher/Physik.md"), paths)
        assertEquals("Faecher/Beispiel.md", chooseRestoredNote("Faecher/Beispiel.md", paths, "Willkommen.md"))
        assertEquals("Willkommen.md", chooseRestoredNote("Faecher/Geloescht.md", paths, "Willkommen.md"))
        assertEquals("Willkommen.md", chooseRestoredNote("", paths, "Willkommen.md"))
        assertNull(chooseRestoredNote(null, emptyList(), "Willkommen.md"))
        assertNull(chooseRestoredNote("Faecher/Beispiel.md", null, "Willkommen.md"))
    }
}
