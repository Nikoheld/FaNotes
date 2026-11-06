package ch.fasrv.fanotes.schulnetz

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class RealMarkupTest {
    private fun fixture(name: String): String =
        checkNotNull(javaClass.getResource("/schulnetz/$name")) { name }.readText()

    @Test
    fun gradesKeepIndividualExamsAndNotTheCourseAverage() {
        val grades = readGradesPage(fixture("noten.html"))
        assertNull(grades.error)
        assertTrue(grades.value.none { it.isSummaryGrade() })
        assertTrue(grades.value.none { it.title.contains("Durchschnitt", ignoreCase = true) })
        val chem = grades.value.filter { it.course.contains("Chemie") || it.subject.contains("Chemie") }
        assertEquals(1, chem.size)
        assertEquals("2026-03-03", chem.single().date)
        assertEquals(5.5, chem.single().mark)
        assertEquals(5.0, chem.single().courseGrade)
        val math = grades.value.filter { it.course.contains("MATH-K26A") }
        assertEquals(1, math.size)
        assertEquals(4.5, math.single().mark)
        assertEquals(4.0, math.single().courseGrade)
        val bio = grades.value.filter { it.subject.contains("Biologie") }
        assertTrue(bio.isEmpty())
        val summaries = courseSummaries(grades.value)
        assertEquals(1, summaries.single { it.label.contains("Chemie") }.marks.size)
        assertEquals(1.0, summaries.single { it.label.contains("Chemie") }.weight)
        assertEquals(5.5, summaries.single { it.label.contains("Chemie") }.average)
        assertFalse(summaries.any { it.label.contains("Biologie") })
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
        assertEquals("01.02.2026", lines.first().date)
        assertTrue(lines.first().amount.contains("-12.50"))
        assertTrue(lines.last().balance.isNotBlank())
    }

    @Test
    fun terminlistePageOneHasTwentyFiveRows() {
        val html = fixture("terminliste.html")
        val events = readTerminliste(html)
        assertNull(events.error)
        assertEquals(25, events.value.size)
        assertEquals("Probenkonzert", events.value.first().text)
        assertEquals(40, terminlisteTotal(html))
        assertTrue(terminlisteNextUrl(html, AKSA_SCHULNETZ_BASE)!!.contains("sRow=25"))
    }

    @Test
    fun stundenplanReadsRenderedLessons() {
        val lessons = parseRenderedTimetable(fixture("stundenplan.html"))
        assertEquals(4, lessons.size)
        val first = lessons.first { it.start.startsWith("2026-11-02T07:45") }
        assertEquals("A12", first.room)
        assertTrue(first.text.contains("Holm"))
        val nested = """
            <div class="dhx_cal_event stpt_event" event_id="deep">
              <div class="stpt_bar" data-bar-start="1794208500000" data-bar-end="1794211200000"></div>
              <div class="stpt_event_text">Mathematik</div>
              <div class="stpt_event_date">08:15 - 09:00 / A1</div>
            </div>
        """.trimIndent()
        val deep = parseRenderedTimetable(nested).single()
        assertTrue(deep.start.startsWith("2026-11-09T08:15"))
        assertEquals("A1", deep.room)
        assertEquals("lesson", deep.eventType)
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
        assertEquals(5.5, grades.first { it.title.contains("Lesetest") }.mark)
        val appointments = parseStartAppointments(html)
        assertTrue(appointments.any { it.text.contains("Probenkonzert") })
    }
}
