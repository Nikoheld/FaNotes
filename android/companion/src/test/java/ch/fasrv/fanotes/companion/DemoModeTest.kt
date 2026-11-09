package ch.fasrv.fanotes.companion

import ch.fasrv.fanotes.schulnetz.demoSnapshot
import org.junit.Assert.assertFalse
import org.junit.Test
import java.time.LocalDate

class DemoModeTest {
    @Test fun theDemoNeverLooksLikeAMissingTimetable() {
        val today = LocalDate.parse("2026-11-13")
        assertFalse(timetableMissing(demoSnapshot(today), linked = true, today = today))
    }
}
