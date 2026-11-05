package ch.fasrv.fanotes.companion

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.escapeJson
import ch.fasrv.fanotes.json.parseJson
import ch.fasrv.fanotes.schulnetz.AKSA_SCHULNETZ_BASE
import ch.fasrv.fanotes.schulnetz.NotifySettings
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
import ch.fasrv.fanotes.schulnetz.describeTables
import ch.fasrv.fanotes.schulnetz.findIcalUrl
import ch.fasrv.fanotes.schulnetz.eventQueryWindow
import ch.fasrv.fanotes.schulnetz.examSchedulerUrl
import ch.fasrv.fanotes.schulnetz.findSchedulerUrl
import ch.fasrv.fanotes.schulnetz.icalBodyUsable
import ch.fasrv.fanotes.schulnetz.mergeById
import ch.fasrv.fanotes.schulnetz.mondaysBetween
import ch.fasrv.fanotes.schulnetz.overlayDated
import ch.fasrv.fanotes.schulnetz.overlayLessons
import ch.fasrv.fanotes.schulnetz.parseWeekSpan
import ch.fasrv.fanotes.schulnetz.planWeekFetches
import ch.fasrv.fanotes.schulnetz.schedulerWeekLoaded
import ch.fasrv.fanotes.schulnetz.spanOfEvents
import ch.fasrv.fanotes.schulnetz.weekMonday
import ch.fasrv.fanotes.schulnetz.classifySchulnetzPage
import ch.fasrv.fanotes.schulnetz.isForcedLogoutUrl
import ch.fasrv.fanotes.schulnetz.linkedPageUrl
import ch.fasrv.fanotes.schulnetz.pageUrl
import ch.fasrv.fanotes.schulnetz.redactSchulnetzSecrets
import ch.fasrv.fanotes.schulnetz.sessionIdsFromPage
import ch.fasrv.fanotes.schulnetz.startPageUrl
import ch.fasrv.fanotes.schulnetz.isExamLike
import ch.fasrv.fanotes.schulnetz.parseIcs
import ch.fasrv.fanotes.schulnetz.parseSchedulerNote
import ch.fasrv.fanotes.schulnetz.parseRenderedTimetable
import ch.fasrv.fanotes.schulnetz.parseStartAppointments
import ch.fasrv.fanotes.schulnetz.parseStartRecentGrades
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
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.time.LocalDate
import java.util.concurrent.TimeUnit

class SchulnetzHttpException(val status: Int, message: String) : Exception(message)

/** Server identity for Schulnetz. Guest identities have no email or password. */
data class SchoolAuth(
    val accountId: String,
    val token: String,
    val guest: Boolean = false,
)

