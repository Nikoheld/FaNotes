package ch.fasrv.fanotes.schulnetz

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class NotifyAlertTest {
    private val grade = SchoolGrade("g1", "Mathematik", "math", "Mathematik", "Probe", "2026-10-20", 5.5, 1.0, true, null, "")

    private fun lesson(
        id: String = "e1",
        start: String = "2026-11-02T08:15:00",
        end: String = "2026-11-02T09:00:00",
        room: String = "R201",
        status: String = "confirmed",
        eventType: String = "lesson",
        text: String = "Mathematik",
    ) = AgendaEvent(id, start, end, text, "", room, emptyList(), "", text, status, eventType, "", "")

    private fun titles(previous: SchulnetzSnapshot, next: SchulnetzSnapshot, settings: NotifySettings = NotifySettings()) =
        diffSnapshots(previous, next, settings).map { it.title }

    @Test
    fun preferencesKeepOnlyEventsTheDiffEmits() {
        val blank = SchulnetzSnapshot()
        assertEquals(listOf("Neue Note"), titles(blank, blank.copy(grades = listOf(grade))))
        assertEquals(emptyList(), titles(blank, blank.copy(grades = listOf(grade)), NotifySettings(gradeNew = false)))
        assertEquals(emptyList(), titles(blank, blank.copy(grades = listOf(grade)), NotifySettings(grades = false, gradeNew = true)))
        val edited = grade.copy(mark = 4.5)
        assertEquals(listOf("Notenänderung"), titles(blank.copy(grades = listOf(grade)), blank.copy(grades = listOf(edited))))
        assertEquals(emptyList(), titles(blank.copy(grades = listOf(grade)), blank.copy(grades = listOf(edited)), NotifySettings(gradeChanged = false)))

        val exam = lesson(id = "ex1", start = "2026-11-10T10:00:00", end = "2026-11-10T10:45:00", room = "R1", eventType = "1_pru")
        assertEquals(listOf("Neue Prüfung"), titles(blank, blank.copy(exams = listOf(exam))))
        assertEquals(emptyList(), titles(blank, blank.copy(exams = listOf(exam)), NotifySettings(examNew = false)))
        val moved = exam.copy(start = "2026-11-10T12:00:00", end = "2026-11-10T12:45:00")
        assertEquals(listOf("Prüfung verschoben"), titles(blank.copy(exams = listOf(exam)), blank.copy(exams = listOf(moved))))
        assertEquals(emptyList(), titles(blank.copy(exams = listOf(exam)), blank.copy(exams = listOf(moved)), NotifySettings(examMoved = false)))
        val cancelled = exam.copy(status = "cancelled")
        assertEquals(listOf("Prüfung fällt aus"), titles(blank.copy(exams = listOf(exam)), blank.copy(exams = listOf(cancelled))))
        val other = exam.copy(id = "ex2", text = "Chemie", courseName = "Chemie")
        assertTrue(titles(blank.copy(exams = listOf(exam)), blank.copy(exams = listOf(other))).contains("Prüfung entfällt"))
        assertFalse(titles(blank.copy(exams = listOf(exam)), blank.copy(exams = listOf(cancelled)), NotifySettings(examCancelled = false)).contains("Prüfung fällt aus"))
        assertFalse(titles(blank.copy(exams = listOf(exam)), blank.copy(exams = listOf(other)), NotifySettings(examCancelled = false)).contains("Prüfung entfällt"))
        val room = exam.copy(room = "R9")
        assertEquals(listOf("Raum geändert"), titles(blank.copy(exams = listOf(exam)), blank.copy(exams = listOf(room))))
        assertEquals(emptyList(), titles(blank.copy(exams = listOf(exam)), blank.copy(exams = listOf(room)), NotifySettings(examRoom = false)))

        val row = lesson()
        assertEquals(listOf("Raum geändert"), titles(blank.copy(events = listOf(row)), blank.copy(events = listOf(row.copy(room = "R202")))))
        assertEquals(emptyList(), titles(blank.copy(events = listOf(row)), blank.copy(events = listOf(row.copy(room = "R202"))), NotifySettings(lessonChanged = false)))
        assertEquals(listOf("Lektion fällt aus"), titles(blank.copy(events = listOf(row)), blank.copy(events = listOf(row.copy(status = "cancelled")))))
        assertEquals(listOf("Lektion entfernt"), titles(blank.copy(events = listOf(row)), blank))
        assertEquals(emptyList(), titles(blank.copy(events = listOf(row)), blank.copy(events = listOf(row.copy(status = "cancelled"))), NotifySettings(lessonCancelled = false)))
        assertFalse(titles(blank.copy(events = listOf(row)), blank, NotifySettings(lessonCancelled = false)).contains("Lektion entfernt"))
        assertEquals(listOf("Lektion fällt aus"), titles(blank.copy(events = listOf(row)), blank.copy(events = listOf(row.copy(status = "cancelled"))), NotifySettings(lessonChanged = false)))

        val appointment = lesson(id = "t1", start = "2026-11-04T15:00:00", end = "2026-11-04T16:00:00", room = "Aula", text = "Elternabend", eventType = "event", status = "")
        assertEquals(listOf("Neuer Termin"), titles(blank, blank.copy(events = listOf(appointment))))
        assertEquals(emptyList(), titles(blank, blank.copy(events = listOf(appointment)), NotifySettings(appointmentNew = false)))
        val shifted = appointment.copy(start = "2026-11-05T15:00:00", end = "2026-11-05T16:00:00")
        assertEquals(emptyList(), titles(blank.copy(events = listOf(appointment)), blank.copy(events = listOf(shifted))))
        assertEquals("message-new", notifyAlertKind(SchulnetzChange("event:t1", "event", "Termin geändert", "Elternabend")))

        val message = SchoolMessage("m1", "Elternabend", "Freitag 19 Uhr", "")
        assertEquals(listOf("Elternabend"), titles(blank, blank.copy(messages = listOf(message))))
        assertEquals(emptyList(), titles(blank, blank.copy(messages = listOf(message)), NotifySettings(messageNew = false)))
        assertEquals(listOf("Elternabend"), titles(blank, blank.copy(messages = listOf(message)), NotifySettings(appointmentNew = false)))

        val absence = SchoolAbsence("a1", "2026-11-01", "2026-11-01", "08:00", "08:45", "Deutsch", "Arzt", false, false, "")
        assertEquals(emptyList(), titles(blank, blank.copy(absences = listOf(absence)), NotifySettings(enabled = false)))
        assertTrue(alertAllowed(NotifySettings(enabled = false, gradeNew = false), SchulnetzChange("probe:1", "grade", "Test: Neue Note", "Test")))
        assertTrue(alertAllowed(NotifySettings(), SchulnetzChange("grade:g1", "grade", "Neue Note", "Mathematik")))
    }
}
