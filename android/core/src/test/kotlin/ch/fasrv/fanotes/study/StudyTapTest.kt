package ch.fasrv.fanotes.study

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

/** The place-on-release tools: nothing is committed on DOWN, a cancelled or dragged contact leaves nothing behind. */
class StudyTapTest {
    private val slop = 12.0

    // -- the state machine ---------------------------------------------------------------

    @Test
    fun aTapThatStaysWithinTheSlopPlacesOnRelease() {
        val tap = StudyTap(100.0, 100.0, slop)
        tap.move(104.0, 97.0)
        assertFalse(tap.moved)
        assertTrue(tap.release(105.0, 98.0, cancel = false))
    }

    @Test
    fun aCancelledContactNeverPlaces() {
        // ACTION_CANCEL, or FLAG_CANCELED on the pointer up: the system rejected the palm after delivering it.
        val tap = StudyTap(100.0, 100.0, slop)
        assertFalse(tap.release(100.0, 100.0, cancel = true))
    }

    @Test
    fun leavingTheSlopMakesItADragEvenIfItComesBack() {
        val tap = StudyTap(100.0, 100.0, slop)
        tap.move(100.0, 140.0)
        assertTrue(tap.moved)
        tap.move(100.0, 100.0)
        assertTrue(tap.moved, "a wandering palm does not become a tap by ending near where it began")
        assertFalse(tap.release(100.0, 100.0, cancel = false))
    }

    @Test
    fun theReleasePositionCountsTooBecauseTheLastEventMayCarryTheDisplacement() {
        val tap = StudyTap(100.0, 100.0, slop)
        assertFalse(tap.release(100.0, 130.0, cancel = false))
        assertTrue(tap.moved)
    }

    @Test
    fun aContactReleasesOnlyOnce() {
        val tap = StudyTap(0.0, 0.0, slop)
        assertTrue(tap.release(1.0, 1.0, cancel = false))
        assertFalse(tap.release(1.0, 1.0, cancel = false))
    }

    // -- what a placed tap does ----------------------------------------------------------

    @Test
    fun aStampTapAddsAndSelectsTheStamp() {
        val effect = assertNotNull(applyStudyTap(StudyTool.STAMP, 1, SPoint(0.4, 0.5), emptyList(), "check", null))
        val stamp = effect.items.single() as StudyStamp
        assertEquals(1, stamp.page)
        assertEquals(0.4, stamp.x)
        assertEquals(0.5, stamp.y)
        assertEquals("check", stamp.stamp)
        assertEquals(stamp.id, effect.select)
        assertNull(effect.tool)
        assertNull(effect.pending)
    }

    @Test
    fun theFirstLegendTapAddsOneAndLeavesTheToolTheSecondMovesIt() {
        val first = assertNotNull(applyStudyTap(StudyTool.LEGEND, 2, SPoint(0.9, 0.3), emptyList(), "gain", null))
        val legend = first.items.single() as StudyLegend
        assertEquals(0.7, legend.x, "a new legend stays on the page")
        assertEquals(StudyTool.SELECT, first.tool)

        val second = assertNotNull(applyStudyTap(StudyTool.LEGEND, 2, SPoint(0.2, 0.6), first.items, "gain", null))
        val moved = second.items.single() as StudyLegend
        assertEquals(legend.id, moved.id, "one legend per page")
        assertEquals(0.2, moved.x)
        assertEquals(0.6, moved.y)

        val otherPage = assertNotNull(applyStudyTap(StudyTool.LEGEND, 3, SPoint(0.1, 0.1), first.items, "gain", null))
        assertEquals(2, otherPage.items.filterIsInstance<StudyLegend>().size)
    }

    @Test
    fun measureTapsCollectPointsAndTheLastOneCommitsTheMeasure() {
        val items = emptyList<StudyAnnotation>()
        val first = assertNotNull(applyStudyTap(StudyTool.DISTANCE, 1, SPoint(0.1, 0.1), items, "gain", null))
        assertSame(items, first.items, "the first point commits nothing")
        assertNull(first.select)
        val pending = assertNotNull(first.pending)
        assertEquals(StudyPending(StudyTool.DISTANCE, 1, listOf(SPoint(0.1, 0.1))), pending)

        val second = assertNotNull(applyStudyTap(StudyTool.DISTANCE, 1, SPoint(0.5, 0.1), items, "gain", pending))
        val measure = second.items.single() as StudyMeasure
        assertEquals(MEASURE_DISTANCE, measure.mode)
        assertEquals(listOf(SPoint(0.1, 0.1), SPoint(0.5, 0.1)), measure.pts)
        assertEquals(measure.id, second.select)
        assertNull(second.pending, "the collected points are cleared")
    }

