package ch.fasrv.fanotes.companion

import ch.fasrv.fanotes.desk.HomeworkTask
import ch.fasrv.fanotes.desk.classifyHomeworkTask
import ch.fasrv.fanotes.desk.homeworkDueMoment
import ch.fasrv.fanotes.schulnetz.isCancelled
import java.time.LocalDate

/** The one banner Heute may show, most important first. */
enum class TodayBanner { Reconnect, SyncError, Demo, SyncOffline, Connect, NotifyTip }

/** Which banners currently apply; [syncError] is only read when [syncNotice] is true. */
data class TodayBannerState(
    val needsReauth: Boolean = false,
    val syncNotice: Boolean = false,
    val syncError: Boolean = false,
    val demo: Boolean = false,
    val connect: Boolean = false,
    val notifyTip: Boolean = false,
)

/** Reconnect > sync error > demo > sync offline > connect Schulnetz > notification tip. At most one is shown. */
fun todayBanner(state: TodayBannerState): TodayBanner? = when {
    state.needsReauth -> TodayBanner.Reconnect
    state.syncNotice && state.syncError -> TodayBanner.SyncError
    state.demo -> TodayBanner.Demo
    state.syncNotice -> TodayBanner.SyncOffline
    state.connect -> TodayBanner.Connect
    state.notifyTip -> TodayBanner.NotifyTip
    else -> null
}

const val UP_NEXT_LIMIT = 4
const val TODAY_NOTES_LIMIT = 2

/** One row of "Up next": an exam or an open task. */
sealed interface UpNextItem {
    val day: LocalDate
    val key: String
    data class Exam(val entry: AgendaEntry) : UpNextItem {
        override val day: LocalDate get() = entry.day
        override val key: String get() = "exam:${entry.key}"
    }
    data class Task(val task: HomeworkTask, override val day: LocalDate) : UpNextItem {
        override val key: String get() = "task:${task.id}"
    }
}

/** Exams of the next 14 days that have not started their end yet, without the one already shown as the hero. */
fun upcomingExams(agenda: List<AgendaEntry>, today: LocalDate, clockNow: String, heroKey: String?): List<AgendaEntry> =
    agenda.filter {
        it.kind == AgendaKind.Exam && it.key != heroKey && it.school?.isCancelled() != true &&
            (it.day > today || (it.day == today && it.end.ifBlank { it.start.ifBlank { "23:59" } } >= clockNow))
    }

/**
 * Open tasks that are overdue or due today or tomorrow, plus [exams]; sorted by day, exams before tasks on the same day
 * (then by time), at most [limit] rows. [showTasks] and [showExams] mirror the "tasks" and "exam" Heute cards.
 */
fun upNext(tasks: List<HomeworkTask>, exams: List<AgendaEntry>, today: LocalDate, showTasks: Boolean, showExams: Boolean, limit: Int = UP_NEXT_LIMIT): List<UpNextItem> {
    val taskItems = if (!showTasks) emptyList() else tasks.filter { !it.done }.mapNotNull { task ->
        val due = task.dueDate?.let { runCatching { LocalDate.parse(it) }.getOrNull() } ?: return@mapNotNull null
        if (classifyHomeworkTask(task, today) == "undated" || due > today.plusDays(1)) null else UpNextItem.Task(task, due)
    }
    val examItems = if (showExams) exams.map { UpNextItem.Exam(it) } else emptyList()
    val sorted = (examItems + taskItems).sortedWith(
        compareBy<UpNextItem> { it.day }
            .thenBy { if (it is UpNextItem.Exam) 0 else 1 }
            .thenBy { item ->
                when (item) {
                    is UpNextItem.Exam -> item.entry.start
                    is UpNextItem.Task -> homeworkDueMoment(item.task)?.toLocalTime()?.toString().orEmpty()
                }
            }
            .thenBy { (it as? UpNextItem.Task)?.task?.title.orEmpty().lowercase() },
    )
    val shown = sorted.take(limit)
    // Many tasks due soon must not hide every exam: the nearest exam keeps the last row.
    val nearestExam = sorted.firstOrNull { it is UpNextItem.Exam }
    if (limit < 1 || nearestExam == null || nearestExam in shown) return shown
    return (shown.dropLast(1) + nearestExam).sortedBy { sorted.indexOf(it) }
}

enum class GlanceTile { Grades, Points, Absences, Updates }

/** [tiles] share one row (at most three); [updatesLink] is true when school updates move to a text link under the row. */
data class GlanceLayout(val tiles: List<GlanceTile>, val updatesLink: Boolean)

/** Enabled tiles with data, in the order grades, points, absences, updates. A fourth one (updates) becomes a link. */
fun glanceLayout(grades: Boolean, points: Boolean, absences: Boolean, updates: Boolean): GlanceLayout {
    val all = listOfNotNull(
        GlanceTile.Grades.takeIf { grades }, GlanceTile.Points.takeIf { points },
        GlanceTile.Absences.takeIf { absences }, GlanceTile.Updates.takeIf { updates },
    )
    return if (all.size > 3) GlanceLayout(all.take(3), updatesLink = GlanceTile.Updates in all.drop(3)) else GlanceLayout(all, false)
}
