package ch.fasrv.fanotes.companion

import ch.fasrv.fanotes.schulnetz.SchulnetzSnapshot
import ch.fasrv.fanotes.schulnetz.isExamLike
import ch.fasrv.fanotes.schulnetz.isLesson
import ch.fasrv.fanotes.schulnetz.weekMondayKey
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.time.LocalDate

/**
 * A whole TAM read against a fake intranet built from the anonymized fixtures. The fake only answers
 * what the real one is documented to answer; every request is recorded to check it stays read-only.
 */
class TamReadTest {
    private val root = "https://intranet.tam.ch/bmz"
    private val today = LocalDate.parse("2026-11-16")
    private val now = "2026-11-16T06:00:00Z"

    private fun fixture(name: String): String =
        listOf("../core/src/test/resources/tam/$name", "android/core/src/test/resources/tam/$name")
            .map(::File).firstOrNull { it.isFile }?.readText() ?: error("fixture $name")

    private fun intranet(signedIn: Boolean = true, week: (String) -> String): Pair<TamTransport, MutableList<TamRequest>> {
        val requests = mutableListOf<TamRequest>()
        val transport = TamTransport { request ->
            requests += request
            val path = java.net.URI(request.url).path
            when {
                !signedIn -> TamResponse(200, fixture("login.html"), root)
                path == "/bmz/timetable/classbook" -> TamResponse(200, "<html><script>var csrfToken='9f8e7d6c5b4a39281706f5e4d3c2b1a0';</script></html>", request.url)
                path.startsWith("/bmz/list/get-person-detail-list/list/30") -> TamResponse(200, fixture("signed-in.html"), request.url)
                path == "/bmz/timetable/ajax-get-timetable" -> {
                    val start = request.form.toMap().getValue("startDate").toLong()
                    val monday = java.time.Instant.ofEpochMilli(start).atZone(ch.fasrv.fanotes.schulnetz.SCHOOL_ZONE).toLocalDate().toString()
                    TamResponse(200, week(monday), request.url)
                }
                path == "/bmz/list/index/list/112" -> TamResponse(200, fixture("absences-list112.html"), request.url)
                path.contains("/rest/ics/") -> TamResponse(200, "BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:t1\nSUMMARY:Elternabend\nDTSTART:20261126T190000\nDTEND:20261126T203000\nEND:VEVENT\nEND:VCALENDAR\n", request.url)
                else -> TamResponse(404, "", request.url)
            }
        }
        return transport to requests
    }

    private val realWeek = fixture("timetable-week.json")

    @Test fun aSignedInReadLoadsTheWeeksAbsencesGradesAndCalendar() {
        val (transport, requests) = intranet { monday -> if (monday == "2026-11-16") realWeek else """{"status":1,"data":[]}""" }
        val read = TamClient(transport).fetch(root, null, null, "$root/rest/ics/type/calendar/date/0/auth/x@y:z/calendar.ics", today, now,
            renderGradebook = { fixture("gradebook-rendered.html") })
        assertEquals(TamProblem.NONE, read.problem)
        assertEquals("424242", read.personId)
        val snapshot = read.snapshot
        // The week of the 16th has its five lessons; the planned other weeks are read and free.
        assertEquals(5, snapshot.events.count { it.isLesson() && weekMondayKey(it.start) == "2026-11-16" })
        assertTrue("2026-11-16" in snapshot.weekRead)
        assertTrue("2026-11-23" in snapshot.weekRead)
        assertTrue(snapshot.exams.single().isExamLike())
        assertEquals(3, snapshot.absences.size)
        assertEquals(4, snapshot.grades.size)
        assertTrue(snapshot.events.any { !it.isLesson() && it.text == "Elternabend" })
        // Only the own person id is asked for, and the only POST is the timetable query.
        assertTrue(requests.filter { it.method == "POST" }.all { java.net.URI(it.url).path == "/bmz/timetable/ajax-get-timetable" && it.form.toMap()["studentId[]"] == "424242" })
        assertTrue(requests.none { it.url.contains("logout") || it.url.contains("login") || it.url.contains("save") })
        assertTrue(requests.filter { it.method == "POST" }.all { it.headers["X-Requested-With"] == "XMLHttpRequest" })
    }

    @Test fun aSignedOutSessionKeepsEverythingStored() {
        val stored = SchulnetzSnapshot(fetchedAt = "2026-11-15T06:00:00Z", events = ch.fasrv.fanotes.schulnetz.parseTamTimetable(realWeek)!!.lessons)
        val (transport, requests) = intranet(signedIn = false) { realWeek }
        val read = TamClient(transport).fetch(root, stored, "424242", null, today, now)
        assertEquals(TamProblem.SIGNED_OUT, read.problem)
        assertEquals(stored.events, read.snapshot.events)
        // Nothing beyond the one page that showed the sign-in form.
        assertEquals(1, requests.size)
    }

    @Test fun anAnswerThatIsNotATimetableNeverEmptiesAStoredWeek() {
        val stored = SchulnetzSnapshot(
            fetchedAt = "2026-11-15T06:00:00Z",
            events = ch.fasrv.fanotes.schulnetz.parseTamTimetable(realWeek)!!.lessons,
            weekRead = mapOf("2026-11-16" to "2026-11-15T06:00:00Z"),
            weekFetched = mapOf("2026-11-16" to "2026-11-15T06:00:00Z"),
        )
        val (transport, _) = intranet { "<html>Fehler</html>" }
        val read = TamClient(transport).fetch(root, stored, "424242", null, today, now)
        assertEquals(TamProblem.NONE, read.problem)
        assertEquals(5, read.snapshot.events.count { it.isLesson() && weekMondayKey(it.start) == "2026-11-16" })
        // Asked, but not confirmed read: it is asked again soon.
        assertTrue("2026-11-23" in read.snapshot.weekFetched)
        assertFalse("2026-11-23" in read.snapshot.weekRead)
    }
}
