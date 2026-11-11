package ch.fasrv.fanotes.schulnetz

import java.time.LocalDate
import java.time.ZonedDateTime
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Lesson marks (cancelled, new, moved, changed) with synthetic data only. */
class LessonMarksTest {
    private val now = ZonedDateTime.parse("2026-11-11T12:00:00+01:00[Europe/Zurich]")
    private val today = LocalDate.parse("2026-11-11")

    private fun xml(kind: String = "0_stp", mark: String = "", deco: String = "", extra: String = "") =
        """<data><event id="t1"><start_date>2026-11-16 08:15</start_date><end_date>2026-11-16 09:00</end_date>
        <text>TstAa</text><event_type>$kind</event_type><markierung>$mark</markierung><textdeco>$deco</textdeco>$extra</event></data>"""

    private fun lesson(
        id: String, start: String, marker: String?, status: String = "", teacher: String = "TstTa", substitute: String = "",
        name: String = "TstAa", room: String = "T01", eventType: String = "0_stp",
    ) = AgendaEvent(
        id, "${start}T08:15:00", "${start}T09:00:00", name, "", room, listOf(teacher), "c-$name", name, status, eventType, "", name,
        marker = marker, substitute = substitute,
    )

    private fun diff(previous: List<AgendaEvent>, next: List<AgendaEvent>) =
        diffSnapshots(SchulnetzSnapshot(events = previous), SchulnetzSnapshot(events = next), NotifySettings(), today, now)

    @Test
    fun `lessonMarker maps marks and ignores exams`() {
        assertEquals("cancelled", lessonMarker("0_stp", "deleted", ""))
        assertEquals("cancelled", lessonMarker("0_stp", "", "text-decoration: line-through"))
        assertEquals("cancelled", lessonMarker("", "none", "line-through"))
        assertEquals("", lessonMarker("0_stp", "", ""))
        assertEquals("", lessonMarker("lesson", "none", ""))
        assertEquals("added", lessonMarker("0_stp", "new", ""))
        assertEquals("moved", lessonMarker("0_stp", "Moved", ""))
        assertEquals("changed", lessonMarker("0_stp", "16", ""))
        assertEquals("changed", lessonMarker("", "Geändert", ""))
        assertEquals("", lessonMarker("1_pru", "deleted", "line-through"))
        assertEquals("", lessonMarker("1_pru", "Kapitel 4", ""))
    }

    @Test
    fun `parser sets status marker and substitute`() {
        val gone = parseSchedulerXml(xml(mark = "deleted", deco = "line-through")).single()
        assertEquals("cancelled", gone.status)
        assertEquals("cancelled", gone.marker)
        assertTrue(gone.isCancelled())
        val changed = parseSchedulerXml(xml(mark = "16", extra = "<neuerlehrername>TstBb</neuerlehrername>")).single()
        assertEquals("changed", changed.marker)
        assertEquals("TstBb", changed.substitute)
        assertTrue(changed.isSubstitution())
        assertEquals("TstCc", parseSchedulerXml(xml(mark = "new", extra = "<neuerlehrer>TstCc</neuerlehrer>")).single().substitute)
        val plain = parseSchedulerXml(xml(extra = "<neuerlehrername>TstBb</neuerlehrername>")).single()
        assertEquals("", plain.marker)
        assertEquals("", plain.substitute)
        assertFalse(plain.isSubstitution())
        val exam = parseSchedulerXml(xml(kind = "1_pru", mark = "Kapitel 4", deco = "line-through")).single()
        assertEquals("", exam.marker)
        assertEquals("", exam.status)
    }

    @Test
    fun `json round trip keeps null and empty marker apart`() {
        val events = listOf(
            lesson("a", "2026-11-16", null),
            lesson("b", "2026-11-17", ""),
            lesson("c", "2026-11-18", "cancelled", status = "cancelled"),
            lesson("d", "2026-11-19", "changed", substitute = "TstBb"),
        )
        val json = SchulnetzSnapshot(events = events).toNormalizedJson()
        val back = parseNormalizedSnapshot(json)!!.events.associateBy { it.id }
        assertNull(back.getValue("a").marker)
        assertEquals("", back.getValue("b").marker)
        assertEquals("cancelled", back.getValue("c").marker)
        assertEquals("changed", back.getValue("d").marker)
        assertEquals("TstBb", back.getValue("d").substitute)
        assertEquals("", back.getValue("a").substitute)
        assertFalse(json.contains("\"substitute\":\"\""))
        val flex = parseEvents("""[{"id":"a","start":"2026-11-16T08:15:00","text":"TstAa"},{"id":"b","start":"2026-11-16T08:15:00","text":"TstAa","marker":""}]""")
            .associateBy { it.id }
        assertNull(flex.getValue("a").marker)
        assertEquals("", flex.getValue("b").marker)
        val baseline = parseAgendaBaseline(agendaBaselineJson(mapOf("2026-11-16" to SchulnetzSnapshot(events = events.take(2)))))
        assertEquals(listOf(null, ""), baseline.getValue("2026-11-16").events.map { it.marker })
    }

    @Test
    fun `seed read keeps past and far cancellations quiet`() {
        val previous = listOf(lesson("p", "2026-10-05", null), lesson("f", "2026-12-14", null))
        val next = listOf(
            lesson("p", "2026-10-05", "cancelled", status = "cancelled"),
            lesson("f", "2026-12-14", "cancelled", status = "cancelled"),
        )
        assertTrue(diff(previous, next).isEmpty())
    }

    @Test
    fun `seed read announces upcoming cancellation and substitute`() {
        val previous = listOf(lesson("u", "2026-11-16", null), lesson("s", "2026-11-17", null))
        val next = listOf(
            lesson("u", "2026-11-16", "cancelled", status = "cancelled"),
            lesson("s", "2026-11-17", "changed", substitute = "TstBb"),
        )
        val titles = diff(previous, next).map { it.title }
        assertEquals(listOf("Lektion fällt aus", "Vertretung"), titles)
    }

    @Test
    fun `cancellation after the seed read is announced even for far lessons`() {
        val previous = listOf(lesson("f", "2026-12-14", ""))
        val next = listOf(lesson("f", "2026-12-14", "cancelled", status = "cancelled"))
        assertEquals(listOf("Lektion fällt aus"), diff(previous, next).map { it.title })
    }

    @Test
    fun `event key includes substitute only when set`() {
        val plain = lesson("a", "2026-11-16", "")
        assertEquals(eventKey(plain), eventKey(plain.copy(marker = null)))
        assertTrue(eventKey(plain.copy(substitute = "TstBb")).endsWith("|TstBb"))
    }

    @Test
    fun `cancelled lesson is neither replaced by nor hides an exam`() {
        val cancelled = lesson("l1", "2026-11-10", "cancelled", status = "cancelled", name = "mat 2.1")
            .copy(start = "2026-11-10T08:00:00", end = "2026-11-10T08:45:00")
        val exam = AgendaEvent("x1", "2026-11-10T08:00:00", "2026-11-10T08:45:00", "mat 2.1", "", "", emptyList(), "c-mat", "mat 2.1", "", "exam", "", "")
        val merge = examsInLessonSlots(listOf(cancelled), listOf(exam))
        assertTrue(merge.droppedLessons.isEmpty())
        assertTrue(merge.exams.isEmpty())
        val merged = mergedScheduleEvents(listOf(cancelled, exam), emptyList(), emptyList())
        assertTrue(merged.any { it.isCancelled() })
        assertTrue(merged.any { it.isExamLike() })
    }
}
