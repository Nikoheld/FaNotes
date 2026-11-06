package ch.fasrv.fanotes.schulnetz

import kotlin.test.*

/** Generated events only; no device screenshot, account data, or real school course codes. */
class AgendaBaselineTest {
    private val week = "2026-11-23"
    private val stamp1 = "2026-11-06T10:00:00Z"
    private val stamp2 = "2026-11-06T11:00:00Z"
    private val stamp3 = "2026-11-06T12:00:00Z"
    private fun exam(id: String = "synthetic-101@calendar.example.org", day: String = week) = AgendaEvent(
        id, "${day}T10:15:00", "${day}T11:00:00", "Synthetic quiz", "", "R1", emptyList(),
        "synthetic", "Synthetic course", "", "exam", "", "Synthetic quiz",
    )
    private fun read(exams: List<AgendaEvent>, stamp: String, weeks: Set<String> = setOf(week), events: List<AgendaEvent> = emptyList()) =
        SchulnetzSnapshot(fetchedAt = stamp, events = events, exams = exams, weekFetched = weeks.associateWith { stamp }, examWeekFetched = weeks.associateWith { stamp })
    private fun changes(previous: SchulnetzSnapshot?, next: SchulnetzSnapshot, stored: Map<String, SchulnetzSnapshot>): Pair<List<SchulnetzChange>, Map<String, SchulnetzSnapshot>> {
        val prepared = prepareAgendaRead(stored, next)
        // The production paths write this BEFORE diffing. Round-trip it to cover restart persistence.
        val persisted = parseAgendaBaseline(agendaBaselineJson(prepared.weeks))
        return diffSnapshots(prepared.comparison(previous), next) to persisted
    }

    @Test fun firstCoveredExamWeekIsQuietEvenWithAnOldLessonAndDifferentCalendarUid() {
        val ordinary = exam("old-lesson").copy(eventType = "lesson", text = "Synthetic course", timetableText = "Synthetic course", start = "${week}T08:00:00", room = "R2")
        val previous = read(emptyList(), stamp1, events = listOf(ordinary)).copy(examWeekFetched = emptyMap())
        val incoming = read(listOf(exam()), stamp2, events = listOf(ordinary))
        val (alerts, baseline) = changes(previous, incoming, emptyMap())
        assertTrue(alerts.isEmpty())
        assertEquals(incoming.exams, baseline.getValue(week).exams)
        assertEquals(stamp2, baseline.getValue(week).examWeekFetched[week])
    }

    @Test fun overlappingStableWeeksAndUidAliasesAreQuietThenOneRealMoveIsReported() {
        val first = read(listOf(exam()), stamp1)
        val baseline = changes(SchulnetzSnapshot(), first, emptyMap()).second
        val alias = exam("synthetic-101")
        val repeat = read(listOf(alias, exam()), stamp2, setOf(week, "2026-11-30"))
        val (quiet, stored) = changes(first, repeat, baseline)
        assertTrue(quiet.isEmpty())
        val moved = alias.copy(start = "${week}T12:00:00", end = "${week}T12:45:00")
        val latest = read(listOf(moved), stamp3, setOf(week, "2026-11-30"))
        val (alerts, after) = changes(repeat, latest, stored)
        assertEquals(listOf("Prüfung verschoben"), alerts.map { it.title })
        assertTrue(alerts.single().body.startsWith("23.11.2026 · "))
        assertEquals(week, alerts.single().date)
        assertTrue(changes(latest, latest, after).first.isEmpty())
        assertTrue(changes(latest, latest.copy(fetchedAt = "2026-11-06T13:00:00Z", examWeekFetched = latest.examWeekFetched.mapValues { "2026-11-06T13:00:00Z" }), after).first.isEmpty())
    }

