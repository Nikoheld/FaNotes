package ch.fasrv.fanotes.schulnetz

import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
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

    @Test
    fun revealCountClimbsByTenthsAndSlowsDownOntoTheExactMark() {
        val steps = gradeRevealSteps(4.75)
        assertEquals(1.0, steps.first().value)
        assertEquals(0L, steps.first().delayBeforeMs)
        assertEquals(4.75, steps.last().value)
        assertTrue(steps.none { kotlin.math.abs(it.value - 4.8) < 1e-9 })
        for (index in 0 until steps.lastIndex) {
            assertEquals(10L + index, Math.round(steps[index].value * 10.0), "step $index")
        }
        val waits = steps.drop(1).map { it.delayBeforeMs }
        assertTrue(waits.zipWithNext().all { (earlier, later) -> later > earlier })
        val total = waits.sum()
        assertTrue(total in 2_000..3_500, "4.75 took ${total}ms")
        val low = gradeRevealSteps(1.1).drop(1).sumOf { it.delayBeforeMs }
        val mid = gradeRevealSteps(4.0).drop(1).sumOf { it.delayBeforeMs }
        val high = gradeRevealSteps(6.0).drop(1).sumOf { it.delayBeforeMs }
        assertTrue(low in 2_000..2_200, "1.1 took ${low}ms")
        assertTrue(mid in low + 1 until high, "4.0 took ${mid}ms")
        assertEquals(3_500L, high)
        assertEquals(1.0, gradeRevealSteps(1.0).single().value)
        assertEquals(0L, gradeRevealSteps(1.0).single().delayBeforeMs)
        assertEquals(5.5, gradeRevealSteps(5.5).last().value)
        assertEquals(6.0, gradeRevealSteps(6.0).last().value)
    }

    @Test
    fun agePromptIsOnlyThePortraitOfSomeoneThatAge() {
        val today = LocalDate.of(2026, 11, 4)
        val plain = Celebrity("Plain Person", LocalDate.of(1983, 1, 1), "no portrait")
        val pictured = Celebrity("Pictured Person", LocalDate.of(1983, 6, 2), "has portrait", "Pictured Person 2020.jpg")
        val otherAge = Celebrity("Younger Person", LocalDate.of(2016, 1, 1), "other age", "Younger Person.jpg")
        val catalog = listOf(plain, pictured, otherAge)
        val prompt = celebrityAgePrompt(4.3, "grade-a", today, catalog)
        assertEquals(
            "https://commons.wikimedia.org/wiki/Special:FilePath/Pictured%20Person%202020.jpg?width=640",
            prompt.imageUrl,
        )
        assertFalse(prompt.imageUrl!!.contains("43"))
        assertFalse(prompt.imageUrl!!.contains("4.3"))
        assertFalse(prompt.imageUrl!!.contains("4,3"))
        assertNull(celebrityAgePrompt(4.3, "grade-a", today, listOf(plain, otherAge)).imageUrl)
        assertEquals("Younger Person", pickCelebrityPhoto(10, "grade-a", today, catalog)?.name)
        assertNull(pickCelebrityPhoto(43, "grade-a", today, listOf(plain)))
        assertNull(portraitUrl(""))
        assertNull(portraitUrl("../other.jpg"))
        assertNull(portraitUrl("https://example.test/a.jpg"))
        assertNull(portraitUrl("notes.gif"))
        assertEquals(40, parseAgeGuess("40"))
        assertEquals(null, parseAgeGuess("4.5"))
        assertEquals(null, parseAgeGuess("0"))
        assertEquals(null, parseAgeGuess("121"))
    }

    @Test
    fun theAnswerStaysHiddenUntilTheAgeGuessIsSettled() {
        val today = LocalDate.of(2026, 11, 4)
        val pictured = Celebrity("Pictured Person", LocalDate.of(1983, 6, 2), "portrait", "Pictured Person 2020.jpg")
        val neighbor = Celebrity("Neighbor Person", LocalDate.of(1984, 6, 2), "other age", "Neighbor Person.jpg")
        val plain = Celebrity("Plain Person", LocalDate.of(1983, 1, 1), "no portrait")
        val catalog = listOf(pictured, neighbor, plain)
        val grade = SchoolGrade("g1", "Mathematik", "math", "Mathematik", "Probe", "2026-11-01", 4.3, 1.0, true, null, "")
        val older = SchoolGrade("g0", "Mathematik", "math", "Mathematik", "Alte Probe", "2026-09-01", 4.0, 1.0, true, null, "")
        val snapshot = SchulnetzSnapshot(grades = listOf(older, grade))
        val change = diffSnapshots(SchulnetzSnapshot(grades = listOf(older)), snapshot).single { it.category == "grade" }
        val hidden = prepareGradeNotifications(listOf(change), guessGrades = true, snapshot = snapshot).single()
        val id = gradeTargetId(grade)
        val url = "https://commons.wikimedia.org/wiki/Special:FilePath/Pictured%20Person%202020.jpg?width=640"
        val prompt = celebrityAgePrompt(4.3, id, today, catalog)
        assertEquals(CelebrityAgePrompt(url), prompt)
        assertFalse(prompt.toString().contains("43"))
        assertFalse(prompt.toString().contains("4.3"))
        assertFalse(prompt.toString().contains("4,3"))
        assertFalse(prompt.toString().contains("1983"))
        assertEquals(url, hiddenGradePortraitUrl(true, hidden, 4.3, today, catalog))
        assertEquals(prompt.imageUrl, hiddenGradePortraitUrl(true, hidden, grade.mark, today, catalog))
        assertFalse(hidden.title.contains("43"))
        assertFalse(hidden.body.contains("43"))
        assertFalse(hidden.title.contains("4.3") || hidden.title.contains("4,3"))
        assertFalse(hidden.body.contains("4.3") || hidden.body.contains("4,3"))
        assertFalse(hidden.title.contains(url))
        assertFalse(hidden.body.contains(url))
        assertNull(hiddenGradePortraitUrl(true, hidden.copy(targetIds = listOf(id, "other"), targetId = "$id,other"), 4.3, today, catalog))
        assertNull(hiddenGradePortraitUrl(false, hidden, 4.3, today, catalog))
        assertNull(hiddenGradePortraitUrl(true, hidden, 4.3, today, listOf(plain, neighbor)))
        assertNull(ageConnection(4.3, settled = false, fromAge = true, ageGuess = 40))
        assertNull(ageConnection(4.3, settled = true, fromAge = false, ageGuess = 40))
        assertEquals(AgeConnection(43, 40), ageConnection(4.3, settled = true, fromAge = true, ageGuess = 40))
        assertEquals(AgeConnection(43, null), ageConnection(4.3, settled = true, fromAge = true, ageGuess = 0))
        assertEquals("?", courseSummaries(listOf(grade), hiddenTargetIds = setOf(id)).single().let {
            if (it.average == null) "?" else it.average.toString()
        })
    }

    @Test
    fun hiddenGradeNoticeDoesNotContainTheAgeOrTheMark() {
        val grade = SchoolGrade("g1", "Mathematik", "math", "Mathematik", "Probe", "2026-11-01", 4.3, 1.0, true, null, "")
        val older = SchoolGrade("g0", "Mathematik", "math", "Mathematik", "Alte Probe", "2026-09-01", 4.0, 1.0, true, null, "")
        val snapshot = SchulnetzSnapshot(grades = listOf(older, grade))
        val change = diffSnapshots(SchulnetzSnapshot(grades = listOf(older)), snapshot).single { it.category == "grade" }
        val hidden = prepareGradeNotifications(listOf(change), guessGrades = true, snapshot = snapshot).single()
        val prompt = celebrityAgePrompt(4.3, gradeTargetId(grade), today)
        assertFalse(hidden.title.contains("43"))
        assertFalse(hidden.body.contains("43"))
        assertFalse(hidden.title.contains("4.3") || hidden.title.contains("4,3"))
        assertFalse(hidden.body.contains("4.3") || hidden.body.contains("4,3"))
        assertTrue(prompt.imageUrl == null || !hidden.title.contains(prompt.imageUrl!!))
        assertTrue(prompt.imageUrl == null || !hidden.body.contains(prompt.imageUrl!!))
        assertEquals("?", courseSummaries(listOf(grade), hiddenTargetIds = setOf(gradeTargetId(grade))).single().let {
            if (it.average == null) "?" else it.average.toString()
        })
    }

    @Test
    fun aRealPortraitIsNeverBorrowedFromAnotherAge() {
        val filesByBirth = linkedMapOf<String, MutableSet<String>>()
        for (person in CELEBRITIES) {
            if (portraitUrl(person.photoFile) == null) continue
            filesByBirth.getOrPut(person.born.toString()) { linkedSetOf() }.add(person.photoFile)
        }
        val seen = linkedMapOf<String, String>()
        for ((born, files) in filesByBirth) {
            for (file in files) {
                val other = seen.put(file, born)
                assertTrue(other == null || other == born, "$file is used for $other and $born")
            }
        }
        for (age in 10..60) {
            val person = pickCelebrityPhoto(age, "grade-$age", today)
            if (person == null) {
                assertTrue(celebritiesAtAge(age, today).none { portraitUrl(it.photoFile) != null })
            } else {
                assertEquals(age, ageOn(person.born, today))
                assertNotNull(portraitUrl(person.photoFile))
                assertTrue(celebritiesAtAge(age, today).any { it.photoFile == person.photoFile })
            }
        }
    }
}
