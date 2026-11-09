package ch.fasrv.fanotes.companion

import ch.fasrv.fanotes.desk.emptyCalendar
import ch.fasrv.fanotes.schulnetz.SchulnetzSnapshot
import ch.fasrv.fanotes.schulnetz.WebSession
import ch.fasrv.fanotes.schulnetz.WeekCoverage
import ch.fasrv.fanotes.schulnetz.eventDate
import ch.fasrv.fanotes.schulnetz.eventDay
import ch.fasrv.fanotes.schulnetz.isExamLike
import ch.fasrv.fanotes.schulnetz.isLesson
import ch.fasrv.fanotes.schulnetz.lessonWeekCoverage
import ch.fasrv.fanotes.schulnetz.upcomingLessons
import ch.fasrv.fanotes.schulnetz.upcomingTimetableUnread
import ch.fasrv.fanotes.schulnetz.weekMondayKey
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.net.URI
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/**
 * A whole read against a fake Schulnetz 5.14.1 built from the anonymized fixtures. Like the real
 * server, the scheduler answers only with the transid its page printed and returns a bare
 * <data></data> for any other transid.
 */
class TimetableWeeksFetchTest {
    private val root = "https://www.schulnetz-ag.ch/aksa"
    private val zone = ZoneId.of("Europe/Zurich")
    private val today = LocalDate.parse("2026-11-06")
    private val fetchedNow = "2026-11-06T17:00:00Z"
    private val sessionId = "f1a2b3c4d5e6f708"
    private val empty = "<?xml version='1.0' encoding='utf-8' ?><data></data>"
    private val holidays = setOf("2026-12-21", "2026-12-28")

    /** The shared fixtures live with the core tests; Gradle runs these tests from the module folder. */
    private fun fixture(name: String): String =
        listOf("../core/src/test/resources/schulnetz/$name", "android/core/src/test/resources/schulnetz/$name")
            .map(::File).firstOrNull { it.isFile }?.readText() ?: error("fixture $name")

    private fun query(url: String): Map<String, String> =
        URI(url).rawQuery.orEmpty().split('&').filter { it.isNotBlank() }.associate { it.substringBefore('=') to it.substringAfter('=', "") }

    private fun menu(pageId: String) = "<html><body><h1>Seite $pageId</h1>" +
        listOf("1", "21311", "21111", "21411", "21200", "22206", "22202", "22108", "21312")
            .joinToString("") { """<a href="index.php?pageid=$it&amp;id=$sessionId&amp;transid=d1e2f3">Seite $it</a>""" } +
        "</body></html>"

    /** [reusedIds]: ids 1..15 every week, the way the real scheduler numbers a week's lessons. */
    private fun lessons(monday: LocalDate, reusedIds: Boolean = false): String = buildString {
        append("<data>")
        for (day in 0L..4L) for ((slot, clock) in listOf("07:45" to "08:30", "08:35" to "09:20", "09:40" to "10:25").withIndex()) {
            val date = monday.plusDays(day)
            val id = if (reusedIds) "${day * 3 + slot + 1}" else "L$date-$slot"
            append("""<event id="$id"><start_date>$date ${clock.first}</start_date><end_date>$date ${clock.second}</end_date><text>Fach $slot</text><zimmerkuerzel>A$slot</zimmerkuerzel><event_type>0_stp</event_type></event>""")
        }
        append("</data>")
    }

    private fun exam(monday: LocalDate): String = if (monday.toString() != "2026-11-16") empty else
        """<data><event id="P1"><start_date>2026-11-18 10:15</start_date><end_date>2026-11-18 11:00</end_date><text>Biologie</text><zimmerkuerzel>B04</zimmerkuerzel><event_type>1_pru</event_type></event></data>"""

    private class Recorder(val requests: MutableList<String> = mutableListOf(), val traces: MutableList<String> = mutableListOf())