    @Test fun missingFieldsEmptyStaleAndPartialReadsDoNotAdvanceOrAnnounceMoves() {
        val first = read(listOf(exam()), stamp2)
        val baseline = changes(SchulnetzSnapshot(), first, emptyMap()).second
        val changed = exam().copy(start = "${week}T12:00:00", end = "${week}T12:45:00")
        val cases = listOf(read(listOf(changed), stamp1), read(emptyList(), stamp3),
            read(listOf(exam().copy(start = week, end = "")), stamp3),
            read(listOf(changed), stamp3).copy(readErrors = listOf("Laden fehlgeschlagen")),
            read(listOf(changed), stamp3).copy(examWeekFetched = emptyMap()))
        for (candidate in cases) {
            val (alerts, stored) = changes(first, candidate, baseline)
            assertTrue(alerts.none { it.category == "exam" })
            assertEquals(baseline.getValue(week).exams, stored.getValue(week).exams)
            assertEquals(stamp2, stored.getValue(week).examWeekFetched[week])
        }
        assertEquals("Prüfung verschoben", changes(first, read(listOf(changed), stamp3), baseline).first.single().title)
        assertEquals("Prüfung verschoben", changes(first, read(listOf(changed), stamp3).copy(readErrors = listOf("Noten: Seite geladen, aber nicht lesbar")), baseline).first.single().title)
    }

    @Test fun newExamInEstablishedEmptyWeekStillAnnouncesAndRoomOnlyIsNotAMove() {
        val empty = read(emptyList(), stamp1)
        val baseline = changes(SchulnetzSnapshot(), empty, emptyMap()).second
        val next = read(listOf(exam()), stamp2)
        val (alerts, stored) = changes(empty, next, baseline)
        assertEquals(listOf("Neue Prüfung"), alerts.map { it.title })
        val room = read(listOf(exam().copy(room = "R3")), stamp3)
        assertEquals(listOf("Raum geändert"), changes(next, room, stored).first.map { it.title })
        val end = read(listOf(exam().copy(end = "${week}T11:30:00")), stamp3)
        assertEquals(listOf("Prüfung verschoben"), changes(next, end, stored).first.map { it.title })
    }

    @Test fun knownExamCanReallyMoveIntoANewWeekAndFormattingIsNotAMove() {
        val first = read(listOf(exam()), stamp1)
        val baseline = changes(SchulnetzSnapshot(), first, emptyMap()).second
        val formatted = exam("synthetic-101").copy(start = "2026-11-23T09:15:00Z", end = "2026-11-23T10:00:00Z")
        assertTrue(changes(first, read(listOf(formatted), stamp2), baseline).first.isEmpty())
        val later = exam("synthetic-101", "2026-11-30")
        val next = read(listOf(later), stamp2, setOf(week, "2026-11-30"))
        val moved = changes(first, next, baseline)
        assertEquals(listOf("Prüfung verschoben"), moved.first.map { it.title })
        assertTrue(moved.first.single().body.startsWith("30.11.2026 · "))
        assertTrue(moved.second.getValue(week).exams.isEmpty())
        assertTrue(changes(next, read(listOf(later), stamp3, setOf(week, "2026-11-30")), moved.second).first.isEmpty())
    }

    @Test fun moveAndCancelledLessonsEachShowTheirOwnEventDateIncludingSwissMidnight() {
        val first = read(listOf(exam(), exam("synthetic-102", "2026-11-24")), stamp1)
        val stored = changes(SchulnetzSnapshot(), first, emptyMap()).second
        val moved = first.exams.map { it.copy(start = it.start.replace("10:15", "12:00"), end = it.end.replace("11:00", "12:45")) }
        val notices = changes(first, read(moved, stamp2), stored).first
        assertEquals(setOf("23.11.2026", "24.11.2026"), notices.map { it.body.substringBefore(" · ") }.toSet())
        val lessons = listOf(exam("lesson-1").copy(text = "Synthetic lesson", timetableText = "Synthetic lesson", eventType = "lesson"),
            exam("lesson-2", "2026-11-24").copy(text = "Synthetic lesson", timetableText = "Synthetic lesson", eventType = "lesson"))
        val cancelled = diffSnapshots(SchulnetzSnapshot(events = lessons), SchulnetzSnapshot(events = lessons.map { it.copy(status = "cancelled") }))
        assertEquals(setOf("23.11.2026", "24.11.2026"), cancelled.map { it.body.substringBefore(" · ") }.toSet())
        assertTrue(cancelled.all { it.title == "Lektion fällt aus" })
        val night = lessons.first().copy(start = "2026-11-08T23:30:00Z", end = "2026-11-09T00:15:00Z")
        val notice = diffSnapshots(SchulnetzSnapshot(events = listOf(night)), SchulnetzSnapshot(events = listOf(night.copy(status = "cancelled"))))
        assertTrue(notice.single().body.startsWith("09.11.2026 · "))
        assertTrue(notice.single().body.contains("00:30–01:15"))
    }
}
