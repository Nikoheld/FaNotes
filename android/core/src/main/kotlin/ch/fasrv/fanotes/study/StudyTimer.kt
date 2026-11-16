package ch.fasrv.fanotes.study

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.jsonNumber
import ch.fasrv.fanotes.json.jsonObject
import ch.fasrv.fanotes.json.jsonString
import ch.fasrv.fanotes.json.parseJson
import ch.fasrv.fanotes.json.stringify

/**
 * The task timer of a PDF's Aufträge list.
 *
 * It keeps running when the panel closes, when the app goes to the background and when the process is killed.
 * Its state is a checkpoint: the clocks at the moment the elapsed seconds were last written into the task.
 * While the process lives the monotonic clock measures the time since the checkpoint, so a clock change does not
 * add or remove time. After a process death only the wall clock of the checkpoint survives (it is stored with the
 * note and the task), and the time since then is counted from it.
 *
 * A stretch longer than [STUDY_TIMER_MAX_GAP_SEC] since the last checkpoint does not count and stops the timer:
 * a timer that was forgotten overnight must not add hours to a task, and the list has no way to take time back.
 */

/** The longest stretch since a checkpoint that still counts (two hours, one double lesson plus a break). */
const val STUDY_TIMER_MAX_GAP_SEC = 2 * 60 * 60

/** Shown when a timer is stopped because the app was gone for longer than [STUDY_TIMER_MAX_GAP_SEC]. */
const val STUDY_TIMER_EXPIRED = "Der Timer wurde angehalten, weil er länger als 2 Stunden ohne die App lief. Diese Zeit wurde nicht gezählt."

/** What survives a killed process: the note, the task and the wall-clock time of the last checkpoint. */
data class StudyTimerRecord(val path: String, val taskId: String, val sinceWallMs: Long)

/**
 * A task timer running in this process. [sinceWallMs] and [sinceMonoMs] (`SystemClock.elapsedRealtime`) are the two
 * clocks at the last checkpoint.
 */
data class StudyTimerRun(val path: String, val taskId: String, val sinceWallMs: Long, val sinceMonoMs: Long) {
    fun stored() = StudyTimerRecord(path, taskId, sinceWallMs)
}

/**
 * What one stretch of time adds to a task.
 *
 * @property seconds whole seconds to add
 * @property remainderMs what is left of the last second; it stays in the checkpoint so no time is lost
 * @property expired the stretch was longer than the limit: nothing counts and the timer stops
 */
data class TimerCredit(val seconds: Int, val remainderMs: Int, val expired: Boolean)

fun timerCredit(gapMs: Long, maxGapSec: Int = STUDY_TIMER_MAX_GAP_SEC): TimerCredit = when {
    gapMs <= 0 -> TimerCredit(0, 0, false)
    gapMs > maxGapSec * 1000L -> TimerCredit(0, 0, true)
    else -> TimerCredit((gapMs / 1000).toInt(), (gapMs % 1000).toInt(), false)
}

/** The credit for a timer that ran in this process: measured with the monotonic clock. */
fun StudyTimerRun.creditAt(nowMonoMs: Long, maxGapSec: Int = STUDY_TIMER_MAX_GAP_SEC) =
    timerCredit(nowMonoMs - sinceMonoMs, maxGapSec)

/** The credit for a timer found after a process death: only the wall clock is left to measure with. */
fun StudyTimerRecord.creditAt(nowWallMs: Long, maxGapSec: Int = STUDY_TIMER_MAX_GAP_SEC) =
    timerCredit(nowWallMs - sinceWallMs, maxGapSec)

/** The timer after a checkpoint: both clocks sit at "now" minus the part of a second that was not counted yet. */
fun StudyTimerRun.afterCheckpoint(credit: TimerCredit, nowWallMs: Long, nowMonoMs: Long) =
    copy(sinceWallMs = nowWallMs - credit.remainderMs, sinceMonoMs = nowMonoMs - credit.remainderMs)

/** A record that is running again in a new process. */
fun StudyTimerRecord.resumed(credit: TimerCredit, nowWallMs: Long, nowMonoMs: Long) =
    StudyTimerRun(path, taskId, nowWallMs - credit.remainderMs, nowMonoMs - credit.remainderMs)

/** Seconds to show on top of a task's stored time right now. Never more than the limit; a longer stretch shows nothing. */
fun StudyTimerRun.liveSeconds(nowMonoMs: Long): Int = creditAt(nowMonoMs).seconds

fun StudyTimerRecord.toJson(): String = jsonObject(
    "path" to jsonString(path),
    "task" to jsonString(taskId),
    "since" to jsonNumber(sinceWallMs.toDouble()),
).stringify()

/** The stored timer, or null for anything that is not a timer written by [toJson]. */
fun studyTimerRecordFromJson(raw: String?): StudyTimerRecord? {
    if (raw.isNullOrBlank() || raw.length > 4096) return null
    val obj = runCatching { parseJson(raw) as? JsonValue.Obj }.getOrNull() ?: return null
    val path = obj.string("path")?.takeIf { it.isNotEmpty() && it.length <= 1024 } ?: return null
    val task = obj.string("task")?.takeIf { it.isNotEmpty() && it.length <= 80 } ?: return null
    val since = obj.double("since")?.takeIf { it > 0.0 && it.isFinite() && it % 1.0 == 0.0 }?.toLong() ?: return null
    return StudyTimerRecord(path, task, since)
}
