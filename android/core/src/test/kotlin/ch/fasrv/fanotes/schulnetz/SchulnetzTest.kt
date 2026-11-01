package ch.fasrv.fanotes.schulnetz

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class SchulnetzParseTest {
    @Test
    fun gradesEventsAndWrappedListsKeepTheMobileFields() {
        val raw = SchulnetzRaw(
            me = """{"id":"s1","firstName":"Fabio","lastName":"Muster","email":"f@aksa.ch","regularClasses":[{"className":"4a"}]}""",
            grades = """{"grades":[{"id":"g1","course":"Mathematik 4a","courseId":"math","subject":"Mathematik","title":"Probe","date":"2026-10-20","mark":"5,5","weight":"1.5","isConfirmed":true,"courseGrade":"5.3","comment":"gut"}]}""",
            events = """[{"id":"e1","startDate":"2026-11-02T08:15:00","endDate":"2026-11-02T09:00:00","text":"Mathematik","roomToken":"R201","teachers":["Herr Schmidt"],"courseName":"Mathematik","status":"confirmed","eventType":"lesson","color":"#4CAF50"}]""",
            absences = """[{"id":"a1","dateFrom":"2026-10-01","dateTo":"2026-10-01","hourFrom":"08:00","hourTo":"08:45","subject":"Französisch","reason":"Arzt","isExcused":false}]""",
            homework = """[{"id":"h1","title":"Aufgaben 12","description":"Buch S. 40","dueDate":"2026-11-03","courseName":"Mathematik"}]""",
            messages = """[{"id":"m1","title":"Elternabend","message":"Freitag 19 Uhr","date":"2026-11-01"}]""",
        )
        val snapshot = parseRawSnapshot(raw, "2026-11-01T12:00:00Z")
        assertEquals("Fabio Muster", snapshot.profile?.displayName)
        assertEquals("4a", snapshot.profile?.className)
        val grade = snapshot.grades.single()
        assertEquals(5.5, grade.mark)
        assertEquals(1.5, grade.weight)
        assertTrue(grade.confirmed)
        assertEquals("R201", snapshot.events.single().room)
        assertEquals(listOf("Herr Schmidt"), snapshot.events.single().teachers)
        assertFalse(snapshot.absences.single().excused)
        assertEquals("Aufgaben 12", snapshot.homework.single().title)
        assertEquals("Freitag 19 Uhr", snapshot.messages.single().body)
        val roundTrip = parseNormalizedSnapshot(snapshot.toNormalizedJson())
        assertEquals(snapshot.grades, roundTrip?.grades)
        assertEquals(snapshot.events, roundTrip?.events)
        assertEquals(snapshot.profile, roundTrip?.profile)
    }

    @Test
    fun marksOutsideTheSwissScaleAreIgnored() {
        assertNull(parseMark("27.5"))
        assertNull(parseMark(""))
        assertEquals(4.75, parseMark("4,75"))
    }
}

class GradeMathTest {
    private val marks = listOf(
        WeightedMark(5.5, 1.0, "Mathe"),
        WeightedMark(4.75, 1.0, "Englisch"),
        WeightedMark(5.25, 1.5, "Physik"),
    )

    @Test
    fun weightedAverageAndPluspunkteUseTheDistanceFromFour() {
        val average = weightedAverage(marks)
        assertNotNull(average)
        assertEquals(5.179, kotlin.math.round(average * 1000.0) / 1000.0)
        assertEquals(4.125, pluspunkte(marks))
        assertEquals("+4,13", formatPluspunkte(pluspunkte(marks)))
    }

    @Test
    fun wunschnoteReportsImpossibleAndAlreadyMet() {
        val tooHigh = wunschnote(marks, target = 5.5, nextWeight = 1.0)
        assertFalse(tooHigh.achievable)
        assertTrue(tooHigh.needed!! > 6.0)
        val reachable = wunschnote(marks, target = 5.0, nextWeight = 1.0)
        assertTrue(reachable.achievable)
        assertEquals(4.375, kotlin.math.round(reachable.needed!! * 1000.0) / 1000.0)
        assertEquals(4.5, reachable.neededHalf)
        val secured = wunschnote(marks, target = 4.0, nextWeight = 1.0)
        assertTrue(secured.alreadyMet)
        assertEquals(1.0, secured.needed)
        assertFalse(wunschnote(marks, target = 5.0, nextWeight = 0.0).achievable)
    }

    @Test
    fun hypotheticalMarksChangeOnlyThatCourse() {
        val grades = listOf(
            SchoolGrade("g1", "Mathematik", "math", "Mathematik", "Probe", "2026-10-01", 4.0, 1.0, true, null, ""),
        )
        val plain = courseSummaries(grades).single()
        assertEquals(4.0, plain.average)
        assertEquals(0.0, plain.pluspunkte)
        val withGuess = courseSummaries(grades, listOf(HypotheticalGrade("h", "math", "nächste", 6.0, 1.0))).single()
        assertEquals(5.0, withGuess.average)
        assertEquals(2.0, withGuess.pluspunkte)
    }
}

