package ch.fasrv.fanotes.schulnetz

import java.time.LocalDate
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
        fixtureDiff(previous, next, settings).map { it.title }

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

    @Test
    fun everySchoolKindCanBeEnabledOrDisabledWithoutTouchingTheOthers() {
        val kinds = listOf(
            "grade-new", "grade-changed", "lesson-cancelled", "lesson-changed",
            "exam-new", "exam-moved", "exam-cancelled", "exam-room",
            "appointment-new", "message-new", "absence-new", "deadline",
        )
        val surfaces = listOf("remote", "foreground", "fallback")
        for (kind in kinds) {
            val change = sampleSchoolAlert(kind)
            assertEquals(kind, notifyAlertKind(change))
            val on = surfaces.map { schoolAlertGate(NotifySettings(), change, notificationsPermitted = true) }
            assertEquals(listOf(AlertGate.DELIVER, AlertGate.DELIVER, AlertGate.DELIVER), on)
            val off = NotifySettings(
                gradeNew = kind != "grade-new",
                gradeChanged = kind != "grade-changed",
                lessonCancelled = kind != "lesson-cancelled",
                lessonChanged = kind != "lesson-changed",
                examNew = kind != "exam-new",
                examMoved = kind != "exam-moved",
                examCancelled = kind != "exam-cancelled",
                examRoom = kind != "exam-room",
                appointmentNew = kind != "appointment-new",
                messageNew = kind != "message-new",
                absences = kind != "absence-new",
                deadlines = kind != "deadline",
            )
            val blocked = surfaces.map { schoolAlertGate(off, change, notificationsPermitted = true) }
            assertEquals(listOf(AlertGate.PREFERENCE, AlertGate.PREFERENCE, AlertGate.PREFERENCE), blocked)
            val sibling = kinds.first { it != kind }
            assertEquals(AlertGate.DELIVER, schoolAlertGate(off, sampleSchoolAlert(sibling), notificationsPermitted = true))
        }
    }

    @Test
    fun masterSwitchBlocksSchoolAlertsAndLeavesProbesAndTheTestButton() {
        val off = NotifySettings(enabled = false, guessGrades = true)
        val surfaces = listOf("remote", "foreground", "fallback")
        for (kind in listOf("grade-new", "exam-moved", "lesson-cancelled", "appointment-new", "message-new", "absence-new", "deadline")) {
            val decisions = surfaces.map { schoolAlertGate(off, sampleSchoolAlert(kind), notificationsPermitted = true) }
            assertEquals(listOf(AlertGate.PREFERENCE, AlertGate.PREFERENCE, AlertGate.PREFERENCE), decisions)
        }
        val probe = SchulnetzChange("probe:1", "grade", "Test: Neue Note", "Test")
        assertEquals(AlertGate.DELIVER, schoolAlertGate(off, probe, notificationsPermitted = true))
        assertEquals(AlertGate.PERMISSION, schoolAlertGate(off, probe, notificationsPermitted = false))
        assertEquals(AlertGate.DELIVER, schoolAlertGate(off, SchulnetzChange("push-test", "settings", "Test", "Lokal"), notificationsPermitted = true))
        assertEquals(AlertGate.PERMISSION, schoolAlertGate(NotifySettings(), sampleSchoolAlert("grade-new"), notificationsPermitted = false))
        assertTrue(off.guessGrades)
        assertFalse(off.enabled)
    }

    @Test
    fun storedSwitchesSurviveARoundTripAndOldCategoryFlagsKeepTheirMeaning() {
        val custom = NotifySettings(
            enabled = false,
            grades = true,
            gradeNew = true,
            gradeChanged = false,
            timetable = true,
            lessonCancelled = false,
            lessonChanged = true,
            exams = false,
            examNew = false,
            examMoved = false,
            examCancelled = false,
            examRoom = false,
            absences = false,
            events = true,
            appointmentNew = true,
            messageNew = false,
            deadlines = true,
            guessGrades = true,
        )
        assertEquals(custom, notifySettingsFromStored(custom.storedFields()))
        val kept = custom.aligned()
        assertFalse(kept.enabled)
        assertTrue(kept.gradeNew)
        assertTrue(kept.guessGrades)
        val legacy = notifySettingsFromStored(mapOf(
            "grades" to false,
            "timetable" to true,
            "exams" to true,
            "absences" to true,
            "events" to false,
            "deadlines" to true,
        ))
        assertTrue(legacy.enabled)
        assertFalse(legacy.grades)
        assertFalse(legacy.gradeNew)
        assertFalse(legacy.gradeChanged)
        assertTrue(legacy.lessonChanged)
        assertFalse(legacy.appointmentNew)
        assertFalse(legacy.messageNew)
        assertFalse(legacy.guessGrades)
        assertEquals(AlertGate.PREFERENCE, schoolAlertGate(legacy, sampleSchoolAlert("grade-new"), notificationsPermitted = true))
        assertEquals(AlertGate.DELIVER, schoolAlertGate(legacy, sampleSchoolAlert("lesson-changed"), notificationsPermitted = true))
        val present = setOf(NotifyPrefs.GRADES, NotifyPrefs.GUESS)
        val values = mapOf(NotifyPrefs.GRADES to false, NotifyPrefs.GUESS to true)
        val fromFile = notifySettingsFromPrefs({ it in present }, { values[it] == true })
        assertFalse(fromFile.gradeNew)
        assertTrue(fromFile.guessGrades)
        assertTrue(fromFile.enabled)
        assertFalse(fromFile.grades)
    }

    @Test
    fun disabledAlertsOmitTheMarkAndAbsenceAndDeadlineStayIndependent() {
        val blank = SchulnetzSnapshot()
        val next = blank.copy(grades = listOf(grade))
        val quiet = fixtureDiff(blank, next, NotifySettings(enabled = false, guessGrades = true))
        assertTrue(quiet.isEmpty())
        assertEquals(5.5, next.grades[0].mark)
        assertFalse(quiet.joinToString { it.body + it.title }.contains("5.5"))
        val today = LocalDate.of(2026, 11, 7)
        val absence = SchoolAbsence("a1", "2026-11-01", "2026-11-01", "08:00", "08:45", "Deutsch", "Arzt", false, false, "", excuseUntil = "08.11.2026")
        val withAbsence = blank.copy(absences = listOf(absence))
        assertEquals(listOf("Neue Absenz", "Entschuldigung läuft ab"), fixtureDiff(blank, withAbsence, NotifySettings(), today).map { it.title })
        assertEquals(listOf("Entschuldigung läuft ab"), fixtureDiff(blank, withAbsence, NotifySettings(absences = false), today).map { it.title })
        assertEquals(listOf("Neue Absenz"), fixtureDiff(blank, withAbsence, NotifySettings(deadlines = false), today).map { it.title })
        assertEquals(emptyList(), fixtureDiff(blank, withAbsence, NotifySettings(enabled = false), today).map { it.title })
    }
}
