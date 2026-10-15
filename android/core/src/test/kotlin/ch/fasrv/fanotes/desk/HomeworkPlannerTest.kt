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

    @Test
    fun tasksLandInTheDesktopBucketsAndImportantOnesSortFirst() {
        val today = LocalDate.of(2026, 10, 15)
        val overdue = HomeworkTask("late", "Spät", dueDate = "2026-10-14")
        val morning = HomeworkTask("am", "Früh", dueDate = "2026-10-15", dueTime = "08:00")
        val soon = HomeworkTask("next", "Bald", dueDate = "2026-10-16", priority = "high")
        val loose = HomeworkTask("none", "Ohne")
        val finished = HomeworkTask("fin", "Weg", dueDate = "2026-10-01", done = true)
        assertEquals("overdue", classifyHomeworkTask(overdue, today))
        assertEquals("today", classifyHomeworkTask(morning, today))
        assertEquals("upcoming", classifyHomeworkTask(soon, today))
        assertEquals("undated", classifyHomeworkTask(loose, today))
        assertEquals("done", classifyHomeworkTask(finished, today))
        assertEquals(
            listOf("next", "late", "am", "none", "fin"),
            sortHomeworkTasks(listOf(finished, loose, morning, overdue, soon)).map { it.id },
        )
        assertEquals(HomeworkStats(4, 1, 1, 0, 1), homeworkStats(listOf(overdue, morning, soon, loose, finished), today))
        val kept = listOf(overdue, morning, soon)
        assertEquals(listOf("late", "next"), removeHomeworkTask(kept, "am").map { it.id })
        assertEquals(listOf("late", "am", "next"), removeHomeworkTask(kept, "missing").map { it.id })
    }

    @Test
    fun subjectsFollowTheDesktopFolderListAndNewTasksKeepTheFieldLimits() {
        val options = homeworkSubjectOptions(
            listOf("physik", " Mathematik ", "", "Mathematik"),
            listOf(HomeworkTask("a", "Lesen", subject = "Algebra"), HomeworkTask("b", "Ohne")),
        )
        assertEquals(listOf("Algebra", "Mathematik", "physik"), options)
        val draft = prepareHomeworkDraft(
            title = "  ${"A".repeat(300)}  ",
            notes = "N".repeat(4_100),
            subject = "  ${"S".repeat(90)} ",
            dueDate = "morgen",
            dueTime = "8:00",
            kind = "appointment",
            priority = "high",
        )
        assertEquals(240, draft?.title?.length)
        assertEquals(4_000, draft?.notes?.length)
        assertEquals(80, draft?.subject?.length)
        assertEquals(null, draft?.dueDate)
        assertEquals(null, draft?.dueTime)
        assertEquals("appointment", draft?.kind)
        assertEquals("high", draft?.priority)
        assertEquals(null, prepareHomeworkDraft("   "))
        val dated = prepareHomeworkDraft("Lesen", dueDate = "2026-10-16", dueTime = "08:00")
        assertEquals("2026-10-16", dated?.dueDate)
        assertEquals("08:00", dated?.dueTime)
    }
}