fun SyncSession.asSchoolAuth() = SchoolAuth(accountId, token, guest = false)

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

    fun fetchWeb(baseUrl: String, session: WebSession, loader: (String) -> LoadedPage, signedOut: Boolean = false, trace: (String) -> Unit = {}, previous: SchulnetzSnapshot? = null): WebBundle {
        val root = baseUrl.trimEnd('/')
        var id = session.id
        var transid = session.transid
        val errors = mutableListOf<String>()
        var debug = ""
        var sawSessionProblem = false
        var oauthPage: String? = null
        var okPages = 0
        var planNote = ""
        val captured = linkedMapOf<String, String>()
        fun remember(name: String, page: LoadedPage) {
            if (name == "stundenplan") planNote = page.note
            if (page.body.isNotBlank()) {
                debug = page.body
                captured[name] = page.body
                if (!page.body.trimStart().startsWith("<?xml")) trace("markup $name ${describeTables(page.body)}")
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
            if (isForcedLogoutUrl(url) || !webReadAllowed(url)) {
                trace("blocked $label url=${redactSchulnetzSecrets(url)}")
                errors += "Blockiert: ${redactSchulnetzSecrets(url)}"
                return ""
            }
            trace("request $label url=${redactSchulnetzSecrets(url)}")
            val page = try {
                loader(url)
            } catch (error: Exception) {
                trace("exception $label ${error.javaClass.simpleName}: ${error.message}")
                errors += error.message ?: "Laden fehlgeschlagen"
                return ""
            }
            val classified = classifySchulnetzPage(page.finalUrl.ifBlank { url }, page.body)
            trace("result $label status=${page.status} rule=${classified.rule} class=${classified.problem} bytes=${page.body.length} final=${redactSchulnetzSecrets(page.finalUrl)}")
            remember(label, page)
            if (classified.problem == SessionProblem.OAUTH_FAILED) {
                oauthPage = pageId
                errors += sessionProblemText(classified.problem)
                return ""
            }
            if (classified.problem != SessionProblem.NONE) {
                sawSessionProblem = true
                errors += sessionProblemText(classified.problem)
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
        val grades = readGradesPage(pages["21311"].orEmpty()).let { read ->
            if (read.value.isNotEmpty()) read else read.copy(value = parseStartRecentGrades(pages["1"].orEmpty()))
        }
        val absences = readAbsencesPage(pages["21111"].orEmpty())
        val exams = readExamsPage(pages["21312"].orEmpty())
        val terminePages = mutableListOf(pages["22108"].orEmpty())
        if (oauthPage == null && !sawSessionProblem) {
            var next = terminlisteNextUrl(pages["22108"].orEmpty(), root)
            var guard = 0
            while (!next.isNullOrBlank() && guard < 8) {
                val body = get(next, "termine", "22108")
                if (body.isBlank()) break
                terminePages += body
                next = terminlisteNextUrl(body, root)
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
        val knownSpan = htmlSpan ?: previous.storedSpan()
        val plan = planWeekFetches(
            if (knownSpan != null) mondaysBetween(knownSpan.start, knownSpan.end) else emptyList(),
            previous?.weekFetched.orEmpty(),
            previous?.icalFetchedAt.orEmpty(),
            java.time.Instant.parse(fetchedNow),
            today,
            icalAvailable,
        )
        val discovered = findSchedulerUrl(planHtml, root)
        val fromPlan = parseSchedulerNote(planNote)
        trace("scheduler source=${if (discovered != null) "page" else "built"} weeks=${plan.fetch.size} ical=${plan.fetchIcal} domEvents=${fromPlan.second.size}")
        val canFetch = oauthPage == null && !sawSessionProblem && planHtml.isNotBlank() && id.isNotBlank() && transid.isNotBlank()
        val lessonWeeks = linkedMapOf<java.time.LocalDate, List<ch.fasrv.fanotes.schulnetz.AgendaEvent>>()
        val examWeeks = linkedMapOf<java.time.LocalDate, List<ch.fasrv.fanotes.schulnetz.AgendaEvent>>()
        if (canFetch) {
            for (monday in plan.fetch) {
                if (oauthPage != null || sawSessionProblem) break
                val max = monday.plusDays(7)
                val curr = if (monday == weekMonday(today)) today.toString() else monday.toString()
                val lessonBody = get(schedulerUrl(root, id, transid, curr, monday.toString(), max.toString()), "scheduler", "scheduler")
                if (schedulerWeekLoaded(lessonBody)) lessonWeeks[monday] = parseSchedulerXml(lessonBody)
                if (oauthPage != null || sawSessionProblem) break
                val examBody = get(examSchedulerUrl(root, id, transid, curr, monday.toString(), max.toString()), "pruefungen-xml", "21312")
                if (schedulerWeekLoaded(examBody)) {
                    examWeeks[monday] = parseSchedulerXml(examBody).map { event ->
                        event.copy(eventType = if (event.eventType.isBlank() || event.eventType == "lesson") "exam" else event.eventType)
                    }
                }
            }
        }
        val currentMonday = weekMonday(today)
        if (currentMonday !in lessonWeeks && canFetch) {
            val rendered = parseRenderedTimetable(planHtml)
            val fallback = when {
                rendered.isNotEmpty() -> rendered
                fromPlan.second.isNotEmpty() -> fromPlan.second
                else -> parseTimetableHtml(planHtml)
            }
            if (fallback.isNotEmpty()) lessonWeeks[currentMonday] = fallback
        }
        if (currentMonday !in examWeeks && exams.value.isNotEmpty()) examWeeks[currentMonday] = exams.value
        val refreshedLessons = lessonWeeks.keys.map { it.toString() }.toSet()
        var events = overlayLessons(previous?.events.orEmpty(), lessonWeeks.values.flatten(), refreshedLessons)
        var span = knownSpan
        var icalAt = previous?.icalFetchedAt.orEmpty()
        val stamps = previous?.weekFetched.orEmpty().toMutableMap()
        if (canFetch) for (monday in refreshedLessons) stamps[monday] = fetchedNow
        var icalExams = emptyList<ch.fasrv.fanotes.schulnetz.AgendaEvent>()
        if (canFetch && plan.fetchIcal && icalAvailable) {
            val body = get(icalUrl.orEmpty(), "ical", "ical")
            if (icalBodyUsable(body)) {
                val parsed = parseIcs(body)
                icalAt = fetchedNow
                if (htmlSpan == null) spanOfEvents(parsed)?.let { span = it }
                val covered = if (span != null) mondaysBetween(span.start, span.end).map { it.toString() }.toSet() else parsed.mapNotNull { weekMondayKey(it.start) }.toSet()
                events = overlayLessons(events, parsed, covered - refreshedLessons)
                icalExams = parsed.filter { it.isExamLike() }
                for (monday in covered - refreshedLessons) stamps[monday] = fetchedNow
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
        if (events.isEmpty() && planHtml.length > 1000 && !planHtml.contains("dhx_cal_container")) {
            errors += "Stundenplan: Seite geladen, aber nicht lesbar"
        }
        trace("parsed grades=${grades.value.size} absences=${absences.value.size} exams=${exams.value.size} events=${events.size} termine=${termine.value.size} weeks=${refreshedLessons.size} okPages=$okPages oauth=${oauthPage.orEmpty()} errors=${errors.size}")
        val snapshot = SchulnetzSnapshot(
            fetchedAt = fetchedNow,
            grades = grades.value,
            events = events,
            exams = examEvents,
            absences = absences.value,
            messages = startMessages(pages["1"].orEmpty(), previous),
            konto = parseKontoauszug(pages["21411"].orEmpty()),
            startMessages = parseStartMessages(pages["1"].orEmpty()),
            readErrors = errors,
            weekFetched = stamps,
            weekSpanStart = span?.start?.toString().orEmpty(),
            weekSpanEnd = span?.end?.toString().orEmpty(),
            icalFetchedAt = icalAt,
        )
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

    private fun startMessages(startHtml: String, previous: SchulnetzSnapshot?): List<ch.fasrv.fanotes.schulnetz.SchoolMessage> {
        val notes = parseStartMessages(startHtml).mapIndexed { index, text ->
            ch.fasrv.fanotes.schulnetz.SchoolMessage("start-$index", "Mitteilung", text, "")
        }
        val appointments = parseStartAppointments(startHtml).map {
            ch.fasrv.fanotes.schulnetz.SchoolMessage(it.id, "Termin", it.text, it.start)
        }
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
        "21311" -> snapshot.copy(grades = readGradesPage(html).value.ifEmpty { snapshot.grades })
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
        val payload = """{"grades":${settings.grades},"timetable":${settings.timetable},"exams":${settings.exams},"absences":${settings.absences},"events":${settings.events},"deadlines":${settings.deadlines},"guessGrades":${settings.guessGrades}}"""
        val (code, body) = fanotes("PUT", "/settings", session, payload)
        if (code !in 200..299) throw SchulnetzHttpException(code, errorMessage(body, code))
    }

    fun snapshot(session: SchoolAuth): String {
        val (code, body) = fanotes("GET", "/snapshot", session, null)
        if (code !in 200..299) throw SchulnetzHttpException(code, errorMessage(body, code))
        return body
    }

    fun changes(session: SchoolAuth, since: Long, quick: Boolean = false): String {
        val (code, body) = fanotes("GET", "/changes?since=$since", session, null, if (quick) quickHttp else http)
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
        client.newCall(builder.build()).execute().use { response ->
            return response.code to (response.body?.string().orEmpty())
        }
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
            settings = NotifySettings(
                grades = settings?.bool("grades") != false,
                timetable = settings?.bool("timetable") != false,
                exams = settings?.bool("exams") != false,
                absences = settings?.bool("absences") != false,
                events = settings?.bool("events") != false,
                deadlines = settings?.bool("deadlines") != false,
                guessGrades = settings?.bool("guessGrades") == true,
            ),
        )
    }

    companion object {
        const val CLIENT_ID = SCHULNETZ_CLIENT_ID
    }
}
