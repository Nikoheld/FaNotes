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
        assertEquals(0.0, wish.pluspunkteBefore)
        assertEquals(1.0, wish.pluspunkteAfter)
        assertEquals(0.5, summary.pluspunkte)
        assertEquals(4.5, summary.zeugnis)
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

    @Test
    fun aargauRoundingExcludesSportAndEmptyCourses() {
        assertEquals(4.5, roundToHalf(4.74))
        assertEquals(5.0, roundToHalf(4.75))
        assertEquals(1.5, promotionPoints(5.5))
        assertEquals(0.0, promotionPoints(4.0))
        assertEquals(-2.0, promotionPoints(3.0))
        assertEquals(-1.0, promotionPoints(3.5))
        assertTrue(isSportCourse("Sport"))
        assertTrue(isSportCourse("SPO Sport"))
        assertFalse(isSportCourse("Mathematik"))
        val sport = SchoolGrade("s", "Sport", "spo", "Sport", "Test", "2026-09-01", 6.0, 1.0, true, null, "")
        val math = SchoolGrade("m", "Mathematik", "math", "Mathematik", "Probe", "2026-09-01", 5.5, 1.0, true, null, "")
        val empty = SchoolGrade("b", "Biologie", "bio", "Biologie", "Durchschnitt", "", null, 1.0, true, null, "")
        val courses = courseSummaries(listOf(sport, math, empty))
        assertEquals(2, courses.size)
        assertEquals(1.5, courses.single { it.promotion }.pluspunkte)
        assertEquals(0.0, courses.single { !it.promotion }.pluspunkte)
        val totals = promotionTotals(courses)
        assertEquals(1.5, totals.plus)
        assertEquals(0.0, totals.minus)
        assertEquals(1.5, totals.total)
    }

    @Test
    fun hiddenLessonsSkipTheWidgetAndThePush() {
        val zone = java.time.ZoneId.of("Europe/Zurich")
        val lesson = AgendaEvent(
            "e1", "2026-11-02T07:45:00", "2026-11-02T08:30:00", "Freifach Chor", "", "A1",
            emptyList(), "chor", "Freifach Chor", "confirmed", "lesson", "", "",
        )
        val later = lesson.copy(id = "e2", start = "2026-11-09T07:45:00", end = "2026-11-09T08:30:00")
        val once = hideOnce(lesson, emptyList())
        assertTrue(lessonHidden(lesson, once, zone))
        assertFalse(lessonHidden(later, once, zone))
        val series = hideSeries(lesson, emptyList())
        assertTrue(lessonHidden(later, series, zone))
        assertEquals(emptyList(), visibleEvents(listOf(lesson, later), series, zone))
        val change = SchulnetzChange("timetable:e1:x", "timetable", "Stundenplan geändert", "Freifach Chor · 07:45 · Raum A1")
        assertTrue(changeIsHidden(change, series))
        assertFalse(changeIsHidden(change.copy(category = "grade"), series))
        val prefs = parseDeskPrefs(serializeDeskPrefs(DeskPrefs(hiddenCards = listOf("tasks"), showPluspunkte = false, startTab = "Noten")))
        assertEquals(listOf("pluspunkte", "lessons", "commute", "exam", "grades", "absences", "events"), shownTodayCards(prefs))
        assertEquals("Noten", prefs.startTab)
        assertEquals(DEFAULT_NAV_BAR, prefs.navBar)
        assertFalse(prefs.showPluspunkte)
    }
}
