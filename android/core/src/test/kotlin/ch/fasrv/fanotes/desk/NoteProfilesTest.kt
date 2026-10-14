package ch.fasrv.fanotes.desk

import ch.fasrv.fanotes.text.PaperKind
import ch.fasrv.fanotes.text.paperLines
import ch.fasrv.fanotes.text.tableRows
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class NoteProfilesTest {
    @Test
    fun universityKeepsTheSchoolTemplatesAndTheProof() {
        val titles = templatesForProfile("university").map { it.title }
        assertEquals(listOf("Protokoll", "Beweis", "Cornell", "Vokabeln"), titles)
        assertEquals(listOf("Tagebuch"), templatesForProfile("private").map { it.title })
        assertTrue(templatesToSeed(listOf("Vorlagen/Protokoll.md"), "school").isEmpty())
        assertEquals("Mathematik", profileFolders("school").first().name)
        val cornell = templatesForProfile("school").first { it.title == "Cornell" }.markdown
        val rows = tableRows(paperLines(cornell).first { it.kind == PaperKind.TABLE }.text)
        assertEquals(listOf("Stichworte", "Notizen"), rows.first())
    }
}
