package ch.fasrv.fanotes.schulnetz

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class GradeTrendTest {
    private fun mark(value: Double, weight: Double, date: String, counted: Boolean = true, label: String = "T") =
        WeightedMark(value, weight, label, counted = counted, date = date)

    @Test
    fun ordersByDateAndRunsAverage() {
        // List order is newest first, like the school list.
        val points = trendPoints(listOf(mark(6.0, 1.0, "2026-03-01"), mark(4.0, 1.0, "2026-02-01"), mark(5.0, 2.0, "2026-01-01")))
        assertEquals(listOf(5.0, 4.0, 6.0), points.map { it.mark })
        assertEquals(5.0, points[0].running, 1e-9)
        assertEquals((10.0 + 4.0) / 3.0, points[1].running, 1e-9)
        assertEquals((10.0 + 4.0 + 6.0) / 4.0, points[2].running, 1e-9)
    }

    @Test
    fun hiddenAndExcludedMarksNeverAppear() {
        val points = trendPoints(listOf(mark(1.0, 1.0, "2026-03-01", counted = false), mark(5.0, 1.0, "2026-02-01")))
        assertEquals(1, points.size)
        assertEquals(5.0, points[0].mark, 0.0)
        assertTrue(trendPoints(listOf(mark(2.0, 1.0, "2026-03-01", counted = false))).isEmpty())
    }

    @Test
    fun sameDateKeepsReverseListOrderAndSchoolDatesParse() {
        val points = trendPoints(listOf(mark(5.0, 1.0, "05.03.2026", label = "b"), mark(4.0, 1.0, "05.03.2026", label = "a")))
        assertEquals(listOf("a", "b"), points.map { it.label })
        assertEquals("2026-03-05", points[0].date)
    }

    @Test
    fun zeroWeightUsesOwnMarkUntilWeightsExist() {
        val points = trendPoints(listOf(mark(5.0, 1.0, "2026-02-01"), mark(3.0, 0.0, "2026-01-01")))
        assertEquals(3.0, points[0].running, 0.0)
        assertEquals(5.0, points[1].running, 0.0)
    }

    @Test
    fun domainContainsPassLineAndStaysOnScale() {
        assertEquals(3 to 5, trendDomain(emptyList()))
        val low = trendDomain(trendPoints(listOf(mark(1.5, 1.0, "2026-01-01"))))
        assertEquals(1, low.first)
        assertEquals(5, low.second)
        assertEquals(6, trendDomain(trendPoints(listOf(mark(5.5, 1.0, "2026-01-01")))).second)
    }

    private fun course(id: String, average: Double?) =
        CourseSummary(id, id, average, null, 0.0, false, 1.0, emptyList())

    @Test
    fun highlightsCountBelowFourAndPickBest() {
        val h = gradeHighlights(listOf(course("A", 3.5), course("B", 5.25), course("C", null), course("D", 4.0), course("E", 3.9)))
        assertEquals(2, h.belowFour)
        assertEquals(4, h.averaged)
        assertEquals("B", assertNotNull(h.best).courseId)
        assertNull(gradeHighlights(listOf(course("C", null))).best)
    }
}
