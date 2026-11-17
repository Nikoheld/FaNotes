package ch.fasrv.fanotes.study

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

/** What the Lernen tools keep across a rotation or a process restart. */
class StudyUiStateTest {
    private fun roundTrip(state: StudyUiState) = decodeStudyUiState(state.encode())

    @Test
    fun theDefaultStateRoundTrips() {
        assertEquals(StudyUiState(), roundTrip(StudyUiState()))
    }

    @Test
    fun toolSelectionChoicesAndANumberedLabelSurvive() {
        val state = StudyUiState(
            tool = StudyTool.BRANCH,
            selectedId = "an-abc-123",
            stampId = "check",
            numbered = true,
            labelColor = "#dc2626",
            branchColor = "#38bdf8",
            branchWidth = 28.0,
        )
        assertEquals(state, roundTrip(state))
    }

    @Test
    fun measurePointsCollectedSoFarComeBack() {
        val state = StudyUiState(
            tool = StudyTool.ANGLE_LINES,
            pending = StudyPending(StudyTool.ANGLE_LINES, 3, listOf(SPoint(0.1, 0.2), SPoint(0.4, 0.2), SPoint(0.5, 0.7))),
        )
        assertEquals(state, roundTrip(state))
    }

    @Test
    fun anUnconfirmedCropComesBackAsLongAsTheCropToolIsOpen() {
        val crop = StudyCrop(2, SRect(0.1, 0.2, 0.6, 0.7))
        val state = StudyUiState(tool = StudyTool.CROP, crop = crop)
        assertEquals(crop, roundTrip(state)?.crop)
        // The tool setter clears a crop when the tool changes, so a stored one for another tool is dropped.
        val stale = state.copy(tool = StudyTool.SELECT).encode()
        assertNull(decodeStudyUiState(stale)?.crop)
    }

    @Test
    fun theOpenLabelEditorKeepsWhatWasTyped() {
        val callout = StudyUiState(tool = StudyTool.SELECT, dialog = StudyDialogState(StudyDialogKind.CALLOUT, id = "an-1-x", text = "Hormon, halb ge"))
        assertEquals(callout, roundTrip(callout))
        val row = StudyUiState(dialog = StudyDialogState(StudyDialogKind.LEGEND_ROW, id = "an-2-y", key = "gain", text = "Gewinn"))
        assertEquals(row, roundTrip(row))
        val terms = StudyUiState(dialog = StudyDialogState(StudyDialogKind.TERMS, text = "A, B,\nC"))
        assertEquals(terms, roundTrip(terms))
    }

    @Test
    fun aPendingListThatDoesNotFitTheOpenToolIsDropped() {
        val wrongTool = StudyUiState(
            tool = StudyTool.DISTANCE,
            pending = StudyPending(StudyTool.ANGLE, 1, listOf(SPoint(0.1, 0.1))),
        ).encode()
        assertNull(decodeStudyUiState(wrongTool)?.pending)
        // A measure that has every point is committed at once, so a full list is never pending.
        val full = StudyUiState(
            tool = StudyTool.DISTANCE,
            pending = StudyPending(StudyTool.DISTANCE, 1, listOf(SPoint(0.1, 0.1), SPoint(0.2, 0.2))),
        ).encode()
        assertNull(decodeStudyUiState(full)?.pending)
    }

    @Test
    fun unreadableTextIsNotAState() {
        assertNull(decodeStudyUiState(null))
        assertNull(decodeStudyUiState(""))
        assertNull(decodeStudyUiState("not json"))
        assertNull(decodeStudyUiState("[1,2]"))
        assertNull(decodeStudyUiState(StudyUiState(tool = StudyTool.STAMP).encode().dropLast(5)))
    }

    @Test
    fun foreignValuesFallBackToTheDefaultsAndNumbersAreClamped() {
        val raw = """{"tool":"LASER","selected":"<script>","stamp":"nope","labelColor":"red","branchColor":"#ABCDEF","branchWidth":9000,""" +
            """"crop":{"page":1,"rect":[-3,0,2,5]},"pending":{"tool":"DISTANCE","page":1,"pts":[[2,-1]]},"dialog":{"kind":"CALLOUT","id":"bad id"}}"""
        val state = assertNotNull(decodeStudyUiState(raw))
        assertNull(state.tool)
        assertNull(state.selectedId)
        assertEquals(STUDY_DEFAULT_STAMP, state.stampId)
        assertEquals(STUDY_DEFAULT_LABEL_COLOR, state.labelColor)
        assertEquals("#abcdef", state.branchColor)
        assertEquals(STUDY_BRANCH_WIDTH_MAX, state.branchWidth)
        assertNull(state.crop)
        assertNull(state.pending)
        assertNull(state.dialog)
    }

    @Test
    fun pointsAndRectanglesAreClampedToThePage() {
        val raw = """{"tool":"CROP","crop":{"page":1,"rect":[-3,0.2,2,0.9]}}"""
        assertEquals(StudyCrop(1, SRect(0.0, 0.2, 1.0, 0.9)), decodeStudyUiState(raw)?.crop)
        val measure = """{"tool":"DISTANCE","pending":{"tool":"DISTANCE","page":1,"pts":[[2,-1]]}}"""
        assertEquals(listOf(SPoint(1.0, 0.0)), decodeStudyUiState(measure)?.pending?.pts)
    }

    @Test
    fun theTypedTextIsBounded() {
        val long = "x".repeat(STUDY_DIALOG_TEXT_MAX + 500)
        val state = StudyUiState(dialog = StudyDialogState(StudyDialogKind.TERMS, text = long))
        assertEquals(STUDY_DIALOG_TEXT_MAX, roundTrip(state)?.dialog?.text?.length)
    }
}
