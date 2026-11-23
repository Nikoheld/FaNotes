package ch.fasrv.fanotes.companion

import ch.fasrv.fanotes.desk.HomeworkTask
import ch.fasrv.fanotes.schulnetz.TeacherAbsenceDay
import java.time.LocalDate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TodayLogicTest {
    private val today = LocalDate.parse("2026-11-23")

    private fun task(id: String, due: String?, done: Boolean = false, time: String? = null) =
        HomeworkTask(id = id, title = "Task $id", dueDate = due, dueTime = time, done = done)

    private fun exam(key: String, day: String, start: String = "08:00", end: String = "08:45", kind: AgendaKind = AgendaKind.Exam) =
        AgendaEntry(key, "Exam $key", kind, LocalDate.parse(day), start, end)

    @Test fun bannerPriorityFollowsTheSpec() {
        val all = TodayBannerState(needsReauth = true, syncNotice = true, syncError = true, demo = true, connect = true, notifyTip = true)
        assertEquals(TodayBanner.Reconnect, todayBanner(all))
        assertEquals(TodayBanner.SyncError, todayBanner(all.copy(needsReauth = false)))
        assertEquals(TodayBanner.Demo, todayBanner(all.copy(needsReauth = false, syncError = false).copy(syncNotice = false)))
        assertEquals(TodayBanner.Demo, todayBanner(all.copy(needsReauth = false, syncError = false).copy(syncNotice = true, demo = true)))
        assertEquals(TodayBanner.SyncOffline, todayBanner(all.copy(needsReauth = false, syncError = false, demo = false)))
        assertEquals(TodayBanner.Connect, todayBanner(TodayBannerState(connect = true, notifyTip = true)))
        assertEquals(TodayBanner.NotifyTip, todayBanner(TodayBannerState(notifyTip = true)))
        assertNull(todayBanner(TodayBannerState()))
    }

    @Test fun syncErrorFlagIsIgnoredWithoutANotice() {
        assertNull(todayBanner(TodayBannerState(syncNotice = false, syncError = true)))
    }

    @Test fun upNextKeepsOverdueTodayAndTomorrowTasksOnly() {
        val tasks = listOf(task("a", "2026-11-20"), task("b", "2026-11-23"), task("c", "2026-11-24"), task("d", "2026-11-25"), task("e", null), task("f", "2026-11-23", done = true))
        val rows = upNext(tasks, emptyList(), today, showTasks = true, showExams = true)
        assertEquals(listOf("task:a", "task:b", "task:c"), rows.map { it.key })
    }

    @Test fun upNextPutsExamsBeforeTasksOnTheSameDayAndSortsByDate() {
        val tasks = listOf(task("t1", "2026-11-24"), task("t2", "2026-11-23"))
        val exams = listOf(exam("late", "2026-11-30"), exam("x1", "2026-11-24"))
        val rows = upNext(tasks, exams, today, showTasks = true, showExams = true)
        assertEquals(listOf("task:t2", "exam:x1", "task:t1", "exam:late"), rows.map { it.key })
    }

    @Test fun upNextIsLimitedToFourRows() {
        val tasks = (1..6).map { task("t$it", "2026-11-23") }
        assertEquals(4, upNext(tasks, listOf(exam("e", "2026-11-23")), today, true, true).size)
        assertEquals("exam:e", upNext(tasks, listOf(exam("e", "2026-11-23")), today, true, true).first().key)
    }

    @Test fun manyTasksDueSoonNeverHideTheNearestExam() {
        val tasks = (1..6).map { task("t$it", "2026-11-23") }
        val exams = listOf(exam("later", "2026-12-03"), exam("next", "2026-11-27"))
        val rows = upNext(tasks, exams, today, true, true)
        assertEquals(listOf("task:t1", "task:t2", "task:t3", "exam:next"), rows.map { it.key })
    }

    @Test fun upNextRespectsTheTasksAndExamCards() {
        val tasks = listOf(task("t", "2026-11-23"))
        val exams = listOf(exam("e", "2026-11-25"))
        assertEquals(listOf("exam:e"), upNext(tasks, exams, today, showTasks = false, showExams = true).map { it.key })
        assertEquals(listOf("task:t"), upNext(tasks, exams, today, showTasks = true, showExams = false).map { it.key })
        assertEquals(emptyList<UpNextItem>(), upNext(tasks, exams, today, showTasks = false, showExams = false))
    }

    @Test fun upcomingExamsDropsThePastTheHeroAndOtherKinds() {
        val agenda = listOf(
            exam("past", "2026-11-23", "07:00", "07:45"), exam("running", "2026-11-23", "09:00", "10:00"), exam("hero", "2026-11-24"),
            exam("task", "2026-11-24", kind = AgendaKind.Task), exam("later", "2026-11-26"),
        )
        assertEquals(listOf("running", "later"), upcomingExams(agenda, today, "09:30", "hero").map { it.key })
    }

    @Test fun glanceShowsOnlyEnabledTilesInOrder() {
        assertEquals(GlanceLayout(listOf(GlanceTile.Points, GlanceTile.Updates), false), glanceLayout(false, true, false, true))
        assertEquals(GlanceLayout(emptyList(), false), glanceLayout(false, false, false, false))
        assertEquals(GlanceLayout(listOf(GlanceTile.Grades, GlanceTile.Absences, GlanceTile.Updates), false), glanceLayout(true, false, true, true))
    }

    @Test fun glanceMovesUpdatesToALinkWhenFourApply() {
        assertEquals(GlanceLayout(listOf(GlanceTile.Grades, GlanceTile.Points, GlanceTile.Absences), true), glanceLayout(true, true, true, true))
    }

    @Test fun teacherLineJoinsNamesAndAddsExcursionAfterASeparator() {
        val line = teacherAbsenceLine(TeacherAbsenceDay("2026-11-23", listOf("A", "B"), listOf("C"))) { "exc: $it" }
        assertEquals("A, B  ·  exc: C", line)
        assertEquals("exc: C", teacherAbsenceLine(TeacherAbsenceDay("2026-11-23", emptyList(), listOf("C"))) { "exc: $it" })
    }
}
