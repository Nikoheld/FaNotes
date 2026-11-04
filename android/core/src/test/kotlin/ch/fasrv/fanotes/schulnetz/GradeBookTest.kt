package ch.fasrv.fanotes.schulnetz

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class GradeBookTest {
    private val school = SchoolGrade("g", "Mathematik", "math", "Mathematik", "Probe", "2026-10-01", 4.0, 1.0, true, null, "")

    @Test
    fun ownGradesCountInAveragePluspunkteAndTheTarget() {
        val book = GradeBook(own = listOf(OwnGrade("o", "math", "Essay", 6.0, 1.0, "2026-11-04")))
        val summary = courseSummaries(listOf(school), book = book).single()
        assertEquals(5.0, summary.average)
        assertEquals(5.0, summary.zeugnis)
        assertEquals(1.0, summary.pluspunkte)
        assertEquals(4.0, summary.marks.first { !it.own }.mark)
        assertTrue(summary.marks.first { it.own }.own)
        assertEquals("Essay", summary.marks.first { it.own }.label)
        val withOwn = wunschnote(countingMarks(summary.marks), target = 5.0, nextWeight = 1.0)
        assertEquals(5.0, withOwn.needed)
        assertEquals(5.0, withOwn.neededHalf)
        val without = wunschnote(countingMarks(courseSummaries(listOf(school)).single().marks), target = 5.0, nextWeight = 1.0)
        assertEquals(6.0, without.needed)
        assertFalse(without.alreadyMet)
    }

    @Test
    fun collectiveGradeCountsOnce() {
        val collective = CollectiveGrade(
            id = "c",
            courseId = "math",
            title = "Reading",
            date = "2026-11-04",
            weight = 2.0,
            parts = listOf(
                CollectivePart("p1", "Part A", 4.0, 1.0),
                CollectivePart("p2", "Part B", 6.0, 1.0),
            ),
        )
        assertEquals(5.0, collectiveValue(collective.parts))
        assertNull(collectiveValue(collective.parts.take(1)))
        val summary = courseSummaries(listOf(school), book = GradeBook(collective = listOf(collective))).single()
        assertEquals(1, summary.marks.count { it.collective })
        assertEquals(2, summary.marks.size)
        assertEquals(4.667, kotlin.math.round(summary.average!! * 1000.0) / 1000.0)
        assertEquals(4.5, summary.zeugnis)
        assertEquals(0.5, summary.pluspunkte)
        assertEquals(3.0, summary.weight)
    }

    @Test
    fun adjustmentChangesOnlyTheCalculationAndRestoreDropsIt() {
        val id = gradeTargetId(school)
        val overridden = GradeBook(adjustments = listOf(GradeAdjustment(id, mark = 5.5, weight = 2.0)))
        val changed = courseSummaries(listOf(school), book = overridden).single()
        val mark = changed.marks.single()
        assertEquals(5.5, changed.average)
        assertEquals(5.5, mark.mark)
        assertEquals(2.0, mark.weight)
        assertEquals(4.0, mark.displayMark)
        assertEquals(1.0, mark.displayWeight)
        assertTrue(mark.adjusted)
        assertFalse(mark.excluded)
        val excluded = courseSummaries(listOf(school), book = GradeBook(adjustments = listOf(GradeAdjustment(id, excluded = true)))).single()
        assertNull(excluded.average)
        assertEquals(4.0, excluded.marks.single().displayMark)
        assertTrue(excluded.marks.single().excluded)
        assertFalse(excluded.marks.single().counted)
        val restored = courseSummaries(listOf(school), book = GradeBook()).single()
        assertEquals(4.0, restored.average)
        assertFalse(restored.marks.single().adjusted)
    }

    @Test
    fun archivedSubjectsLeaveTheAverages() {
        val deutsch = SchoolGrade("d", "Deutsch", "de", "Deutsch", "Probe", "2026-10-01", 3.0, 1.0, true, null, "")
        val courses = courseSummaries(listOf(school, deutsch), book = GradeBook(archivedCourseIds = listOf("de")))
        val active = activeCourses(courses)
        assertEquals(listOf("math"), active.map { it.courseId })
        assertTrue(courses.single { it.courseId == "de" }.archived)
        assertEquals(0.0, promotionTotals(active).total)
        assertEquals(-2.0, promotionTotals(courses).total)
        assertEquals(4.0, overallAverage(active))
    }

    @Test
    fun hiddenMarksStayOutOfTheOverallAverage() {
        val older = SchoolGrade("g0", "Mathematik", "math", "Mathematik", "Alte Probe", "2026-09-01", 4.0, 1.0, true, null, "")
        val grade = school.copy(id = "g1", title = "Probe", mark = 5.5)
        val id = gradeTargetId(grade)
        val open = courseSummaries(listOf(older, grade))
        val masked = courseSummaries(listOf(older, grade), hiddenTargetIds = setOf(id))
        assertEquals(4.75, open.single().average)
        assertEquals(4.0, masked.single().average)
        assertEquals(4.75, overallAverage(open))
        assertEquals(4.0, overallAverage(masked))
        assertEquals(2, masked.single().marks.size)
        assertFalse(masked.single().marks.single { it.targetId == id }.counted)
    }

    @Test
    fun gradeBookRoundTripsAndDropsEmptyAdjustments() {
        val book = GradeBook(
            own = listOf(OwnGrade("o", "math", "Say \"hi\"", 5.5, 1.0, "2026-11-04")),
            collective = listOf(
                CollectiveGrade(
                    "c", "math", "Reading", "2026-11-04", 1.0,
                    listOf(CollectivePart("a", "A", 4.0, 1.0), CollectivePart("b", "B", 5.0, 2.0)),
                ),
            ),
            adjustments = listOf(GradeAdjustment("target", mark = 6.0), GradeAdjustment("gone")),
            archivedCourseIds = listOf("de", "de", " "),
        )
        val stored = parseGradeBook(serializeGradeBook(book))
        assertEquals(book.own, stored.own)
        assertEquals(book.collective, stored.collective)
        assertEquals(listOf(GradeAdjustment("target", mark = 6.0)), stored.adjustments)
        assertEquals(listOf("de"), stored.archivedCourseIds)
        assertEquals(GradeBook(), parseGradeBook(""))
        assertEquals("2026-11-04", parseGradeDate("4.11.2026"))
        assertEquals("2026-11-04", parseGradeDate("2026-11-04"))
        assertEquals("4.11.2026", formatGradeDate("2026-11-04"))
    }

    @Test
    fun longPressRevealIsOptionalAndOffByDefault() {
        assertFalse(DeskPrefs().revealLongPress)
        val stored = parseDeskPrefs(serializeDeskPrefs(DeskPrefs(revealLongPress = true)))
        assertTrue(stored.revealLongPress)
        assertFalse(parseDeskPrefs("""{"theme":"system"}""").revealLongPress)
        assertEquals("Hidden · tap to reveal", hiddenMarkHint(false))
        assertEquals("Hidden · hold to reveal", hiddenMarkHint(true))
    }
}