    private fun read(
        recorder: Recorder,
        schedulerWorks: Boolean = true,
        previous: SchulnetzSnapshot? = null,
        at: String = fetchedNow,
        reusedIds: Boolean = false,
        answersWeek: LocalDate? = null,
        gradesPage: Boolean = false,
    ): SchulnetzSnapshot {
        val loader: (String) -> LoadedPage = { url ->
            recorder.requests += url
            val q = query(url)
            val body = when {
                url.contains("scheduler_processor.php") -> {
                    val monday = LocalDate.parse(q.getValue("min_date"))
                    when {
                        !schedulerWorks -> empty
                        // answersWeek: a scheduler that ignores the requested range.
                        q["pageid"] == "22202" && q["transid"] == "a1b2c3" -> if (monday.toString() in holidays) empty else lessons(answersWeek ?: monday, reusedIds)
                        q["pageid"] == "21312" && q["transid"] == "b2c3d4" -> exam(monday)
                        else -> empty
                    }
                }
                q["pageid"] == "21311" && gradesPage -> fixture("noten-5141.html")
                q["pageid"] == "22202" -> fixture("stundenplan-5141.html")
                q["pageid"] == "21312" -> fixture("pruefungsplan-5141.html")
                q["pageid"] == "22108" && q.containsKey("numRows") -> fixture("terminliste-alle.html")
                q["pageid"] == "22108" -> fixture("terminliste.html")
                else -> menu(q["pageid"].orEmpty())
            }
            LoadedPage(url, url, 200, body)
        }
        val client = SchulnetzClient().apply { onMainThread = { false } }
        val bundle = client.fetchWeb(
            root,
            WebSession(root, "", sessionId, "e0e0e0"),
            loader,
            trace = { recorder.traces += it },
            previous = previous,
            today = today,
            fetchedNow = at,
        )
        return bundle.snapshot
    }

    @Test fun everyWeekOfTheSemesterLoadsWithThePagesOwnTransid() {
        val recorder = Recorder()
        val snapshot = read(recorder)
        val scheduler = recorder.requests.filter { it.contains("scheduler_processor.php") }
        val lessonCalls = scheduler.filter { query(it)["pageid"] == "22202" }
        val examCalls = scheduler.filter { query(it)["pageid"] == "21312" }
        assertTrue(lessonCalls.isNotEmpty())
        assertTrue("timetable weeks use the transid 22202 printed", lessonCalls.all { query(it)["transid"] == "a1b2c3" })
        assertTrue("exam weeks use the transid 21312 printed", examCalls.all { query(it)["transid"] == "b2c3d4" })
        assertTrue(recorder.traces.any { it.startsWith("scheduler transid page=22202 source=page-scheduler") })
        assertTrue(recorder.traces.any { it.startsWith("semester span=2026-08-10..2027-01-29") })
        // Read-only: no form saves, no eSchool, no logout.
        assertTrue(recorder.requests.none { it.contains("xajax") || it.contains("23118") || it.contains("pageid=9999") })

        val taught = snapshot.events.filter { it.isLesson() }.mapNotNull { weekMondayKey(it.start) }.toSet()
        for (week in listOf("2026-11-09", "2026-11-16", "2026-11-23", "2026-11-30", "2026-12-07", "2027-01-25")) assertTrue(week, week in taught)
        // Holidays answered empty with a proven transid: read and free, not unread.
        assertTrue("2026-12-21" in snapshot.weekRead)
        assertTrue("2026-12-21" !in taught)
        assertTrue(snapshot.exams.any { it.start.startsWith("2026-11-18") && it.isExamLike() })
        // The whole Terminliste in one read, reaching into January.
        assertTrue(recorder.requests.any { it.contains("pageid=22108") && it.contains("numRows=1000000") })
        assertTrue(snapshot.events.any { !it.isLesson() && eventDate(eventDay(it))?.toString()?.startsWith("2027-01") == true })

        // Planner: next weeks have lessons, not "Keine Termine".
        val nextWeek = LocalDate.parse("2026-11-16")
        // Lessons without rooms: appointment and room labels need Android string resources, which JVM tests lack.
        val lessonsOnly = snapshot.copy(events = snapshot.events.filter { it.isLesson() }.map { it.copy(room = "") })
        val agenda = agendaForDays(listOf(nextWeek), lessonsOnly, emptyCalendar(), emptyList(), emptyList(), zone)
        assertTrue(agenda.getValue(nextWeek).any { it.kind == AgendaKind.Lesson })
        assertEquals(WeekCoverage.LOADED, lessonWeekCoverage(snapshot, nextWeek, today))
        // Widget on Friday evening: Monday's first lesson, not "Keine anstehende Lektion".
        val next = upcomingLessons(snapshot.events, Instant.parse(fetchedNow), zone, 4)
        assertTrue(next.isNotEmpty())
        assertTrue(next.first().start.startsWith("2026-11-09"))
        assertFalse(upcomingTimetableUnread(snapshot, today))
    }

