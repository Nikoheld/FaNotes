package ch.fasrv.fanotes.desk

import java.text.Collator
import java.time.DayOfWeek
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.format.DateTimeFormatter
import java.time.temporal.TemporalAdjusters
import java.util.Locale

/**
 * Week and month grids from the desktop homework board.
 * Weeks start on Monday. The month grid is six weeks and marks days
 * that fall outside the cursor's month.
 */
data class PlannerDay(val date: LocalDate, val outside: Boolean)

fun homeworkWeekdays(): List<String> = listOf("Mo", "Di", "Mi", "Do", "Fr", "Sa", "So")

fun homeworkPlannerDays(cursor: LocalDate, view: String): List<PlannerDay> {
    if (view == "week") {
        val start = cursor.with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY))
        return (0..6).map { PlannerDay(start.plusDays(it.toLong()), false) }
    }
    val first = cursor.withDayOfMonth(1).with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY))
    return (0..41).map { offset ->
        val day = first.plusDays(offset.toLong())
        PlannerDay(day, day.month != cursor.month)
    }
}

fun homeworkPlannerShift(cursor: LocalDate, view: String, step: Int): LocalDate =
    if (view == "week") cursor.plusWeeks(step.toLong()) else cursor.plusMonths(step.toLong())

fun homeworkPlannerLabel(cursor: LocalDate, view: String): String {
    val german = Locale.GERMAN
    if (view == "week") {
        val days = homeworkPlannerDays(cursor, "week")
        val format = DateTimeFormatter.ofPattern("d. MMM", german)
        return "Woche ${days.first().date.format(format)} – ${days.last().date.format(format)}"
    }
    return cursor.format(DateTimeFormatter.ofPattern("MMMM yyyy", german))
}

/** Overdue, today, upcoming, undated, or done. A due time stays inside its calendar day. */
fun classifyHomeworkTask(task: HomeworkTask, today: LocalDate = LocalDate.now()): String {
    if (task.done) return "done"
    val due = task.dueDate?.let { runCatching { LocalDate.parse(it) }.getOrNull() } ?: return "undated"
    return when {
        due < today -> "overdue"
        due == today -> "today"
        else -> "upcoming"
    }
}

fun homeworkDueMoment(task: HomeworkTask): LocalDateTime? {
    val date = task.dueDate?.let { runCatching { LocalDate.parse(it) }.getOrNull() } ?: return null
    val time = task.dueTime?.let { runCatching { LocalTime.parse(it) }.getOrNull() } ?: LocalTime.of(23, 59)
    return date.atTime(time)
}

/** Open tasks first, important ones before normal, then the earliest due moment. */
fun sortHomeworkTasks(tasks: List<HomeworkTask>): List<HomeworkTask> = tasks.sortedWith { left, right ->
    if (left.done != right.done) return@sortedWith if (left.done) 1 else -1
    if (left.priority != right.priority) return@sortedWith if (left.priority == "high") -1 else 1
    val leftDue = homeworkDueMoment(left)
    val rightDue = homeworkDueMoment(right)
    when {
        leftDue == null && rightDue == null -> left.title.compareTo(right.title, ignoreCase = true)
        leftDue == null -> 1
        rightDue == null -> -1
        leftDue != rightDue -> leftDue.compareTo(rightDue)
        else -> left.title.compareTo(right.title, ignoreCase = true)
    }
}

data class HomeworkStats(val open: Int, val overdue: Int, val today: Int, val appointments: Int, val done: Int)

fun homeworkStats(tasks: List<HomeworkTask>, today: LocalDate = LocalDate.now()): HomeworkStats {
    val open = tasks.filter { !it.done }
    return HomeworkStats(
        open = open.size,
        overdue = open.count { classifyHomeworkTask(it, today) == "overdue" },
        today = open.count { classifyHomeworkTask(it, today) == "today" },
        appointments = open.count { it.kind == "appointment" },
        done = tasks.size - open.size,
    )
}

/** Drop one entry and keep the rest in order, the same as the desktop delete button. */
fun removeHomeworkTask(tasks: List<HomeworkTask>, id: String): List<HomeworkTask> =
    tasks.filter { it.id != id }

/**
 * Folder names plus subjects already used, in German dictionary order.
 * The desktop datalist is built the same way from the vault's top folders.
 */
fun homeworkSubjectOptions(folderNames: List<String>, tasks: List<HomeworkTask>): List<String> {
    val names = LinkedHashSet<String>()
    for (name in folderNames) {
        val trimmed = name.trim()
        if (trimmed.isNotEmpty()) names += trimmed
    }
    for (task in tasks) {
        val subject = task.subject.trim()
        if (subject.isNotEmpty()) names += subject
    }
    return names.sortedWith(Collator.getInstance(Locale.GERMAN))
}

/** Fields accepted by the desktop `createHomeworkTask`, or null when the title is blank. */
data class HomeworkDraft(
    val title: String,
    val notes: String,
    val subject: String,
    val dueDate: String?,
    val dueTime: String?,
    val kind: String,
    val priority: String,
)

fun prepareHomeworkDraft(
    title: String,
    notes: String = "",
    subject: String = "",
    dueDate: String? = null,
    dueTime: String? = null,
    kind: String = "homework",
    priority: String = "normal",
): HomeworkDraft? {
    val cleanTitle = title.trim().take(240)
    if (cleanTitle.isEmpty()) return null
    return HomeworkDraft(
        title = cleanTitle,
        notes = notes.take(4_000),
        subject = subject.trim().take(80),
        dueDate = dueDate?.trim()?.takeIf { ISO_DATE.matches(it) },
        dueTime = dueTime?.trim()?.takeIf { ISO_TIME.matches(it) },
        kind = if (kind == "appointment") "appointment" else "homework",
        priority = if (priority == "high") "high" else "normal",
    )
}

private val ISO_DATE = Regex("""\d{4}-\d{2}-\d{2}""")
private val ISO_TIME = Regex("""\d{2}:\d{2}""")

/** Offen, Hausaufgaben, Termine, Erledigt, Alle — the desktop filter row. */
fun visibleHomeworkTasks(tasks: List<HomeworkTask>, filter: String): List<HomeworkTask> = tasks.filter { task ->
    when (filter) {
        "all" -> true
        "done" -> task.done
        "homework" -> !task.done && task.kind == "homework"
        "appointment" -> !task.done && task.kind == "appointment"
        else -> !task.done
    }
}
