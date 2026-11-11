package ch.fasrv.fanotes.schulnetz

import java.time.Instant
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class WidgetRowsTest {
    private fun lesson(id: String, day: String, start: String, end: String, name: String = "Mathematik", status: String = "") =
        AgendaEvent(id, "${day}T$start:00", "${day}T$end:00", "", "", "B12", listOf("Nord"), "c-$name", name, status, "", "", "")

    // 2026-11-10 is a Tuesday; Zurich is UTC+1 in November.
    private val now = Instant.parse("2026-11-10T09:00:00Z")
    private val past = lesson("p", "2026-11-10", "08:00", "08:45")
    private val a = lesson("a", "2026-11-10", "10:15", "11:00")
    private val b = lesson("b", "2026-11-10", "11:05", "11:50", name = "Deutsch")
    private val tomorrow = lesson("t", "2026-11-11", "08:00", "08:45", name = "Physik")

    @Test
    fun `only the remaining lessons of today then the next day under a heading`() {
        val rows = widgetRows(listOf(tomorrow, b, past, a), emptyList(), emptyList(), now)
        assertEquals(listOf("Mathematik", "Deutsch", "", "Physik"), rows.map { it.title })
        assertEquals(listOf(false, false, true, false), rows.map { it.heading })
        assertEquals(LocalDate.parse("2026-11-11"), rows[2].day)
        assertEquals("10:15–11:00", rows[0].clock)
        assertEquals("B12", rows[0].room)
    }

    @Test
    fun `a Friday evening rolls over the weekend to Monday`() {
        val monday = lesson("m", "2026-11-16", "08:00", "08:45")
        val rows = widgetRows(listOf(monday), emptyList(), emptyList(), Instant.parse("2026-11-13T17:00:00Z"))
        assertEquals(LocalDate.parse("2026-11-16"), rows.first().day)
        assertTrue(rows.first().heading)
        assertEquals(2, rows.size)
    }

    @Test
    fun `no lesson left today starts with the next day heading`() {
        val rows = widgetRows(listOf(past, tomorrow), emptyList(), emptyList(), now)
        assertTrue(rows.first().heading)
        assertEquals("Physik", rows[1].title)
    }

    @Test
    fun `hidden lessons are dropped`() {
        val hidden = hideOnce(a, emptyList())
        val rows = widgetRows(listOf(a, b), emptyList(), hidden, now)
        assertEquals(listOf("Deutsch"), rows.map { it.title })
    }

    @Test
    fun `a cancelled lesson stays with a marker`() {
        val off = a.copy(status = "cancelled")
        val rows = widgetRows(listOf(off, b), emptyList(), emptyList(), now)
        assertEquals(listOf(true, false), rows.map { it.cancelled })
        assertEquals("Mathematik", rows[0].title)
    }

    @Test
    fun `an exam in a lesson slot replaces the lesson`() {
        val exam = AgendaEvent("x", a.start, a.end, "Mathematik Prüfung Kapitel 4", "", "", emptyList(), "c-Mathematik", "", "", "exam", "", "")
        val rows = widgetRows(listOf(a, b), listOf(exam), emptyList(), now)
        assertEquals(2, rows.size)
        assertTrue(rows[0].exam)
        assertEquals("Mathematik Prüfung Kapitel 4", rows[0].title)
        assertEquals("B12", rows[0].room)
        assertEquals("10:15–11:00", rows[0].clock)
    }
}