    @Test fun aBareEmptyAnswerNeverMarksAWeekAsChecked() {
        val recorder = Recorder()
        // Every scheduler call returns the empty <data></data> a stale transid causes.
        val snapshot = read(recorder, schedulerWorks = false)
        val nextWeek = LocalDate.parse("2026-11-16")
        assertTrue("attempted", "2026-11-16" in snapshot.weekFetched)
        assertTrue("not read", "2026-11-16" !in snapshot.weekRead)
        // The planner says "not loaded" instead of a free week, and the widget knows it is unread.
        assertEquals(WeekCoverage.UNREAD, lessonWeekCoverage(snapshot, nextWeek, today))
        assertTrue(upcomingTimetableUnread(snapshot, today))
        // This week still shows the lessons the page itself drew.
        assertTrue(snapshot.events.any { it.isLesson() && it.start.startsWith("2026-11-02") })
        // 40 minutes later the unread weeks are asked again instead of waiting a day, and fill in.
        val again = Recorder()
        val later = read(again, schedulerWorks = true, previous = snapshot, at = "2026-11-06T17:40:00Z")
        assertTrue(again.requests.any { it.contains("scheduler_processor.php") && it.contains("min_date=2026-11-23") })
        assertTrue(later.events.any { it.isLesson() && it.start.startsWith("2026-11-23") })
        assertTrue("2026-11-23" in later.weekRead)
    }

    private fun perWeek(snapshot: SchulnetzSnapshot): Map<String, Int> =
        snapshot.events.filter { it.isLesson() }.groupingBy { weekMondayKey(it.start).orEmpty() }.eachCount()

    @Test fun lessonsStayThroughLaterSyncsWhenSchulnetzReusesLessonIds() {
        val first = read(Recorder(), reusedIds = true, gradesPage = true)
        val loaded = perWeek(first)
        // Every week read keeps all 15 lessons, though every week uses the ids 1..15 and the
        // Terminliste is merged in. Before, only the first week's lessons kept their ids.
        for (week in listOf("2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23", "2026-12-07")) assertEquals(week, 15, loaded[week])
        assertTrue(first.events.any { !it.isLesson() })

        // A later sync whose scheduler only returns the stale-transid <data></data>: nothing is lost,
        // and this week's lessons are not replaced by what the page itself drew.
        val stale = read(Recorder(), schedulerWorks = false, previous = first, at = "2026-11-06T17:40:00Z", reusedIds = true)
        assertEquals(loaded, perWeek(stale))

        // A scheduler that answers every request with this week's lessons empties no other week.
        val confused = read(Recorder(), previous = stale, at = "2026-11-07T18:00:00Z", reusedIds = true, answersWeek = LocalDate.parse("2026-11-02"))
        assertEquals(loaded, perWeek(confused))

        // The widget and planner still see next week.
        val next = upcomingLessons(confused.events, Instant.parse("2026-11-07T18:00:00Z"), zone, 4)
        assertTrue(next.isNotEmpty() && next.first().start.startsWith("2026-11-09"))
        assertFalse(upcomingTimetableUnread(confused, today))
    }

    @Test fun everyGradeRowIsReadAndNothingIsEverSentToSchulnetz() {
        val recorder = Recorder()
        val snapshot = read(recorder, gradesPage = true)
        assertEquals(8, snapshot.grades.size)
        assertEquals(3, snapshot.grades.count { it.mark == null })
        assertEquals(4.25, snapshot.grades.single { it.title == "Geometrie" }.mark)
        // Read-only: the page's confirm link and mail form are never used, nor any action, save or logout.
        assertTrue(recorder.requests.none { it.contains("action=") || it.contains("xajax") || it.contains("pageid=9999") || it.contains("23118") })
    }
}
