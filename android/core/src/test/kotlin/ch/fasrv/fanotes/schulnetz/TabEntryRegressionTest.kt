package ch.fasrv.fanotes.schulnetz

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.ZoneOffset

class TabEntryRegressionTest {
    private val zone = ZoneId.of("Europe/Zurich")

    @Test
    fun localSchulnetzTimestampsMatchTheZonedClockWithoutAThrowingParse() {
        val local = parseSchulnetzInstant("2026-11-09T08:15:00", zone)
        assertEquals(LocalDateTime.parse("2026-11-09T08:15:00").atZone(zone).toInstant(), local)
        assertEquals(Instant.parse("2026-11-02T08:15:00Z"), parseSchulnetzInstant("2026-11-02T08:15:00Z", zone))
        assertEquals(
            LocalDateTime.parse("2026-11-02T08:15:00").toInstant(ZoneOffset.ofHours(1)),
            parseSchulnetzInstant("2026-11-02T08:15:00+01:00", zone),
        )
        assertEquals(LocalDate.parse("2026-11-12").atStartOfDay(zone).toInstant(), parseSchulnetzInstant("2026-11-12", zone))
        assertEquals(
            LocalDateTime.parse("2026-11-09T08:15:00.500").atZone(zone).toInstant(),
            parseSchulnetzInstant("2026-11-09T08:15:00.5", zone),
        )
        assertNull(parseSchulnetzInstant("", zone))
        assertNull(parseSchulnetzInstant("not-a-date", zone))
    }

    @Test
    fun oneIndexMatchesAPerDayScanAndStaysCheapForAFullTimetable() {
        val events = (0 until 400).map { index ->
            val day = LocalDate.of(2026, 11, 2).plusDays((index % 20).toLong())
            AgendaEvent(
                "e$index", "${day}T08:15:00", "${day}T09:00:00", "Mathematik", "", "A1",
                emptyList(), "c$index", "M4a", "", "lesson", "", "Mathematik",
            )
        }
        val started = System.nanoTime()
        val indexed = eventsByLocalDay(events, zone)
        val elapsedMs = (System.nanoTime() - started) / 1_000_000
        assertTrue("indexing 400 local lessons took ${elapsedMs}ms", elapsedMs < 1_500)
        val day = LocalDate.of(2026, 11, 2)
        assertEquals(eventsOn(events, day, zone).map { it.id }, indexed.getValue(day).map { it.id })
        assertEquals(20, indexed.getValue(day).size)
        assertEquals(20, indexed.size)
    }

    @Test
    fun readableSubjectWinsAndCourseKeysStaySeparate() {
        val exam = AgendaEvent(
            "phy", "2026-11-12T10:15:00", "2026-11-12T11:00:00", "Mathe & Physik", "", "B04",
            emptyList(), "phy", "PHY", "", "exam", "", "Mathe & Physik",
        )
        assertEquals("PHY", exam.label)
        assertEquals("Mathe & Physik (PHY)", preferredEventTitle(exam))
        assertFalse(looksLikeCourseCode("Mathematik"))
        assertFalse(looksLikeCourseCode("Sport"))
        assertTrue(looksLikeCourseCode("M4a"))
        val math = SchoolGrade("a", "M4a", "1", "Mathematik", "Probe", "2026-10-01", 5.0, 1.0, true, null, "")
        val other = SchoolGrade("b", "M4b", "2", "Mathematik", "Probe", "2026-10-01", 4.0, 1.0, true, null, "")
        val courses = courseSummaries(listOf(math, other))
        assertEquals(setOf("1", "2"), courses.map { it.courseId }.toSet())
        assertEquals(setOf("Mathematik (M4a)", "Mathematik (M4b)"), courses.map { it.label }.toSet())
        assertEquals("Mathematik", courseAlias("Mathematik (M4a)", mapOf("m4a" to "Mathematik")))
        assertEquals("PHY", preferredSubjectTitle("PHY", ""))
        assertEquals("Mathematik", preferredEventTitle(exam.copy(courseName = "Mathematik", text = "Mathematik")))
    }

    @Test
    fun genericAppointmentTitleUsesTheBodyAndUndatedExamsDoNotSortFirst() {
        assertEquals("Elternabend Aula", messageHeadline("Termin", "Elternabend Aula"))
        assertEquals("Mitteilung", messageHeadline("Mitteilung", "Elternabend Aula"))
        assertEquals("Termin", messageHeadline("Termin", ""))
        assertFalse(examHasDate(""))
        assertFalse(examHasDate("08:15"))
        assertTrue(examHasDate("2026-11-12"))
        assertTrue(examHasDate("2026-11-12T10:15:00"))
        assertTrue(examHasDate("12.11.2026"))
        val order = listOf("", "2026-11-20T08:00:00", "2026-11-12").sortedBy { examAlleKey(it) }
        assertEquals(listOf("2026-11-12", "2026-11-20T08:00:00", ""), order)
        assertTrue(eventsByLocalDay(listOf(AgendaEvent("bare", "", "", "Prüfung", "", "", emptyList(), "", "PHY", "", "exam", "", "")), zone).isEmpty())
    }
}
