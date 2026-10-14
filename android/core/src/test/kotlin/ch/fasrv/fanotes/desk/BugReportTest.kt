package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class BugReportTest {
    @Test
    fun aReportOlderThanFiveMinutesIsDropped() {
        val now = 10_000_000L
        val log = BugReportLog()
        log.record(BugReportEvent(now - BUG_REPORT_WINDOW_MS - 60_000, "pen", noteId = "alt.md", x = 0.1, y = 0.1, pointerType = "pen", tool = "pen"), now)
        val mid = log.record(BugReportEvent(now - 90_000, "pen", noteId = "Mathe.md", x = 0.42, y = 0.55, pointerType = "pen", tool = "pen"), now)
        assertEquals(1, mid.size)
        assertEquals("Mathe.md", mid[0].noteId)
        assertEquals(0.42, mid[0].x)
        assertTrue(mid.none { it.noteId == "alt.md" })
        assertEquals(1, log.snapshot(now).size)
    }

    @Test
    fun theReportGoesToTheFaNotesHostEvenFromAnotherOrigin() {
        val now = 20_000_000L
        val log = BugReportLog()
        log.record(
            BugReportEvent(now - 30_000, "pen", noteId = "Physik.md", x = 0.33, y = 0.48, pointerType = "pen", tool = "pen", version = "2026.8.36", platform = "win32"),
            now,
        )
        val request = buildBugReportRequest(
            description = "Stift springt nach oben",
            events = log.snapshot(now),
            version = "2026.8.36",
            platform = "win32",
            now = now,
            origin = "https://evil.example",
        )
        assertEquals("fanotes.fasrv.ch", request.host)
        assertEquals("https://fanotes.fasrv.ch/api/v1/bug-report", request.url)
        assertEquals("Stift springt nach oben", request.body.description)
        assertEquals(1, request.body.events.size)
        assertEquals("Physik.md", request.body.events[0].noteId)
        assertTrue(BUG_REPORT_WINDOW_MS / BUG_REPORT_PEN_SAMPLE_MS <= BUG_REPORT_MAX_EVENTS)
    }

    @Test
    fun fiveMinutesOfPenSamplesStayUnderTheBodyCap() {
        val now = 20_000_000L
        val log = BugReportLog()
        val start = now - BUG_REPORT_WINDOW_MS + 1
        val step = maxOf(1L, (BUG_REPORT_WINDOW_MS - 2) / BUG_REPORT_MAX_EVENTS)
        for (index in 0 until BUG_REPORT_MAX_EVENTS) {
            log.record(
                BugReportEvent(
                    at = start + index * step,
                    kind = "pen",
                    noteId = "Faecher/Mathematik/Uebungen/Lineare-Algebra-Blatt-12.md",
                    x = 0.123456789 + (index % 50) / 1000.0,
                    y = 0.554321098 + (index % 40) / 1000.0,
                    pointerType = "pen",
                    tool = "fineliner",
                    version = "2026.8.36",
                    platform = "linux",
                ),
                now,
            )
        }
        val request = buildBugReportRequest(
            description = "x".repeat(2000),
            events = log.snapshot(now),
            version = "2026.8.36",
            platform = "linux",
            now = now,
        )
        assertEquals(BUG_REPORT_MAX_EVENTS, request.body.events.size)
        assertTrue(request.json.toByteArray(Charsets.UTF_8).size < BUG_REPORT_MAX_BODY_BYTES)
    }

    @Test
    fun penSamplesCloserThanFourHundredMillisecondsCollapse() {
        val log = BugReportLog()
        log.recordPen(BugReportEvent(1_000, "pen", x = 0.1, y = 0.2), 1_000)
        log.recordPen(BugReportEvent(1_100, "pen", x = 0.3, y = 0.4), 1_100)
        assertEquals(1, log.snapshot(1_100).size)
        log.recordPen(BugReportEvent(1_500, "pen", x = 0.5, y = 0.6), 1_500)
        assertEquals(2, log.snapshot(1_500).size)
    }
}