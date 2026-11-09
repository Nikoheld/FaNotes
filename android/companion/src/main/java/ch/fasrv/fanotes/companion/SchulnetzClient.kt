package ch.fasrv.fanotes.companion

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.escapeJson
import ch.fasrv.fanotes.json.parseJson
import ch.fasrv.fanotes.schulnetz.AKSA_SCHULNETZ_BASE
import ch.fasrv.fanotes.schulnetz.NotifySettings
import ch.fasrv.fanotes.schulnetz.notifySettingsFromStored
import ch.fasrv.fanotes.schulnetz.SCHULNETZ_API_PATH
import ch.fasrv.fanotes.schulnetz.SCHULNETZ_CLIENT_ID
import ch.fasrv.fanotes.schulnetz.SCHULNETZ_REFERER
import ch.fasrv.fanotes.schulnetz.SCHULNETZ_USER_AGENT
import ch.fasrv.fanotes.schulnetz.SchulnetzRaw
import ch.fasrv.fanotes.schulnetz.SchulnetzSnapshot
import ch.fasrv.fanotes.schulnetz.SchulnetzTokens
import ch.fasrv.fanotes.schulnetz.SessionProblem
import ch.fasrv.fanotes.schulnetz.WebSession
import ch.fasrv.fanotes.schulnetz.authorizationCodeForm
import ch.fasrv.fanotes.schulnetz.findIcalUrl
import ch.fasrv.fanotes.schulnetz.keepStoredRead
import ch.fasrv.fanotes.schulnetz.pageToken
import ch.fasrv.fanotes.schulnetz.tableCount
import ch.fasrv.fanotes.schulnetz.terminlisteRow
import ch.fasrv.fanotes.schulnetz.terminlisteShouldFetch
import ch.fasrv.fanotes.schulnetz.eventQueryWindow
import ch.fasrv.fanotes.schulnetz.examSchedulerUrl
import ch.fasrv.fanotes.schulnetz.findSchedulerUrl
import ch.fasrv.fanotes.schulnetz.icalBodyUsable
import ch.fasrv.fanotes.schulnetz.mergeById
import ch.fasrv.fanotes.schulnetz.mondaysBetween
import ch.fasrv.fanotes.schulnetz.overlayDated
import ch.fasrv.fanotes.schulnetz.overlayLessons
import ch.fasrv.fanotes.schulnetz.parseWeekSpan
import ch.fasrv.fanotes.schulnetz.confirmedLessonStamps
import ch.fasrv.fanotes.schulnetz.planWeekFetches
import ch.fasrv.fanotes.schulnetz.schedulerBodyUsable
import ch.fasrv.fanotes.schulnetz.schedulerWeekLoaded
import ch.fasrv.fanotes.schulnetz.spanOfEvents
import ch.fasrv.fanotes.schulnetz.weekMonday
import ch.fasrv.fanotes.schulnetz.classifySchulnetzPage
import ch.fasrv.fanotes.schulnetz.isForcedLogoutUrl
import ch.fasrv.fanotes.schulnetz.DiagnosticTrace
import ch.fasrv.fanotes.schulnetz.httpResultCategory
import ch.fasrv.fanotes.schulnetz.linkedPageUrl
import ch.fasrv.fanotes.schulnetz.pageUrl
import ch.fasrv.fanotes.schulnetz.redactSchulnetzSecrets
import ch.fasrv.fanotes.schulnetz.sessionIdsFromPage
import ch.fasrv.fanotes.schulnetz.startPageUrl
import ch.fasrv.fanotes.schulnetz.isExamLike
import ch.fasrv.fanotes.schulnetz.isLesson
import ch.fasrv.fanotes.schulnetz.parseIcs
import ch.fasrv.fanotes.schulnetz.parseSchedulerNote
import ch.fasrv.fanotes.schulnetz.parseRenderedTimetable
import ch.fasrv.fanotes.schulnetz.parseStartAppointments
import ch.fasrv.fanotes.schulnetz.parseStartRecentGrades
import ch.fasrv.fanotes.schulnetz.parseTerminliste
import ch.fasrv.fanotes.schulnetz.parseTimetableHtml
import ch.fasrv.fanotes.schulnetz.parseKontoauszug
import ch.fasrv.fanotes.schulnetz.parseSchedulerXml
import ch.fasrv.fanotes.schulnetz.parseStartMessages
import ch.fasrv.fanotes.schulnetz.parseTokenJson
import ch.fasrv.fanotes.schulnetz.readAbsencesPage
import ch.fasrv.fanotes.schulnetz.readExamsPage
import ch.fasrv.fanotes.schulnetz.readGradesPage
import ch.fasrv.fanotes.schulnetz.readTerminliste
import ch.fasrv.fanotes.schulnetz.refreshTokenForm
import ch.fasrv.fanotes.schulnetz.schedulerUrl
import ch.fasrv.fanotes.schulnetz.terminlisteNextUrl
import ch.fasrv.fanotes.schulnetz.weekMondayKey
import ch.fasrv.fanotes.schulnetz.WeekSpan
import ch.fasrv.fanotes.schulnetz.schulnetzCallAllowed
import ch.fasrv.fanotes.schulnetz.sessionProblemText
import ch.fasrv.fanotes.schulnetz.toNormalizedJson
import ch.fasrv.fanotes.schulnetz.webReadAllowed
import ch.fasrv.fanotes.sync.SYNC_ORIGIN
import ch.fasrv.fanotes.sync.SyncSession
import android.os.Looper
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.time.LocalDate
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

class SchulnetzHttpException(val status: Int, message: String) : Exception(message)

/** Server identity for Schulnetz. Guest identities have no email or password. */
data class SchoolAuth(
    val accountId: String,
    val token: String,
    val guest: Boolean = false,
)

fun SyncSession.asSchoolAuth() = SchoolAuth(accountId, token, guest = false)

/** Result of one authenticated delivery probe. The correlation joins the server clock to the device. */
data class ProbeAck(
    val serverAt: String,
    val correlation: String,
    val scenario: String,
    val count: Int,
    val probeRemaining: Int = -1,
    val clearRemaining: Int = -1,
)

