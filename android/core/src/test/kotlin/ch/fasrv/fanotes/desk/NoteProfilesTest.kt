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
        assertEquals(8, FIRST_RUN_LOGO_RADIUS_DP)
        assertEquals(12, FIRST_RUN_PROFILE_RADIUS_DP)
        assertEquals(12, FIRST_RUN_PICKER_RADIUS_DP)
        assertEquals(11, FIRST_RUN_SUBJECT_RADIUS_DP)
        assertEquals("Willkommen bei FaNotes", firstRunEyebrow(0))
        assertEquals("Fast geschafft · 4 von 4", firstRunEyebrow(3))
        assertEquals("Bleibt lokal", FIRST_RUN_LOCAL)
        assertEquals(3, FIRST_RUN_BENEFITS.size)
        assertEquals(3, FIRST_RUN_WRITING.size)
        assertTrue(firstRunFolderIntro("Schule").contains("Schule"))
        assertEquals("Algebra, Geometrie & Analysis", firstRunFolderBlurb("Mathematik"))
        assertEquals(listOf("Seminare"), firstRunChosenFolders(withoutLectures.copy(selected = setOf("Seminare"))).map { it.name })
        assertEquals(3, firstRunStep(start, 9).step)
        assertEquals("school", firstRunChooseProfile(start, "nope").profile)
    }

    @Test
    fun theWelcomePreviewUsesTheDesktopWindow() {
        assertEquals(1, firstRunPreviewColumns(760))
        assertEquals(2, firstRunPreviewColumns(761))
        assertEquals(12, FIRST_RUN_PREVIEW_RADIUS_DP)
        assertEquals(32, FIRST_RUN_PREVIEW_HEADER_DP)
        assertEquals(listOf("Mathematik", "Deutsch", "Französisch", "Physik", "Wirtschaft"), FIRST_RUN_PREVIEW_SUBJECTS)
        assertEquals("Ableitungen", FIRST_RUN_PREVIEW_HEADING)
        assertEquals("Die Änderungsrate beschreibt die Steigung.", FIRST_RUN_PREVIEW_TYPED)
        assertEquals("1 Treffer", FIRST_RUN_PREVIEW_HITS)
        assertEquals("Handschrift", FIRST_RUN_PREVIEW_INK)
        assertEquals("Vorschau von FaNotes", FIRST_RUN_PREVIEW_LABEL)
        assertEquals("Analysis.md", FIRST_RUN_WRITING_FILE)
        assertEquals("Integralrechnung", FIRST_RUN_WRITING_HEADING)
        assertEquals("Der Flächeninhalt lässt sich mit dem bestimmten Integral berechnen.", FIRST_RUN_WRITING_TYPED)
        assertEquals("Im Hintergrund erkannt", FIRST_RUN_WRITING_RECOGNIZED)
        assertEquals("∫₀¹ (x + 2) dx = 2,5", FIRST_RUN_WRITING_FORMULA)
        assertEquals("Optional umwandeln", FIRST_RUN_WRITING_CONVERT)
        assertEquals("Vorschau einer Seite mit Text und Handschrift", FIRST_RUN_WRITING_PREVIEW_LABEL)
        assertEquals(0.87f to 1.13f, firstRunColumnWeights(0))
        assertEquals(0.75f to 1.25f, firstRunColumnWeights(1))
        assertEquals(0.78f to 1.22f, firstRunColumnWeights(2))
        assertEquals(0.82f to 1.18f, firstRunColumnWeights(3))
    }

    @Test
    fun theFirstRunGridFollowsTheDesktopBreakpoints() {
        assertEquals(0.78f to 1.22f, firstRunColumnWeights(0, 980))
        assertEquals(0.78f to 1.22f, firstRunColumnWeights(1, 800))
        assertEquals(0.78f to 1.22f, firstRunColumnWeights(2, 980))
        assertEquals(0.72f to 1.28f, firstRunColumnWeights(3, 980))
        assertEquals(0.87f to 1.13f, firstRunColumnWeights(0, 981))
        assertEquals(0.82f to 1.18f, firstRunColumnWeights(3, 981))
        assertEquals(30, firstRunColumnGap(3, 760))
        assertEquals(28, firstRunColumnGap(1, 900))
        assertEquals(35, firstRunColumnGap(3, 900))
        assertEquals(45, firstRunColumnGap(0, 1000))
        assertEquals(45, firstRunColumnGap(3, 1180))
    }

    @Test
    fun folderButtonsUseTheirOwnColor() {
        assertEquals(0xFF2A6F97.toInt(), firstRunFolderArgb("#2a6f97"))
        assertEquals(0xFF2A6F97.toInt(), firstRunFolderArgb(profileFolders("school").first { it.name == "Mathematik" }.color))
        assertEquals(0xFF333333.toInt(), mixArgb(0xFF000000.toInt(), 0xFFFFFFFF.toInt(), 0.80f))
        assertEquals(0xFF333333.toInt(), firstRunSubjectInk("#000000", 0xFFFFFFFF.toInt()))
        assertEquals(0.13f, FIRST_RUN_SUBJECT_FILL)
        assertEquals(0.61f, FIRST_RUN_SUBJECT_LINE)
    }
}
