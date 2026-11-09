package ch.fasrv.fanotes.schulnetz

import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Field reports on 2026.11.2-beta.17: lessons showed and then vanished from the planner, and some
 * grades were missing. Schulnetz reuses a lesson id in every week, and later reads (Terminliste merge,
 * the server's copy after a push) dropped or replaced lessons the app already had.
 */
class KeepLessonsAndGradesTest {
    private fun fixture(name: String): String =
        requireNotNull(javaClass.classLoader.getResource("schulnetz/$name")) { name }.readText()

    /** 15 lessons a week, numbered 1..15 the way Schulnetz numbers them, the same ids every week. */
    private fun lessons(vararg mondays: String): List<AgendaEvent> = mondays.flatMap { monday ->
        (0L..4L).flatMap { day ->
            listOf("07:45", "08:35", "09:40").mapIndexed { slot, clock ->
                val date = LocalDate.parse(monday).plusDays(day)
                AgendaEvent(
                    id = (day * 3 + slot + 1).toString(), start = "${date}T$clock:00", end = "${date}T$clock:00",
                    text = "Fach $slot", comment = "", room = "", teachers = emptyList(), courseId = "C$slot",
                    courseName = "Fach $slot", status = "", eventType = "0_stp", color = "", timetableText = "Fach $slot",
                )
            }
        }
    }

    private fun appointment(id: String, day: String, text: String = "Sporttag") = AgendaEvent(
        id = id, start = "${day}T08:00:00", end = "${day}T12:00:00", text = text, comment = "", room = "",
        teachers = emptyList(), courseId = "", courseName = "", status = "", eventType = "event", color = "", timetableText = "",
    )

    private fun perWeek(events: List<AgendaEvent>): Map<String, Int> =
        events.filter { it.isLesson() }.groupingBy { weekMondayKey(it.start).orEmpty() }.eachCount()

    private fun perWeek(snapshot: SchulnetzSnapshot): Map<String, Int> = perWeek(snapshot.events)

    @Test fun theTerminlisteMergeKeepsLessonsThatReuseTheirIdEveryWeek() {
        val stored = lessons("2026-11-02", "2026-11-09", "2026-11-16") + appointment("T1", "2026-11-12")
        val merged = mergeById(stored, listOf(appointment("T1", "2026-11-12", "Sporttag (verschoben)"), appointment("T2", "2026-11-19")))
        assertEquals(mapOf("2026-11-02" to 15, "2026-11-09" to 15, "2026-11-16" to 15), perWeek(merged))
        assertEquals("Sporttag (verschoben)", merged.single { it.id == "T1" }.text)
        assertTrue(merged.any { it.id == "T2" })
    }

    @Test fun anEmptyOrPartialServerCopyNeverRemovesStoredLessons() {
        val read = "2026-11-09T07:00:00Z"
        val phone = SchulnetzSnapshot(
            fetchedAt = read,
            events = lessons("2026-11-09", "2026-11-16", "2026-11-23") + appointment("T1", "2026-11-12"),
            weekRead = mapOf("2026-11-09" to read, "2026-11-16" to read, "2026-11-23" to read),
            weekFetched = mapOf("2026-11-09" to read, "2026-11-16" to read, "2026-11-23" to read),
        )
        val all = mapOf("2026-11-09" to 15, "2026-11-16" to 15, "2026-11-23" to 15)
        // Nothing at all, appointments only (no lesson ever read on the server), and a failed read.
        for (server in listOf(
            SchulnetzSnapshot(fetchedAt = "2026-11-09T18:00:00Z"),
            SchulnetzSnapshot(fetchedAt = "2026-11-09T18:00:00Z", events = listOf(appointment("T9", "2026-11-13"))),
            SchulnetzSnapshot(fetchedAt = "2026-11-09T18:00:00Z", readErrors = listOf("Schulnetz: inactivity")),
        )) assertEquals(all, perWeek(adoptServerSnapshot(phone, server)))
        // This week only (the view older servers gave): the other weeks stay.
        val thisWeek = SchulnetzSnapshot(fetchedAt = "2026-11-09T18:00:00Z", events = lessons("2026-11-09").drop(3), weekRead = mapOf("2026-11-09" to "2026-11-09T18:00:00Z"))
        val merged = adoptServerSnapshot(phone, thisWeek)
        // A newer server read of a week replaces it (here: three lessons fewer), the others are kept.
        assertEquals(mapOf("2026-11-09" to 12, "2026-11-16" to 15, "2026-11-23" to 15), perWeek(merged))
        // An older server read, or a week the server read as empty, keeps the stored lessons.
        val older = thisWeek.copy(weekRead = mapOf("2026-11-09" to "2026-11-08T07:00:00Z"))
        assertEquals(all, perWeek(adoptServerSnapshot(phone, older)))
        val emptyWeek = SchulnetzSnapshot(fetchedAt = "2026-11-09T18:00:00Z", events = lessons("2026-11-09"), weekRead = mapOf("2026-11-09" to "2026-11-09T18:00:00Z", "2026-11-16" to "2026-11-09T18:00:00Z"))
        assertEquals(all, perWeek(adoptServerSnapshot(phone, emptyWeek)))
        // Appointments the server does not have stay too.
        assertTrue(adoptServerSnapshot(phone, SchulnetzSnapshot(fetchedAt = "2026-11-09T18:00:00Z")).events.any { it.id == "T1" })
        // The planner still sees every week as read.
        val kept = adoptServerSnapshot(phone, thisWeek)
        for (week in listOf("2026-11-09", "2026-11-16", "2026-11-23")) {
            assertEquals(WeekCoverage.LOADED, lessonWeekCoverage(kept, LocalDate.parse(week), LocalDate.parse("2026-11-09")), week)
        }
    }

    @Test fun everyGradeRowOfARealShapedGradesPageIsRead() {
        val read = readGradesPage(fixture("noten-5141.html"))
        assertNull(read.error)
        val grades = read.value
        // 8 rows in four courses: plain marks, marks followed by an info tooltip with other numbers,
        // a comma decimal, rows still waiting for a mark, a row without date or weight. A course
        // without grades adds none.
        assertEquals(8, grades.size)
        fun by(title: String) = grades.single { it.title == title }
        assertEquals(4.25, by("Geometrie").mark)
        assertEquals(5.0, by("Aufsatz Erörterung").mark)
        assertEquals(2.0, by("Aufsatz Erörterung").weight)
        assertEquals(4.5, by("Kurztest Wurzeln").mark)
        assertEquals(0.5, by("Kurztest Wurzeln").weight)
        assertNull(by("Funktionen").mark)
        assertNull(by("Genetik").mark)
        assertEquals("", by("Vocabulaire").date)
        assertEquals(1.0, by("Vocabulaire").weight)
        assertTrue(grades.all { it.mark == null || it.mark!! in 1.0..6.0 })
        assertEquals(listOf("MAT_K99Z_Demo", "Kurs", "BIO_K99Z_Demo", "FRA_K99Z_Demo"), grades.map { it.courseId }.distinct())
    }

    @Test fun aPendingGradeIsNotNewsAndItsMarkArrivingIs() {
        val grades = readGradesPage(fixture("noten-5141.html")).value
        val pending = grades.single { it.title == "Funktionen" }
        val without = grades.filter { it.mark != null }
        assertTrue(matchGradeChanges(without, without + pending).isEmpty())
        val marked = pending.copy(id = pending.id + "-4", mark = 4.0)
        val changes = matchGradeChanges(without + pending, without + marked)
        assertEquals(1, changes.size)
        assertEquals("Neue Note", changes.single().title)
    }

    @Test fun serverGradesFromAnOlderParserNeverReplaceTheAppsCompleteList() {
        val all = readGradesPage(fixture("noten-5141.html")).value
        val phone = SchulnetzSnapshot(fetchedAt = "2026-11-09T07:00:00Z", grades = all, gradeParser = GRADE_PARSER_VERSION)
        // What the server kept before this fix: plain marks only, flagged complete.
        val oldServer = SchulnetzSnapshot(fetchedAt = "2026-11-09T18:00:00Z", grades = all.filter { it.title in setOf("Algebra 1", "Kurztest Wurzeln") })
        assertEquals(all, adoptServerSnapshot(phone, oldServer).grades)
        // A server on the current parser is adopted, so a grade read there shows up on the phone.
        val extra = all.first().copy(id = "exam-new", title = "Neu", date = "2026-11-09", mark = 4.0)
        val newServer = SchulnetzSnapshot(fetchedAt = "2026-11-09T18:00:00Z", grades = all + extra, gradeParser = GRADE_PARSER_VERSION)
        assertEquals(all + extra, adoptServerSnapshot(phone, newServer).grades)
        // The version survives the JSON round trip the app and server use.
        assertEquals(GRADE_PARSER_VERSION, parseNormalizedSnapshot(newServer.toNormalizedJson())?.gradeParser)
    }
}
