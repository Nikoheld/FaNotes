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
    fun theWelcomePreviewAsideFollowsTheDesktopColumn() {
        assertEquals(118, firstRunPreviewAsideDp(981))
        assertEquals(102, firstRunPreviewAsideDp(980))
        assertEquals(102, firstRunPreviewAsideDp(760))
    }

    @Test
    fun theWelcomePreviewAsidePaddingFollowsTheDesktopBreakpoint() {
        assertEquals(FirstRunPreviewAsidePad(top = 17, end = 10, bottom = 17, start = 10), firstRunPreviewAsidePad(981))
        assertEquals(FirstRunPreviewAsidePad(top = 17, end = 7, bottom = 17, start = 7), firstRunPreviewAsidePad(980))
        assertEquals(FirstRunPreviewAsidePad(top = 17, end = 7, bottom = 17, start = 7), firstRunPreviewAsidePad(760))
    }

    @Test
    fun theWelcomePreviewSubjectColumnStaysAMiniature() {
        assertEquals(7.5f, FIRST_RUN_PREVIEW_HEADING_SP)
        assertEquals(7, FIRST_RUN_PREVIEW_SUBJECT_SP)
        assertEquals(7, FIRST_RUN_PREVIEW_SUBJECT_PAD_DP)
        assertEquals(7, FIRST_RUN_PREVIEW_SUBJECT_GAP_DP)
        assertEquals(6, FIRST_RUN_PREVIEW_SUBJECT_RADIUS_DP)
        assertEquals(6, FIRST_RUN_PREVIEW_MARK_DP)
        assertEquals(2, FIRST_RUN_PREVIEW_MARK_RADIUS_DP)
        val accent = 0xFF226688.toInt()
        assertEquals(
            listOf(
                "Mathematik" to accent,
                "Deutsch" to 0xFFC76868.toInt(),
                "Französisch" to 0xFF3D8BE0.toInt(),
                "Physik" to 0xFF5E9ABD.toInt(),
                "Wirtschaft" to 0xFFCF9A48.toInt(),
            ),
            FIRST_RUN_PREVIEW_SUBJECTS.zip(firstRunPreviewMarkColors(accent)),
        )
        assertEquals(360, FIRST_RUN_PREVIEW_BODY_MIN_DP)
        assertEquals(325, FIRST_RUN_PREVIEW_BODY_MIN_SHORT_DP)
        assertEquals(325, firstRunPreviewBodyMinDp(761, 680))
        assertEquals(325, firstRunPreviewBodyMinDp(981, 400))
        assertEquals(360, firstRunPreviewBodyMinDp(400, 900))
        assertEquals(360, firstRunPreviewBodyMinDp(760, 900))
        assertEquals(360, firstRunPreviewBodyMinDp(760, 680))
        assertEquals(360, firstRunPreviewBodyMinDp(1200, 681))
    }

    @Test
    fun theWelcomePreviewPaperMatchesTheDesktopSheet() {
        assertEquals(6, FIRST_RUN_PREVIEW_KICKER_SP)
        assertEquals(20, FIRST_RUN_PREVIEW_PAPER_TITLE_SP)
        assertEquals(8.5f, FIRST_RUN_PREVIEW_TYPED_SP)
        assertEquals(11, FIRST_RUN_PREVIEW_PAPER_RADIUS_TOP_DP)
        assertEquals(0xFFFBFAF7.toInt(), FIRST_RUN_PREVIEW_PAPER_FILL)
        assertEquals(0xFF26272C.toInt(), FIRST_RUN_PREVIEW_PAPER_INK)
        assertEquals(0xFF8D8D90.toInt(), FIRST_RUN_PREVIEW_KICKER_INK)
        assertEquals(0xFF54555A.toInt(), FIRST_RUN_PREVIEW_TYPED_INK)
        assertEquals(18, FIRST_RUN_PREVIEW_PAPER_MARGIN_TOP_DP)
        assertEquals(19, FIRST_RUN_PREVIEW_PAPER_MARGIN_INLINE_DP)
        assertEquals(0, FIRST_RUN_PREVIEW_PAPER_MARGIN_BOTTOM_DP)
        assertEquals(25, FIRST_RUN_PREVIEW_PAPER_PAD_BLOCK_DP)
        assertEquals(27, FIRST_RUN_PREVIEW_PAPER_PAD_INLINE_DP)
        assertEquals(0, FIRST_RUN_PREVIEW_PAPER_RADIUS_BOTTOM_DP)
        assertEquals(700, FIRST_RUN_PREVIEW_KICKER_WEIGHT)
        assertEquals(0.12f, FIRST_RUN_PREVIEW_KICKER_TRACKING_EM)
        assertEquals(650, FIRST_RUN_PREVIEW_PAPER_TITLE_WEIGHT)
        assertEquals(1.1f, FIRST_RUN_PREVIEW_PAPER_TITLE_LINE)
        assertEquals(-0.035f, FIRST_RUN_PREVIEW_PAPER_TITLE_TRACKING_EM)
        assertEquals(9, FIRST_RUN_PREVIEW_PAPER_TITLE_MARGIN_TOP_DP)
        assertEquals(17, FIRST_RUN_PREVIEW_PAPER_TITLE_MARGIN_BOTTOM_DP)
        assertEquals(1.5f, FIRST_RUN_PREVIEW_TYPED_LINE)
        assertEquals("MATHEMATIK · ANALYSIS", FIRST_RUN_PREVIEW_KICKER)
        assertEquals("Ableitungen", FIRST_RUN_PREVIEW_HEADING)
        assertEquals("Die Änderungsrate beschreibt die Steigung.", FIRST_RUN_PREVIEW_TYPED)
        assertEquals(342, firstRunPreviewPaperMinDp(1200, 800))
        assertEquals(307, firstRunPreviewPaperMinDp(900, 680))
        assertEquals(342, firstRunPreviewPaperMinDp(760, 680))
        assertEquals(0, FIRST_RUN_PREVIEW_PAPER_SHADOW_X_DP)
        assertEquals(10, FIRST_RUN_PREVIEW_PAPER_SHADOW_Y_DP)
        assertEquals(30, FIRST_RUN_PREVIEW_PAPER_SHADOW_BLUR_DP)
        assertEquals(0.14f, FIRST_RUN_PREVIEW_PAPER_SHADOW_ALPHA)
        assertEquals(0x24000000, firstRunPreviewPaperShadowColor())
        val frame = checkNotNull(firstRunPreviewPaperShadowFrame(100f, 80f, 2f))
        assertEquals(60f, frame.blurPx)
        assertEquals(22f, frame.topRadiusPx)
        assertEquals(0x24000000, frame.color)
        assertEquals(frame.padPx, frame.shapeLeftPx)
        assertEquals(frame.padPx + 20f, frame.shapeTopPx)
        assertEquals(null, firstRunPreviewPaperShadowFrame(0f, 80f, 2f))
    }

    @Test
    fun theWelcomePreviewFormulaAndSearchMatchTheDesktopSheet() {
        assertEquals(0xFFE7E5DF.toInt(), FIRST_RUN_PREVIEW_RULE_ARGB)
        assertEquals(11, FIRST_RUN_PREVIEW_RULE_MARGIN_TOP_DP)
        assertEquals(4, FIRST_RUN_PREVIEW_RULE_MARGIN_BOTTOM_DP)
        assertEquals(330, FIRST_RUN_PREVIEW_INK_VIEW_WIDTH)
        assertEquals(98, FIRST_RUN_PREVIEW_INK_HEIGHT_DP)
        assertEquals(3.4f, FIRST_RUN_PREVIEW_INK_WIDTH_DP)
        assertEquals(27, FIRST_RUN_PREVIEW_SEARCH_HEIGHT_DP)
        assertEquals(7, FIRST_RUN_PREVIEW_SEARCH_SP)
        assertEquals(7, FIRST_RUN_PREVIEW_SEARCH_RADIUS_DP)
        assertEquals(6, FIRST_RUN_PREVIEW_SEARCH_GAP_DP)
        assertEquals(8, FIRST_RUN_PREVIEW_SEARCH_PAD_DP)
        assertEquals(11, FIRST_RUN_PREVIEW_SEARCH_ICON_DP)
        assertEquals(0xFF66676B.toInt(), FIRST_RUN_PREVIEW_SEARCH_ARGB)
        assertEquals(0xFFDFDDD7.toInt(), FIRST_RUN_PREVIEW_SEARCH_BORDER_ARGB)
        assertEquals(0xFFFFFFFF.toInt(), FIRST_RUN_PREVIEW_SEARCH_FILL_ARGB)
        assertEquals(5, FIRST_RUN_PREVIEW_SEARCH_SHADOW_Y_DP)
        assertEquals(0.06f, FIRST_RUN_PREVIEW_SEARCH_SHADOW_ALPHA)
        assertEquals(6.5f, FIRST_RUN_PREVIEW_HITS_SP)
        val accent = 0xFF226688.toInt()
        assertEquals(mixArgb(accent, 0xFF222222.toInt(), 0.78f), firstRunPreviewInkStroke(accent))
        assertEquals(mixArgb(accent, 0xFF333333.toInt(), 0.78f), firstRunPreviewSearchHits(accent))
    }

    @Test
    fun theWritingPreviewSheetFollowsTheDesktopPage() {
        assertEquals(FirstRunWritingPad(31, 34, 0, 34), firstRunWritingFramePad(1200, 800))
        assertEquals(FirstRunWritingPad(31, 28, 0, 28), firstRunWritingFramePad(1200, 680))
        assertEquals(FirstRunWritingPad(31, 24, 0, 24), firstRunWritingFramePad(900, 800))
        assertEquals(FirstRunWritingPad(31, 28, 0, 28), firstRunWritingFramePad(900, 680))
        assertEquals(FirstRunWritingPad(31, 24, 0, 24), firstRunWritingFramePad(760, 680))
        assertEquals(FirstRunWritingPad(36, 44, 36, 44), firstRunWritingSheetPad(1200, 800))
        assertEquals(FirstRunWritingPad(27, 44, 27, 44), firstRunWritingSheetPad(1200, 680))
        assertEquals(FirstRunWritingPad(36, 34, 36, 34), firstRunWritingSheetPad(900, 800))
        assertEquals(FirstRunWritingPad(27, 34, 27, 34), firstRunWritingSheetPad(900, 680))
        assertEquals(FirstRunWritingPad(36, 34, 36, 34), firstRunWritingSheetPad(760, 680))
        assertEquals(407, firstRunWritingSheetMinDp(1200, 800))
        assertEquals(354, firstRunWritingSheetMinDp(900, 680))
        assertEquals(407, firstRunWritingSheetMinDp(760, 400))
        assertEquals(150, firstRunWritingInkHeightDp(1200, 800))
        assertEquals(127, firstRunWritingInkHeightDp(761, 680))
        assertEquals(150, firstRunWritingInkHeightDp(760, 680))
        assertEquals("12. AUGUST · MATHEMATIK", firstRunWritingDateLabel())
        assertEquals(0xFFFBFAF7.toInt(), FIRST_RUN_WRITING_SHEET_FILL)
        assertEquals(0xFF28292D.toInt(), FIRST_RUN_WRITING_SHEET_INK)
        assertEquals(0xFF55565B.toInt(), FIRST_RUN_WRITING_TYPED_INK)
        assertEquals(19, FIRST_RUN_WRITING_FRAME_RADIUS_DP)
        assertEquals(11, FIRST_RUN_WRITING_SHEET_RADIUS_DP)
        assertEquals(420, FIRST_RUN_WRITING_INK_VIEW_WIDTH)
        assertEquals(3.3f, FIRST_RUN_WRITING_INK_WIDTH_DP)
        val accent = 0xFF226688.toInt()
        assertEquals(mixArgb(accent, 0xFF24252A.toInt(), 0.78f), firstRunWritingInkStroke(accent))
        assertEquals(mixArgb(accent, 0xFFDDDDDD.toInt(), 0.24f), firstRunWritingTranscriptBorder(accent))
        assertEquals(mixArgb(accent, 0xFFFFFFFF.toInt(), 0.05f), firstRunWritingTranscriptFill(accent))
        assertEquals(mixArgb(accent, 0xFF333333.toInt(), 0.75f), firstRunWritingSparkle(accent))
        assertEquals(mixArgb(accent, 0xFF222222.toInt(), 0.82f), firstRunWritingSelectionLabel(accent))
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
        assertEquals(70, firstRunColumnGap(0, 1000))
        assertEquals(83, firstRunColumnGap(3, 1180))
    }

    @Test
    fun theWideFirstRunGapFollowsTheDesktopClamp() {
        assertEquals(70, firstRunColumnGap(0, 1000))
        assertEquals(83, firstRunColumnGap(0, 1180))
        assertEquals(83, firstRunColumnGap(1, 1180))
        assertEquals(83, firstRunColumnGap(2, 1180))
        assertEquals(100, firstRunColumnGap(0, 2000))
        assertEquals(100, firstRunColumnGap(1, 2000))
        assertEquals(100, firstRunColumnGap(2, 2000))
        assertEquals(105, firstRunColumnGap(3, 2000))
        assertEquals(74, firstRunColumnGap(0, 1050))
        assertEquals(30, firstRunColumnGap(3, 640))
        assertEquals(28, firstRunColumnGap(1, 900))
        assertEquals(35, firstRunColumnGap(3, 900))
    }

    @Test
    fun theWelcomePreviewTagsFloatOnTheWindow() {
        val wide = firstRunPreviewFloatOne(761)
        val narrow = firstRunPreviewFloatOne(760)
        val found = firstRunPreviewFloatTwo()
        assertEquals(0.24f, wide.topFraction)
        assertEquals(-25, wide.rightDp)
        assertEquals(-8, narrow.rightDp)
        assertEquals(true, wide.fromTop)
        assertEquals(FirstRunPreviewFloatOffset(25, 0.24f, 0), firstRunPreviewFloatOffset(wide))
        assertEquals(FirstRunPreviewFloatOffset(8, 0.24f, 0), firstRunPreviewFloatOffset(narrow))
        assertEquals(28, found.rightDp)
        assertEquals(-16, found.bottomDp)
        assertEquals(false, found.fromTop)
        assertEquals(FirstRunPreviewFloatOffset(-28, 0f, 16), firstRunPreviewFloatOffset(found))
        assertEquals(8, FIRST_RUN_PREVIEW_FLOAT_PAD_BLOCK_DP)
        assertEquals(10, FIRST_RUN_PREVIEW_FLOAT_PAD_INLINE_DP)
        assertEquals(6, FIRST_RUN_PREVIEW_FLOAT_GAP_DP)
        assertEquals(9, FIRST_RUN_PREVIEW_FLOAT_RADIUS_DP)
        assertEquals(8, FIRST_RUN_PREVIEW_FLOAT_SP)
        assertEquals(600, FIRST_RUN_PREVIEW_FLOAT_WEIGHT)
        assertEquals(15, FIRST_RUN_PREVIEW_FLOAT_ICON_DP)
        assertEquals(0xFF8EC4E0.toInt(), firstRunPreviewFloatIcon(dark = true))
        assertEquals(0xFF1A6690.toInt(), firstRunPreviewFloatIcon(dark = false))
        assertEquals(0xEDFFFFFF.toInt(), firstRunPreviewFloatFill(0xFFFFFFFF.toInt()))
        assertEquals(0x29FFFFFF, firstRunPreviewFloatBorder(dark = true))
        assertEquals(0x2937352F, firstRunPreviewFloatBorder(dark = false))
        assertEquals(0, FIRST_RUN_PREVIEW_FLOAT_SHADOW_X_DP)
        assertEquals(13, FIRST_RUN_PREVIEW_FLOAT_SHADOW_Y_DP)
        assertEquals(35, FIRST_RUN_PREVIEW_FLOAT_SHADOW_BLUR_DP)
        assertEquals(0.2f, FIRST_RUN_PREVIEW_FLOAT_SHADOW_ALPHA)
        assertEquals(0x33000000, firstRunPreviewFloatShadowColor())
    }

    @Test
    fun theWelcomePreviewHeaderMatchesTheDesktopWindow() {
        assertEquals(7, FIRST_RUN_PREVIEW_HEADER_TITLE_SP)
        assertEquals(600, FIRST_RUN_PREVIEW_HEADER_TITLE_WEIGHT)
        assertEquals(6, FIRST_RUN_PREVIEW_HEADER_DOT_DP)
        assertEquals(5, FIRST_RUN_PREVIEW_HEADER_GAP_DP)
        assertEquals(12, FIRST_RUN_PREVIEW_HEADER_PAD_DP)
        assertEquals(32, FIRST_RUN_PREVIEW_HEADER_DP)
        assertEquals(0xFFD8A643.toInt(), FIRST_RUN_PREVIEW_HEADER_MIDDLE_DOT)
        assertEquals(0xEB202020.toInt(), firstRunPreviewHeaderFill(0xFF202020.toInt()))
        assertEquals(0x17FFFFFF, firstRunPreviewBorder("dark"))
        assertEquals(0x17FFFFFF, firstRunPreviewBorder("midnight"))
        assertEquals(0x17FFFFFF, firstRunPreviewBorder("system", systemDark = true))
        assertEquals(0x1737352F, firstRunPreviewBorder("light"))
        assertEquals(0x1737352F, firstRunPreviewBorder("system", systemDark = false))
        assertEquals(0x1A37352F, firstRunPreviewBorder("sepia"))
        assertEquals(0xB5FF9295.toInt(), firstRunPreviewHeaderClose(0xFFFF8D90.toInt(), firstRunPreviewBorder("dark")))
        assertEquals(0xB5BA3542.toInt(), firstRunPreviewHeaderClose(0xFFC03543.toInt(), firstRunPreviewBorder("light")))
        assertEquals(0xB6BA3542.toInt(), firstRunPreviewHeaderClose(0xFFC03543.toInt(), firstRunPreviewBorder("sepia")))
        assertEquals(0x25FFFFFF, firstRunPreviewWindowBorder("dark"))
        assertEquals(0x25FFFFFF, firstRunPreviewWindowBorder("aurora"))
        assertEquals(0x2537352F, firstRunPreviewWindowBorder("light"))
        assertEquals(0x2537352F, firstRunPreviewWindowBorder("sepia"))
        assertEquals(0, FIRST_RUN_PREVIEW_WINDOW_SHADOW_X_DP)
        assertEquals(34, FIRST_RUN_PREVIEW_WINDOW_SHADOW_Y_DP)
        assertEquals(95, FIRST_RUN_PREVIEW_WINDOW_SHADOW_BLUR_DP)
        assertEquals(0.25f, FIRST_RUN_PREVIEW_WINDOW_SHADOW_ALPHA)
        assertEquals(0x40000000, firstRunPreviewWindowShadowColor())
        assertEquals(0x06FFFFFF, FIRST_RUN_PREVIEW_WINDOW_RING)
    }

    @Test
    fun theWelcomePreviewGlowSitsBehindTheWindow() {
        assertEquals(0.12f, FIRST_RUN_PREVIEW_GLOW_INSET_BLOCK)
        assertEquals(0.08f, FIRST_RUN_PREVIEW_GLOW_INSET_INLINE)
        assertEquals(65, FIRST_RUN_PREVIEW_GLOW_BLUR_DP)
        assertEquals(0.22f, FIRST_RUN_PREVIEW_GLOW_COLOR_ALPHA)
        assertEquals(0.7f, FIRST_RUN_PREVIEW_GLOW_OPACITY)
        assertEquals(0x272A6F97, firstRunPreviewGlowColor(0xFF2A6F97.toInt()))
        val frame = checkNotNull(firstRunPreviewGlowFrame(100f, 200f, 2f, 0xFF2A6F97.toInt()))
        assertEquals(130f, frame.blurPx)
        assertEquals(262f, frame.padPx)
        assertEquals(270f, frame.ovalLeftPx)
        assertEquals(286f, frame.ovalTopPx)
        assertEquals(354f, frame.ovalRightPx)
        assertEquals(438f, frame.ovalBottomPx)
        assertEquals(0x272A6F97, frame.color)
        assertEquals(null, firstRunPreviewGlowFrame(0f, 200f, 2f, 0xFF2A6F97.toInt()))
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
