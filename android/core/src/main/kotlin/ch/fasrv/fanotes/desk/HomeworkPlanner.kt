package ch.fasrv.fanotes.desk

import java.time.DayOfWeek
import java.time.LocalDate
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
