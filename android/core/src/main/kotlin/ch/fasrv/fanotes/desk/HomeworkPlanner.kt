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

/** Card chrome from `.homework-card` and `.homework-bucket` in the desktop board. */
const val HOMEWORK_CARD_RADIUS_DP = 12
const val HOMEWORK_CARD_PAD_DP = 10
const val HOMEWORK_CARD_GAP_DP = 4
const val HOMEWORK_CARD_ACTION_DP = 34
const val HOMEWORK_CARD_ACTION_RADIUS_DP = 6
const val HOMEWORK_CARD_INSET_DP = 3
const val HOMEWORK_CARD_DONE_ALPHA = 0.72f
const val HOMEWORK_CARD_FILL_ALPHA = 0.90f
const val HOMEWORK_OVERDUE_BORDER = 0.40f
const val HOMEWORK_OVERDUE_FILL = 0.06f
const val HOMEWORK_COUNT_DP = 18
const val HOMEWORK_CARDS_GAP_DP = 8
const val HOMEWORK_BUCKET_GAP_DP = 8
const val HOMEWORK_EMPTY_MIN_DP = 180
const val HOMEWORK_KIND_HOMEWORK = "Hausaufgabe"
const val HOMEWORK_KIND_APPOINTMENT = "Termin"
const val HOMEWORK_PRIORITY_HIGH = "Wichtig"
const val HOMEWORK_NO_DATE = "Kein Termin"
const val HOMEWORK_MARK_OPEN = "Als offen markieren"
const val HOMEWORK_MARK_DONE = "Als erledigt markieren"
const val HOMEWORK_DELETE = "Eintrag löschen"
const val HOMEWORK_COLLAPSE = "einklappen"
const val HOMEWORK_EXPAND = "anzeigen"
const val HOMEWORK_EMPTY_TITLE = "Noch keine Einträge"
const val HOMEWORK_EMPTY_BODY = "Lege deine erste Hausaufgabe oder den nächsten Termin oben an."

private val HOMEWORK_DUE_FORMAT = DateTimeFormatter.ofPattern("EEE, dd. MMM", Locale.forLanguageTag("de-CH"))

fun homeworkKindLabel(kind: String): String =
    if (kind == "appointment") HOMEWORK_KIND_APPOINTMENT else HOMEWORK_KIND_HOMEWORK

fun homeworkBucketLabel(bucket: String): String = when (bucket) {
    "overdue" -> "Überfällig"
    "today" -> "Heute"
    "upcoming" -> "Demnächst"
    "undated" -> "Ohne Termin"
    "done" -> "Erledigt"
    else -> bucket
}

/** de-CH short date, with the clock after a middot when the task has one. */
fun homeworkDueLabel(task: HomeworkTask): String {
    val raw = task.dueDate ?: return HOMEWORK_NO_DATE
    val date = runCatching { LocalDate.parse(raw) }.getOrNull() ?: return HOMEWORK_NO_DATE
    val label = date.format(HOMEWORK_DUE_FORMAT)
    val time = task.dueTime?.takeIf { it.isNotBlank() }
    return if (time == null) label else "$label · $time"
}

/** Classes the desktop card sets: done, overdue, high, appointment. */
fun homeworkCardMarks(task: HomeworkTask, today: LocalDate = LocalDate.now()): List<String> = buildList {
    if (task.done) add("done")
    if (classifyHomeworkTask(task, today) == "overdue") add("overdue")
    if (task.priority == "high") add("high")
    if (task.kind == "appointment") add("appointment")
}

/** The later desktop rule paints the accent bar over the warning bar. */
fun homeworkCardInset(task: HomeworkTask): String = when {
    task.kind == "appointment" -> "accent"
    task.priority == "high" -> "warning"
    else -> "none"
}

/** The done bucket stays hidden until the filter is Erledigt or Alle, or the list is expanded. */
fun homeworkDoneBucketVisible(filter: String, expanded: Boolean): Boolean =
    filter == "done" || filter == "all" || expanded

/** Null on the Erledigt filter, which has no collapse control. */
fun homeworkDoneToggleLabel(filter: String, expanded: Boolean): String? {
    if (filter == "done") return null
    return if (expanded || filter == "all") HOMEWORK_COLLAPSE else HOMEWORK_EXPAND
}

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
