package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
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
    fun theDialogUsesTheDesktopCard() {
        assertEquals(520, BUG_REPORT_MAX_DP)
        assertEquals(0.94f, BUG_REPORT_WIDTH_FRACTION)
        assertEquals(12, BUG_REPORT_RADIUS_DP)
        assertEquals(24, BUG_REPORT_SHADOW_Y_DP)
        assertEquals(80, BUG_REPORT_SHADOW_BLUR_DP)
        assertEquals(0.16f, BUG_REPORT_SHADOW_ALPHA)
        assertEquals(140, BUG_REPORT_FIELD_MIN_DP)
        assertEquals(10, BUG_REPORT_FIELD_RADIUS_DP)
        assertEquals(2000, BUG_REPORT_MAX_CHARS)
        assertEquals(0.45f, BUG_REPORT_DISABLED_ALPHA)
        assertEquals(520, bugReportCardWidthDp(800))
        assertEquals(376, bugReportCardWidthDp(400))
        assertEquals(640, bugReportMaxHeightDp(1000))
        assertEquals(360, bugReportMaxHeightDp(400))
        assertEquals("Wird gesendet …", bugReportSendLabel(true))
        assertEquals("Bericht senden", bugReportSendLabel(false))
        assertEquals(false, bugReportCanSend("  ", false))
        assertEquals(false, bugReportCanSend("Stift springt", true))
        assertEquals(true, bugReportCanSend("Stift springt", false))
        assertEquals("Kurz beschreiben, z. B. Stift springt nach oben beim Schreiben.", BUG_REPORT_PLACEHOLDER)
    }

    @Test
    fun theBugReportDialogUsesTheSettingsModalShadow() {
        val shadow = bugReportPanelShadow()
        assertEquals(0, BUG_REPORT_SHADOW_X_DP)
        assertEquals(0, shadow.xDp)
        assertEquals(24, shadow.yDp)
        assertEquals(80, shadow.blurDp)
        assertEquals(0.16f, shadow.alpha)
        assertTrue(shadow.yDp != 0)
        val reach = bugReportShadowReach(shadow)
        assertEquals(80, reach.leftDp)
        assertEquals(56, reach.topDp)
        assertEquals(80, reach.rightDp)
        assertEquals(104, reach.bottomDp)
        assertEquals(reach.leftDp, reach.rightDp)
        assertTrue(reach.bottomDp > reach.topDp)
        val frame = checkNotNull(bugReportShadowFrame(400f, 300f, 2f))
        assertEquals(160f, frame.blurPx)
        assertEquals(0f, frame.shapeLeftPx - frame.padPx)
        assertEquals(48f, frame.shapeTopPx - frame.padPx)
        assertTrue(frame.shapeTopPx - frame.padPx != 0f)
        assertEquals(0x29000000, frame.color)
        assertEquals(0x29000000, bugReportShadowColor(0.16f))
        assertTrue(frame.shapeBottomPx + frame.blurPx < frame.bitmapHeightPx)
        assertTrue(bugReportShadowFavorsDown(frame, 300f))
        val flat = frame.copy(shapeTopPx = frame.padPx, shapeBottomPx = frame.padPx + 300f)
        assertTrue(!bugReportShadowFavorsDown(flat, 300f))
        assertTrue(bugReportShadowFrame(0f, 300f, 2f) == null)
        // The winning rule is a literal, so dark and sepia stay off `var(--shadow)`.
        val dark = confirmDialogShadow("dark")
        val sepia = confirmDialogShadow("sepia")
        assertNotEquals(dark.yDp, shadow.yDp)
        assertNotEquals(dark.blurDp, shadow.blurDp)
        assertNotEquals(dark.alpha, shadow.alpha)
        assertNotEquals(sepia.yDp, shadow.yDp)
        assertNotEquals(sepia.blurDp, shadow.blurDp)
        assertNotEquals(sepia.alpha, shadow.alpha)
        assertNotEquals(confirmShadowColor(sepia.alpha, sepia.red, sepia.green, sepia.blue), frame.color)
        assertNotEquals(confirmShadowColor(dark.alpha, dark.red, dark.green, dark.blue), frame.color)
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