/** Result of a device-scoped probe cleanup. [failed] means the file could not be updated. */
data class ProbeClear(val removed: Int, val failed: Boolean)

data class WebBundle(
    val snapshot: SchulnetzSnapshot,
    val problem: SessionProblem,
    val debugHtml: String,
    val session: WebSession,
    val okPages: Int = 0,
    val oauthPage: String? = null,
    val captures: Map<String, String> = emptyMap(),
)

data class SchulnetzLinkState(
    val linked: Boolean = false,
    val baseUrl: String = AKSA_SCHULNETZ_BASE,
    val displayName: String = "",
    val needsReauth: Boolean = false,
    val lastPollAt: String = "",
    val lastError: String = "",
    val revision: Long = 0,
    val topic: String = "",
    val pushServer: String = "",
    val pushUrl: String = "",
    val settings: NotifySettings = NotifySettings(),
    val reachable: Boolean = true,
)

class SchulnetzClient(
    private val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(40, TimeUnit.SECONDS)
        .writeTimeout(40, TimeUnit.SECONDS)
        .build(),
) {
    /** Timetable HTML and XML are parsed here so a large page cannot run on the UI thread. */
    private val timetableParse = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "schulnetz-parse").apply { isDaemon = true }
    }

    /** Bound used by the FCM callback so a push finishes inside a few seconds. */
    private val quickHttp: OkHttpClient = http.newBuilder()
        .callTimeout(6, TimeUnit.SECONDS)
        .connectTimeout(3, TimeUnit.SECONDS)
        .readTimeout(5, TimeUnit.SECONDS)
        .build()
    fun exchangeCode(baseUrl: String, code: String, verifier: String, deviceId: String): SchulnetzTokens =
        token(baseUrl, authorizationCodeForm(code, verifier, deviceId))

    fun refresh(baseUrl: String, refreshToken: String, deviceId: String): SchulnetzTokens =
        token(baseUrl, refreshTokenForm(refreshToken, deviceId))

    fun fetchRaw(baseUrl: String, accessToken: String, previous: SchulnetzSnapshot? = null): SchulnetzRaw {
        val root = baseUrl.trimEnd('/')
        val today = LocalDate.now()
        fun get(path: String): String? {
            val url = "$root$path"
            if (!schulnetzCallAllowed("GET", url)) return null
            val (status, body) = call("GET", url, schoolHeaders(accessToken, path.contains("index.php")), null)
            if (status == 401) throw SchulnetzHttpException(401, "Die Schulnetz-Sitzung ist abgelaufen.")
            return body.takeIf { status in 200..299 }
        }
        var spanStart = previous?.weekSpanStart.orEmpty()
        var spanEnd = previous?.weekSpanEnd.orEmpty()
        val planHtml = if ((spanStart.isBlank() || spanEnd.isBlank()) && previous?.weekFetched.isNullOrEmpty()) get("/index.php?pageid=22202") else null
        if (!planHtml.isNullOrBlank()) {
            parseWeekSpan(planHtml)?.let { span ->
                spanStart = span.start.toString()
                spanEnd = span.end.toString()
            }
        }
        val window = eventQueryWindow(spanStart, spanEnd, previous?.weekFetched.orEmpty(), previous?.icalFetchedAt.orEmpty(), today, java.time.Instant.now())
        val events = get("/rest/v1/me/events?min_date=${window.min}&max_date=${window.max}")
        return SchulnetzRaw(
            me = get("/rest/v1/me"),
            grades = get("/rest/v1/me/grades"),
            events = events,
            exams = get("/rest/v1/me/exams"),
            absences = get("/rest/v1/me/absences"),
            homework = get("/rest/v1/me/notes/homework"),
            messages = get("/rest/v1/me/notifications/push"),
            vacations = get("/rest/v1/me/vacations"),
            lateness = get("/rest/v1/me/lateness"),
            kontoHtml = get("/index.php?pageid=21411"),
            startHtml = get("/index.php?pageid=1"),
            eventMin = window.min.toString(),
            eventMax = window.max.toString(),
            weekSpanStart = spanStart,
            weekSpanEnd = spanEnd,
            eventsFetched = !events.isNullOrBlank(),
        )
    }

    fun status(session: SchoolAuth): SchulnetzLinkState {
        val (code, body) = fanotes("GET", "/status", session, null)
        if (code == 404) return SchulnetzLinkState(reachable = false)
        if (code !in 200..299) throw SchulnetzHttpException(code, errorMessage(body, code))
        return parseStatus(body)
    }

    fun linkWeb(session: SchoolAuth, baseUrl: String, deviceId: String, userAgent: String, ssoCookies: Map<String, String>, displayName: String): SchulnetzLinkState {
        val cookies = ssoCookies.entries.joinToString(",") { (host, value) -> "${escapeJson(host)}:${escapeJson(value)}" }
        val payload = buildString {
            append("{\"mode\":\"web\",\"baseUrl\":").append(escapeJson(baseUrl))
            append(",\"deviceId\":").append(escapeJson(deviceId))
            append(",\"userAgent\":").append(escapeJson(userAgent))
            append(",\"displayName\":").append(escapeJson(displayName))
            append(",\"ssoCookies\":{").append(cookies).append("}}")
        }
        val (code, body) = fanotes("PUT", "/link", session, payload)
        if (code !in 200..299) throw SchulnetzHttpException(code, errorMessage(body, code))
        return parseStatus(body)
    }

    fun uploadSnapshot(session: SchoolAuth, snapshot: SchulnetzSnapshot) {
        val (code, body) = fanotes("PUT", "/snapshot", session, snapshot.toNormalizedJson())
        if (code !in 200..299 && code != 404) throw SchulnetzHttpException(code, errorMessage(body, code))
    }

    fun fetchWeb(baseUrl: String, session: WebSession, loader: (String) -> LoadedPage, signedOut: Boolean = false, trace: (String) -> Unit = {}, previous: SchulnetzSnapshot? = null, context: String = ""): WebBundle {
        val root = baseUrl.trimEnd('/')
        var id = session.id
        var transid = session.transid
        val errors = mutableListOf<String>()
        var debug = ""
        var sawSessionProblem = false
        var oauthPage: String? = null
        var okPages = 0
        var planNote = ""
        var planError = ""
        val captured = linkedMapOf<String, String>()
        fun remember(name: String, page: LoadedPage) {
            if (name == "stundenplan") planNote = page.note
            if (page.body.isNotBlank()) {
                debug = page.body
                captured[name] = page.body
                if (!page.body.trimStart().startsWith("<?xml")) trace("markup $name tables=${tableCount(page.body)}")
            }
            trace("page $name")
        }
        fun adopt(page: LoadedPage) {
            val found = sessionIdsFromPage(page.finalUrl, page.body) ?: return
            trace("session ids source=${found.source}")
            id = found.id
            transid = found.transid
        }
        fun get(url: String, label: String, pageId: String): String {
            val started = System.nanoTime()
            val mainThread = Looper.myLooper() == Looper.getMainLooper()
            val pageName = pageToken(url)
            fun duration() = (System.nanoTime() - started) / 1_000_000
            if (isForcedLogoutUrl(url) || !webReadAllowed(url)) {
                trace("blocked $label page=$pageName mainThread=$mainThread $context")
                errors += "Blockiert"
                if (label == "stundenplan") planError = "blocked"
                return ""
            }
            trace("request $label page=$pageName mainThread=$mainThread $context")
            val page = try {
                loader(url)
            } catch (error: Exception) {
                trace("exception $label ${error.javaClass.simpleName} durationMs=${duration()} timeout=false cancelled=false mainThread=$mainThread $context")
                errors += "Laden fehlgeschlagen"
                if (label == "stundenplan") planError = error.javaClass.simpleName
                return ""
            }
            val classified = classifySchulnetzPage(page.finalUrl.ifBlank { url }, page.body)
            val timedOut = page.error == "timeout"
            val cancelled = page.error == "cancelled" || page.error == "render-process-gone" || page.error == "main-thread"
            trace("result $label status=${page.status} rule=${classified.rule} class=${classified.problem} bytes=${page.body.length} durationMs=${duration()} timeout=$timedOut cancelled=$cancelled mainThread=$mainThread final=${pageToken(page.finalUrl)} $context")
            if (label == "stundenplan") {
                planError = page.error.orEmpty()
                trace("stundenplan bytes=${page.body.length} tables=${tableCount(page.body)} timeout=$timedOut cancelled=$cancelled $context")
            }
            remember(label, page)
            if (classified.problem == SessionProblem.OAUTH_FAILED) {
                oauthPage = pageId
                errors += sessionProblemText(classified.problem)
                if (label == "stundenplan" && planError.isBlank()) planError = classified.problem.name
                return ""
            }
            if (classified.problem != SessionProblem.NONE) {
                sawSessionProblem = true
                errors += sessionProblemText(classified.problem)
                if (label == "stundenplan" && planError.isBlank()) planError = classified.problem.name
                return ""
            }
            if (page.error != null || page.status !in 200..299 || page.body.isBlank()) {
                errors += "Laden fehlgeschlagen"
                return ""
            }
            okPages += 1
            adopt(page)
            return page.body
        }
        val pages = linkedMapOf<String, String>()
        pages["1"] = get(startPageUrl(root, id, transid, signedOut), "start", "1")
        val order = listOf(
            "21311" to "noten",
            "21111" to "absenzen",
            "21411" to "konto",
            "21200" to "agenda",
            "22202" to "stundenplan",
            "22108" to "termine",
            "21312" to "pruefungen",
        )
        for ((pageId, label) in order) {
            if (sawSessionProblem || oauthPage != null) break
            val parents = when (pageId) {
                "22202", "22108", "21312" -> listOf("21200", "1")
                else -> listOf("1")
            }
            val fromLink = parents.firstNotNullOfOrNull { linkedPageUrl(pages[it].orEmpty(), pageId, root, id) }
            val url = fromLink ?: if (id.isBlank() || transid.isBlank()) "" else pageUrl(root, pageId, id, transid)
            if (url.isBlank()) {
                trace("stop $label, no session id to build a url")
                sawSessionProblem = true
                errors += sessionProblemText(SessionProblem.LOGIN_WALL)
                break
            }
            pages[pageId] = get(url, label, pageId)
        }
        // The start page contains recent marks, not a complete grade book.
        val grades = readGradesPage(pages["21311"].orEmpty())
        val absences = readAbsencesPage(pages["21111"].orEmpty())
        val exams = readExamsPage(pages["21312"].orEmpty())
        val terminePages = mutableListOf(pages["22108"].orEmpty())
        if (oauthPage == null && !sawSessionProblem) {
            val seenTermine = parseTerminliste(pages["22108"].orEmpty()).map { it.id }.toMutableSet()
            val seenRows = mutableSetOf<Int>()
            var currentRow = 0
            var next = terminlisteNextUrl(pages["22108"].orEmpty(), root, currentRow)
            var guard = 0
            while (!next.isNullOrBlank() && guard < 8) {
                val row = terminlisteRow(next) ?: break
                if (!terminlisteShouldFetch(next, currentRow, seenRows)) break
                seenRows += row
                val body = get(next, "termine", "22108")
                if (body.isBlank()) break
                val ids = parseTerminliste(body).map { it.id }
                if (ids.isEmpty() || ids.all { it in seenTermine }) break
                seenTermine += ids
                terminePages += body
                currentRow = row
                next = terminlisteNextUrl(body, root, currentRow)
                guard += 1
            }
        }
        val termine = readTerminliste(terminePages.joinToString("\n"))
        grades.error?.let { errors += it }
        absences.error?.let { errors += it }
        exams.error?.let { errors += it }
        termine.error?.let { errors += it }
        val today = java.time.LocalDate.now()
        val fetchedNow = java.time.Instant.now().toString()
        val planHtml = pages["22202"].orEmpty()
        val htmlSpan = parseWeekSpan(planHtml)
        val icalUrl = findIcalUrl(planHtml, root)
        val icalAvailable = !icalUrl.isNullOrBlank() && webReadAllowed(icalUrl)
        // Without a range on the page, plan the school year from appointments and holidays,
        // not only the four weeks around today.
        val knownSpan = htmlSpan ?: previous.storedSpan()
        // Planning only: the fallback is not Schulnetz's range, so it is never stored as one.
        val planSpan = knownSpan ?: ch.fasrv.fanotes.schulnetz.fallbackSchoolSpan(previous?.events.orEmpty(), previous?.vacations.orEmpty(), today, previous?.exams.orEmpty())
        val plan = planWeekFetches(
            if (planSpan != null) mondaysBetween(planSpan.start, planSpan.end) else emptyList(),
            // Retry timing follows every attempt, so an unread week is not requested on every sync.
            previous?.weekFetched.orEmpty() + confirmedLessonStamps(previous?.events.orEmpty(), previous?.weekFetched.orEmpty(), previous?.weekRead.orEmpty()),
            previous?.icalFetchedAt.orEmpty(),
            java.time.Instant.parse(fetchedNow),
            today,
            icalAvailable,
            emptyWeeks = previous?.weekRead.orEmpty().keys.filterTo(HashSet()) { week ->
                previous?.events.orEmpty().none { it.isLesson() && weekMondayKey(it.start) == week }
            },
        )
        val discovered = findSchedulerUrl(planHtml, root)
        val fromPlan = parseSchedulerNote(planNote)
        val callerMain = Looper.myLooper() == Looper.getMainLooper()
        var parseFailed = false
        val parseStarted = System.nanoTime()
        trace("parse stundenplan begin mainThread=$callerMain bytes=${planHtml.length} tables=${tableCount(planHtml)} weeksRequested=${plan.fetch.size} $context")
        trace("scheduler source=${if (discovered != null) "page" else "built"} weeks=${plan.fetch.size} ical=${plan.fetchIcal} domEvents=${fromPlan.second.size}")
        fun <T> offMain(label: String, block: () -> T): T? {
            if (callerMain) {
                parseFailed = true
                trace("parse $label skipped reason=main-thread $context")
                return null
            }
            val future = timetableParse.submit(Callable<T> { block() })
            return try {
                future.get(8, TimeUnit.SECONDS)
            } catch (timeout: TimeoutException) {
                future.cancel(true)
                parseFailed = true
                trace("parse $label timeout durationMs=8000 mainThread=false $context")
                null
            } catch (error: Exception) {
                val cause = (error as? java.util.concurrent.ExecutionException)?.cause ?: error
                parseFailed = true
                trace("parse $label failed ${cause.javaClass.simpleName} mainThread=false $context")
                null
            }
        }
        val canFetch = oauthPage == null && !sawSessionProblem && planHtml.isNotBlank() && id.isNotBlank() && transid.isNotBlank() && planError.isBlank()
        val lessonWeeks = linkedMapOf<java.time.LocalDate, List<ch.fasrv.fanotes.schulnetz.AgendaEvent>>()
        val examWeeks = linkedMapOf<java.time.LocalDate, List<ch.fasrv.fanotes.schulnetz.AgendaEvent>>()
        val checkedEmpty = mutableSetOf<java.time.LocalDate>()
        var currentEmptyUsable = false
        /** True once the scheduler itself returned lessons for some week in this read. */
        var schedulerGaveLessons = false
        val examStamps = previous?.examWeekFetched.orEmpty().toMutableMap()
        if (canFetch && !callerMain) {
            // Schulnetz hands out a new transid with every page, and the scheduler only answers
            // with the transid of its own page. After Terminliste and Prüfungen the timetable's
            // transid is stale and every week came back empty, so open each page again right
            // before its weeks: first the timetable weeks, then the exam weeks.
            fun reopen(pageId: String, label: String) {
                // The current transid, like a click on the page that is open now; older links carry stale ones.
                val url = pageUrl(root, pageId, id, transid)
                get(url, label, pageId)
            }
            if (plan.fetch.isNotEmpty()) reopen("22202", "stundenplan-wochen")
            for (monday in plan.fetch) {
                if (oauthPage != null || sawSessionProblem || parseFailed) break
                val max = monday.plusDays(7)
                val curr = if (monday == weekMonday(today)) today.toString() else monday.toString()
                val lessonBody = get(schedulerUrl(root, id, transid, curr, monday.toString(), max.toString()), "scheduler", "scheduler")
                val lessonParsed = if (schedulerWeekLoaded(lessonBody)) offMain("scheduler-xml") { parseSchedulerXml(lessonBody) } else emptyList()
                // Shape only, no content: shows in the diagnostic log why a week has no lessons.
                trace("scheduler week=$monday bytes=${lessonBody.length} loaded=${schedulerWeekLoaded(lessonBody)} usable=${schedulerBodyUsable(lessonBody)} lessons=${lessonParsed?.size ?: -1} $context")
                if (lessonParsed == null) break
                if (lessonParsed.isNotEmpty()) { lessonWeeks[monday] = lessonParsed; schedulerGaveLessons = true }
                else if (schedulerBodyUsable(lessonBody) && !schedulerWeekLoaded(lessonBody)) {
                    if (monday != weekMonday(today)) checkedEmpty += monday else currentEmptyUsable = true
                }
            }
            if (plan.fetch.isNotEmpty() && oauthPage == null && !sawSessionProblem && !parseFailed) reopen("21312", "pruefungen-wochen")
            for (monday in plan.fetch) {
                if (oauthPage != null || sawSessionProblem || parseFailed) break
                val max = monday.plusDays(7)
                val curr = if (monday == weekMonday(today)) today.toString() else monday.toString()
                val examBody = get(examSchedulerUrl(root, id, transid, curr, monday.toString(), max.toString()), "pruefungen-xml", "21312")
                val examParsed = if (schedulerWeekLoaded(examBody)) {
                    offMain("exam-xml") {
                        parseSchedulerXml(examBody).map { event ->
                            event.copy(eventType = if (event.eventType.isBlank() || event.eventType == "lesson") "exam" else event.eventType)
                        }
                    }
                } else {
                    emptyList()
                }
                if (examParsed == null) break
                if (examParsed.isNotEmpty()) {
                    examWeeks[monday] = examParsed
                    examStamps[monday.toString()] = fetchedNow
                } else if (schedulerBodyUsable(examBody) && !schedulerWeekLoaded(examBody) &&
                    previous?.exams.orEmpty().none { weekMondayKey(it.start) == monday.toString() }) {
                    examStamps[monday.toString()] = fetchedNow
                }
            }
        } else if (canFetch) {
            parseFailed = true
        }
        val currentMonday = weekMonday(today)
        if (currentMonday !in lessonWeeks && canFetch && !parseFailed) {
            val fallback = offMain("stundenplan-html") {
                val rendered = parseRenderedTimetable(planHtml)
                when {
                    rendered.isNotEmpty() -> rendered
                    fromPlan.second.isNotEmpty() -> fromPlan.second
                    else -> parseTimetableHtml(planHtml)
                }
            }
            if (fallback?.isNotEmpty() == true) lessonWeeks[currentMonday] = fallback
        }
        if (currentMonday !in examWeeks && exams.value.isNotEmpty() && !parseFailed && planError.isBlank()) examWeeks[currentMonday] = exams.value
        val expectedPlan = oauthPage == null && !sawSessionProblem && id.isNotBlank() && transid.isNotBlank()
        val timetableFailed = planError.isNotBlank() || parseFailed || (expectedPlan && planHtml.isBlank())
        if (timetableFailed) {
            lessonWeeks.clear()
            examWeeks.clear()
            checkedEmpty.clear()
            examStamps.clear()
            examStamps.putAll(previous?.examWeekFetched.orEmpty())
        }
        val refreshedLessons = lessonWeeks.keys.map { it.toString() }.toSet()
        trace("parse stundenplan end weeksRequested=${plan.fetch.size} weeksReceived=${refreshedLessons.size} durationMs=${(System.nanoTime() - parseStarted) / 1_000_000} mainThread=$callerMain bytes=${planHtml.length} tables=${tableCount(planHtml)} $context")
        var events = overlayLessons(previous?.events.orEmpty(), lessonWeeks.values.flatten(), refreshedLessons)
        var span = knownSpan
        var icalAt = previous?.icalFetchedAt.orEmpty()
        val stamps = previous?.weekFetched.orEmpty().toMutableMap()
        val reads = previous?.weekRead.orEmpty().toMutableMap()
        if (reads.isEmpty()) {
            for ((week, stamp) in confirmedLessonStamps(previous?.events.orEmpty(), stamps, emptyMap())) reads[week] = stamp
        }
        if (canFetch && !timetableFailed) {
            for (monday in refreshedLessons) {
                stamps[monday] = fetchedNow
                reads[monday] = fetchedNow
            }
            // An empty answer proves a free week only when the scheduler gave lessons for another
            // week in this read, or the week is a holiday. Otherwise the week stays "not loaded".
            val proven = schedulerGaveLessons
            val vacations = previous?.vacations.orEmpty()
            for (monday in checkedEmpty) {
                stamps[monday.toString()] = fetchedNow
                if (ch.fasrv.fanotes.schulnetz.emptyWeekCountsAsRead(monday, proven, vacations)) reads[monday.toString()] = fetchedNow
            }
            if (currentMonday !in lessonWeeks && currentEmptyUsable && ch.fasrv.fanotes.schulnetz.emptyWeekCountsAsRead(currentMonday, proven, vacations)) reads[currentMonday.toString()] = fetchedNow
            if (!proven && plan.fetch.isNotEmpty()) {
                val cleaned = ch.fasrv.fanotes.schulnetz.withoutUnprovenEmptyReads(reads, events, vacations)
                reads.clear(); reads.putAll(cleaned)
            }
        }
        var icalExams = emptyList<ch.fasrv.fanotes.schulnetz.AgendaEvent>()
        if (canFetch && !timetableFailed && plan.fetchIcal && icalAvailable) {
            val body = get(icalUrl.orEmpty(), "ical", "ical")
            if (icalBodyUsable(body)) {
                val parsed = offMain("ical") { parseIcs(body) }
                if (parsed != null) {
                    icalAt = fetchedNow
                    if (htmlSpan == null) spanOfEvents(parsed)?.let { span = it }
                    val covered = if (span != null) mondaysBetween(span.start, span.end).map { it.toString() }.toSet() else parsed.mapNotNull { weekMondayKey(it.start) }.toSet()
                    events = overlayLessons(events, parsed, covered - refreshedLessons)
                    icalExams = parsed.filter { it.isExamLike() && weekMondayKey(it.start) !in examWeeks.keys.map { week -> week.toString() }.toSet() }
                    for (monday in covered) if (icalExams.any { weekMondayKey(it.start) == monday } ||
                        previous?.exams.orEmpty().none { weekMondayKey(it.start) == monday }) examStamps[monday] = fetchedNow
                }
            }
        }
        if (termine.value.isNotEmpty()) events = mergeById(events, termine.value)
        val examEvents = mergeById(
            mergeById(
                overlayDated(previous?.exams.orEmpty(), examWeeks.values.flatten(), examWeeks.keys.map { it.toString() }.toSet()),
                lessonWeeks.values.flatten().filter { it.isExamLike() },
            ),
            icalExams,
        )
        val messages = startMessages(pages["1"].orEmpty(), previous, sawSessionProblem)
        if (events.isEmpty() && planHtml.length > 1000 && !planHtml.contains("dhx_cal_container") && !timetableFailed) {
            errors += "Stundenplan: Seite geladen, aber nicht lesbar"
        }
        val blocked = sawSessionProblem || pages["1"].isNullOrBlank()
        val snapshot = keepStoredRead(
            previous,
            SchulnetzSnapshot(
                fetchedAt = fetchedNow,
                grades = grades.value,
                events = events,
                exams = examEvents,
                absences = absences.value,
                messages = messages,
                konto = parseKontoauszug(pages["21411"].orEmpty()),
                startMessages = parseStartMessages(pages["1"].orEmpty()),
                readErrors = errors,
                weekFetched = stamps,
                examWeekFetched = examStamps,
                weekRead = reads,
                weekSpanStart = span?.start?.toString().orEmpty(),
                weekSpanEnd = span?.end?.toString().orEmpty(),
                icalFetchedAt = icalAt,
            ),
            blocked = blocked,
            timetableFailed = timetableFailed,
            okPages = okPages,
            gradesComplete = !pages["21311"].isNullOrBlank() && grades.error == null,
        )
        trace("parsed grades=${snapshot.grades.size} absences=${snapshot.absences.size} exams=${snapshot.exams.size} events=${snapshot.events.size} termine=${termine.value.size} weeks=${if (timetableFailed) 0 else refreshedLessons.size} okPages=$okPages oauth=${oauthPage.orEmpty()} blocked=$blocked timetableFailed=$timetableFailed errors=${errors.size} $context")
        val problem = when {
            oauthPage != null -> SessionProblem.OAUTH_FAILED
            errors.any { it == "Bei Schulnetz neu anmelden" } -> SessionProblem.INTERACTIVE
            errors.any { it.contains("IP-Adresse") } -> SessionProblem.IP_REJECTED
            errors.any { it.contains("abgelaufen") } -> SessionProblem.INACTIVITY
            errors.any { it.contains("Anmeldung") } -> SessionProblem.LOGIN_WALL
            else -> SessionProblem.NONE
        }
        val reported = if (problem == SessionProblem.INTERACTIVE) snapshot.copy(readErrors = listOf("Bei Schulnetz neu anmelden")) else snapshot
        return WebBundle(reported, problem, debug, WebSession(root, "", id, transid), okPages, oauthPage, captured)
    }

    private fun startMessages(startHtml: String, previous: SchulnetzSnapshot?, failed: Boolean = false): List<ch.fasrv.fanotes.schulnetz.SchoolMessage> {
        val notes = parseStartMessages(startHtml).mapIndexed { index, text ->
            ch.fasrv.fanotes.schulnetz.SchoolMessage("start-$index", "Mitteilung", text, "")
        }
        val appointments = parseStartAppointments(startHtml).map {
            ch.fasrv.fanotes.schulnetz.SchoolMessage(it.id, "Termin", it.text, it.start)
        }
        if (failed && notes.isEmpty() && appointments.isEmpty()) return previous?.messages.orEmpty()
        val keptAppointments = if (appointments.isNotEmpty()) appointments else previous?.messages.orEmpty().filter { it.title == "Termin" }
        return notes + keptAppointments
    }

    private fun SchulnetzSnapshot?.storedSpan(): WeekSpan? {
        val snap = this ?: return null
        val start = snap.weekSpanStart.takeIf { it.isNotBlank() }?.let { runCatching { java.time.LocalDate.parse(it) }.getOrNull() } ?: return null
        val end = snap.weekSpanEnd.takeIf { it.isNotBlank() }?.let { runCatching { java.time.LocalDate.parse(it) }.getOrNull() } ?: return null
        if (end.isBefore(start)) return null
        return WeekSpan(start, end)
    }

    fun mergePage(snapshot: SchulnetzSnapshot, pageId: String, html: String): SchulnetzSnapshot = when (pageId) {
        "21311" -> readGradesPage(html).let { read ->
            snapshot.copy(grades = ch.fasrv.fanotes.schulnetz.keepGradeRead(snapshot.grades, read.value, read.error == null),
                gradesReadComplete = read.error == null && read.value.isNotEmpty())
        }
        "21111" -> snapshot.copy(absences = readAbsencesPage(html).value.ifEmpty { snapshot.absences })
        "21312" -> snapshot.copy(exams = readExamsPage(html).value.ifEmpty { snapshot.exams })
        "22108" -> snapshot.copy(events = (snapshot.events + readTerminliste(html).value).distinctBy { it.id })
        "21411" -> snapshot.copy(konto = parseKontoauszug(html).ifEmpty { snapshot.konto })
        "1" -> snapshot.copy(startMessages = parseStartMessages(html).ifEmpty { snapshot.startMessages })
        else -> snapshot
    }

    fun link(session: SchoolAuth, baseUrl: String, deviceId: String, tokens: SchulnetzTokens, displayName: String): SchulnetzLinkState {
        val payload = buildString {
            append("{\"baseUrl\":").append(escapeJson(baseUrl))
            append(",\"deviceId\":").append(escapeJson(deviceId))
            append(",\"refreshToken\":").append(escapeJson(tokens.refreshToken))
            append(",\"accessToken\":").append(escapeJson(tokens.accessToken))
            append(",\"expiresIn\":").append(tokens.expiresInSeconds ?: 600)
            append(",\"displayName\":").append(escapeJson(displayName))
            append('}')
        }
        val (code, body) = fanotes("PUT", "/link", session, payload)
        if (code !in 200..299) throw SchulnetzHttpException(code, errorMessage(body, code))
        return parseStatus(body)
    }

    fun unlink(session: SchoolAuth) {
        val (code, body) = fanotes("DELETE", "/link", session, null)
        if (code !in 200..299 && code != 404) throw SchulnetzHttpException(code, errorMessage(body, code))
    }

    fun saveSettings(session: SchoolAuth, settings: NotifySettings) {
        val payload = buildString {
            append("{\"enabled\":").append(settings.enabled)
            append(",\"grades\":").append(settings.grades)
            append(",\"gradeNew\":").append(settings.gradeNew)
            append(",\"gradeChanged\":").append(settings.gradeChanged)
            append(",\"timetable\":").append(settings.timetable)
            append(",\"lessonCancelled\":").append(settings.lessonCancelled)
            append(",\"lessonChanged\":").append(settings.lessonChanged)
            append(",\"exams\":").append(settings.exams)
            append(",\"examNew\":").append(settings.examNew)
            append(",\"examMoved\":").append(settings.examMoved)
            append(",\"examCancelled\":").append(settings.examCancelled)
            append(",\"examRoom\":").append(settings.examRoom)
            append(",\"absences\":").append(settings.absences)
            append(",\"events\":").append(settings.events)
            append(",\"appointmentNew\":").append(settings.appointmentNew)
            append(",\"messageNew\":").append(settings.messageNew)
            append(",\"deadlines\":").append(settings.deadlines)
            append(",\"guessGrades\":").append(settings.guessGrades)
            append('}')
        }
        val (code, body) = fanotes("PUT", "/settings", session, payload)
        if (code !in 200..299) throw SchulnetzHttpException(code, errorMessage(body, code))
    }

    fun snapshot(session: SchoolAuth): String {
        val (code, body) = fanotes("GET", "/snapshot", session, null)
        if (code !in 200..299) throw SchulnetzHttpException(code, errorMessage(body, code))
        return body
    }

    fun changes(session: SchoolAuth, since: Long, deviceKey: String = "", quick: Boolean = false): String {
        val device = if (deviceKey.matches(Regex("^[a-f0-9]{32}$"))) "&device=$deviceKey" else ""
        val (code, body) = fanotes("GET", "/changes?since=$since$device", session, null, if (quick) quickHttp else http)
        if (code !in 200..299) throw SchulnetzHttpException(code, errorMessage(body, code))
        return body
    }

    fun registerFcmToken(session: SchoolAuth, token: String) {
        val (code, body) = fanotes("PUT", "/push-token", session, "{\"token\":${escapeJson(token)}}")
        if (code !in 200..299) throw SchulnetzHttpException(code, errorMessage(body, code))
    }

    fun testPush(session: SchoolAuth) {
        val (code, body) = fanotes("POST", "/push/test", session, "{}")
        if (code !in 200..299) throw SchulnetzHttpException(code, errorMessage(body, code))
    }

    /** Asks the server to deliver marked test changes to this device only. */
    fun probePush(session: SchoolAuth, token: String, scenario: String = "standard"): ProbeAck {
        val name = when (scenario) {
            "duplicate", "reorder" -> scenario
            else -> "standard"
        }
        val (code, body) = fanotes("POST", "/push/probe", session, "{\"token\":${escapeJson(token)},\"scenario\":${escapeJson(name)}}")
        if (code !in 200..299) throw SchulnetzHttpException(code, errorMessage(body, code))
        val obj = parseJson(body) as? JsonValue.Obj
        return ProbeAck(
            serverAt = obj?.string("serverAt").orEmpty(),
            correlation = obj?.string("correlation").orEmpty(),
            scenario = obj?.string("scenario").orEmpty().ifBlank { name },
            count = obj?.double("count")?.toInt() ?: 0,
            probeRemaining = obj?.double("probeRemaining")?.toInt() ?: -1,
            clearRemaining = obj?.double("clearRemaining")?.toInt() ?: -1,
        )
    }

    /** Deletes this device's probe rows. School records and the revision stay. */
    fun clearProbe(session: SchoolAuth, token: String): ProbeClear {
        val (code, body) = fanotes("POST", "/push/probe/clear", session, "{\"token\":${escapeJson(token)}}")
        if (code !in 200..299) throw SchulnetzHttpException(code, errorMessage(body, code))
        val obj = parseJson(body) as? JsonValue.Obj
        return ProbeClear(
            removed = obj?.double("removed")?.toInt() ?: 0,
            failed = obj?.bool("failed") == true,
        )
    }

    fun createGuest(): SchoolAuth {
        val (code, body) = call(
            "POST",
            "$SYNC_ORIGIN$SCHULNETZ_API_PATH/guest",
            mapOf(
                "Accept" to "application/json",
                "Accept-Language" to AppLanguage.acceptLanguage(),
                "Content-Type" to "application/json",
            ),
            "{}",
        )
        if (code !in 200..299) throw SchulnetzHttpException(code, errorMessage(body, code))
        val obj = parseJson(body) as? JsonValue.Obj ?: throw SchulnetzHttpException(code, "Anfrage fehlgeschlagen ($code).")
        val accountId = obj.string("accountId").orEmpty()
        val token = obj.string("token").orEmpty()
        if (!accountId.matches(Regex("^[a-f0-9]{32}$")) || !token.matches(Regex("^[A-Za-z0-9_-]{40,80}$"))) {
            throw SchulnetzHttpException(code, "Anfrage fehlgeschlagen ($code).")
        }
        return SchoolAuth(accountId, token, guest = true)
    }

    fun adopt(session: SchoolAuth, guestId: String, guestToken: String): Long {
        val (code, body) = fanotes("POST", "/adopt", session, "{\"guestAccountId\":${escapeJson(guestId)},\"guestToken\":${escapeJson(guestToken)}}")
        if (code !in 200..299) throw SchulnetzHttpException(code, errorMessage(body, code))
        return (parseJson(body) as? JsonValue.Obj)?.double("revision")?.toLong() ?: 0L
    }

    fun detach(session: SchoolAuth, guestId: String, guestToken: String, fcmToken: String?): Long {
        val tokenField = if (fcmToken.isNullOrBlank()) "" else ",\"fcmToken\":${escapeJson(fcmToken)}"
        val (code, body) = fanotes("POST", "/detach", session, "{\"guestAccountId\":${escapeJson(guestId)},\"guestToken\":${escapeJson(guestToken)}$tokenField}")
        if (code !in 200..299) throw SchulnetzHttpException(code, errorMessage(body, code))
        return (parseJson(body) as? JsonValue.Obj)?.double("revision")?.toLong() ?: 0L
    }

    fun deleteGuest(session: SchoolAuth) {
        val (code, body) = fanotes("DELETE", "/guest", session, null)
        if (code !in 200..299 && code != 404) throw SchulnetzHttpException(code, errorMessage(body, code))
    }

    private fun token(baseUrl: String, form: String): SchulnetzTokens {
        val url = "${baseUrl.trimEnd('/')}/token.php"
        if (!schulnetzCallAllowed("POST", url, form)) {
            throw SchulnetzHttpException(400, "Diese Schulnetz-Anmeldung ist nicht erlaubt.")
        }
        val (status, body) = call(
            "POST",
            url,
            mapOf(
                "Accept" to "application/json",
                "Content-Type" to "application/x-www-form-urlencoded",
                "Referer" to SCHULNETZ_REFERER,
                "User-Agent" to SCHULNETZ_USER_AGENT,
            ),
            form,
        )
        val tokens = runCatching { parseTokenJson(body) }.getOrElse { SchulnetzTokens("", "", null, "invalid") }
        if (status !in 200..299 || tokens.accessToken.isBlank()) {
            val reason = tokens.error?.takeIf { it.isNotBlank() && !it.contains(tokens.accessToken) } ?: "http-$status"
            throw SchulnetzHttpException(status, "Schulnetz hat die Anmeldung abgelehnt ($reason).")
        }
        if (tokens.refreshToken.isBlank()) {
            throw SchulnetzHttpException(status, "Schulnetz hat kein Refresh-Token geliefert.")
        }
        return tokens
    }

    private fun fanotes(method: String, path: String, session: SchoolAuth, json: String?, client: OkHttpClient = http): Pair<Int, String> =
        call(
            method,
            "$SYNC_ORIGIN$SCHULNETZ_API_PATH$path",
            mapOf(
                "Authorization" to "Bearer ${session.token}",
                (if (session.guest) "X-Kanti-Guest" else "X-FaNotes-Account") to session.accountId,
                "Accept" to "application/json",
                "Accept-Language" to AppLanguage.acceptLanguage(),
                "Content-Type" to "application/json",
                // This app's own diff handles every timetable week; older apps get this week only.
                "X-Kanti-Timetable" to "weeks",
            ),
            json,
            client,
        )

    private fun call(method: String, url: String, headers: Map<String, String>, body: String?, client: OkHttpClient = http): Pair<Int, String> {
        val media = if (headers["Content-Type"]?.contains("json") == true) "application/json" else "application/x-www-form-urlencoded"
        val requestBody = when {
            method == "GET" -> null
            body == null && method == "DELETE" -> ByteArray(0).toRequestBody(null)
            else -> (body ?: "").toRequestBody(media.toMediaType())
        }
        val builder = Request.Builder().url(url).method(method, requestBody)
        headers.forEach { (name, value) -> builder.header(name, value) }
        val watch = DiagnosticTrace.enabled
        val started = if (watch) System.nanoTime() else 0L
        try {
            client.newCall(builder.build()).execute().use { response ->
                val result = response.code to (response.body?.string().orEmpty())
                if (watch) noteDiagnosticHttp(method, url, started, result.first)
                return result
            }
        } catch (error: java.io.IOException) {
            if (watch) noteDiagnosticHttp(method, url, started, 0)
            throw error
        }
    }

    /** Method and path only. Slow calls and failures are kept; bodies and tokens are not. */
    private fun noteDiagnosticHttp(method: String, url: String, startedNs: Long, status: Int) {
        val elapsed = ((System.nanoTime() - startedNs) / 1_000_000L).coerceAtLeast(0)
        if (status in 200..299 && elapsed < 500L) return
        DiagnosticTrace.record("network", diagnosticRequestName(method, url), elapsed, httpResultCategory(status))
    }

    private fun diagnosticRequestName(method: String, url: String): String {
        val bare = url.substringBefore('#').substringBefore('?')
        val scheme = bare.indexOf("://")
        val pathAt = if (scheme >= 0) bare.indexOf('/', scheme + 3) else bare.indexOf('/')
        val path = if (pathAt >= 0) bare.substring(pathAt) else "/"
        return "$method ${path.take(64).ifBlank { "/" }}"
    }

    private fun schoolHeaders(access: String, html: Boolean) = mapOf(
        "Accept" to if (html) "text/html" else "application/json",
        "Authorization" to "Bearer $access",
        "Referer" to SCHULNETZ_REFERER,
        "User-Agent" to SCHULNETZ_USER_AGENT,
    )

    private fun errorMessage(body: String, status: Int): String {
        val parsed = runCatching { (parseJson(body) as? JsonValue.Obj)?.string("error") }.getOrNull()
        return parsed?.takeIf { it.isNotBlank() && it.length < 240 } ?: "Anfrage fehlgeschlagen ($status)."
    }

    private fun storedAlertFlags(settings: JsonValue.Obj?): Map<String, Boolean> {
        if (settings == null) return emptyMap()
        return buildMap {
            for (name in ALERT_SETTING_NAMES) {
                val value = settings.bool(name) ?: continue
                put(name, value)
            }
        }
    }

    private fun parseStatus(body: String): SchulnetzLinkState {
        val obj = parseJson(body) as? JsonValue.Obj ?: return SchulnetzLinkState()
        val settings = obj.obj("settings")
        val push = obj.obj("push")
        return SchulnetzLinkState(
            linked = obj.bool("linked") == true,
            baseUrl = obj.string("baseUrl") ?: AKSA_SCHULNETZ_BASE,
            displayName = obj.string("displayName").orEmpty(),
            needsReauth = obj.bool("needsReauth") == true,
            lastPollAt = obj.string("lastPollAt").orEmpty(),
            lastError = obj.string("lastError").orEmpty(),
            revision = obj.double("revision")?.toLong() ?: 0L,
            topic = push?.string("topic").orEmpty(),
            pushServer = push?.string("server").orEmpty(),
            pushUrl = push?.string("url").orEmpty(),
            settings = notifySettingsFromStored(storedAlertFlags(settings)),
        )
    }

    companion object {
        const val CLIENT_ID = SCHULNETZ_CLIENT_ID
        private val ALERT_SETTING_NAMES = listOf(
            "enabled", "grades", "gradeNew", "gradeChanged", "timetable", "lessonCancelled", "lessonChanged",
            "exams", "examNew", "examMoved", "examCancelled", "examRoom", "absences", "events",
            "appointmentNew", "messageNew", "deadlines", "guessGrades",
        )
    }
}