    @Test
    fun anAngleNeedsThreePointsAndALineAngleFour() {
        var pending: StudyPending? = null
        var items = emptyList<StudyAnnotation>()
        for (i in 1..2) {
            val step = assertNotNull(applyStudyTap(StudyTool.ANGLE, 1, SPoint(0.1 * i, 0.2), items, "gain", pending))
            assertTrue(step.items.isEmpty())
            pending = step.pending
        }
        val done = assertNotNull(applyStudyTap(StudyTool.ANGLE, 1, SPoint(0.5, 0.5), items, "gain", pending))
        items = done.items
        assertEquals(3, (items.single() as StudyMeasure).pts.size)

        var lines: StudyPending? = null
        for (i in 1..3) lines = assertNotNull(applyStudyTap(StudyTool.ANGLE_LINES, 1, SPoint(0.1 * i, 0.4), emptyList(), "gain", lines)).pending
        val fourth = assertNotNull(applyStudyTap(StudyTool.ANGLE_LINES, 1, SPoint(0.9, 0.9), emptyList(), "gain", lines))
        assertEquals(4, (fourth.items.single() as StudyMeasure).pts.size)
    }

    @Test
    fun aMeasureRestartsOnAnotherPageOrWithAnotherTool() {
        val pendingOnPage1 = StudyPending(StudyTool.DISTANCE, 1, listOf(SPoint(0.1, 0.1)))
        val otherPage = assertNotNull(applyStudyTap(StudyTool.DISTANCE, 2, SPoint(0.5, 0.5), emptyList(), "gain", pendingOnPage1))
        assertEquals(listOf(SPoint(0.5, 0.5)), otherPage.pending?.pts)
        assertEquals(2, otherPage.pending?.page)

        val otherTool = assertNotNull(applyStudyTap(StudyTool.ANGLE, 1, SPoint(0.5, 0.5), emptyList(), "gain", pendingOnPage1))
        assertEquals(listOf(SPoint(0.5, 0.5)), otherTool.pending?.pts)
    }

    @Test
    fun onlyTheTapToolsPlaceOnRelease() {
        for (tool in listOf(StudyTool.STAMP, StudyTool.LEGEND, StudyTool.ANGLE, StudyTool.ANGLE_LINES, StudyTool.DISTANCE)) {
            assertTrue(isTapTool(tool), "$tool")
        }
        for (tool in listOf(StudyTool.SELECT, StudyTool.CALLOUT, StudyTool.BRANCH, StudyTool.CROP, null)) {
            assertFalse(isTapTool(tool), "$tool")
            if (tool != null) assertNull(applyStudyTap(tool, 1, SPoint(0.5, 0.5), emptyList(), "gain", null))
        }
    }

    // -- the whole gesture ---------------------------------------------------------------

    /** The controller's sequence: arm on DOWN (items untouched), feed moves, apply the effect only when [StudyTap.release] says so. */
    private fun gesture(moves: List<Pair<Double, Double>>, up: Pair<Double, Double>, cancel: Boolean): StudyTapEffect? {
        val items = emptyList<StudyAnnotation>()
        val tap = StudyTap(200.0, 300.0, slop)
        // Nothing is committed while the contact is down: the effect is computed from the release only.
        for ((x, y) in moves) tap.move(x, y)
        return if (tap.release(up.first, up.second, cancel)) applyStudyTap(StudyTool.STAMP, 1, SPoint(0.25, 0.5), items, "gain", null) else null
    }

    @Test
    fun aStampIsPlacedOnlyByAnUncancelledStationaryRelease() {
        assertNotNull(gesture(listOf(201.0 to 300.0), 202.0 to 301.0, cancel = false))
        assertNull(gesture(listOf(201.0 to 300.0), 202.0 to 301.0, cancel = true), "palm rejection cancel")
        assertNull(gesture(listOf(260.0 to 300.0), 202.0 to 301.0, cancel = false), "dragged away")
        assertNull(gesture(emptyList(), 400.0 to 300.0, cancel = false), "released far from where it landed")
    }
}
