package ch.fasrv.fanotes.desk

import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class HomeworkPlannerTest {
    @Test
    fun weekAndMonthFollowTheDesktopMondayGrid() {
        val thursday = LocalDate.of(2026, 10, 15)
        val week = homeworkPlannerDays(thursday, "week")
        assertEquals(LocalDate.of(2026, 10, 12), week.first().date)
        assertEquals(LocalDate.of(2026, 10, 18), week.last().date)
        assertTrue(week.none { it.outside })
        val month = homeworkPlannerDays(thursday, "month")
        assertEquals(42, month.size)
        assertEquals(LocalDate.of(2026, 9, 28), month.first().date)
        assertTrue(month.first().outside)
        assertFalse(month.first { it.date == LocalDate.of(2026, 10, 1) }.outside)
        assertEquals(LocalDate.of(2026, 10, 22), homeworkPlannerShift(thursday, "week", 1))
        assertEquals(LocalDate.of(2026, 11, 15), homeworkPlannerShift(thursday, "month", 1))
        assertEquals(listOf("Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"), homeworkWeekdays())
        val tasks = listOf(
            HomeworkTask("a", "Lesen", dueDate = "2026-10-15"),
            HomeworkTask("b", "Elternabend", dueDate = "2026-10-16", kind = "appointment"),
            HomeworkTask("c", "Fertig", done = true),
        )
        assertEquals(listOf("a", "b"), visibleHomeworkTasks(tasks, "open").map { it.id })
        assertEquals(listOf("a"), visibleHomeworkTasks(tasks, "homework").map { it.id })
        assertEquals(listOf("c"), visibleHomeworkTasks(tasks, "done").map { it.id })
    }
}