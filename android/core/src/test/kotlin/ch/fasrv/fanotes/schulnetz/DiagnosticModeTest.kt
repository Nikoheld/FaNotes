package ch.fasrv.fanotes.schulnetz

import java.time.LocalDate
import java.time.ZoneId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertSame
import kotlin.test.assertTrue

class DiagnosticModeTest {
    private val zone = ZoneId.of("Europe/Zurich")
    private val day = LocalDate.of(2026, 11, 7)

    @Test
    fun modeIsOffUntilChosenAndTheBufferStaysBounded() {
        assertEquals(DiagnosticScenario.OFF, DiagnosticScenario.fromId(null))
        assertEquals(DiagnosticScenario.OFF, DiagnosticScenario.fromId("nope"))
        val trace = DiagnosticTrace
        val was = trace.enabled
        try {
            trace.enabled = false
            trace.clear()
            trace.record("push", "secret", detail = "Bearer abcdef")
            assertTrue(trace.recent().isEmpty())
            trace.enabled = true
            repeat(DiagnosticTrace.CAPACITY + 5) { index -> trace.record("tab", "agenda", index.toLong(), "slow") }
            assertEquals(DiagnosticTrace.CAPACITY, trace.recent().size)
            assertEquals((5).toLong(), trace.recent().first().durationMs)
        } finally {
            trace.clear()
            trace.enabled = was
        }
    }

    @Test
    fun schoolPreviewStaysSimulatedAndRespectsZurichDays() {
        val lines = diagnosticPreview(DiagnosticScenario.SCHOOL, zone, day)
        assertTrue(lines.all { it.title.startsWith("Simulation") || it.detail.startsWith("geplant") || it.detail.startsWith("abgesagt") || it.title.contains("Simulation") })
        assertTrue(lines.none { it.detail.contains("5.5") || it.title.contains("5.5") })
        val joined = lines.joinToString("\n") { "${it.title} ${it.detail}" }
        assertTrue(joined.contains("Datum 07.11.2026"))
        assertTrue(joined.contains("Elterngespräch"))
        val zurich = lines.first { it.title.contains("Zürich 23:30") }
        val utc = lines.first { it.title.contains("UTC 23:30") }
        val future = lines.first { it.title.contains("nächste Woche") }
        assertTrue(zurich.detail.contains("07.11.2026"))
        assertTrue(utc.detail.contains("08.11.2026"))
        assertTrue(future.detail.contains(formatProbeDay(day.plusDays(10).toString())))
        assertTrue(joined.contains("abgesagt"))
    }

    @Test
    fun malformedRowsDropBlanksAndDuplicatesWithoutTouchingTheInput() {
        val rows = malformedFixture()
        val cleaned = collapseSyntheticRows(rows)
        assertEquals(1, cleaned.kept.size)
        assertEquals("sim:keep", cleaned.kept[0].id)
        assertEquals("Simulation: gültige Zeile", cleaned.kept[0].title)
        assertEquals(2, cleaned.dropped)
        assertEquals(1, cleaned.duplicates)
        assertEquals(4, rows.size)
        val preview = diagnosticPreview(DiagnosticScenario.MALFORMED, zone, day)
        assertTrue(preview[1].detail.contains("2 ungültig") && preview[1].detail.contains("1 doppelt"))
    }

    @Test
    fun overlayCopiesTheSnapshotAndLeavesTheStoredListsAlone() {
        val grade = SchoolGrade("real", "Mathematik", "m1", "Mathematik", "Probe", "2026-11-01", 5.5, 1.0, true, null, "")
        val event = AgendaEvent("real-event", "2026-11-07T08:15:00", "2026-11-07T09:00:00", "Mathematik", "", "A1", emptyList(), "m1", "Mathematik", "", "lesson", "", "Mathematik")
        val base = SchulnetzSnapshot(grades = listOf(grade), events = listOf(event), fetchedAt = "2026-11-07T12:00:00Z")
        val originalGrades = base.grades
        val originalEvents = base.events
        val extraGrade = SchoolGrade("sim:grade", "Simulation", "sim", "Simulation", "Simulation: Testnote", day.toString(), null, 1.0, true, null, "")
        val extraEvent = AgendaEvent("sim:lesson", "${day}T10:00:00", "${day}T10:45:00", "Simulation: Lektion", "", "", emptyList(), "", "SIM", "cancelled", "lesson", "", "Simulation: Lektion")
        val next = isolateSchoolSnapshot(base, listOf(extraGrade), listOf(extraEvent))
        assertSame(originalGrades, base.grades)
        assertSame(originalEvents, base.events)
        assertEquals(1, base.grades.size)
        assertEquals(1, base.events.size)
        assertEquals("real", base.grades[0].id)
        assertTrue(next.grades !== base.grades)
        assertEquals(listOf("real", "sim:grade"), next.grades.map { it.id })
        assertEquals(listOf("real-event", "sim:lesson"), next.events.map { it.id })
        assertEquals(5.5, base.grades[0].mark)
        assertEquals(null, next.grades[1].mark)
    }

