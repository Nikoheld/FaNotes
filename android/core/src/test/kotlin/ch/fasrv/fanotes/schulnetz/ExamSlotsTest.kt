package ch.fasrv.fanotes.schulnetz

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ExamSlotsTest {
    private fun lesson(id: String, start: String, end: String, name: String = "mat 2.1", course: String = "c-mat", room: String = "B12", status: String = "") =
        AgendaEvent(id, "2026-11-10T$start:00", "2026-11-10T$end:00", "", "", room, listOf("Nord"), course, name, status, "", "", "")

    private fun exam(start: String, end: String, text: String = "mat 2.1 Prüfung Kapitel 4", course: String = "", room: String = "", name: String = "") =
        AgendaEvent("x1", "2026-11-10T$start:00", "2026-11-10T$end:00", text, "", room, emptyList(), course, name, "", "exam", "", "")

    private val l1 = lesson("l1", "08:00", "08:45")
    private val l2 = lesson("l2", "08:50", "09:35")

    @Test
    fun `an exam over one lesson takes the lesson's place with its room`() {
        val merge = examsInLessonSlots(listOf(l1, l2), listOf(exam("08:00", "08:45")))
        assertEquals(setOf("l1|${l1.start}|"), merge.droppedLessons)
        val shown = merge.exams.single().shown
        assertEquals(l1.start, shown.start)
        assertEquals(l1.end, shown.end)
        assertEquals("B12", shown.room)
        assertEquals("mat 2.1 Prüfung Kapitel 4", shown.text)
        assertTrue(shown.isExamLike())
    }

    @Test
    fun `an exam over a double lesson takes both`() {
        val merge = examsInLessonSlots(listOf(l1, l2), listOf(exam("08:00", "09:35", room = "A1")))
        assertEquals(2, merge.droppedLessons.size)
        val shown = merge.exams.single().shown
        assertEquals(l1.start, shown.start)
        assertEquals(l2.end, shown.end)
        assertEquals("A1", shown.room)
        assertEquals(listOf(shown), merge.apply(listOf(l1, l2, merge.exams.single().original)))
    }

    @Test
    fun `an exam over two courses is not merged`() {
        val other = lesson("l2", "08:50", "09:35", name = "deu 2.1", course = "c-deu")
        val merge = examsInLessonSlots(listOf(l1, other), listOf(exam("08:00", "09:35")))
        assertTrue(merge.droppedLessons.isEmpty() && merge.exams.isEmpty())
    }

    @Test
    fun `an exam over three lessons is not merged`() {
        val l3 = lesson("l3", "09:40", "10:25")
        assertTrue(examsInLessonSlots(listOf(l1, l2, l3), listOf(exam("08:00", "10:25"))).exams.isEmpty())
    }

    @Test
    fun `an exam without a time is not merged`() {
        val dayOnly = exam("00:00", "00:00").copy(start = "2026-11-10", end = "2026-11-10")
        assertTrue(examsInLessonSlots(listOf(l1, l2), listOf(dayOnly)).exams.isEmpty())
    }

    @Test
    fun `an exam of another course in the same slot is not merged`() {
        val merge = examsInLessonSlots(listOf(l1), listOf(exam("08:00", "08:45", text = "Prüfung Geschichte", course = "c-his")))
        assertTrue(merge.droppedLessons.isEmpty() && merge.exams.isEmpty())
    }

    @Test
    fun `matching by course id works without the name in the text`() {
        val merge = examsInLessonSlots(listOf(l1), listOf(exam("08:00", "08:45", text = "Prüfung", course = "c-mat")))
        assertEquals(1, merge.exams.size)
    }

    @Test
    fun `a cancelled lesson is ignored`() {
        val off = lesson("l1", "08:00", "08:45", status = "cancelled")
        assertTrue(examsInLessonSlots(listOf(off), listOf(exam("08:00", "08:45"))).exams.isEmpty())
    }

    @Test
    fun `the same lesson id in another week is not dropped`() {
        val nextWeek = l1.copy(start = "2026-11-17T08:00:00", end = "2026-11-17T08:45:00")
        val merge = examsInLessonSlots(listOf(l1), listOf(exam("08:00", "08:45")))
        assertEquals(listOf(nextWeek), merge.apply(listOf(nextWeek)))
    }
}
