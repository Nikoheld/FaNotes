package ch.fasrv.fanotes.schulnetz

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class DemoDataTest {
    private val zone = ZoneId.of("Europe/Zurich")

    @Test fun theDemoCoversTodayAndTheComingWeeks() {
        val today = LocalDate.parse("2026-11-13") // a Friday
        val demo = demoSnapshot(today)
        assertTrue(demo.isDemo())
        val taught = demo.events.filter { it.isLesson() }.mapNotNull { weekMondayKey(it.start) }.toSet()
        for (offset in -2L..10L) {
            val monday = LocalDate.parse("2026-11-09").plusWeeks(offset).toString()
            assertTrue(monday in taught, monday)
            assertEquals(WeekCoverage.LOADED, lessonWeekCoverage(demo, LocalDate.parse(monday), today))
        }
        // The widget on Friday evening shows Monday's first lesson; the planner never says "not loaded".
        val next = upcomingLessons(demo.events, Instant.parse("2026-11-13T18:00:00Z"), zone, 4)
        assertTrue(next.first().start.startsWith("2026-11-16T07:45"))
        assertFalse(upcomingTimetableUnread(demo, today))
    }

    @Test fun itShowsEveryKindOfSchoolData() {
        val today = LocalDate.parse("2026-11-11")
        val demo = demoSnapshot(today)
        assertTrue(demo.grades.size >= 10)
        assertTrue(demo.exams.count { eventDate(eventDay(it))!!.isAfter(today) } >= 3)
        assertTrue(demo.exams.any { eventDate(eventDay(it))!!.isBefore(today) })
        assertTrue(demo.exams.all { it.isExamLike() })
        assertTrue(demo.events.any { it.isLesson() && it.isCancelled() })
        assertTrue(demo.events.any { it.isLesson() && it.isSubstitution() })
        assertTrue(demo.events.any { !it.isLesson() && !it.isExamLike() })
        assertTrue(demo.absences.any { !it.excused && it.excuseUntil.isNotBlank() })
        assertTrue(demo.messages.isNotEmpty() && demo.konto.isNotEmpty())
        // No exam or lesson falls on a weekend.
        assertTrue((demo.events + demo.exams).all { eventDate(eventDay(it))!!.dayOfWeek.value <= 5 })
    }

    @Test fun everythingIsMarkedSyntheticAndStaysQuiet() {
        val today = LocalDate.parse("2026-11-11")
        val demo = demoSnapshot(today)
        val ids = demo.grades.map { it.id } + demo.events.map { it.id } + demo.exams.map { it.id } + demo.absences.map { it.id } + demo.messages.map { it.id }
        assertTrue(ids.all(::isDemoId))
        assertEquals(DEMO_DISPLAY_NAME, demo.profile?.displayName)
        assertTrue(demo.profile?.email.isNullOrBlank())
        // Rebuilding the demo for the same day is not a change, so it can never raise a notification.
        assertTrue(diffSnapshots(demo, demoSnapshot(today), NotifySettings(), today).isEmpty())
        assertFalse(SchulnetzSnapshot().isDemo())
    }
}
