package ch.fasrv.fanotes.study

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** The task timer: it counts through panel changes, backgrounding and process death, but not through a forgotten night. */
class StudyTimerTest {
    private val minute = 60_000L
    private val limit = STUDY_TIMER_MAX_GAP_SEC * 1000L

    private fun run(wall: Long = 1_700_000_000_000, mono: Long = 5_000_000) = StudyTimerRun("Bio/Blatt.pdf", "auftrag-2", wall, mono)

    // -- credit -----------------------------------------------------------------------------

    @Test
    fun aStretchCountsInWholeSecondsAndKeepsTheRest() {
        assertEquals(TimerCredit(60, 0, false), timerCredit(minute))
        assertEquals(TimerCredit(1, 999, false), timerCredit(1_999))
        assertEquals(TimerCredit(0, 400, false), timerCredit(400))
    }

    @Test
    fun theCreditIsSteadyWhenTheClockGoesBackwards() {
        assertEquals(TimerCredit(0, 0, false), timerCredit(0))
        assertEquals(TimerCredit(0, 0, false), timerCredit(-30 * minute))
    }

    @Test
    fun aStretchUpToTheLimitCountsAndALongerOneStopsTheTimer() {
        assertEquals(TimerCredit(STUDY_TIMER_MAX_GAP_SEC, 0, false), timerCredit(limit))
        assertEquals(TimerCredit(0, 0, true), timerCredit(limit + 1))
        assertEquals(TimerCredit(0, 0, true), timerCredit(14 * 3_600_000L), "left running overnight")
        assertTrue(timerCredit(5_001, maxGapSec = 5).expired, "the limit is a parameter")
        assertFalse(timerCredit(5_000, maxGapSec = 5).expired)
    }

    // -- in this process: the monotonic clock ---------------------------------------------------

    @Test
    fun aClockChangeDoesNotAddOrRemoveTime() {
        val started = run()
        // The wall clock jumps ten hours ahead and then back; only the monotonic clock counts.
        val credit = started.creditAt(nowMonoMs = started.sinceMonoMs + 90_000)
        assertEquals(90, credit.seconds)
        val next = started.afterCheckpoint(credit, nowWallMs = started.sinceWallMs + 10 * 3_600_000L, nowMonoMs = started.sinceMonoMs + 90_000)
        assertEquals(started.sinceMonoMs + 90_000, next.sinceMonoMs)
    }

    @Test
    fun theLastFractionOfASecondCarriesOverToTheNextCheckpoint() {
        var timer = run()
        var credited = 0
        var mono = timer.sinceMonoMs
        var wall = timer.sinceWallMs
        // Three checkpoints 1.4 s apart are 4.2 s: 4 s are counted and 0.2 s wait in the checkpoint.
        repeat(3) {
            mono += 1_400
            wall += 1_400
            val credit = timer.creditAt(mono)
            credited += credit.seconds
            timer = timer.afterCheckpoint(credit, wall, mono)
        }
        assertEquals(4, credited)
        assertEquals(200L, mono - timer.sinceMonoMs)
        assertEquals(mono - timer.sinceMonoMs, wall - timer.sinceWallMs, "both clocks keep the same remainder")
    }

    @Test
    fun theLiveCounterShowsTheTimeSinceTheCheckpointButNeverAnImpossibleOne() {
        val timer = run()
        assertEquals(0, timer.liveSeconds(timer.sinceMonoMs))
        assertEquals(125, timer.liveSeconds(timer.sinceMonoMs + 125_400))
        assertEquals(0, timer.liveSeconds(timer.sinceMonoMs - 1_000))
        assertEquals(0, timer.liveSeconds(timer.sinceMonoMs + limit + 1), "a stretch past the limit shows nothing")
    }

    // -- after a process death: the wall clock ---------------------------------------------------

    @Test
    fun aStoredTimerResumesWithTheTimeThatPassedWhileTheAppWasGone() {
        val record = run().stored()
        val credit = record.creditAt(nowWallMs = record.sinceWallMs + 25 * minute + 300)
        assertEquals(TimerCredit(25 * 60, 300, false), credit)
        val resumed = record.resumed(credit, nowWallMs = record.sinceWallMs + 25 * minute + 300, nowMonoMs = 42_000)
        assertEquals(StudyTimerRun("Bio/Blatt.pdf", "auftrag-2", record.sinceWallMs + 25 * minute, 42_000 - 300), resumed)
    }

    @Test
    fun aStoredTimerFromTheNightBeforeIsStoppedWithoutCountingTheNight() {
        val record = run().stored()
        assertTrue(record.creditAt(record.sinceWallMs + 9 * 3_600_000L).expired)
        assertFalse(record.creditAt(record.sinceWallMs + 119 * minute).expired)
        assertTrue(record.creditAt(record.sinceWallMs + 121 * minute).expired)
        assertEquals(0, record.creditAt(record.sinceWallMs + 9 * 3_600_000L).seconds)
    }

    @Test
    fun aStoredTimerFromTheFutureCountsNothing() {
        val record = run().stored()
        assertEquals(TimerCredit(0, 0, false), record.creditAt(record.sinceWallMs - 5 * minute))
    }

    @Test
    fun theStopNoticeNamesTheActualLimit() {
        assertTrue(STUDY_TIMER_EXPIRED.contains("${STUDY_TIMER_MAX_GAP_SEC / 3600} Stunden"), STUDY_TIMER_EXPIRED)
    }

    // -- what is stored -------------------------------------------------------------------------

    @Test
    fun theRecordSurvivesAWriteAndRead() {
        val record = StudyTimerRecord("Biologie/Zelle \"Blatt\" 3.pdf", "auftrag-12", 1_763_280_123_456)
        val json = record.toJson()
        assertEquals(record, studyTimerRecordFromJson(json))
        assertEquals("""{"path":"Biologie/Zelle \"Blatt\" 3.pdf","task":"auftrag-12","since":1763280123456}""", json)
    }

    @Test
    fun anythingElseInTheStoreIsNotATimer() {
        assertNull(studyTimerRecordFromJson(null))
        assertNull(studyTimerRecordFromJson(""))
        assertNull(studyTimerRecordFromJson("{broken"))
        assertNull(studyTimerRecordFromJson("[]"))
        assertNull(studyTimerRecordFromJson("""{"path":"","task":"a","since":5}"""))
        assertNull(studyTimerRecordFromJson("""{"path":"a.pdf","task":"","since":5}"""))
        assertNull(studyTimerRecordFromJson("""{"path":"a.pdf","task":"a"}"""))
        assertNull(studyTimerRecordFromJson("""{"path":"a.pdf","task":"a","since":-5}"""))
        assertNull(studyTimerRecordFromJson("""{"path":"a.pdf","task":"a","since":"soon"}"""))
        assertNull(studyTimerRecordFromJson("""{"path":"a.pdf","task":"a","since":1.5}"""))
        assertNull(studyTimerRecordFromJson("""{"path":"${"p".repeat(1025)}","task":"a","since":5}"""))
    }
}
