package ch.fasrv.fanotes.schulnetz

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class WeekRangeTest {
    private val today = LocalDate.parse("2026-11-04")
    private val now = Instant.parse("2026-11-04T12:00:00Z")
    private val zone = ZoneId.of("Europe/Zurich")

    private fun lesson(id: String, start: String, room: String = "A1", type: String = "lesson") = AgendaEvent(
        id, start, start, "Mathematik", "", room, listOf("Nord"), "math", "Mathematik", "", type, "", "",
    )

    @Test
    fun spanComesFromThePageClockOrTheDataAttributes() {
        val script = """<script>scheduler.config.limit_start = new Date(2026, 7, 17); scheduler.config.limit_end = new Date(2027, 6, 4);</script>"""
        val fromClock = parseWeekSpan(script)
        assertEquals(LocalDate.parse("2026-08-17"), fromClock!!.start)
        assertEquals(LocalDate.parse("2027-07-04"), fromClock.end)
        val quoted = """scheduler.config.limit_start = "2026-08-17"; scheduler.config.limit_end = "2027-07-04";"""
        assertEquals(fromClock, parseWeekSpan(quoted))
        val data = """<div data-min-date="2026-08-17" data-max-date="2027-07-04"></div>"""
        assertEquals(fromClock, parseWeekSpan(data))
        assertNull(parseWeekSpan("<html><body>Stundenplan</body></html>"))
        assertNull(parseWeekSpan("""<script>scheduler.config.limit_start = new Date(Date.UTC(2026, 7, 17)); scheduler.config.limit_end = new Date(Date.UTC(2027, 6, 4));</script>"""))
        assertNull(parseWeekSpan("""<div data-min-date="17.08.2026" data-max-date="04.07.2027"></div>"""))
    }

    @Test
    fun anUnmarkedPageProbesTheNextWeeksOnceAndThenWaits() {
        val first = planWeekFetches(emptyList(), emptyMap(), "", now, today, icalAvailable = false)
        assertEquals(
            listOf("2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23", "2026-11-30").map(LocalDate::parse),
            first.fetch,
        )
        val held = planWeekFetches(emptyList(), mapOf("2026-11-02" to now.toString()), "", now, today, icalAvailable = false)
        assertEquals(first.fetch, held.fetch)
        val fresh = first.fetch.associate { it.toString() to now.toString() }
        val quiet = planWeekFetches(emptyList(), fresh, "", now, today, icalAvailable = false)
        assertEquals(listOf(LocalDate.parse("2026-11-02")), quiet.fetch)
        val stale = fresh.toMutableMap()
        stale["2026-11-16"] = "2026-11-03T11:00:00Z"
        stale["2026-11-23"] = "2026-11-03T11:00:00Z"
        stale["2026-11-30"] = "2026-11-03T10:00:00Z"
        val one = planWeekFetches(emptyList(), stale, "", now, today, icalAvailable = false)
        assertEquals(listOf(LocalDate.parse("2026-11-02"), LocalDate.parse("2026-11-30")), one.fetch)
        val next = LocalDate.parse("2026-11-09")
        val url = schedulerUrl(AKSA_SCHULNETZ_BASE, "abc", "def", next.toString(), next.toString(), next.plusDays(7).toString())
        assertTrue(url.contains("min_date=2026-11-09"))
        assertTrue(url.contains("max_date=2026-11-16"))
        assertFalse(url.contains("min_date=2026-08-17"))
        val xml = """<data><event id="next"><start_date>2026-11-09 08:15</start_date><end_date>2026-11-09 09:00</end_date><text>Mathematik</text><event_type>0_stp</event_type></event></data>"""
        val current = lesson("e1", "2026-11-04T08:15:00")
        val merged = overlayLessons(listOf(current), parseSchedulerXml(xml), setOf("2026-11-09"))
        assertEquals(setOf("e1", "next"), merged.map { it.id }.toSet())
        assertTrue(schedulerBodyUsable("<data></data>"))
        assertFalse(schedulerWeekLoaded("<data></data>"))
    }

    @Test
    fun firstSyncUsesTheCalendarOnceAndLaterSyncsStayNear() {
        val mondays = mondaysBetween(LocalDate.parse("2026-01-05"), LocalDate.parse("2027-06-28"))
        assertTrue(mondays.size > WEEK_CAP)
        val withCalendar = planWeekFetches(mondays, emptyMap(), "", now, today, icalAvailable = true)
        assertEquals(
            listOf(LocalDate.parse("2026-10-26"), LocalDate.parse("2026-11-02"), LocalDate.parse("2026-11-09")),
            withCalendar.fetch,
        )
        assertTrue(withCalendar.fetchIcal)
        val withoutCalendar = planWeekFetches(mondays, emptyMap(), "", now, today, icalAvailable = false)
        assertEquals(WEEK_CAP, withoutCalendar.fetch.size)
        assertFalse(withoutCalendar.fetchIcal)
        val probed = planWeekFetches(emptyList(), emptyMap(), "", now, today, icalAvailable = false)
        assertEquals(probeMondays(today), probed.fetch)
        assertEquals(WEEK_PROBE + 1, probed.fetch.size)
        assertFalse(probed.fetchIcal)
        val withCalendarProbe = planWeekFetches(emptyList(), emptyMap(), "", now, today, icalAvailable = true)
        assertEquals(listOf(LocalDate.parse("2026-11-02"), LocalDate.parse("2026-11-09")), withCalendarProbe.fetch)
        assertTrue(withCalendarProbe.fetchIcal)

        val fresh = mondays.associate { it.toString() to now.toString() }
        val quiet = planWeekFetches(mondays, fresh, now.toString(), now, today, icalAvailable = true)
        assertEquals(listOf(LocalDate.parse("2026-11-02")), quiet.fetch)
        assertFalse(quiet.fetchIcal)

        val adjacentStale = fresh.toMutableMap()
        adjacentStale["2026-10-26"] = "2026-11-04T11:00:00Z"
        val adjacent = planWeekFetches(mondays, adjacentStale, now.toString(), now, today, icalAvailable = true)
        assertEquals(listOf(LocalDate.parse("2026-10-26"), LocalDate.parse("2026-11-02")), adjacent.fetch)

        val dayOld = fresh.mapValues { "2026-11-03T11:00:00Z" }.toMutableMap()
        dayOld["2026-11-02"] = now.toString()
        dayOld["2026-10-26"] = now.toString()
        dayOld["2026-11-09"] = now.toString()
        dayOld["2026-08-17"] = "2026-10-01T00:00:00Z"
        val far = planWeekFetches(mondays, dayOld, "", now, today, icalAvailable = false)
        assertEquals(listOf(LocalDate.parse("2026-11-02"), LocalDate.parse("2026-08-17")), far.fetch)
        val calendarInstead = planWeekFetches(mondays, dayOld, "2026-11-03T11:00:00Z", now, today, icalAvailable = true)
        assertTrue(calendarInstead.fetchIcal)
        assertFalse(calendarInstead.fetch.contains(LocalDate.parse("2026-08-17")))
    }

    @Test
    fun refreshedWeekKeepsAppointmentsAndOtherWeeks() {
        val current = lesson("e1", "2026-11-02T08:15:00")
        val appointment = lesson("t1", "2026-11-03T15:00:00", type = "event")
        val far = lesson("far", "2026-12-07T08:15:00")
        val replacement = lesson("e2", "2026-11-04T09:00:00", room = "B2")
        val merged = overlayLessons(listOf(current, appointment, far), listOf(replacement), setOf("2026-11-02"))
        assertEquals(setOf("t1", "far", "e2"), merged.map { it.id }.toSet())
        val block = lesson("s1", "2026-11-02T08:00:00", type = "0_stp")
        val shown = overlayLessons(listOf(current), listOf(block), setOf("2026-11-02"))
        assertEquals(listOf("s1"), shown.map { it.id })
        assertEquals(listOf(current, appointment, far), overlayLessons(listOf(current, appointment, far), emptyList(), emptySet()))
        assertFalse(schedulerBodyUsable(""))
        assertFalse(schedulerBodyUsable("   "))
        assertTrue(schedulerBodyUsable("<data></data>"))
        assertFalse(schedulerWeekLoaded(""))
        assertFalse(schedulerWeekLoaded("<data></data>"))
        assertTrue(schedulerWeekLoaded("<data><event id=\"e1\"></event></data>"))
        val kept = applyEventWindow(listOf(current, far), listOf(replacement), "2026-10-28", "2026-11-25")
        assertTrue(kept.any { it.id == "far" })
        assertTrue(kept.any { it.id == "e2" })
        assertFalse(kept.any { it.id == "e1" })
    }

    @Test
    fun aNewFutureWeekIsSilentAndAKnownWeekStillNotifies() {
        val current = lesson("e1", "2026-11-02T08:15:00")
        val future = lesson("e2", "2026-11-16T08:15:00")
        val previous = SchulnetzSnapshot(events = listOf(current))
        val next = SchulnetzSnapshot(
            events = listOf(current.copy(room = "B2"), future),
            weekFetched = mapOf("2026-11-02" to now.toString(), "2026-11-16" to now.toString()),
        )
        assertEquals(listOf("Raum geändert"), diffSnapshots(previous, next).map { it.title })
        val legacy = diffSnapshots(SchulnetzSnapshot(), SchulnetzSnapshot(events = listOf(current)))
        assertEquals(setOf("timetable"), legacy.map { it.category }.toSet())
        val hiddenRemoval = diffSnapshots(
            SchulnetzSnapshot(events = listOf(current, future), weekFetched = mapOf("2026-11-02" to now.toString())),
            SchulnetzSnapshot(events = listOf(current), weekFetched = mapOf("2026-11-02" to now.toString(), "2026-11-16" to now.toString())),
        )
        assertTrue(hiddenRemoval.none { it.category == "timetable" })
    }

    @Test
    fun weekStampsSurviveTheSnapshotJson() {
        val snap = SchulnetzSnapshot(
            fetchedAt = now.toString(),
            weekFetched = mapOf("2026-11-02" to now.toString()),
            weekSpanStart = "2026-08-17",
            weekSpanEnd = "2027-07-04",
            icalFetchedAt = now.toString(),
        )
        val parsed = parseNormalizedSnapshot(snap.toNormalizedJson())
        assertEquals(snap.weekFetched, parsed!!.weekFetched)
        assertEquals("2026-08-17", parsed.weekSpanStart)
        assertEquals("2027-07-04", parsed.weekSpanEnd)
        assertEquals(now.toString(), parsed.icalFetchedAt)
    }

    @Test
    fun calendarGetIsAllowedAndBlockedPagesStayBlocked() {
        val base = "https://www.schulnetz-ag.ch/aksa"
        assertTrue(schulnetzCallAllowed("GET", "$base/abo.ics"))
        assertFalse(schulnetzCallAllowed("POST", "$base/abo.ics"))
        assertFalse(schulnetzCallAllowed("GET", "$base/abo.ics?pageid=23118"))
        assertFalse(schulnetzCallAllowed("GET", "$base/abo.ics?pageid=9999"))
        assertFalse(schulnetzCallAllowed("GET", "$base/abo.ics?action=confirm"))
        assertFalse(schulnetzCallAllowed("GET", "$base/index.php?pageid=23118"))
        assertFalse(schulnetzCallAllowed("GET", "$base/index.php?pageid=9999"))
    }

    @Test
    fun hidingOneLessonStaysOnThatWeek() {
        val weekA = lesson("e1", "2026-11-02T08:15:00")
        val weekB = lesson("e2", "2026-11-09T08:15:00")
        val once = hideOnce(weekA, emptyList())
        assertTrue(lessonHidden(weekA, once, zone))
        assertFalse(lessonHidden(weekB, once, zone))
    }

    @Test
    fun tokenWindowStaysNarrowUntilAFarWeekIsDue() {
        val near = eventQueryWindow("", "", emptyMap(), "", today, now)
        assertEquals(today.minusDays(7), near.min)
        assertEquals(today.plusDays(21), near.max)
        assertFalse(near.wide)
        val wide = eventQueryWindow("2026-08-17", "2027-07-04", emptyMap(), "", today, now)
        assertTrue(wide.wide)
        assertEquals(LocalDate.parse("2026-08-17"), wide.min)
        val stamps = mondaysBetween(LocalDate.parse("2026-08-17"), LocalDate.parse("2027-07-04")).associate { it.toString() to now.toString() }
        val again = eventQueryWindow("2026-08-17", "2027-07-04", stamps, "", today, now)
        assertFalse(again.wide)
        assertEquals(today.minusDays(7), again.min)
    }
}
