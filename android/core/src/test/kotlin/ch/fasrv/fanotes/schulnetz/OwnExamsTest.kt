package ch.fasrv.fanotes.schulnetz

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Mirrors fanotes-site/own-exams.test.mjs. Synthetic data only. */
class OwnExamsTest {
    private fun lesson(id: String, name: String, day: String = "2026-11-02") =
        AgendaEvent(id, "${day}T07:45:00", "${day}T08:30:00", name, "", "", emptyList(), "9001", name, "", "0_stp", "", name)

    private fun exam(id: String, name: String, day: String = "2099-02-10") =
        AgendaEvent(id, "${day}T10:15:00", "${day}T11:00:00", name, "", "B04", emptyList(), "", name, "", "exam", "", name)

    private val timetable = listOf(
        lesson("l1", "Mat_G24a_Holm"), lesson("l2", "Eng_G24a"), lesson("l3", "Phy 2.3"), lesson("l4", "Bio_G24a_Nord", "2026-11-03"),
    )

    private fun ids(list: List<AgendaEvent>) = list.map { it.id }

    @Test
    fun `course identity accepts both separators and needs a group part`() {
        assertEquals(CourseIdentity("mat", "g24a", "holm"), courseIdentity("Mat_G24a_Holm"))
        assertEquals(CourseIdentity("phy", "2.3", ""), courseIdentity("Phy 2.3"))
        assertEquals(CourseIdentity("phy", "2.3", ""), courseIdentity("Phy 2.3 Test Kapitel 4"))
        assertNull(courseIdentity("Bio Test Zellen"))
        assertNull(courseIdentity("Notenkonferenz"))
        assertNull(courseIdentity(""))
    }

    @Test
    fun `a foreign course is dropped and an own course kept`() {
        assertEquals(listOf("e1"), ids(ownExams(listOf(exam("e1", "Mat_G24a_Holm Test 1"), exam("e2", "Chx_2.3_Salt Test 2")), timetable).exams))
    }

    @Test
    fun `the other group of the same subject is excluded`() {
        val list = listOf(exam("e1", "Phy_2.3_Kern Test"), exam("e2", "Phy_2.4_Kern Test"), exam("e3", "Eng_G24b Test"), exam("e4", "Phy 2.3 Test"))
        assertEquals(listOf("e1", "e4"), ids(ownExams(list, timetable).exams))
    }

    @Test
    fun `a missing teacher matches and a different teacher does not`() {
        val list = listOf(exam("a", "Eng_G24a_Berg Test"), exam("b", "Mat_G24a Test"), exam("c", "Mat_G24a_Glas Test"))
        assertEquals(listOf("a", "b"), ids(ownExams(list, timetable).exams))
    }

    @Test
    fun `entries without a course code are kept`() {
        val bio = exam("bio", "Bio Test Zellen")
        val termin = exam("trm", "Klassenabend").copy(eventType = "5_trm")
        assertEquals(listOf("bio", "trm"), ids(ownExams(listOf(bio, termin), timetable).exams))
        assertEquals(listOf("bio"), ids(ownExams(listOf(bio), timetable + lesson("l9", "Bio 2.1")).exams))
    }

    @Test
    fun `lessons of every loaded week define the courses`() {
        assertEquals(listOf("e2"), ids(ownExams(listOf(exam("e2", "Chx_2.3_Salt Test", "2026-12-01")), listOf(lesson("x1", "Chx_2.3_Salt", "2026-09-14"))).exams))
    }

    @Test
    fun `without a loaded timetable nothing is filtered and the state is marked`() {
        val foreign = exam("e2", "Chx_2.3_Salt Test")
        val none = ownExams(listOf(foreign), emptyList())
        assertEquals(listOf("e2"), ids(none.exams))
        assertTrue(none.unfiltered)
        assertFalse(ownExams(listOf(foreign), timetable).unfiltered)
        assertFalse(ownExams(emptyList(), emptyList()).unfiltered)
        val snapshot = SchulnetzSnapshot(exams = listOf(foreign)).withOwnExams()
        assertTrue(snapshot.examsUnfiltered)
        assertTrue(parseNormalizedSnapshot(snapshot.toNormalizedJson())!!.examsUnfiltered)
    }

    @Test
    fun `an exam in both the timetable and the overview is one exam`() {
        val inTimetable = exam("tt-1", "Mat_G24a_Holm Test 1").copy(eventType = "1_pru")
        val inOverview = exam("ov-1", "Mat_G24a_Holm Test 1")
        assertEquals(1, dedupeExams(listOf(inOverview, inTimetable)).size)
    }

    @Test
    fun `an all-day exam listed twice under different ids is one exam, other courses and days stay apart`() {
        fun allDay(id: String, name: String, day: String = "2099-02-10") = exam(id, name, day).copy(start = "${day}T00:00:00", end = "${day}T00:00:00")
        val first = allDay("7", "Phy 2.3 Test Kapitel 4")
        assertEquals(listOf("7"), dedupeExams(listOf(first, allDay("12", "Phy 2.3 Test Kapitel 4"))).map { it.id })
        assertEquals(2, dedupeExams(listOf(first, allDay("13", "Mat_G24a_Holm Test 1"))).size)
        assertEquals(2, dedupeExams(listOf(first, allDay("14", "Phy 2.3 Test Kapitel 4", "2099-02-11"))).size)
    }

    @Test
    fun `a stored snapshot loses foreign exams when it is read`() {
        val stored = SchulnetzSnapshot(events = timetable, exams = listOf(exam("e1", "Mat_G24a_Holm Test 1"), exam("e2", "Chx_2.3_Salt Test 2")))
        assertEquals(listOf("e1"), ids(parseNormalizedSnapshot(stored.toNormalizedJson())!!.exams))
    }

    @Test
    fun `adopting a server snapshot narrows its exams to the phone and server lessons`() {
        val server = SchulnetzSnapshot(events = timetable, exams = listOf(exam("e1", "Mat_G24a_Holm Test 1"), exam("e2", "Chx_2.3_Salt Test 2")))
        assertEquals(listOf("e1"), ids(adoptServerSnapshot(SchulnetzSnapshot(), server).exams))
    }

    private val base = SchulnetzSnapshot(events = timetable, fetchedAt = "2026-11-01T10:00:00Z")
    private fun titles(previous: SchulnetzSnapshot, next: SchulnetzSnapshot) = diffSnapshots(previous, next).map { it.title }

    @Test
    fun `no notification for a foreign exam and one for an own exam`() {
        assertEquals(emptyList(), titles(base, base.copy(exams = listOf(exam("e2", "Chx_2.3_Salt Test 2")))))
        assertEquals(listOf("Neue Prüfung"), titles(base, base.copy(exams = listOf(exam("e1", "Mat_G24a_Holm Test 1")))))
    }

    @Test
    fun `a foreign exam leaving the stored list on migration is silent`() {
        val stored = base.copy(exams = listOf(exam("e1", "Mat_G24a_Holm Test 1"), exam("e2", "Chx_2.3_Salt Test 2")))
        assertEquals(emptyList(), titles(stored, base.copy(exams = listOf(exam("e1", "Mat_G24a_Holm Test 1")))))
    }

    @Test
    fun `an unloaded timetable keeps the old diff behaviour`() {
        val none = base.copy(events = emptyList())
        assertEquals(listOf("Neue Prüfung"), titles(none, none.copy(exams = listOf(exam("e2", "Chx_2.3_Salt Test 2")))))
    }
}
