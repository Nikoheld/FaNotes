package ch.fasrv.fanotes.schulnetz

import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class DeskTest {
    @Test
    fun ownMarksDoNotReplaceOfficialOnesAndWishUsesWeights() {
        val official = listOf(SchoolGrade("g", "Mathematik", "math", "Mathematik", "Probe", "2026-10-20", 4.0, 2.0, true, 4.0, ""))
        val own = listOf(HypotheticalGrade("h", "math", "Eigene Note", 6.0, 1.0))
        val summary = courseSummaries(official, own).single()
        assertEquals(4.0, summary.marks.first { !it.own }.mark)
        assertEquals(6.0, summary.marks.first { it.own }.mark)
        assertEquals(2.0, summary.marks.first { !it.own }.weight)
        val impossible = wunschnote(summary.marks.filter { !it.own }, 5.0, 1.0)
        assertFalse(impossible.achievable)
        val wish = wunschnote(summary.marks.filter { !it.own }, 5.0, 2.0)
        assertTrue(wish.achievable)
        assertEquals(6.0, wish.needed)
    }

    @Test
    fun excuseReminderFiresOnlyBeforeTheDeadline() {
        val open = SchoolAbsence("a", "01.11.2026", "01.11.2026", "", "", "Deutsch", "Arzt", false, false, "", "04.11.2026")
        val excused = open.copy(id = "b", excused = true)
        val today = LocalDate.of(2026, 11, 2)
        val reminders = excuseReminders(listOf(open, excused), today, withinDays = 2)
        assertEquals(1, reminders.size)
        assertEquals("deadline", reminders.single().category)
        assertTrue(excuseReminders(listOf(open), today.plusDays(5), 2).isEmpty())
        val previous = SchulnetzSnapshot(absences = emptyList())
        val next = SchulnetzSnapshot(absences = listOf(open))
        val changes = diffSnapshots(previous, next, NotifySettings(absences = false, deadlines = true, grades = false, timetable = false, exams = false, events = false), today)
        assertEquals("deadline", changes.single().category)
    }

    @Test
    fun newGradeDiffAndBadgesStayPrivate() {
        val previous = SchulnetzSnapshot(grades = emptyList())
        val next = SchulnetzSnapshot(grades = listOf(SchoolGrade("g", "Chemie", "che", "Chemie", "Test", "2026-11-01", 6.0, 1.0, true, null, "")))
        val changes = diffSnapshots(previous, next, NotifySettings(), LocalDate.of(2026, 11, 2))
        assertEquals("Neue Note", changes.single().title)
        val badges = companionBadges(notesWritten = 1, streakDays = 3, highestMark = 6.0)
        assertTrue(badges.all { it.id != "rank" })
        assertEquals(3, badges.count { it.earned })
        assertFalse(badges.first { it.id == "notes-10" }.earned)
        assertEquals(2, openingStreak(setOf("2026-11-01", "2026-11-02"), LocalDate.of(2026, 11, 2)))
        assertEquals("#112233", subjectColor("Mathematik", "", mapOf("mathematik" to "#112233")))
        assertEquals("#112233", subjectColor("MAT_K26A_LehAa", "", mapOf("mat_k26a_lehaa mathematik" to "#112233")))
    }
}
