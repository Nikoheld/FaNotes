package ch.fasrv.fanotes.schulnetz

import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class PlannedAbsencesTest {
    private val today = LocalDate.of(2026, 11, 10)

    private fun lesson(id: String, day: String, from: String, to: String, name: String = "geo 2.3") =
        AgendaEvent(id, "${day}T$from:00", "${day}T$to:00", name, "", "", emptyList(), id, name, "", "0_stp", "", name)

    // Wed 11.11. and Thu 12.11.2026 lessons.
    private val lessons = listOf(
        lesson("1", "2026-11-11", "08:00", "08:45"),
        lesson("2", "2026-11-11", "08:45", "09:30"),
        lesson("3", "2026-11-11", "09:45", "10:30", "mat 2.1"),
        lesson("4", "2026-11-11", "13:15", "14:00", "bio 2.1"),
    )
    private val snapshot = SchulnetzSnapshot(events = lessons, absenceQuota = 30.0, absenceRemaining = 30.0)

    private fun plan(id: String, day: String, from: String, to: String, subject: String = "geo 2.3") = PlannedAbsence(id, day, from, to, subject, id, 1L)

    private fun open(id: String, day: String, from: String, to: String) =
        SchoolAbsence(id, day, day, from, to, "geo 2.3", "", false, false, "offen", pending = true)

    @Test
    fun aPlannedDoubleLessonCostsThree() {
        val result = provisionalTally(snapshot, listOf(plan("a", "2026-11-11", "08:00", "08:45"), plan("b", "2026-11-11", "08:45", "09:30")), today)
        assertEquals(3, result.tally.estimated)
        assertEquals(0, result.current.estimated)
        assertEquals(3, result.plannedPoints)
        assertEquals(27.0, result.tally.remaining)
        assertEquals(3, result.blockPoints(plan("a", "2026-11-11", "08:00", "08:45")))
        assertTrue(result.items.all { it.state == PlannedState.Upcoming })
    }

    @Test
    fun aPlannedLessonNextToAnOpenReportJoinsItsBlock() {
        val withOpen = snapshot.copy(absences = listOf(open("o1", "11.11.2026", "08:00", "08:45")))
        assertEquals(2, absenceTally(withOpen).estimated)
        val result = provisionalTally(withOpen, listOf(plan("b", "2026-11-11", "08:45", "09:30")), today)
        // Two lessons in a row: 3, not 2 + 2.
        assertEquals(3, result.tally.estimated)
        assertEquals(1, result.plannedPoints)
    }

    @Test
    fun aPlannedLessonThatLaterAppearsAsAnOpenReportIsNotCountedTwice() {
        val planned = listOf(plan("a", "2026-11-11", "08:00", "08:45"))
        val withOpen = snapshot.copy(absences = listOf(open("o1", "11.11.2026", "08:00", "08:45")))
        val result = provisionalTally(withOpen, planned, today)
        assertEquals(PlannedState.Matched, result.items.single().state)
        assertEquals(2, result.tally.estimated)
        assertEquals(0, result.plannedPoints)
        assertNull(result.blockPoints(planned.single()))
    }

    @Test
    fun aBookedEntryOnThatDayMatches() {
        val booked = SchoolAbsence("abs-1", "11.11.2026", "11.11.2026", "", "", "", "Krankheit", false, true, "gebucht", points = 3.0)
        val result = provisionalTally(snapshot.copy(absences = listOf(booked), absenceRemaining = 27.0), listOf(plan("a", "2026-11-11", "08:00", "08:45")), today)
        assertEquals(PlannedState.Matched, result.items.single().state)
        assertEquals(0, result.tally.estimated)
        assertEquals(3.0, result.tally.booked)
        assertEquals(27.0, result.tally.remaining)
    }

    @Test
    fun aNonOverlappingTimeOnTheSameDayDoesNotMatch() {
        val withOpen = snapshot.copy(absences = listOf(open("o1", "11.11.2026", "13:15", "14:00")))
        val items = matchPlanned(listOf(plan("a", "2026-11-11", "08:00", "08:45")), withOpen, today)
        assertEquals(PlannedState.Upcoming, items.single().state)
    }

    @Test
    fun aPastPlanWithoutARealAbsenceIsNotEnteredAndNotCounted() {
        val result = provisionalTally(snapshot, listOf(plan("a", "2026-11-09", "08:00", "08:45")), today)
        assertEquals(PlannedState.NotEntered, result.items.single().state)
        assertEquals(0, result.tally.estimated)
        assertEquals(1, result.notEntered.size)
        // Today still counts as upcoming.
        assertEquals(PlannedState.Upcoming, matchPlanned(listOf(plan("t", "2026-11-10", "08:00", "08:45")), snapshot, today).single().state)
    }

    @Test
    fun aPlannedExamLessonCostsTen() {
        val exam = AgendaEvent("exam-1", "2026-11-11T13:15:00", "2026-11-11T14:00:00", "bio 2.1 Prüfung", "", "", emptyList(), "", "bio 2.1 Prüfung", "", "exam", "", "bio 2.1 Prüfung")
        val result = provisionalTally(snapshot.copy(exams = listOf(exam)), listOf(plan("e", "2026-11-11", "13:15", "14:00", "bio 2.1")), today)
        assertEquals(10, result.tally.estimated)
        assertEquals(20.0, result.tally.remaining)
    }

    @Test
    fun storageRoundTripsAndSkipsBrokenRows() {
        val items = listOf(plan("a", "2026-11-11", "08:00", "08:45", "Mathe \"2\""), plan("b", "2026-11-12", "09:00", "09:45"))
        assertEquals(items, parsePlannedAbsences(serializePlannedAbsences(items)))
        assertTrue(parsePlannedAbsences("nope").isEmpty())
        assertEquals(1, parsePlannedAbsences("""{"items":[{"id":"x","date":"bad"},{"id":"y","date":"2026-11-11","start":"08:00","end":"08:45","subject":"s"}]}""").size)
    }

    @Test
    fun markingALessonStoresItOnceAndFindsItAgain() {
        val first = lessons.first()
        val marked = planAbsence(first, emptyList(), 5L)
        assertEquals(1, marked.size)
        assertEquals("2026-11-11", marked.single().date)
        assertEquals("08:00", marked.single().start)
        assertEquals("08:45", marked.single().end)
        assertEquals(marked, planAbsence(first, marked, 6L))
        assertNotNull(plannedFor(first, marked))
        assertNull(plannedFor(lessons[1], marked))
    }
}