class SchulnetzDiffTest {
    private val lesson = AgendaEvent(
        "e1", "2026-11-02T08:15:00", "2026-11-02T09:00:00", "Mathematik", "", "R201",
        listOf("Herr Schmidt"), "math", "Mathematik", "confirmed", "lesson", "#3d8bfd", "",
    )

    @Test
    fun firstSnapshotIsSilentAndLaterChangesAreCategorised() {
        val next = SchulnetzSnapshot(
            grades = listOf(SchoolGrade("g1", "Mathematik", "math", "Mathematik", "Probe", "2026-10-20", 5.5, 1.0, true, null, "")),
            events = listOf(lesson),
            exams = listOf(lesson.copy(id = "x1", eventType = "exam", text = "Prüfung")),
            absences = listOf(SchoolAbsence("a1", "2026-10-01", "2026-10-01", "08:00", "08:45", "Französisch", "Arzt", false, false, "")),
            messages = listOf(SchoolMessage("m1", "Elternabend", "Freitag", "2026-11-01")),
        )
        assertTrue(diffSnapshots(null, next).isEmpty())
        val changes = diffSnapshots(SchulnetzSnapshot(), next)
        assertEquals(setOf("grade", "timetable", "exam", "absence", "event"), changes.map { it.category }.toSet())
        assertEquals("Neue Note", changes.first { it.category == "grade" }.title)
        val quiet = diffSnapshots(SchulnetzSnapshot(), next, NotifySettings(grades = false, timetable = false, exams = false, absences = false, events = false))
        assertTrue(quiet.isEmpty())
    }

    @Test
    fun cancellationSubstitutionAndRemovalAreTimetableChanges() {
        val previous = SchulnetzSnapshot(events = listOf(lesson, lesson.copy(id = "gone")))
        val cancelled = lesson.copy(status = "cancelled")
        val cover = lesson.copy(id = "e2", teachers = listOf("Frau Meier"), comment = "Vertretung")
        val next = SchulnetzSnapshot(events = listOf(cancelled, cover))
        val changes = diffSnapshots(previous, next)
        assertEquals("Lektion fällt aus", changes.first { it.id.startsWith("timetable:e1:") }.title)
        assertEquals("Lektion entfernt", changes.first { it.id == "timetable:gone:removed" }.title)
        val again = diffSnapshots(next, next)
        assertTrue(again.none { it.category == "timetable" })
    }
}

class SchulnetzOAuthTest {
    @Test
    fun pkceChallengeAndAuthorizeUrlMatchTheMobileClient() {
        val session = createPkceSession(AKSA_SCHULNETZ_BASE) { "a".repeat(it) }
        assertEquals(pkceChallenge("a".repeat(128)), session.challenge)
        assertTrue(session.authorizeUrl.startsWith("https://www.schulnetz-ag.ch/aksa/authorize.php?"))
        assertTrue(session.authorizeUrl.contains("client_id=$SCHULNETZ_CLIENT_ID"))
        assertTrue(session.authorizeUrl.contains("code_challenge_method=S256"))
        assertTrue(session.authorizeUrl.contains("redirect_uri="))
        assertTrue(session.authorizeUrl.contains("scope=openid%20"))
        val form = authorizationCodeForm("code", session.verifier, "0123456789abcdef01234567")
        assertTrue(form.startsWith("grant_type=authorization_code"))
        assertTrue(form.contains("redirect_uri="))
        assertFalse(form.contains("passwort"))
    }

    @Test
    fun microsoftCompositeStateFromTheAksaProbeMatches() {
        val received = "ef3823e5716990fbcbf1c9e93252e357cmVzcG9uc2VfdHlwZT1jb2RlJmNsaWVudF9pZD1wcHl5YlNobk1lckhkdEJRJnN0YXRlPXRlc3RzdGF0ZSZyZWRpcmVjdF91cmk9JnNjb3BlPW9wZW5pZCsmbm9uY2U9YWJjJmNvZGVfY2hhbGxlbmdlPUU5TWVsaG9hMk93dkZyRU1USmd1Q0hhb2VLMXQ4VVJXYnVHSlNzdHctY00mY29kZV9jaGFsbGVuZ2VfbWV0aG9kPVMyNTY="
        assertTrue(stateMatches("teststate", received))
        assertFalse(stateMatches("other", received))
        assertTrue(stateMatches("plain", "plain"))
        val callback = "https://www.schulnetz-ag.ch/aksa/authorize.php?code=abc&state=plain"
        assertEquals("abc" to "plain", authorizationCodeFromUrl(callback))
        val tokens = parseTokenJson("""{"access_token":"a","refresh_token":"r","expires_in":3600}""")
        assertEquals("r", tokens.refreshToken)
        assertEquals(3600L, tokens.expiresInSeconds)
    }
}

class SchulnetzPolicyTest {
    private val base = "https://www.schulnetz-ag.ch/aksa"

