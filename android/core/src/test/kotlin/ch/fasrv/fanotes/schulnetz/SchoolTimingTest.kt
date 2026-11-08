package ch.fasrv.fanotes.schulnetz

import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.test.Test
import java.time.LocalDate
import java.time.ZonedDateTime

/** Synthetic data only. Mirrors the server cases in fanotes-site/schulnetz-logic.test.mjs. */
class SchoolTimingTest {
    private val at: ZonedDateTime = ZonedDateTime.of(2026, 11, 9, 13, 30, 0, 0, SCHOOL_ZONE)
    private val today: LocalDate = at.toLocalDate()
    private val blank = SchulnetzSnapshot()

    private fun change(category: String, body: String, date: String = "", id: String = "$category:x") =
        SchulnetzChange(id = id, category = category, title = "t", body = body, date = date)

    private fun exam(id: String, start: String, end: String) =
        AgendaEvent(id = id, start = start, end = end, text = "Biologie", comment = "", room = "R1", teachers = emptyList(), courseId = "", courseName = "Biologie", status = "", eventType = "1_pru", color = "", timetableText = "")

    private fun appointment(id: String, day: String) =
        AgendaEvent(id = id, start = "${day}T15:00:00", end = "${day}T16:00:00", text = "Anlass $id", comment = "", room = "Aula", teachers = emptyList(), courseId = "", courseName = "", status = "", eventType = "event", color = "", timetableText = "")

    @Test fun endedLessonsExamsAndAppointmentsAreOver() {
        assertTrue(changeIsOver(change("exam", "15.10.2026 · Mathematik · 14:55–15:40"), at))
        assertTrue(changeIsOver(change("exam", "09.11.2026 · Chemie · 08:15–09:00"), at))
        assertFalse(changeIsOver(change("exam", "09.11.2026 · Chemie · 14:00–14:45"), at))
        assertTrue(changeIsOver(change("timetable", "Deutsch", date = "2026-11-06"), at))
        assertFalse(changeIsOver(change("event", "Sporttag", date = "2026-11-20"), at))
    }

    @Test fun gradesAbsencesMessagesAndProbesNeverExpire() {
        assertFalse(changeIsOver(change("grade", "Mathematik 5.5", date = "2026-10-01"), at))
        assertFalse(changeIsOver(change("absence", "Deutsch", date = "2026-10-01"), at))
        assertFalse(changeIsOver(change("event", "Freitag 19 Uhr"), at))
        assertFalse(changeIsOver(change("exam", "01.01.2026", id = "probe:1"), at))
    }

    @Test fun diffDropsNoticesForPastExams() {
        val past = exam("p1", "2026-10-29T10:00:00", "2026-10-29T10:45:00")
        val future = exam("p2", "2026-11-19T10:00:00", "2026-11-19T10:45:00")
        val added = diffSnapshots(blank, blank.copy(exams = listOf(past, future)), NotifySettings(), today, at)
        assertEquals(listOf("2026-11-19"), added.map { it.date })
        val moved = diffSnapshots(blank.copy(exams = listOf(past)), blank.copy(exams = listOf(past.copy(start = "2026-10-29T12:00:00", end = "2026-10-29T12:45:00"))), NotifySettings(), today, at)
        assertTrue(moved.isEmpty())
    }

    @Test fun appointmentsTheListNewlyReachesStayQuiet() {
        val before = blank.copy(events = listOf(appointment("a", "2026-11-12"), appointment("b", "2026-12-03")))
        assertEquals(LocalDate.parse("2026-12-03"), appointmentHorizon(before))
        val inside = diffSnapshots(before, before.copy(events = before.events + appointment("c", "2026-11-26")), NotifySettings(), today, at)
        assertEquals(listOf("Neuer Termin"), inside.map { it.title })
        val beyond = diffSnapshots(before, before.copy(events = before.events + appointment("d", "2027-03-01")), NotifySettings(), today, at)
        assertTrue(beyond.isEmpty())
        val many = (0..APPOINTMENT_BURST).map { appointment("n$it", "2026-11-20") }
        assertTrue(diffSnapshots(before, before.copy(events = before.events + many), NotifySettings(), today, at).isEmpty())
        // With no earlier list, a single appointment is still news.
        assertEquals(listOf("Neuer Termin"), diffSnapshots(blank, blank.copy(events = listOf(appointment("e", "2026-11-25"))), NotifySettings(), today, at).map { it.title })
    }

    @Test fun emptySchedulerProvesAFreeWeekOnlyNextToLessonsOrInHolidays() {
        val holidays = listOf(SchoolVacation(id = "v", name = "Weihnachtsferien", start = "2026-12-21", end = "2027-01-03"))
        assertTrue(weekIsHoliday(LocalDate.parse("2026-12-28"), holidays))
        assertFalse(weekIsHoliday(LocalDate.parse("2026-11-16"), holidays))
        assertFalse(emptyWeekCountsAsRead(LocalDate.parse("2026-11-16"), false, holidays))
        assertTrue(emptyWeekCountsAsRead(LocalDate.parse("2026-11-16"), true, holidays))
        assertTrue(emptyWeekCountsAsRead(LocalDate.parse("2026-12-28"), false, holidays))
        val lesson = AgendaEvent(id = "l", start = "2026-11-10T08:15:00", end = "2026-11-10T09:00:00", text = "Deutsch", comment = "", room = "", teachers = emptyList(), courseId = "", courseName = "Deutsch", status = "", eventType = "lesson", color = "", timetableText = "")
        val kept = withoutUnprovenEmptyReads(mapOf("2026-11-09" to "x", "2026-11-16" to "x", "2026-12-28" to "x"), listOf(lesson), holidays)
        assertEquals(setOf("2026-11-09", "2026-12-28"), kept.keys)
    }

    @Test fun schoolYearRangeWithoutAPageRange() {
        val holidays = listOf(SchoolVacation(id = "v", name = "Weihnachtsferien", start = "2026-12-21", end = "2027-01-03"))
        val span = fallbackSchoolSpan(listOf(appointment("y", "2027-06-30")), holidays, today)
        assertEquals(WeekSpan(LocalDate.parse("2026-10-12"), LocalDate.parse("2027-06-30")), span)
        // Never narrower than the four-week probe.
        assertEquals(WeekSpan(LocalDate.parse("2026-10-12"), LocalDate.parse("2026-12-07")), fallbackSchoolSpan(listOf(appointment("z", "2026-11-10")), emptyList(), today))
        assertNull(fallbackSchoolSpan(emptyList(), emptyList(), today))
    }
}
