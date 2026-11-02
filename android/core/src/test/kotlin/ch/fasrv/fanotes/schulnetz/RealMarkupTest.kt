package ch.fasrv.fanotes.schulnetz

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class RealMarkupTest {
    private fun fixture(name: String): String =
        checkNotNull(javaClass.getResource("/schulnetz/$name")) { name }.readText()

    @Test
    fun gradesKeepCourseAveragesAndIndividualExams() {
        val grades = readGradesPage(fixture("noten.html"))
        assertNull(grades.error)
        val courses = grades.value.filter { it.title == "Durchschnitt" }
        assertEquals(13, courses.size)
        assertEquals(3.1, courses.first { it.course.contains("MAT_") }.mark)
        assertEquals(4.2, courses.first { it.subject.contains("Chemie") }.mark)
        assertNull(courses.first { it.subject.contains("Biologie") }.mark)
        val chem = grades.value.filter { it.course.contains("Chemie") && it.title != "Durchschnitt" }
        assertTrue(chem.isNotEmpty())
        assertEquals("2026-09-17", chem.first().date)
        assertEquals(4.2, chem.first().mark)
    }

    @Test
    fun absencesPageWithNoRowsIsEmpty() {
        val read = readAbsencesPage(fixture("absenzen.html"))
        assertNull(read.error)
        assertTrue(read.value.isEmpty())
    }

    @Test
    fun kontoauszugReadsTheClassAccount() {
        val lines = parseKontoauszug(fixture("kontoauszug.html"))
        assertEquals(11, lines.size)
        assertEquals("11.10.2026", lines.first().date)
        assertTrue(lines.first().amount.contains("-56.95"))
        assertTrue(lines.last().balance.isNotBlank())
    }

    @Test
    fun terminlistePageOneHasTwentyFiveRows() {
        val html = fixture("terminliste.html")
        val events = readTerminliste(html)
        assertNull(events.error)
        assertEquals(25, events.value.size)
        assertEquals("Lunchtimekonzert", events.value.first().text)
        assertEquals(173, terminlisteTotal(html))
        assertTrue(terminlisteNextUrl(html, AKSA_SCHULNETZ_BASE)!!.contains("sRow=25"))
    }

    @Test
    fun stundenplanReadsRenderedLessons() {
        val lessons = parseRenderedTimetable(fixture("stundenplan.html"))
        assertEquals(45, lessons.size)
        val first = lessons.first { it.start.startsWith("2026-11-02T07:45") }
        assertEquals("222", first.room)
        assertTrue(first.text.contains("Amat"))
        assertEquals(
            "https://www.schulnetz-ag.ch/aksa/scheduler_processor.php?view=week&curr_date=2026-11-04&min_date=2026-11-02&max_date=2026-11-09&ansicht=schueleransicht&id=abc&transid=def&pageid=22202&timeshift=-60",
            schedulerUrl(AKSA_SCHULNETZ_BASE, "abc", "def", "2026-11-04", "2026-11-02", "2026-11-09"),
        )
    }

    @Test
    fun examPlanIsEmptyThisWeekAndUsesTheClassOverview() {
        val html = fixture("pruefungsplan.html")
        val exams = readExamsPage(html)
        assertNull(exams.error)
        assertTrue(exams.value.isEmpty())
        assertEquals(
            "https://www.schulnetz-ag.ch/aksa/scheduler_processor.php?view=week&curr_date=2026-11-02&min_date=2026-11-02&max_date=2026-11-09&ansicht=klassenuebersicht&showOnlyThisClass=-1&id=abc&transid=def&pageid=21312&timeshift=-60",
            examSchedulerUrl(AKSA_SCHULNETZ_BASE, "abc", "def", "2026-11-02", "2026-11-02", "2026-11-09"),
        )
    }

    @Test
    fun startPageReadsRecentGradesAndAppointments() {
        val html = fixture("start.html")
        val grades = parseStartRecentGrades(html)
        assertTrue(grades.size >= 3)
        assertEquals(3.6, grades.first { it.title.contains("Lesecheck") }.mark)
        val appointments = parseStartAppointments(html)
        assertTrue(appointments.any { it.text.contains("Lunchtimekonzert") })
    }
}
