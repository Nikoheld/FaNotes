package ch.fasrv.fanotes.companion

import ch.fasrv.fanotes.desk.CALENDAR_NOTE_PATH
import ch.fasrv.fanotes.desk.HOMEWORK_NOTE_PATH
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PlannerHoldTest {
    @Test
    fun homeworkIsNeverHeldButTheCalendarStillIs() {
        assertFalse(HOMEWORK_NOTE_PATH in CompanionGraph.PLANNER_HOLD_PATHS)
        assertTrue(CALENDAR_NOTE_PATH in CompanionGraph.PLANNER_HOLD_PATHS)
    }
}
