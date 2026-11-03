package ch.fasrv.fanotes.schulnetz

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.util.Collections
import kotlin.test.Test
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
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
    fun weightedAverageAndAargauPluspunkteRoundTheCourseMark() {
        val average = weightedAverage(marks)
        assertNotNull(average)
        assertEquals(5.179, kotlin.math.round(average * 1000.0) / 1000.0)
        assertEquals(5.0, roundToHalf(average))
        assertEquals(1.0, promotionPoints(roundToHalf(average)))
        assertEquals(4.5, roundToHalf(4.74))
        assertEquals(5.0, roundToHalf(4.75))
        assertEquals(1.5, promotionPoints(5.5))
        assertEquals(0.0, promotionPoints(4.0))
        assertEquals(-2.0, promotionPoints(3.0))
        assertEquals(-1.0, promotionPoints(3.5))
        assertEquals("+1,5", formatPluspunkte(1.5))
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
        assertEquals(4.0, plain.zeugnis)
        assertEquals(0.0, plain.pluspunkte)
        val withGuess = courseSummaries(grades, listOf(HypotheticalGrade("h", "math", "nächste", 6.0, 1.0))).single()
        assertEquals(5.0, withGuess.average)
        assertEquals(5.0, withGuess.zeugnis)
        assertEquals(1.0, withGuess.pluspunkte)
        val sport = courseSummaries(
            listOf(SchoolGrade("s", "Sport", "spo", "Sport", "Test", "2026-10-01", 5.5, 1.0, true, null, "")),
        ).single()
        assertFalse(sport.promotion)
        assertEquals(0.0, sport.pluspunkte)
        val empty = courseSummaries(listOf(SchoolGrade("e", "Biologie", "bio", "Biologie", "Durchschnitt", "", null, 1.0, true, null, "")))
        assertTrue(empty.isEmpty())
        val totals = promotionTotals(listOf(withGuess, sport, courseSummaries(listOf(SchoolGrade("d", "Deutsch", "de", "Deutsch", "Probe", "2026-10-01", 3.0, 1.0, true, null, ""))).single()))
        assertEquals(1.0, totals.plus)
        assertEquals(-2.0, totals.minus)
        assertEquals(-1.0, totals.total)
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
        val moved = diffSnapshots(SchulnetzSnapshot(events = listOf(lesson)), SchulnetzSnapshot(events = listOf(lesson.copy(room = "R202"))))
        assertEquals("Raum geändert", moved.single { it.category == "timetable" }.title)
        val shifted = diffSnapshots(SchulnetzSnapshot(events = listOf(lesson)), SchulnetzSnapshot(events = listOf(lesson.copy(start = "2026-11-02T09:15:00", end = "2026-11-02T10:00:00"))))
        assertEquals("Zeit geändert", shifted.single { it.category == "timetable" }.title)
        assertEquals("Neue Note", diffSnapshots(SchulnetzSnapshot(), SchulnetzSnapshot(grades = listOf(SchoolGrade("g2", "Chemie", "che", "Chemie", "Test", "2026-11-01", 6.0, 1.0, true, null, "")))).single { it.category == "grade" }.title)
    }

    @Test
    fun courseAverageRowsAreNotGradesAndDropSilently() {
        val exam = SchoolGrade("exam:che", "Chemie", "che", "Chemie", "1. Prüfung", "2026-09-17", 4.2, 1.0, true, 4.2, "")
        val average = SchoolGrade("course:che:4.2", "Chemie", "che", "Chemie", "Durchschnitt", "", 4.2, 1.0, true, 4.2, "")
        val summaries = courseSummaries(listOf(average, exam))
        assertEquals(1, summaries.single().marks.size)
        assertEquals(4.2, summaries.single().average)
        assertEquals(1.0, summaries.single().weight)
        val stored = parseNormalizedSnapshot(
            SchulnetzSnapshot(fetchedAt = "2026-11-02T12:00:00Z", grades = listOf(average, exam)).toNormalizedJson(),
        )
        assertEquals(listOf(exam), stored?.grades)
        val changes = diffSnapshots(SchulnetzSnapshot(grades = listOf(average, exam)), SchulnetzSnapshot(grades = listOf(exam)))
        assertTrue(changes.none { it.category == "grade" })
        assertTrue(isSummaryGradeTitle("Aktueller Durchschnitt"))
        assertTrue(isSummaryGradeTitle("Ø"))
        assertFalse(isSummaryGradeTitle("1. Prüfung"))
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
        assertTrue(schulnetzCallAllowed("GET", "$base/scheduler_processor.php?view=week&pageid=21312&ansicht=klassenuebersicht&showOnlyThisClass=-1"))
        assertFalse(schulnetzCallAllowed("GET", "$base/scheduler_processor.php?pageid=22202&action=raster&rasterid=0"))
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

class WebSessionTest {
    private val start = """
        <main>
          <h1>Start</h1>
          <div class="cls-start-mitteilung">Elternabend am Freitag</div>
          <a href="index.php?pageid=21311&amp;id=abc123&amp;transid=a1b2c3">Noten</a>
          <a href="index.php?pageid=21111&amp;id=abc123&amp;transid=a1b2c3">Absenzen</a>
        </main>
    """.trimIndent()

    @Test
    fun aksaLoginUsesTheWebsiteAndNotTheBrokenMobileRedirect() {
        assertTrue(usesWebsiteSession(AKSA_SCHULNETZ_BASE))
        assertEquals("https://www.schulnetz-ag.ch/aksa/index.php?pageid=1", webLoginUrl(AKSA_SCHULNETZ_BASE))
        assertFalse(webLoginUrl(AKSA_SCHULNETZ_BASE).contains("authorize.php"))
        assertFalse(loginWebViewAllowed("https://www.schulnetz-ag.ch/aksa/authorize.php", "www.schulnetz-ag.ch"))
        assertTrue(loginWebViewAllowed("https://www.schulnetz-ag.ch/aksa/", "www.schulnetz-ag.ch"))
        assertTrue(loginWebViewAllowed("https://login.microsoftonline.com/common/oauth2/v2.0/authorize", AKSA_SCHULNETZ_BASE))
        assertFalse(schulnetzCallAllowed("GET", "https://www.schulnetz-ag.ch/aksa/index.php?pageid=9999"))
        assertFalse(schulnetzCallAllowed("GET", "https://www.schulnetz-ag.ch/aksa/index.php?pageid=1&action=global_logout"))
    }

    @Test
    fun landingSessionAndIpOrInactivityForceAFreshLogin() {
        assertTrue(isLoggedInLanding("https://www.schulnetz-ag.ch/aksa/", start))
        val session = extractWebSession("https://www.schulnetz-ag.ch/aksa/", start, AKSA_SCHULNETZ_BASE)
        assertEquals("abc123", session?.id)
        assertEquals("a1b2c3", session?.transid)
        assertEquals(
            SessionProblem.IP_REJECTED,
            sessionProblem("https://www.schulnetz-ag.ch/aksa/loginto.php?pageid=1", "Ihre IP-Adresse wurde vom System zurückgewiesen"),
        )
        assertEquals(
            SessionProblem.INACTIVITY,
            sessionProblem("https://www.schulnetz-ag.ch/aksa/loginto.php?pageid=1&mode=5", "Inaktivitätslimit überschritten"),
        )
        assertFalse(isLoggedInLanding("https://www.schulnetz-ag.ch/aksa/loginto.php?pageid=1&mode=5", "Inaktivitätslimit überschritten"))
        assertEquals("ESTSAUTH=1", stripPhpSession("PHPSESSID=phone; ESTSAUTH=1"))
    }

    @Test
    fun microsoftSignInPageIsLoginRequiredNotAParseError() {
        val html = """
            <html><head><title>Sign in to your account</title></head><body>
            <script>
            ${'$'}Config={"sCompanyDisplayName":"Alte Kantonsschule Aarau","sErrorCode":"50058","urlPost":"https://login.microsoftonline.com/common/login","pgid":"ConvergedSignIn"};
            </script>
            </body></html>
        """.trimIndent()
        val url = "https://login.microsoftonline.com/8c2df54b-02dc-4a78-809d-8a025372e6c4/oauth2/v2.0/authorize?redirect_uri=https%3A%2F%2Fwww.schulnetz-ag.ch%2Faksa%2F"
        assertTrue(microsoftLoginRequired(url, html))
        assertEquals(SessionProblem.INTERACTIVE, sessionProblem(url, html))
        assertEquals(SessionProblem.INTERACTIVE, sessionProblem("https://www.schulnetz-ag.ch/aksa/index.php?pageid=21111", html))
        val read = readAbsencesPage(html)
        assertEquals("Bei Schulnetz neu anmelden", read.error)
        assertFalse(read.error!!.contains("nicht gelesen"))
        assertTrue(read.html.isEmpty())
        assertEquals("converged-sign-in", classifySchulnetzPage("https://www.schulnetz-ag.ch/aksa/index.php?pageid=21111", html).rule)
    }

    @Test
    fun loggedInPageWithMenuLogoutLinksStaysOk() {
        val html = """
            <html><body>
              <nav>
                <a href="index.php?pageid=1">Anmelden</a>
                <a href="loginto.php?pageid=1&amp;mode=5">Abmelden</a>
                <a href="loginto.php?pageid=1&amp;mode=17">Login nicht erfolgreich</a>
                <a href="index.php?pageid=1&amp;action=global_logout">Logout</a>
                <span>Sitzung</span>
                <form><input name="login"><input name="passwort" type="password"></form>
              </nav>
              <main>
                <h1>Noten</h1>
                <a href="index.php?pageid=21311&amp;id=abc123&amp;transid=a1b2c3">Noten</a>
                <a href="index.php?pageid=21111&amp;id=abc123&amp;transid=a1b2c3">Absenzen</a>
                <a href="index.php?pageid=21200&amp;id=abc123&amp;transid=a1b2c3">Agenda</a>
                <a href="index.php?pageid=22202&amp;id=abc123&amp;transid=a1b2c3">Stundenplan</a>
              </main>
              <script>${'$'}Config={"urlPost":"https://example.invalid/login"};</script>
            </body></html>
        """.trimIndent()
        val url = "https://www.schulnetz-ag.ch/aksa/index.php?pageid=21311&id=abc123&transid=a1b2c3"
        val classified = classifySchulnetzPage(url, html)
        assertEquals(SessionProblem.NONE, classified.problem)
        assertEquals("ok", classified.rule)
        assertEquals(SessionProblem.NONE, sessionProblem(url, html))
        assertTrue(isLoggedInLanding("https://www.schulnetz-ag.ch/aksa/", html))
        assertEquals(
            "https://www.schulnetz-ag.ch/aksa/index.php?pageid=21311&id=abc123&transid=a1b2c3",
            linkedPageUrl(html, "21311", AKSA_SCHULNETZ_BASE),
        )
        assertNull(linkedPageUrl(html, "9999", AKSA_SCHULNETZ_BASE))
        assertEquals(SessionProblem.LOGIN_WALL, sessionProblem("https://www.schulnetz-ag.ch/aksa/", "<html><body>Bitte warten</body></html>"))
        assertEquals("missing-page-id", classifySchulnetzPage("https://www.schulnetz-ag.ch/aksa/", "<html><body>Bitte warten</body></html>").rule)
        val handshake = "https://www.schulnetz-ag.ch/aksa/loginto.php?mode=17&lang="
        assertEquals(SessionProblem.OAUTH_FAILED, sessionProblem(handshake, "Login nicht erfolgreich. Bitte versuchen Sie es erneut."))
        assertEquals("url-mode-17", classifySchulnetzPage(handshake, "").rule)
        assertFalse(bareOauthAllowed(hasSessionId = true, signedOut = false))
        assertTrue(bareOauthAllowed(hasSessionId = true, signedOut = true))
        assertTrue(bareOauthAllowed(hasSessionId = false, signedOut = false))
        assertEquals(
            "https://www.schulnetz-ag.ch/aksa/index.php?pageid=1&id=3cbca9162e104cac&transid=a28e52",
            startPageUrl(AKSA_SCHULNETZ_BASE, "3cbca9162e104cac", "a28e52", signedOut = false),
        )
        assertEquals(webLoginUrl(AKSA_SCHULNETZ_BASE), startPageUrl(AKSA_SCHULNETZ_BASE, "3cbca9162e104cac", "a28e52", signedOut = true))
    }

    @Test
    fun sessionIdComesFromTheLoadedPageNotAStrayLink() {
        val html = """
            <a href="index.php?pageid=21311&amp;id=bc9a6d042b6b9214&amp;transid=6a0734">alt</a>
            <a href="index.php?pageid=21311&amp;id=3cbca9162e104cac&amp;transid=a28e52">Noten</a>
            <a href="index.php?pageid=21111&amp;id=3cbca9162e104cac&amp;transid=a28e52">Absenzen</a>
            <a href="index.php?pageid=21200&amp;id=3cbca9162e104cac&amp;transid=bcfb2e">Agenda</a>
        """.trimIndent()
        val chosen = sessionIdsFromPage("https://www.schulnetz-ag.ch/aksa/", html)
        assertEquals("3cbca9162e104cac", chosen?.id)
        assertEquals("bcfb2e", chosen?.transid)
        assertTrue(chosen!!.source.startsWith("page-links:"))
        val fromUrl = sessionIdsFromPage(
            "https://www.schulnetz-ag.ch/aksa/index.php?pageid=1&id=3cbca9162e104cac&transid=a28e52",
            html,
        )
        assertEquals("final-url", fromUrl?.source)
        assertEquals("a28e52", fromUrl?.transid)
        assertEquals(
            "https://www.schulnetz-ag.ch/aksa/index.php?pageid=21311&id=3cbca9162e104cac&transid=a28e52",
            linkedPageUrl(html, "21311", AKSA_SCHULNETZ_BASE, "3cbca9162e104cac"),
        )
    }

    @Test
    fun logRedactionKeepsSessionIdsAndDropsSecrets() {
        val raw = "https://www.schulnetz-ag.ch/aksa/index.php?pageid=1&id=abc123&transid=a1b2c3&code=secret&flowToken=flow-secret Cookie: PHPSESSID=phone; ESTSAUTHPERSISTENT=persist Authorization: Bearer tok-1"
        val redacted = redactSchulnetzSecrets(raw)
        assertTrue(redacted.contains("id=abc123"))
        assertTrue(redacted.contains("transid=a1b2c3"))
        assertFalse(redacted.contains("secret"))
        assertFalse(redacted.contains("phone"))
        assertFalse(redacted.contains("persist"))
        assertFalse(redacted.contains("tok-1"))
        assertTrue(redacted.contains("code=[redacted]"))
        assertTrue(redacted.contains("names=PHPSESSID,ESTSAUTHPERSISTENT"))
    }

    @Test
    fun gradesAbsencesSchedulerAndIcsMatchSchulnetzMarkup() {
        val grades = """
            <main>
              <table>
                <tr><td><b>MA-4a-He</b><br>Mathematik</td><td>5.25</td><td>bestätigt</td></tr>
                <tr><td>
                  <table>
                    <tr><td>Einzelprüfungen</td></tr>
                    <tr><td></td><td>20.10.2026</td><td>Probe</td><td>5.5</td><td>1</td><td>5.0</td></tr>
                  </table>
                </td></tr>
              </table>
            </main>
        """.trimIndent()
        val parsed = readGradesPage(grades)
        assertEquals(null, parsed.error)
        assertEquals(5.5, parsed.value.single().mark)
        assertEquals("Mathematik", parsed.value.single().course)
        assertEquals("2026-10-20", parsed.value.single().date)
        val broken = readGradesPage("<html><body>etwas anderes</body></html>")
        assertEquals("Noten: Seite geladen, aber nicht lesbar", broken.error)
        val mdl = """
            <table class="mdl-data-table">
              <thead><tr><th>Fach</th><th>Datum</th><th>Thema</th><th>Note</th><th>Gewichtung</th></tr></thead>
              <tbody><tr><td>Mathematik</td><td>20.10.2026</td><td>Probe</td><td>5.5</td><td>1</td></tr></tbody>
            </table>
        """.trimIndent()
        val headerGrade = readGradesPage(mdl)
        assertEquals(null, headerGrade.error)
        assertEquals(5.5, headerGrade.value.single().mark)
        assertEquals("Mathematik", headerGrade.value.single().course)
        val absenceTable = """
            <table class="mdl-data-table">
              <tr><th>Datum</th><th>Zeit</th><th>Lektion</th><th>Grund</th><th>Status</th></tr>
              <tr><td>01.10.2026</td><td>08:15</td><td>Mathematik</td><td>Arzt</td><td>offen</td></tr>
            </table>
        """.trimIndent()
        val absenceRow = readAbsencesPage(absenceTable).value.single()
        assertEquals("Arzt", absenceRow.reason)
        assertEquals("Mathematik", absenceRow.subject)
        val examTable = """
            <table><tr><th>Datum</th><th>Kurs</th><th>Thema</th></tr>
            <tr><td>12.11.2026</td><td>Englisch</td><td>Vokabeltest</td></tr></table>
        """.trimIndent()
        assertEquals("Vokabeltest", readExamsPage(examTable).value.single().text)
        assertTrue(describeTables(mdl).contains("tables=1"))
        val plan = """<script>scheduler.load("scheduler_processor.php?view=week&ansicht=schueleransicht&id=abc123&transid=a1b2c3&pageid=22202");</script>"""
        val found = findSchedulerUrl(plan, AKSA_SCHULNETZ_BASE)
        assertTrue(found!!.contains("view=week"))
        assertFalse(found.contains("action=raster"))
        assertEquals(
            "https://www.schulnetz-ag.ch/aksa/scheduler_processor.php?view=week&curr_date=2026-11-02&min_date=2026-11-02&max_date=2026-11-09&ansicht=schueleransicht&id=abc&transid=def&pageid=22202&timeshift=-60",
            schedulerUrl(AKSA_SCHULNETZ_BASE, "abc", "def", "2026-11-02", "2026-11-02", "2026-11-09"),
        )

        val absences = """
            <main><table>
              <tr><th>Datum von</th><th>Datum bis</th><th>Grund</th><th>Info</th><th>Frist</th><th>EAE</th><th>Entschuldigt</th><th>Lektionen</th><th>Kommentar</th><th>Trainer</th><th>Kenntnis</th></tr>
              <tr><td>01.10.2026</td><td>01.10.2026</td><td>Arzt</td><td></td><td></td><td>offen</td><td>Nein</td><td>1</td><td></td><td></td><td></td></tr>
            </table></main>
        """.trimIndent()
        val absence = readAbsencesPage(absences).value.single()
        assertEquals("Arzt", absence.reason)
        assertFalse(absence.excused)

        val xml = """
            <data>
              <event id="e9">
                <start_date>2026-11-02 08:15</start_date>
                <end_date>2026-11-02 09:00</end_date>
                <text>Mathematik</text>
                <zimmerkuerzel>R201</zimmerkuerzel>
                <lehrerkuerzelname>Schmidt</lehrerkuerzelname>
                <kurskuerzel>MATH</kurskuerzel>
                <kommentar>fällt aus</kommentar>
              </event>
            </data>
        """.trimIndent()
        val lesson = parseSchedulerXml(xml).single()
        assertEquals("2026-11-02T08:15:00", lesson.start)
        assertEquals("R201", lesson.room)
        assertTrue(lesson.isCancelled())
        val ics = parseIcs("BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:u1\nDTSTART:20261103T101500\nDTEND:20261103T110000\nSUMMARY:Englisch\nLOCATION:A12\nEND:VEVENT\nEND:VCALENDAR")
        assertEquals("Englisch", ics.single().courseName)
        assertEquals("A12", ics.single().room)
        assertEquals("https://www.schulnetz-ag.ch/aksa/abo.ics", findIcalUrl("<script>icalAbo('abo.ics')</script>", AKSA_SCHULNETZ_BASE))
    }
}

class SchulnetzGateTest {
    @Test
    fun loginTriggeredDuringRefreshIsQueued() = runBlocking {
        val gate = SchulnetzGate()
        val order = Collections.synchronizedList(mutableListOf<String>())
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val refresh = async(Dispatchers.Default) {
            gate.exclusive("refresh:test") {
                order += "refresh-start"
                started.complete(Unit)
                release.await()
                order += "refresh-end"
            }
        }
        started.await()
        val login = async(Dispatchers.Default) {
            gate.exclusive("visible-login:heute-button") {
                order += "login"
            }
        }
        delay(200)
        assertFalse(order.contains("login"))
        assertEquals("refresh:test", gate.holder)
        assertTrue(gate.isLocked)
        release.complete(Unit)
        refresh.await()
        login.await()
        assertEquals(listOf("refresh-start", "refresh-end", "login"), order.toList())
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
