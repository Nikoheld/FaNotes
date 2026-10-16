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

    @Test
    fun cardsUseTheDesktopKindDateAndInset() {
        val today = LocalDate.of(2026, 10, 15)
        val late = HomeworkTask("late", "Spät", dueDate = "2026-10-14", dueTime = "18:30", priority = "high")
        val visit = HomeworkTask("visit", "Elternabend", dueDate = "2026-10-15", kind = "appointment", priority = "high")
        val open = HomeworkTask("open", "Lesen")
        val finished = HomeworkTask("fin", "Weg", dueDate = "not-a-date", done = true)
        assertEquals("Mi., 14. Okt. · 18:30", homeworkDueLabel(late))
        assertEquals("Do., 15. Okt.", homeworkDueLabel(visit))
        assertEquals(HOMEWORK_NO_DATE, homeworkDueLabel(open))
        assertEquals(HOMEWORK_NO_DATE, homeworkDueLabel(finished))
        assertEquals(HOMEWORK_KIND_HOMEWORK, homeworkKindLabel("homework"))
        assertEquals(HOMEWORK_KIND_APPOINTMENT, homeworkKindLabel("appointment"))
        assertEquals("Überfällig", homeworkBucketLabel("overdue"))
        assertEquals("Erledigt", homeworkBucketLabel("done"))
        assertEquals(listOf("overdue", "high"), homeworkCardMarks(late, today))
        assertEquals(listOf("high", "appointment"), homeworkCardMarks(visit, today))
        assertEquals(listOf("done"), homeworkCardMarks(finished, today))
        assertEquals("warning", homeworkCardInset(late))
        assertEquals("accent", homeworkCardInset(visit))
        assertEquals("none", homeworkCardInset(open))
        assertEquals(12, HOMEWORK_CARD_RADIUS_DP)
        assertEquals(34, HOMEWORK_CARD_ACTION_DP)
        assertEquals(3, HOMEWORK_CARD_INSET_DP)
        assertEquals(0.72f, HOMEWORK_CARD_DONE_ALPHA)
        assertEquals(0.40f, HOMEWORK_OVERDUE_BORDER)
        assertFalse(homeworkDoneBucketVisible("open", expanded = false))
        assertTrue(homeworkDoneBucketVisible("all", expanded = false))
        assertTrue(homeworkDoneBucketVisible("open", expanded = true))
        assertEquals(HOMEWORK_EXPAND, homeworkDoneToggleLabel("open", expanded = false))
        assertEquals(HOMEWORK_COLLAPSE, homeworkDoneToggleLabel("all", expanded = false))
        assertEquals(null, homeworkDoneToggleLabel("done", expanded = true))
        assertEquals("Eintrag löschen", HOMEWORK_DELETE)
        assertEquals("Als erledigt markieren", HOMEWORK_MARK_DONE)
        assertEquals("Als offen markieren", HOMEWORK_MARK_OPEN)
    }

    @Test
    fun composerMatchesTheDesktopForm() {
        assertEquals(1, homeworkComposerColumns(0))
        assertEquals(1, homeworkComposerColumns(HOMEWORK_COMPOSER_STACK_DP))
        assertEquals(2, homeworkComposerColumns(HOMEWORK_COMPOSER_STACK_DP + 1))
        assertEquals(2, homeworkComposerColumns(HOMEWORK_COMPOSER_NARROW_DP))
        assertEquals(HOMEWORK_COMPOSER_WIDE_COLUMNS, homeworkComposerColumns(HOMEWORK_COMPOSER_NARROW_DP + 1))
        assertEquals(4, homeworkComposerColumns(HOMEWORK_SHELL_MAX_DP))
        assertEquals(2, homeworkComposerColumns(800 - HOMEWORK_SHELL_INSET_DP * 2))
        assertEquals(360, HOMEWORK_COMPOSER_STACK_DP)
        assertEquals(760, HOMEWORK_COMPOSER_NARROW_DP)
        assertEquals(14, HOMEWORK_COMPOSER_PAD_DP)
        assertEquals(10, HOMEWORK_COMPOSER_GAP_DP)
        assertEquals(12, HOMEWORK_COMPOSER_RADIUS_DP)
        assertEquals(0.92f, HOMEWORK_COMPOSER_FILL)
        assertEquals(16, HOMEWORK_COMPOSER_SHADOW_DP)
        assertEquals(0.16f, HOMEWORK_COMPOSER_SHADOW_ALPHA)
        assertEquals(8, HOMEWORK_COMPOSER_ROW_GAP_DP)
        assertEquals(1.5f, HOMEWORK_GROW_FR)
        assertEquals(0.7f, HOMEWORK_TRACK_FR)
        assertEquals(34, HOMEWORK_INPUT_MIN_DP)
        assertEquals(58, HOMEWORK_NOTES_MIN_DP)
        assertEquals(6, HOMEWORK_INPUT_RADIUS_DP)
        assertEquals(7, HOMEWORK_INPUT_PAD_Y_DP)
        assertEquals(9, HOMEWORK_INPUT_PAD_X_DP)
        assertEquals(650, HOMEWORK_INPUT_WEIGHT)
        assertEquals(0.55f, HOMEWORK_FOCUS_BORDER)
        assertEquals(0.14f, HOMEWORK_FOCUS_RING)
        assertEquals(3, HOMEWORK_FOCUS_RING_DP)
        assertEquals(0.55f, HOMEWORK_PRIMARY_DISABLED)
        assertEquals(500, HOMEWORK_PRIMARY_WEIGHT)
        assertEquals(15, HOMEWORK_PRIMARY_ICON_DP)
        assertEquals("", HOMEWORK_DEFAULT_DUE)
        assertEquals("homework", HOMEWORK_DEFAULT_KIND)
        assertEquals("normal", HOMEWORK_DEFAULT_PRIORITY)
        assertEquals("Eintrag hinzufügen", HOMEWORK_ADD)
        assertEquals("Aufgabe / Termin", HOMEWORK_TASK_LABEL)
        assertEquals("Art", HOMEWORK_KIND_FIELD)
        assertEquals("z. B. Mathe S. 42, Nr. 3–5 oder Elternabend", HOMEWORK_TASK_PLACEHOLDER)
        assertEquals("Mathematik", HOMEWORK_SUBJECT_PLACEHOLDER)
        assertEquals("Optional: Seite, Heft, Mitbringsel …", HOMEWORK_NOTES_PLACEHOLDER)
        assertEquals("Normal", HOMEWORK_PRIORITY_NORMAL)
        assertEquals("Schule & Organisation", HOMEWORK_EYEBROW)
        assertEquals("Hausaufgaben & Termine", HOMEWORK_TITLE)
        assertEquals(32, HOMEWORK_TITLE_SP)
        assertTrue(HOMEWORK_TITLE_SP in HOMEWORK_TITLE_MIN_SP..HOMEWORK_TITLE_MAX_SP)
        assertEquals(720, HOMEWORK_TITLE_WEIGHT)
        assertEquals(-0.04f, HOMEWORK_TITLE_TRACKING)
        assertEquals(0.08f, HOMEWORK_EYEBROW_TRACKING)
        assertEquals(26, HOMEWORK_STAT_MIN_DP)
        assertEquals(7, HOMEWORK_STATS_GAP_DP)
        assertEquals(14, HOMEWORK_STATS_MARGIN_DP)
        assertEquals(0.35f, HOMEWORK_STAT_WARN_MIX)
        assertEquals(0.70f, HOMEWORK_STAT_FILL)
        assertEquals("überfällig", HOMEWORK_STAT_OVERDUE)
        assertEquals(28, HOMEWORK_CHIP_MIN_DP)
        assertEquals(11, HOMEWORK_CHIP_PAD_X_DP)
        assertEquals(700, HOMEWORK_CHIP_WEIGHT)
        assertEquals(0.45f, HOMEWORK_CHIP_ACTIVE_BORDER)
        assertEquals(0.16f, HOMEWORK_CHIP_ACTIVE_FILL)
        assertEquals(1080, HOMEWORK_SHELL_MAX_DP)
        assertEquals(24, HOMEWORK_SHELL_INSET_DP)
        assertEquals(30, HOMEWORK_SHELL_PAD_TOP_DP)
        assertEquals("Als Notiz öffnen", HOMEWORK_OPEN_NOTE)
        assertEquals("Schließen", HOMEWORK_CLOSE)
        assertEquals(34, HOMEWORK_ACTION_DP)
        assertEquals("Liste", HOMEWORK_VIEW_LIST)
        assertEquals("Offen", HOMEWORK_FILTER_OPEN)
        assertEquals("Alle", HOMEWORK_FILTER_ALL)
    }

    @Test
    fun theCalendarUsesTheDesktopDayCards() {
        assertEquals(86, homeworkDayMinDp("month"))
        assertEquals(150, homeworkDayMinDp("week"))
        assertEquals(3, homeworkDayLimit("month"))
        assertEquals(8, homeworkDayLimit("week"))
        assertEquals("high", homeworkDayChip("appointment", "high"))
        assertEquals("appointment", homeworkDayChip("appointment", "normal"))
        assertEquals("open", homeworkDayChip("homework", "normal"))
        assertEquals(12, HOMEWORK_CAL_RADIUS_DP)
        assertEquals(10, HOMEWORK_DAY_RADIUS_DP)
        assertEquals(32, HOMEWORK_NAV_DP)
        assertEquals("Vorheriger Zeitraum", HOMEWORK_PREVIOUS)
        assertEquals("Nächster Zeitraum", HOMEWORK_NEXT)
    }
}