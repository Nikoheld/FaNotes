package ch.fasrv.fanotes.schulnetz

import java.time.Instant
import java.time.ZoneId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ProbeNoticeTest {
    private val zone = ZoneId.of("Europe/Zurich")
    private val probe = SchulnetzChange(
        id = "probe:20261107:grade-new",
        category = "grade",
        title = "Test: Neue Note",
        body = "Test · Testfach · Testprobe · Datum 07.11.2026",
        targetId = "probe-target:grade-new",
        courseId = "probe-course",
        date = "2026-11-07",
        gradeKeys = listOf("probe:key:grade-new"),
        serverAt = "2026-11-07T12:00:00.000Z",
    )

    @Test
    fun probeGradesStayVisibleAndOutOfTheLedger() {
        val real = SchulnetzChange("grade:real", "grade", "Neue Note", "Mathematik", gradeKeys = listOf("c:real"), targetId = "real-target")
        val seeded = settleGradeNotifications(listOf(probe, real), emptyList(), null)
        assertEquals(listOf(probe.id), seeded.changes.map { it.id })
        assertFalse(seeded.keys.any { it.startsWith("probe:") })
        val kept = settleGradeNotifications(listOf(probe), emptyList(), setOf("c:kept"))
        assertEquals(listOf(probe.id), kept.changes.map { it.id })
        assertTrue("c:kept" in kept.keys)
        assertFalse("probe:key:grade-new" in kept.keys)
        assertEquals(emptyList(), newGradeTargetIds(listOf(probe, real)).filter { it.startsWith("probe") })
        assertEquals(listOf("real-target"), newGradeTargetIds(listOf(probe, real)))
        assertEquals(2, groupGradeChanges(listOf(probe, probe.copy(id = "probe:20261107:grade-changed", title = "Test: Notenänderung"))).size)
    }

    @Test
    fun hiddenProbeKeepsTheTestLabelAndTheSwissDate() {
        assertEquals("07.11.2026", formatProbeDay("2026-11-07"))
        val hidden = redactGradeChange(probe, SchulnetzSnapshot())
        assertFalse(hidden.title.startsWith("Test:"))
        assertFalse(hidden.body.contains("Datum"))
        val received = Instant.parse("2026-11-07T12:00:01.250Z").toEpochMilli()
        val displayed = Instant.parse("2026-11-07T12:00:01.650Z").toEpochMilli()
        val stamped = stampProbeChange(hidden, received, displayed, zone)
        assertTrue(stamped.title.startsWith("Test:"))
        assertTrue(stamped.body.contains("Datum 07.11.2026"))
        assertTrue(stamped.body.contains("Server 07.11.2026 13:00:00.000"))
        assertTrue(stamped.body.contains("Empfangen 07.11.2026 13:00:01.250"))
        assertTrue(stamped.body.contains("Angezeigt 07.11.2026 13:00:01.650"))
        assertFalse(stamped.body.contains("5.5"))
        val summary = probeLogSummary(probeLogLine(stamped, received, displayed), zone)
        assertTrue(summary.contains("07.11.2026"))
        assertTrue(summary.contains("Server 07.11.2026 13:00:00.000"))
        assertTrue(summary.contains("Empfangen 07.11.2026 13:00:01.250"))
    }

    @Test
    fun probeRowsStayOnTheAddressedDevice() {
        val mine = probeDeviceKey("phone:APA91b-probe-device-token")
        val other = probeDeviceKey("phone:APA91b-other-device-tokenx")
        assertEquals(32, mine.length)
        assertTrue(mine.matches(Regex("^[a-f0-9]{32}$")))
        assertTrue(mine != other)
        assertFalse(mine.contains("APA91"))
        assertTrue(changeVisibleToDevice("grade:real", "", ""))
        assertFalse(changeVisibleToDevice("probe:1", "", mine))
        assertFalse(changeVisibleToDevice("probe:1", mine, ""))
        assertFalse(changeVisibleToDevice("probe:1", mine, other))
        assertTrue(changeVisibleToDevice("probe:1", mine, mine))
    }
}
