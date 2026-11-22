package ch.fasrv.fanotes.desk

import ch.fasrv.fanotes.vault.NoteKind
import ch.fasrv.fanotes.vault.VaultNode
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

class ShellPolishTest {
    @Test
    fun oledThemeMatchesTheDesktopValueAndIsPureBlack() {
        val oled = themePalette("oled", systemDark = false)
        assertEquals("oled", oled.id)
        assertTrue(oled.dark)
        assertEquals("#000000", oled.background)
        assertEquals("#000000", oled.surface)
        assertEquals("#000000", oled.panelStrong)
        assertEquals("#e8e8e8", oled.text)
        assertTrue(THEME_CHOICES.any { it.id == "oled" })
        assertTrue(themeChoiceSelected("oled", "oled"))
        assertFalse(themeChoiceSelected("oled", "dark"))
        // The desktop's other dark themes still differ from the new black one.
        assertNotEquals(themePalette("dark", false).background, oled.background)
        assertEquals(0f, confirmDialogShadow("oled").alpha)
    }

    @Test
    fun unknownThemeStillFollowsTheSystem() {
        assertEquals("dark", themePalette("snow", systemDark = true).id)
        assertEquals("light", themePalette("snow", systemDark = false).id)
    }

    @Test
    fun swatchesCarryRuleAndTextSoCloseDarkThemesDiffer() {
        val dark = themeSwatch("dark")
        val midnight = themeSwatch("midnight")
        val forest = themeSwatch("forest")
        assertNotEquals(dark.text, midnight.text)
        assertNotEquals(midnight.line, forest.line)
        assertEquals("#262626", themeSwatch("oled").line)
        assertTrue(themeSwatch("system").split)
    }

    @Test
    fun touchLayerIsOnForTouchscreensWhateverTheWindowWidth() {
        assertTrue(touchLarge(null, touchscreen = true))
        assertTrue(touchLarge("", touchscreen = true))
        assertFalse(touchLarge(null, touchscreen = false))
        assertFalse(touchLarge("off", touchscreen = true))
        assertTrue(touchLarge("on", touchscreen = false))
    }

    @Test
    fun hitAreasGrowButDrawnSizesStayPinned() {
        val compact = TouchMetrics(false)
        val touch = TouchMetrics(true)
        assertEquals(SWATCH_HIT_DP, compact.swatchHitDp)
        assertEquals(SWATCH_DP, SWATCH_HIT_DP)
        assertEquals(TOUCH_MIN_DP, touch.swatchHitDp)
        assertEquals(0, compact.chipHitDp)
        assertEquals(TOUCH_MIN_DP, touch.chipHitDp)
        // Pinned desktop constants are untouched.
        assertEquals(RIBBON_BUTTON_DP, touch.ribbonButtonVisualDp)
        assertEquals(23, SWATCH_DP)
    }

    @Test
    fun portraitSettingsRowsStackInsteadOfSqueezingTheLabel() {
        // An 800 dp portrait window gives the content column about 470 dp, below the stacking limit.
        val portraitContent = (800 * 0.95).toInt() * 0.62
        assertTrue(portraitContent < SETTING_ROW_STACK_BELOW_DP)
        // The 1280 dp landscape modal (1080 dp) keeps label and control side by side.
        assertTrue(1080 * 0.62 >= SETTING_ROW_STACK_BELOW_DP)
    }

    @Test
    fun ribbonToolsOpenInAPopupOnPortraitTablets() {
        assertTrue(800 < RIBBON_TOOLS_POPUP_BELOW_DP)
        assertTrue(1280 >= RIBBON_TOOLS_POPUP_BELOW_DP)
    }

    @Test
    fun calendarDayIsLongGermanNotIso() {
        assertEquals("Sonntag, 22. November 2026", calendarDayLabel(LocalDate.of(2026, 11, 22)))
    }

    @Test
    fun studyWeekReadsMondayFirstWithSundayIndexZero() {
        assertEquals(listOf("Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"), STUDY_WEEKDAY_ORDER.map { it.second })
        assertEquals(1, STUDY_WEEKDAY_ORDER.first().first)
        assertEquals(0, STUDY_WEEKDAY_ORDER.last().first)
        assertEquals(setOf(0, 1, 2, 3, 4, 5, 6), STUDY_WEEKDAY_ORDER.map { it.first }.toSet())
    }

    @Test
    fun internalFoldersAreNoSubjects() {
        val rows = listOf(".fanotes", "Mathe", ".trash", "Deutsch").map { StudySubject(it, 1, 0, 0, 0, 0.0) }
        assertEquals(listOf("Mathe", "Deutsch"), visibleStudySubjects(rows).map { it.subject })
        assertFalse(isSubjectFolderName(".fanotes"))
        assertFalse(isSubjectFolderName("Assets"))
        assertFalse(isSubjectFolderName(" "))
        assertTrue(isSubjectFolderName("Mathe"))
    }

    @Test
    fun vaultPickersListFoldersAndPdfsWithoutHiddenOnes() {
        val tree = listOf(
            VaultNode(".fanotes", ".fanotes", NoteKind.FOLDER, 0, listOf(VaultNode("x.pdf", ".fanotes/x.pdf", NoteKind.PDF, 0))),
            VaultNode(
                "Mathe", "Mathe", NoteKind.FOLDER, 0,
                listOf(
                    VaultNode("Buch.pdf", "Mathe/Buch.pdf", NoteKind.PDF, 0),
                    VaultNode("Notiz.md", "Mathe/Notiz.md", NoteKind.MARKDOWN, 0),
                    VaultNode("Sub", "Mathe/Sub", NoteKind.FOLDER, 0, listOf(VaultNode("B2.pdf", "Mathe/Sub/B2.pdf", NoteKind.PDF, 0))),
                ),
            ),
            VaultNode("Lose.pdf", "Lose.pdf", NoteKind.PDF, 0),
        )
        assertEquals(listOf("Mathe", "Mathe/Sub"), vaultFolderPaths(tree))
        assertEquals(listOf("Mathe/Buch.pdf", "Mathe/Sub/B2.pdf", "Lose.pdf"), vaultPdfPaths(tree))
    }
}
