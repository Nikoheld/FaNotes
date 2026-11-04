package ch.fasrv.fanotes.schulnetz

import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class GuessGradeTest {
    private val today = LocalDate.of(2026, 11, 4)

    @Test
    fun celebrityAgeUsesHalfUpOnMarkTimesTen() {
        assertEquals(43, celebrityAge(4.3))
        assertEquals(43, celebrityAge(4.25))
        assertEquals(42, celebrityAge(4.24))
        assertEquals(41, celebrityAge(4.05))
        assertEquals(50, celebrityAge(5.0))
        assertEquals(10, celebrityAge(1.0))
        assertEquals(60, celebrityAge(6.0))
        assertEquals(45, celebrityAge(4.5))
        assertEquals(46, celebrityAge(4.55))
    }

    @Test
    fun ageOnCountsCompletedYearsFromBirthDate() {
        assertEquals(26, ageOn(LocalDate.of(2000, 11, 4), today))
        assertEquals(25, ageOn(LocalDate.of(2000, 11, 5), today))
        assertEquals(0, ageOn(LocalDate.of(2027, 1, 1), today))
        assertEquals(16, ageOn(LocalDate.of(2010, 5, 28), today))
        assertEquals(10, ageOn(LocalDate.of(2015, 12, 5), today))
        assertEquals(11, ageOn(LocalDate.of(2015, 5, 2), today))
    }

    @Test
    fun compareGuessRoundsToTheMarksOwnPrecision() {
        assertEquals(GuessComparison.CORRECT, compareGuess(4.5, 4.5))
        assertEquals(GuessComparison.CORRECT, compareGuess(5.47, 5.5))
        assertEquals(GuessComparison.ACTUAL_HIGHER, compareGuess(5.44, 5.5))
        assertEquals(GuessComparison.ACTUAL_HIGHER, compareGuess(4.0, 5.0))
        assertEquals(GuessComparison.ACTUAL_LOWER, compareGuess(5.5, 4.5))
        assertEquals(GuessComparison.CORRECT, compareGuess(4.25, 4.25))
        assertEquals(GuessComparison.ACTUAL_LOWER, compareGuess(4.3, 4.25))
        assertEquals(GuessComparison.CORRECT, compareGuess(5.4, 5.0))
        assertEquals(GuessComparison.CORRECT, compareGuess(4.5, 4.50))
        assertEquals(4.5, parseGuessMark("4,5"))
        assertEquals(4.25, parseGuessMark("4.25"))
        assertEquals(null, parseGuessMark("7"))
        assertEquals(null, parseGuessMark(""))
        assertEquals(1, markDecimals(4.5))
        assertEquals(2, markDecimals(4.25))
        assertEquals(0, markDecimals(5.0))
    }

    @Test
    fun catalogCoversEveryAgeFromTenToSixtyWithAtLeastTwoPeople() {
        for (age in 10..60) {
            val people = celebritiesAtAge(age, today)
            assertTrue(people.size >= 2, "age $age has ${people.size} people")
            assertTrue(people.size >= 3, "age $age has ${people.size} people")
        }
        val first = pickCelebrity(43, "grade-a", today)
        val same = pickCelebrity(43, "grade-a", today)
        val other = pickCelebrity(43, "grade-b", today)
        assertNotNull(first)
        assertEquals(first, same)
        assertEquals(43, ageOn(first.born, today))
        assertTrue(other == null || ageOn(other.born, today) == 43)
    }

    @Test
    fun hiddenNotificationsAndAveragesDoNotLeakTheMark() {
        val grade = SchoolGrade("g1", "Mathematik", "math", "Mathematik", "Probe", "2026-11-01", 5.5, 1.0, true, null, "")
        val older = SchoolGrade("g0", "Mathematik", "math", "Mathematik", "Alte Probe", "2026-09-01", 4.0, 1.0, true, null, "")
        val snapshot = SchulnetzSnapshot(grades = listOf(older, grade))
        val change = diffSnapshots(SchulnetzSnapshot(grades = listOf(older)), snapshot).single { it.category == "grade" }
        assertTrue(change.body.contains("5,5") || change.body.contains("5.5"))
        val hidden = prepareGradeNotifications(listOf(change), guessGrades = true, snapshot = snapshot).single()
        assertEquals("Neue Note in Mathematik – tippen zum Aufdecken", hidden.title)
        assertEquals("Probe", hidden.body)
        assertFalse(hidden.title.contains("5"))
        assertFalse(hidden.body.contains("5,5"))
        assertFalse(hidden.body.contains("5.5"))
        val payload = notifyPayload(hidden)
        assertFalse(payload.contains("5,5"))
        assertFalse(payload.contains("5.5"))
        assertEquals("grade:g1:hidden", hidden.id)
        assertFalse(payload.contains("5.5|"))
        val shown = groupGradeChanges(listOf(change, change.copy(id = "grade:other")))
        assertTrue(shown.first().body.contains("5"))
        val id = gradeTargetId(grade)
        val open = courseSummaries(listOf(older, grade)).single()
        assertEquals(4.75, open.average)
        val masked = courseSummaries(listOf(older, grade), hiddenTargetIds = setOf(id)).single()
        assertEquals(4.0, masked.average)
        assertEquals(2, masked.marks.size)
        assertEquals(5.5, highestVisibleMark(listOf(older, grade), emptySet(), guessGrades = false))
        assertEquals(4.0, highestVisibleMark(listOf(older, grade), setOf(id), guessGrades = true))
        assertEquals(listOf(id), newGradeTargetIds(listOf(change)))
    }
}
