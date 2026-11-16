package ch.fasrv.fanotes.study

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** The Aufträge sheet leaves the page visible. */
class StudySheetTest {
    @Test
    fun theSheetTakesAtMostFortyPercentOfTheWindow() {
        assertEquals(320, studySheetMaxHeightDp(800), "tablet in landscape")
        assertEquals(400, studySheetMaxHeightDp(1000))
        assertEquals(STUDY_SHEET_MAX_DP, studySheetMaxHeightDp(1333), "tablet in portrait never exceeds the old 460 dp")
        assertEquals(STUDY_SHEET_MAX_DP, studySheetMaxHeightDp(5000))
    }

    @Test
    fun aSmallWindowStillGetsRoomForItsFields() {
        assertEquals(STUDY_SHEET_MIN_DP, studySheetMaxHeightDp(500), "40 % would be 200 dp")
        assertEquals(STUDY_SHEET_MIN_DP, studySheetMaxHeightDp(360), "phone in landscape")
        assertEquals(180, studySheetMaxHeightDp(180), "never taller than the window, for example with the keyboard open")
        assertEquals(STUDY_SHEET_MIN_DP, studySheetMaxHeightDp(0))
        assertEquals(STUDY_SHEET_MIN_DP, studySheetMaxHeightDp(-5))
    }

    @Test
    fun phonesLandscapeAndSplitScreenAreCompact() {
        assertTrue(studySheetCompact(412, 915), "phone")
        assertTrue(studySheetCompact(915, 412), "phone in landscape")
        assertTrue(studySheetCompact(500, 1200), "split screen")
        assertFalse(studySheetCompact(800, 1280), "tablet in portrait")
        assertFalse(studySheetCompact(1280, 800), "tablet in landscape")
        assertFalse(studySheetCompact(STUDY_SHEET_COMPACT_WIDTH_DP, STUDY_SHEET_COMPACT_HEIGHT_DP))
        assertTrue(studySheetCompact(STUDY_SHEET_COMPACT_WIDTH_DP - 1, 900))
    }
}
