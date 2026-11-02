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
import ch.fasrv.fanotes.schulnetz.examSchedulerUrl
import ch.fasrv.fanotes.schulnetz.findSchedulerUrl
import ch.fasrv.fanotes.schulnetz.classifySchulnetzPage
import ch.fasrv.fanotes.schulnetz.isForcedLogoutUrl
import ch.fasrv.fanotes.schulnetz.linkedPageUrl
import ch.fasrv.fanotes.schulnetz.pageUrl
import ch.fasrv.fanotes.schulnetz.redactSchulnetzSecrets
import ch.fasrv.fanotes.schulnetz.sessionIdsFromPage
import ch.fasrv.fanotes.schulnetz.startPageUrl
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
import ch.fasrv.fanotes.schulnetz.weekBounds
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
    fun exchangeCode(baseUrl: String, code: String, verifier: String, deviceId: String): SchulnetzTokens =
        token(baseUrl, authorizationCodeForm(code, verifier, deviceId))

    fun refresh(baseUrl: String, refreshToken: String, deviceId: String): SchulnetzTokens =
        token(baseUrl, refreshTokenForm(refreshToken, deviceId))

    fun fetchRaw(baseUrl: String, accessToken: String): SchulnetzRaw {
        val root = baseUrl.trimEnd('/')
        val today = LocalDate.now()
        fun get(path: String): String? {
            val url = "$root$path"
            if (!schulnetzCallAllowed("GET", url)) return null
            val (status, body) = call("GET", url, schoolHeaders(accessToken, path.contains("index.php")), null)
            if (status == 401) throw SchulnetzHttpException(401, "Die Schulnetz-Sitzung ist abgelaufen.")
            return body.takeIf { status in 200..299 }
        }
        return SchulnetzRaw(
            me = get("/rest/v1/me"),
            grades = get("/rest/v1/me/grades"),
            events = get("/rest/v1/me/events?min_date=${today.minusDays(7)}&max_date=${today.plusDays(21)}"),
            exams = get("/rest/v1/me/exams"),
            absences = get("/rest/v1/me/absences"),
            homework = get("/rest/v1/me/notes/homework"),
            messages = get("/rest/v1/me/notifications/push"),
            vacations = get("/rest/v1/me/vacations"),
            lateness = get("/rest/v1/me/lateness"),
            kontoHtml = get("/index.php?pageid=21411"),
            startHtml = get("/index.php?pageid=1"),
        )
    }

    fun status(session: SyncSession): SchulnetzLinkState {
        val (code, body) = fanotes("GET", "/status", session, null)
        if (code == 404) return SchulnetzLinkState(reachable = false)
        if (code !in 200..299) throw SchulnetzHttpException(code, errorMessage(body, code))
        return parseStatus(body)
    }

    fun linkWeb(session: SyncSession, baseUrl: String, deviceId: String, userAgent: String, ssoCookies: Map<String, String>, displayName: String): SchulnetzLinkState {
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

    fun uploadSnapshot(session: SyncSession, snapshot: SchulnetzSnapshot) {
        val (code, body) = fanotes("PUT", "/snapshot", session, snapshot.toNormalizedJson())
        if (code !in 200..299 && code != 404) throw SchulnetzHttpException(code, errorMessage(body, code))
    }

    fun fetchWeb(baseUrl: String, session: WebSession, loader: (String) -> LoadedPage, signedOut: Boolean = false, trace: (String) -> Unit = {}): WebBundle {
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
            trace("session ids source=${found.source} id=${found.id} transid=${found.transid}")
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
        val (monday, nextMonday) = weekBounds(today)
        val fromPlan = parseSchedulerNote(planNote)
        val discovered = findSchedulerUrl(pages["22202"].orEmpty(), root)
        trace("scheduler source=${if (discovered != null) "page" else "built"} domEvents=${fromPlan.second.size}")
        val scheduler = if (oauthPage != null || sawSessionProblem || pages["22202"].isNullOrBlank()) "" else {
            get(discovered ?: schedulerUrl(root, id, transid, today.toString(), monday.toString(), nextMonday.toString()), "scheduler", "scheduler")
        }
        val examXml = if (oauthPage != null || sawSessionProblem || pages["21312"].isNullOrBlank()) "" else {
            get(examSchedulerUrl(root, id, transid, today.toString(), monday.toString(), nextMonday.toString()), "pruefungen-xml", "21312")
        }
        val icalUrl = findIcalUrl(pages["22202"].orEmpty(), root)
        val ical = if (oauthPage != null || sawSessionProblem || icalUrl.isNullOrBlank() || !webReadAllowed(icalUrl)) emptyList() else parseIcs(get(icalUrl, "ical", "ical"))
        val rendered = parseRenderedTimetable(pages["22202"].orEmpty())
        val events = when {
            rendered.isNotEmpty() -> rendered
            fromPlan.second.isNotEmpty() -> fromPlan.second
            else -> parseSchedulerXml(scheduler).ifEmpty { ical }.ifEmpty { parseTimetableHtml(pages["22202"].orEmpty()) }
        }
        if (events.isEmpty() && pages["22202"].orEmpty().length > 1000 && !pages["22202"].orEmpty().contains("dhx_cal_container")) {
            errors += "Stundenplan: Seite geladen, aber nicht lesbar"
        }
        val examEvents = readExamsPage(pages["21312"].orEmpty()).value.ifEmpty { parseSchedulerXml(examXml).map { it.copy(eventType = "exam") } }
        trace("parsed grades=${grades.value.size} absences=${absences.value.size} exams=${exams.value.size} events=${events.size} termine=${termine.value.size} okPages=$okPages oauth=${oauthPage.orEmpty()} errors=${errors.size}")
        val snapshot = SchulnetzSnapshot(
            fetchedAt = java.time.Instant.now().toString(),
            grades = grades.value,
            events = events,
            exams = examEvents,
            absences = absences.value,
            messages = (parseStartMessages(pages["1"].orEmpty()).mapIndexed { index, text -> ch.fasrv.fanotes.schulnetz.SchoolMessage("start-$index", "Mitteilung", text, "") }
                + parseStartAppointments(pages["1"].orEmpty()).map { ch.fasrv.fanotes.schulnetz.SchoolMessage(it.id, "Termin", it.text, it.start) }),
            konto = parseKontoauszug(pages["21411"].orEmpty()),
            startMessages = parseStartMessages(pages["1"].orEmpty()),
            readErrors = errors,
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

    fun mergePage(snapshot: SchulnetzSnapshot, pageId: String, html: String): SchulnetzSnapshot = when (pageId) {
        "21311" -> snapshot.copy(grades = readGradesPage(html).value.ifEmpty { snapshot.grades })
        "21111" -> snapshot.copy(absences = readAbsencesPage(html).value.ifEmpty { snapshot.absences })
        "21312" -> snapshot.copy(exams = readExamsPage(html).value.ifEmpty { snapshot.exams })
        "22108" -> snapshot.copy(events = (snapshot.events + readTerminliste(html).value).distinctBy { it.id })
        "21411" -> snapshot.copy(konto = parseKontoauszug(html).ifEmpty { snapshot.konto })
        "1" -> snapshot.copy(startMessages = parseStartMessages(html).ifEmpty { snapshot.startMessages })
        else -> snapshot
    }

    fun link(session: SyncSession, baseUrl: String, deviceId: String, tokens: SchulnetzTokens, displayName: String): SchulnetzLinkState {
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

    fun unlink(session: SyncSession) {
        val (code, body) = fanotes("DELETE", "/link", session, null)
        if (code !in 200..299 && code != 404) throw SchulnetzHttpException(code, errorMessage(body, code))
    }

    fun saveSettings(session: SyncSession, settings: NotifySettings) {
        val payload = """{"grades":${settings.grades},"timetable":${settings.timetable},"exams":${settings.exams},"absences":${settings.absences},"events":${settings.events},"deadlines":${settings.deadlines}}"""
        val (code, body) = fanotes("PUT", "/settings", session, payload)
        if (code !in 200..299) throw SchulnetzHttpException(code, errorMessage(body, code))
    }

    fun snapshot(session: SyncSession): String {
        val (code, body) = fanotes("GET", "/snapshot", session, null)
        if (code !in 200..299) throw SchulnetzHttpException(code, errorMessage(body, code))
        return body
    }

    fun changes(session: SyncSession, since: Long): String {
        val (code, body) = fanotes("GET", "/changes?since=$since", session, null)
        if (code !in 200..299) throw SchulnetzHttpException(code, errorMessage(body, code))
        return body
    }

    fun registerEndpoint(session: SyncSession, endpoint: String) {
        val (code, body) = fanotes("PUT", "/push-endpoint", session, "{\"endpoint\":${escapeJson(endpoint)}}")
        if (code !in 200..299) throw SchulnetzHttpException(code, errorMessage(body, code))
    }

    fun testPush(session: SyncSession) {
        val (code, body) = fanotes("POST", "/push/test", session, "{}")
        if (code !in 200..299) throw SchulnetzHttpException(code, errorMessage(body, code))
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

    private fun fanotes(method: String, path: String, session: SyncSession, json: String?): Pair<Int, String> =
        call(
            method,
            "$SYNC_ORIGIN$SCHULNETZ_API_PATH$path",
            mapOf(
                "Authorization" to "Bearer ${session.token}",
                "X-FaNotes-Account" to session.accountId,
                "Accept" to "application/json",
                "Content-Type" to "application/json",
            ),
            json,
        )

    private fun call(method: String, url: String, headers: Map<String, String>, body: String?): Pair<Int, String> {
        val media = if (headers["Content-Type"]?.contains("json") == true) "application/json" else "application/x-www-form-urlencoded"
        val requestBody = when {
            method == "GET" -> null
            body == null && method == "DELETE" -> ByteArray(0).toRequestBody(null)
            else -> (body ?: "").toRequestBody(media.toMediaType())
        }
        val builder = Request.Builder().url(url).method(method, requestBody)
        headers.forEach { (name, value) -> builder.header(name, value) }
        http.newCall(builder.build()).execute().use { response ->
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
            ),
        )
    }

    companion object {
        const val CLIENT_ID = SCHULNETZ_CLIENT_ID
    }
}
