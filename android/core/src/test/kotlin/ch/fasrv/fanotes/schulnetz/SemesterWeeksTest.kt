package ch.fasrv.fanotes.schulnetz

import java.time.Instant
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Anonymized Schulnetz 5.14.1 page shapes (make-fixtures.mjs): semester range and fresh transid. */
class SemesterWeeksTest {
    private fun fixture(name: String) = checkNotNull(javaClass.getResource("/schulnetz/$name")) { name }.readText()
    private val semester = WeekSpan(LocalDate.parse("2026-08-10"), LocalDate.parse("2027-01-29"))

    @Test fun theSemesterRangeComesFromTheRealMarkers() {
        assertEquals(semester, parseWeekSpan(fixture("stundenplan-5141.html")))
        assertEquals(semester, parseWeekSpan(fixture("pruefungsplan-5141.html")))
        // Each marker on its own. The grid view's "to" and the guard date are exclusive.
        assertEquals(semester, semesterSpan("""scheduler.createGridView({name:"grid",fields:[{id:"a"},{id:"b"}],from:new Date("2026-08-10"),to:new Date("2027-01-30")});"""))
        assertEquals(semester, semesterSpan("""return scheduler.templates.day_date(new Date("2026-08-10"))+" &ndash; "+scheduler.templates.day_date(scheduler.date.add(new Date("2027-01-30"),-1,"day"));"""))
        assertEquals(semester, semesterSpan("""<input id="zeitraum_von" value="10.08.2026"><input id="zeitraum_bis" value="29.01.2027">"""))
        assertEquals(semester, semesterSpan("""<input id="zeitraum_von" value="10.08.2026"> if('2027-01-30'<max_date) alert('Folgesemester')"""))
        // The older synthetic page and a page without markers have no range.
        assertNull(parseWeekSpan(fixture("stundenplan.html")))
        assertNull(semesterSpan("<html><body>Stundenplan</body></html>"))
    }

    @Test fun theSchedulerUsesTheTransidThePagePrinted() {
        val plan = fixture("stundenplan-5141.html")
        val exams = fixture("pruefungsplan-5141.html")
        assertEquals("a1b2c3", schedulerTransid(plan, "22202"))
        assertNull(schedulerTransid(plan, "21312"))
        assertEquals("b2c3d4", schedulerTransid(exams, "21312"))
        // The request URL carried an older transid; the page's own one wins.
        val ids = sessionIdsFromPage("https://www.schulnetz-ag.ch/aksa/index.php?pageid=22202&id=f1a2b3c4d5e6f708&transid=e0e0e0", plan)
        assertEquals("a1b2c3", ids?.transid)
        assertEquals("f1a2b3c4d5e6f708", ids?.id)
        assertEquals("page-scheduler", ids?.source)
    }

    @Test fun everyWeekOfTheSemesterIsPlannedAndUnreadWeeksComeBackSoon() {
        val today = LocalDate.parse("2026-11-06")
        val now = Instant.parse("2026-11-06T17:00:00Z")
        val mondays = mondaysBetween(semester.start, semester.end)
        assertEquals(LocalDate.parse("2026-08-10"), mondays.first())
        assertEquals(LocalDate.parse("2027-01-25"), mondays.last())
        val first = planWeekFetches(mondays, emptyMap(), "", now, today, false)
        // Coming weeks first: the far batch reaches into December before any past week.
        assertTrue(first.fetch.contains(LocalDate.parse("2026-11-09")))
        assertTrue(first.fetch.filter { it > today.plusWeeks(4) }.size == WEEK_BATCH)
        assertTrue(first.fetch.none { it < today.minusWeeks(5) })
        // A week asked an hour ago that never answered with proof is asked again; a confirmed one is not.
        val stamp = "2026-11-06T16:00:00Z"
        val stamps = mapOf("2026-11-23" to stamp, "2026-11-30" to stamp)
        val again = planWeekFetches(mondays, stamps, "", now, today, false, unreadWeeks = setOf("2026-11-23"))
        assertTrue(LocalDate.parse("2026-11-23") in again.fetch)
        assertTrue(LocalDate.parse("2026-11-30") !in again.fetch)
    }
}
