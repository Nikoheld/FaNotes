package ch.fasrv.fanotes.schulnetz

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.parseJson
import ch.fasrv.fanotes.json.stringify
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class AbsencePointsTest {
    private fun resource(name: String): String = checkNotNull(javaClass.getResource("/schulnetz/$name")) { name }.readText()

    /** The same cases run in fanotes-site/absence-points.test.mjs, so app and server estimate alike. */
    @Test
    fun sharedCasesEstimateLikeTheReglement() {
        val root = parseJson(resource("absence-points-cases.json")) as JsonValue.Obj
        val cases = (root.fields["cases"] as JsonValue.Arr).items.map { it as JsonValue.Obj }
        assertTrue(cases.size >= 15)
        for (case in cases) {
            val name = (case.fields["name"] as JsonValue.Str).value
            val snapshot = checkNotNull(parseNormalizedSnapshot(case.fields["snapshot"]!!.stringify())) { name }
            val expect = case.fields["expect"] as JsonValue.Obj
            val tally = absenceTally(snapshot)
            assertEquals(expect.double("estimated")!!.toInt(), tally.estimated, name)
            assertEquals(expect.double("booked")!!, tally.booked, 1e-9, name)
            val remaining = expect.fields["remaining"]
            if (remaining is JsonValue.Num) assertEquals(remaining.value, tally.remaining!!, 1e-9, name) else assertNull(tally.remaining, name)
            for ((id, points) in (expect.fields["points"] as JsonValue.Obj).fields) {
                assertEquals((points as JsonValue.Num).value.toInt(), tally.estimates[id]?.points, "$name $id")
            }
            for ((id, rule) in (expect.fields["rules"] as JsonValue.Obj).fields) {
                assertEquals((rule as JsonValue.Str).value, tally.estimates[id]?.rule, "$name $id")
            }
            val blocks = tally.estimates.entries.filter { it.value.block >= 0 }.groupBy({ it.value.block }, { it.key }).toSortedMap().values.map { it.toSet() }
            val expected = (expect.fields["blocks"] as JsonValue.Arr).items.map { block -> (block as JsonValue.Arr).items.map { (it as JsonValue.Str).value }.toSet() }
            assertEquals(expected, blocks, name)
        }
    }

    @Test
    fun openReportsOfTheRealLayoutAreRead() {
        val read = readAbsenceStatement(resource("absenzen-aksa-open.html"))
        assertNull(read.error)
        val statement = read.value
        assertTrue(statement.read)
        assertEquals(30.0, statement.quota)
        assertEquals(30.0, statement.remaining)
        assertEquals(2, statement.absences.size)
        val (first, second) = statement.absences
        assertTrue(first.pending && second.pending)
        assertNotEquals(first.id, second.id, "a double lesson reported twice stays two rows")
        assertEquals("03.11.2026", first.dateFrom)
        assertEquals("08:00", first.hourFrom)
        assertEquals("08:45", first.hourTo)
        assertEquals("08:45", second.hourFrom)
        assertEquals("09:30", second.hourTo)
        assertEquals("geo 2.3", first.subject)
        assertNull(first.points)
        assertTrue(first.isOpen())
        // The same rows through the list reader the rest of the app uses.
        assertEquals(statement.absences, readAbsencesPage(resource("absenzen-aksa-open.html")).value)
    }

    @Test
    fun theDoubleLessonCostsThreeAndLowersTheRemainingQuota() {
        val statement = readAbsenceStatement(resource("absenzen-aksa-open.html")).value
        val lessons = listOf("08:00" to "08:45", "08:45" to "09:30", "09:45" to "10:30").mapIndexed { index, (from, to) ->
            AgendaEvent("${4001 + index}", "2026-11-03T$from:00", "2026-11-03T$to:00", if (index < 2) "geo 2.3" else "mat 2.1", "", "B12", emptyList(), "100$index",
                if (index < 2) "geo 2.3" else "mat 2.1", "", "0_stp", "", if (index < 2) "geo 2.3" else "mat 2.1")
        }
        val exam = AgendaEvent("exam-1", "2026-11-03T13:15:00", "2026-11-03T14:00:00", "bio 2.1 Prüfung", "", "", emptyList(), "", "bio 2.1 Prüfung", "", "exam", "", "bio 2.1 Prüfung")
        val snapshot = SchulnetzSnapshot(events = lessons, exams = listOf(exam)).withAbsenceStatement(statement)
        val tally = absenceTally(snapshot)
        assertEquals(3, tally.estimated)
        assertEquals(0.0, tally.booked)
        assertEquals(27.0, tally.remaining)
        assertEquals(2, tally.openReports)
        assertEquals(setOf(3), tally.estimates.values.map { it.points }.toSet())
        assertEquals(listOf(true, false), statement.absences.map { tally.estimates.getValue(it.id).first })
    }

    @Test
    fun bookedRowsQuotaAndAReasonFieldAreReadWithoutTouchingTheForm() {
        val statement = readAbsenceStatement(resource("absenzen-aksa-booked.html")).value
        assertEquals(30.0, statement.quota)
        assertEquals(27.0, statement.remaining)
        val booked = statement.absences.single { !it.pending }
        assertEquals(3.0, booked.points)
        assertEquals("Krankheit", booked.reason)
        assertEquals("27.10.2026", booked.dateFrom)
        assertEquals("27.10.2026", booked.dateTo)
        assertFalse(booked.isOpen())
        val open = statement.absences.single { it.pending }
        assertEquals("mat 2.1", open.subject)
        assertEquals("10:30", open.hourFrom)
        assertFalse(open.subject.contains("Speichern") || open.reason.contains("Zahnarzt"))
        val tally = absenceTally(SchulnetzSnapshot().withAbsenceStatement(statement))
        assertEquals(3.0, tally.booked)
        // No timetable for that week: one lesson, 1 + 1.
        assertEquals(2, tally.estimated)
        assertEquals(25.0, tally.remaining)
    }

    @Test
    fun theOlderLayoutsStillRead() {
        val read = readAbsencesPage(resource("absenzen.html"))
        assertNull(read.error)
        assertTrue(read.value.isEmpty())
        assertTrue(readAbsenceStatement(resource("absenzen.html")).value.read)
    }

    @Test
    fun anOpenReportTurningIntoABookedEntryIsNotCountedTwice() {
        val lessons = listOf(
            AgendaEvent("4001", "2026-11-03T08:00:00", "2026-11-03T08:45:00", "geo 2.3", "", "", emptyList(), "1", "geo 2.3", "", "0_stp", "", "geo 2.3"),
            AgendaEvent("4002", "2026-11-03T08:45:00", "2026-11-03T09:30:00", "geo 2.3", "", "", emptyList(), "2", "geo 2.3", "", "0_stp", "", "geo 2.3"),
        )
        val open = SchulnetzSnapshot(events = lessons).withAbsenceStatement(readAbsenceStatement(resource("absenzen-aksa-open.html")).value)
        assertEquals(27.0, absenceTally(open).remaining)
        val bookedRow = SchoolAbsence("abs-1", "03.11.2026", "03.11.2026", "", "", "", "Krankheit", false, true, "gebucht", points = 3.0)
        // Schulnetz books the entry and the open reports are still listed for a while.
        val both = open.copy(absences = listOf(bookedRow) + open.absences, absenceRemaining = 27.0)
        val tally = absenceTally(both)
        assertEquals(0, tally.estimated)
        assertEquals(3.0, tally.booked)
        assertEquals(27.0, tally.remaining)
        assertTrue(tally.estimates.values.all { it.rule == "booked" })
        // Then the open reports are gone.
        val booked = open.copy(absences = listOf(bookedRow), absenceRemaining = 27.0)
        assertEquals(3.0, absenceTally(booked).total)
        assertEquals(27.0, absenceTally(booked).remaining)
        val changes = diffSnapshots(open, booked, today = LocalDate.of(2026, 11, 10))
        assertEquals(listOf("Krankheit · 03.11.2026 · 3 Punkte gebucht · Kontingent noch 27 von 30"), changes.filter { it.category == "absence" }.map { it.body })
    }

    @Test
    fun theFirstReadWithThePointsParserIsABaselineAndLaterReportsAreAnnouncedWithTheEstimate() {
        val olderRead = SchulnetzSnapshot(
            absences = parseAbsencesByHeader(resource("absenzen-aksa-open.html")),
        )
        assertEquals(0, olderRead.absenceParser)
        val statement = readAbsenceStatement(resource("absenzen-aksa-open.html")).value
        val first = olderRead.withAbsenceStatement(statement)
        assertTrue(diffSnapshots(olderRead, first, today = LocalDate.of(2026, 11, 10)).none { it.category == "absence" })
        val later = first.copy(absences = first.absences + SchoolAbsence("abs-open-x", "10.11.2026", "10.11.2026", "10:30", "11:15", "mat 2.1", "", false, false, "offen", pending = true))
        val notices = diffSnapshots(first, later, today = LocalDate.of(2026, 11, 10)).filter { it.category == "absence" }
        assertEquals(1, notices.size)
        // The 03.11 week has no timetable here, so each report is one block: 2 + 2 + 2 = 6.
        assertEquals("mat 2.1 · 10.11.2026 10:30 · Absenzmeldung offen · geschätzt 2 Punkte · Kontingent noch 24 von 30", notices.single().body)
    }

    @Test
    fun snapshotsKeepPointsQuotaAndOpenReports() {
        val statement = readAbsenceStatement(resource("absenzen-aksa-booked.html")).value
        val snapshot = SchulnetzSnapshot(revision = 3).withAbsenceStatement(statement)
        val copy = checkNotNull(parseNormalizedSnapshot(snapshot.toNormalizedJson()))
        assertEquals(snapshot.absences, copy.absences)
        assertEquals(30.0, copy.absenceQuota)
        assertEquals(27.0, copy.absenceRemaining)
        assertEquals(ABSENCE_PARSER_VERSION, copy.absenceParser)
    }

    @Test
    fun anUnreadPageKeepsTheStoredStatementAndTheNewerParserWinsOnAdoption() {
        val stored = SchulnetzSnapshot().withAbsenceStatement(readAbsenceStatement(resource("absenzen-aksa-booked.html")).value)
        val unread = SchulnetzSnapshot()
        assertEquals(stored.absences, keepAbsenceRead(stored, unread).absences)
        assertEquals(27.0, keepAbsenceRead(stored, unread).absenceRemaining)
        val emptyRead = SchulnetzSnapshot().withAbsenceStatement(AbsenceStatement(emptyList(), 30.0, 30.0, read = true))
        assertTrue(keepAbsenceRead(stored, emptyRead).absences.isEmpty())
        // An older server copy (parsed by an app before the points parser) does not replace the phone's statement.
        val olderServer = SchulnetzSnapshot(absences = parseAbsencesByHeader(resource("absenzen-aksa-booked.html")))
        assertEquals(stored.absences, adoptServerSnapshot(stored, olderServer).absences)
        assertEquals(30.0, adoptServerSnapshot(stored, olderServer).absenceQuota)
        assertTrue(adoptServerSnapshot(stored, emptyRead).absences.isEmpty())
    }

    @Test
    fun pointsTextIsGerman() {
        assertEquals("3", pointsText(3.0))
        assertEquals("2,5", pointsText(2.5))
        assertEquals("-1", pointsText(-1.0))
    }
}