    @Test
    fun readsAreAllowedAndEnrolmentConfirmationAndWritesAreNot() {
        assertTrue(schulnetzCallAllowed("GET", "$base/rest/v1/me/grades"))
        assertTrue(schulnetzCallAllowed("GET", "$base/rest/v1/me/events?min_date=2026-11-01&max_date=2026-11-08"))
        assertTrue(schulnetzCallAllowed("GET", "$base/rest/v1/me/notifications/push"))
        assertTrue(schulnetzCallAllowed("GET", "$base/index.php?pageid=21411"))
        assertTrue(schulnetzCallAllowed("GET", "$base/index.php?pageid=1"))
        assertTrue(schulnetzCallAllowed("GET", "$base/scheduler_processor.php?view=week&pageid=22202&ansicht=schueleransicht"))
        assertTrue(schulnetzCallAllowed("POST", "$base/token.php", "grant_type=refresh_token&refresh_token=abc&client_id=x"))
        assertFalse(schulnetzCallAllowed("POST", "$base/rest/v1/me/absences", """{"reason":"x"}"""))
        assertFalse(schulnetzCallAllowed("DELETE", "$base/rest/v1/me/absences/1"))
        assertFalse(schulnetzCallAllowed("POST", "$base/rest/v1/me/notifications/token", """{"token":"fcm"}"""))
        assertFalse(schulnetzCallAllowed("GET", "$base/rest/v1/me/notifications/token"))
        assertFalse(schulnetzCallAllowed("GET", "$base/index.php?pageid=23118"))
        assertFalse(schulnetzCallAllowed("GET", "$base/index.php?pageid=9999"))
        assertFalse(schulnetzCallAllowed("GET", "$base/index.php?pageid=21311&action=confirm"))
        assertFalse(schulnetzCallAllowed("GET", "$base/rest/v1/me/absencesAndLateness/isAlreadyConfirmed"))
        assertFalse(schulnetzCallAllowed("POST", "$base/token.php", "grant_type=password&passwort=secret"))
        assertFalse(schulnetzCallAllowed("GET", "http://www.schulnetz-ag.ch/aksa/rest/v1/me"))
        assertFalse(loginWebViewAllowed("$base/index.php?pageid=23118", "www.schulnetz-ag.ch"))
        assertTrue(loginWebViewAllowed("https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize", "www.schulnetz-ag.ch"))
        assertEquals(base, normalizeSchoolBase("$base/"))
        assertNull(normalizeSchoolBase("https://evil.example/aksa"))
    }

    @Test
    fun leaseBlocksASecondDeviceUntilItExpires() {
        val first = claimRefreshLease(null, "phone-a", 1_000L, 500L)
        assertEquals("phone-a", first?.holderId)
        assertNull(claimRefreshLease(first, "phone-b", 1_200L, 500L))
        assertEquals("phone-b", claimRefreshLease(first, "phone-b", 1_600L, 500L)?.holderId)
        assertEquals("phone-a", claimRefreshLease(first, "phone-a", 1_200L, 500L)?.holderId)
        assertNull(localRefreshLease(serverLinked = true, existing = null, deviceId = "phone-a", nowMs = 0L))
    }

    @Test
    fun weekendOpensNextWeekAndCancellationSkipsTheNextLesson() {
        val saturday = LocalDate.of(2026, 10, 31)
        assertEquals(LocalDate.of(2026, 11, 2), timetableAnchor(saturday))
        assertEquals(LocalDate.of(2026, 11, 2), schoolWeek(timetableAnchor(saturday)).first())
        val zone = ZoneId.of("Europe/Zurich")
        val cancelled = AgendaEvent(
            "c", "2026-11-02T07:15:00Z", "2026-11-02T08:00:00Z", "Deutsch", "", "A1",
            emptyList(), "de", "Deutsch", "cancelled", "lesson", "", "",
        )
        val later = cancelled.copy(id = "n", status = "confirmed", start = "2026-11-02T08:15:00Z", end = "2026-11-02T09:00:00Z", courseName = "Mathematik")
        val now = Instant.parse("2026-11-02T07:00:00Z")
        assertEquals("n", nextUp(listOf(cancelled, later), now, zone)?.id)
        assertEquals(1, todayChanges(listOf(cancelled, later), LocalDate.of(2026, 11, 2), zone).size)
        assertEquals("#3d8bfd", subjectColor("Mathematik", "#3d8bfd"))
    }
}

class WebFallbackTest {
    @Test
    fun kontoauszugAndStartMessagesComeFromTheReadOnlyPages() {
        val konto = """
            <table id="tblKontoauszug">
            <tr><th>Datum</th><th>Bezeichnung</th><th>Betrag</th><th>Saldo</th></tr>
            <tr><td>01.11.2026</td><td>Mittagessen</td><td>-12.50</td><td>40.00</td></tr>
            </table>
        """.trimIndent()
        val line = parseKontoauszug(konto).single()
        assertEquals("01.11.2026", line.date)
        assertEquals("Mittagessen", line.label)
        assertEquals("-12.50", line.amount)
        assertEquals("40.00", line.balance)
        val start = """<div class="cls-start-mitteilung">Elternabend am Freitag</div><script>secret()</script>"""
        assertEquals(listOf("Elternabend am Freitag"), parseStartMessages(start))
        assertTrue(parseStartMessages("<html><body>Login</body></html>").isEmpty())
    }
}