    @Test
    fun exportDropsMarksSecretsAndNoteText() {
        val report = diagnosticReport(
            "2026.11.2-beta.10 (51000160)",
            listOf("Verbindung: linked", "Push: registered"),
            listOf(
                DiagnosticEntry("push", "receipt", 40, "ok", "probe:20261107120000000"),
                DiagnosticEntry("network", "GET /api/v1/schulnetz/changes", 12, "auth", "Bearer secret-token password=hunter2 user@example.com 5.5 Mathematik"),
            ),
        )
        assertTrue(report.contains("2026.11.2-beta.10"))
        assertTrue(report.contains("probe:20261107120000000"))
        assertTrue(report.contains("07.11") || report.contains("Datum") || report.contains("linked"))
        assertFalse(report.contains("Bearer secret-token"))
        assertFalse(report.contains("hunter2"))
        assertFalse(report.contains("user@example.com"))
        assertFalse(report.contains("5.5"))
        assertFalse(report.contains("Mathematik"))
        assertEquals("auth", httpResultCategory(401))
        assertEquals("offline", httpResultCategory(0))
        assertEquals("server", httpResultCategory(503))
    }

    @Test
    fun alertPreviewFollowsEachSwitchAndDoesNotInventAChangedAppointment() {
        val grade = SchoolGrade("real", "Mathematik", "m1", "Mathematik", "Probe", "2026-11-01", 5.5, 1.0, true, null, "")
        val stored = SchulnetzSnapshot(grades = listOf(grade), fetchedAt = "2026-11-07T12:00:00Z")
        val settings = NotifySettings(gradeNew = false, examRoom = false, guessGrades = true, enabled = true)
        val lines = diagnosticPreview(DiagnosticScenario.ALERTS, zone, day, settings)
        assertEquals(DiagnosticScenario.ALERTS, DiagnosticScenario.fromId("alerts"))
        assertTrue(lines.all { it.title.startsWith("Simulation:") })
        assertEquals("aus", lines.first { it.title.contains("Neue Noten") }.detail)
        assertEquals("an", lines.first { it.title.contains("Notenänderungen") }.detail)
        assertEquals("aus", lines.first { it.title.contains("Raumänderung bei Prüfungen") }.detail)
        assertEquals("an", lines.first { it.title.contains("Neue Termine") }.detail)
        assertTrue(lines.none { it.title.contains("Termin geändert") || it.title.contains("Termin abgesagt") })
        assertTrue(lines.first { it.title.contains("Zustelltest") }.detail.contains("ignoriert"))
        assertTrue(lines.first { it.title.contains("Vordergrund") }.detail.contains("gleiche Prüfung"))
        assertTrue(lines.first { it.title.contains("Noten verstecken") }.detail.startsWith("an"))
        assertTrue(lines.first { it.title.contains("Hauptschalter") }.detail.startsWith("an"))
        val joined = lines.joinToString("\n") { "${it.title} ${it.detail}" }
        assertFalse(joined.contains("5.5"))
        assertEquals(1, stored.grades.size)
        assertEquals(5.5, stored.grades[0].mark)
        val masterOff = diagnosticPreview(DiagnosticScenario.ALERTS, zone, day, NotifySettings(enabled = false, guessGrades = true))
        assertTrue(masterOff.first { it.title.contains("Hauptschalter") }.detail.startsWith("aus"))
        assertTrue(masterOff.filter { it.title.contains("Neue Noten") || it.title.contains("Neue Termine") }.all { it.detail == "aus" })
        assertTrue(masterOff.first { it.title.contains("Zustelltest") }.detail.contains("an"))
        assertTrue(masterOff.first { it.title.contains("Noten verstecken") }.detail.startsWith("an"))
        val status = diagnosticAlertStatus(settings)
        assertTrue(status.contains("Schulmeldungen: an"))
        assertTrue(status.contains("neue Noten"))
        assertTrue(status.contains("Noten verstecken: an"))
        assertFalse(status.contains("5.5"))
    }

    @Test
    fun startupRecordsTheFirstFrameAndARepeatedConflictIsOneKey() {
        val trace = DiagnosticTrace
        val was = trace.enabled
        try {
            trace.enabled = false
            trace.clear()
            trace.noteStartup(140)
            trace.noteStartup(-5)
            trace.noteEnabled()
            val startup = trace.recent().single { it.category == "startup" }
            assertEquals("enabled", startup.name)
            assertEquals(140L, startup.durationMs)
            assertEquals("ok", startup.result)
            assertEquals("conflict:Notes/a.md,Notes/b.md", diagnosticSyncKey("SYNCING", listOf("Notes/b.md", "Notes/a.md", "Notes/a.md")))
            assertEquals("conflict:Notes/a.md,Notes/b.md", diagnosticSyncKey("ERROR", listOf("Notes/a.md", "Notes/b.md")))
            assertEquals("idle", diagnosticSyncKey("IDLE", emptyList()))
        } finally {
            trace.clear()
            trace.enabled = was
        }
    }

    @Test
    fun statePreviewDoesNotClaimARealSessionChange() {
        val lines = diagnosticPreview(DiagnosticScenario.STATES, zone, day).joinToString("\n") { it.detail }
        assertTrue(lines.contains("nicht abgemeldet"))
        assertTrue(lines.contains("Keine Fassung wird überschrieben"))
        assertTrue(lines.contains("Gespeicherte Schuldaten bleiben"))
    }
}
