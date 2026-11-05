package ch.fasrv.fanotes.schulnetz

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class NotifyLinkTest {
    private val grade = SchoolGrade("g1", "Mathematik", "math", "Mathematik", "Probe", "2026-11-01", 5.5, 1.0, true, null, "")
    private val other = SchoolGrade("g2", "Chemie", "che", "Chemie", "Test", "2026-11-02", 4.5, 1.0, true, null, "")
    private val lesson = AgendaEvent(
        "e1", "2026-11-02T08:15:00", "2026-11-02T09:00:00", "Mathematik", "", "R201",
        emptyList(), "math", "Mathematik", "confirmed", "lesson", "", "",
    )
    private val exam = lesson.copy(id = "x1", eventType = "exam", text = "Prüfung")
    private val absence = SchoolAbsence("a1", "2026-10-01", "2026-10-01", "08:00", "08:45", "Französisch", "Arzt", false, false, "", "04.11.2026")
    private val message = SchoolMessage("m1", "Elternabend", "Freitag", "2026-11-01")
    private val snapshot = SchulnetzSnapshot(
        fetchedAt = "2026-11-02T12:00:00Z",
        grades = listOf(grade, other),
        events = listOf(lesson),
        exams = listOf(exam),
        absences = listOf(absence),
        messages = listOf(message),
    )

    @Test
    fun hashIgnoresCaseAndStaysStableForHumanFields() {
        assertEquals(notifyHash("math", "2026-11-01", "Probe"), notifyHash("MATH", "2026-11-01", " probe "))
        assertEquals(gradeTargetId(grade), notifyHash("math", "2026-11-01", "Probe"))
        assertEquals(lessonTargetId(lesson), notifyHash("2026-11-02", "08:15", "Mathematik"))
        assertEquals(absenceTargetId(absence), notifyHash("a1", "2026-10-01", "Französisch", "Arzt"))
    }

    @Test
    fun payloadRoundTripsThroughNtfyEnvelopeAndLocalJson() {
        val change = diffSnapshots(SchulnetzSnapshot(), SchulnetzSnapshot(grades = listOf(grade))).single { it.category == "grade" }
        assertEquals("grades", change.target)
        assertEquals(gradeTargetId(grade), change.targetId)
        assertEquals("math", change.courseId)
        assertEquals("2026-11-01", change.date)
        val json = notifyPayload(change)
        val parsed = changeFromPayload(json)
        assertNotNull(parsed)
        assertEquals(change.id, parsed.id)
        assertEquals(change.targetId, parsed.targetId)
        assertEquals(listOf(gradeTargetId(grade)), parsed.targetIds)
        val nested = parseNotifyLink("""{"id":"ntfy1","event":"message","message":${ch.fasrv.fanotes.json.escapeJson(json)}}""")
        assertNotNull(nested)
        assertEquals("grade", nested.kind)
        assertEquals(listOf(gradeTargetId(grade)), nested.ids)
        assertNull(parseNotifyLink("""{"event":"keepalive"}"""))
        assertNull(changeFromPayload("""{"event":"open"}"""))
    }

    @Test
    fun routingOpensTheMatchingScreenAndFallsBackWithAHint() {
        val gradeRoute = routeNotify(notifyLinkOf(linkedChange("grade:g1", "grade", "Neue Note", "x", gradeTargetId(grade), "math", "2026-11-01")), snapshot)
        assertEquals("Noten", gradeRoute.tab)
        assertEquals("math", gradeRoute.courseId)
        assertEquals(listOf(gradeTargetId(grade)), gradeRoute.highlightIds)
        assertTrue(gradeRoute.found)
        val missingGrade = routeNotify(NotifyLink("grade", listOf("gone"), "math", "2026-11-01"), snapshot)
        assertEquals("Noten", missingGrade.tab)
        assertFalse(missingGrade.found)
        assertTrue(missingGrade.hint.contains("Note"))
        val lessonRoute = routeNotify(NotifyLink("timetable", listOf(lessonTargetId(lesson)), date = "2026-11-02"), snapshot)
        assertEquals("Plan", lessonRoute.tab)
        assertEquals("2026-11-02", lessonRoute.day)
        assertTrue(lessonRoute.found)
        val missingLesson = routeNotify(NotifyLink("timetable", listOf("gone"), date = "2026-11-03"), snapshot)
        assertEquals("Plan", missingLesson.tab)
        assertEquals("2026-11-03", missingLesson.day)
        assertTrue(missingLesson.hint.contains("Lektion"))
        val replaced = lesson.copy(id = "neu", text = "Mathematik Holm", courseName = "Mathematik Holm", timetableText = "Mathematik Holm")
        val opened = routeNotify(
            NotifyLink("timetable", listOf("gone"), "math", "2026-11-02", "Mathematik · 08:15–09:00 · Raum R201"),
            snapshot.copy(events = listOf(replaced)),
        )
        assertTrue(opened.found)
        assertEquals("", opened.hint)
        assertEquals(listOf(lessonTargetId(replaced)), opened.highlightIds)
        val wrongRoom = routeNotify(
            NotifyLink("timetable", listOf("gone"), "math", "2026-11-02", "Mathematik · 08:15–09:00 · Raum Z9"),
            snapshot.copy(events = listOf(replaced)),
        )
        assertFalse(wrongRoom.found)
        assertTrue(wrongRoom.hint.contains("Lektion"))
        val examRoute = routeNotify(NotifyLink("exam", listOf(lessonTargetId(exam))), snapshot)
        assertEquals("Pruefungen", examRoute.section)
        assertTrue(examRoute.found)
        val deadline = excuseReminders(listOf(absence), java.time.LocalDate.of(2026, 11, 2)).single()
        val absenceRoute = routeNotify(notifyLinkOf(deadline), snapshot)
        assertEquals("Absenzen", absenceRoute.section)
        assertTrue(absenceRoute.found)
        val messageRoute = routeNotify(NotifyLink("event", listOf(messageTargetId(message))), snapshot)
        assertEquals("Termine", messageRoute.section)
        assertTrue(messageRoute.found)
        val testRoute = routeNotify(notifyLinkOf(linkedChange("push-test", "settings", "Testbenachrichtigung", "x", "settings")), snapshot)
        assertEquals("Einstellungen", testRoute.section)
        val loginRoute = routeNotify(notifyLinkOf(linkedChange("schulnetz-login-required", "event", "Bei Schulnetz neu anmelden", "x", "home")), snapshot)
        assertEquals("Heute", loginRoute.tab)
    }

    @Test
    fun groupedGradesKeepEveryTargetId() {
        val first = linkedChange("grade:g1", "grade", "Neue Note", "Mathematik · Probe", gradeTargetId(grade), "math", "2026-11-01")
        val second = linkedChange("grade:g2", "grade", "Neue Note", "Chemie · Test", gradeTargetId(other), "che", "2026-11-02")
        val grouped = groupGradeChanges(listOf(first, second, linkedChange("exam:x", "exam", "Neue Prüfung", "x", lessonTargetId(exam))))
        assertEquals("2 neue Noten", grouped.first().title)
        assertEquals(setOf(gradeTargetId(grade), gradeTargetId(other)), grouped.first().targetIds.toSet())
        assertEquals("", grouped.first().courseId)
        val route = routeNotify(notifyLinkOf(grouped.first()), snapshot)
        assertEquals("Noten", route.tab)
        assertEquals("", route.courseId)
        assertEquals(setOf(gradeTargetId(grade), gradeTargetId(other)), route.highlightIds.toSet())
        assertEquals("exam", grouped.last().category)
        assertEquals(1, groupGradeChanges(listOf(first)).size)
        val mark = courseSummaries(listOf(grade)).single().marks.single()
        assertEquals(gradeTargetId(grade), mark.targetId)
    }
}
