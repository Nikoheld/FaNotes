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

    @Test
    fun firstRunKeepsTheChosenFoldersAndResetsThemWithTheProfile() {
        val start = firstRunStart()
        assertEquals(0, start.step)
        assertEquals(profileFolders("school").size, start.selected.size)
        val uni = firstRunChooseProfile(start, "university")
        assertEquals(setOf("Vorlesungen", "Seminare", "Forschung", "Prüfungen", "Literatur"), uni.selected)
        val withoutLectures = firstRunToggleFolder(uni, "Vorlesungen")
        assertEquals(4, withoutLectures.selected.size)
        assertEquals(withoutLectures, firstRunToggleFolder(withoutLectures, "Nicht da"))
        val all = firstRunToggleAll(withoutLectures)
        assertEquals(5, all.selected.size)
        val none = firstRunToggleAll(all)
        assertEquals(emptySet(), none.selected)
        assertEquals("Nur Eingang wird angelegt.", firstRunPlanLine(0))
        assertEquals("2 Ordner + Eingang wird angelegt.", firstRunPlanLine(2))
        assertEquals("4 von 5 ausgewählt", firstRunSelectionLine(4, 5))
        assertEquals("∑", firstRunFolderMark("Mathematik"))
        assertEquals("Algebra, Geometrie & Analysis", firstRunFolderBlurb("Mathematik"))
        assertEquals(listOf("Seminare"), firstRunChosenFolders(withoutLectures.copy(selected = setOf("Seminare"))).map { it.name })
        assertEquals(3, firstRunStep(start, 9).step)
        assertEquals("school", firstRunChooseProfile(start, "nope").profile)
    }
}
