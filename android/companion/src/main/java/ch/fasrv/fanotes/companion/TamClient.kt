package ch.fasrv.fanotes.companion

import ch.fasrv.fanotes.schulnetz.GRADE_PARSER_VERSION
import ch.fasrv.fanotes.schulnetz.SchulnetzSnapshot
import ch.fasrv.fanotes.schulnetz.confirmedLessonStamps
import ch.fasrv.fanotes.schulnetz.isExamLike
import ch.fasrv.fanotes.schulnetz.isLesson
import ch.fasrv.fanotes.schulnetz.keepGradeRead
import ch.fasrv.fanotes.schulnetz.overlayDated
import ch.fasrv.fanotes.schulnetz.overlayLessons
import ch.fasrv.fanotes.schulnetz.parseIcs
import ch.fasrv.fanotes.schulnetz.parseTamAbsences
import ch.fasrv.fanotes.schulnetz.parseTamGradebook
import ch.fasrv.fanotes.schulnetz.parseTamTimetable
import ch.fasrv.fanotes.schulnetz.planWeekFetches
import ch.fasrv.fanotes.schulnetz.tamPersonId
import ch.fasrv.fanotes.schulnetz.tamReadAllowed
import ch.fasrv.fanotes.schulnetz.tamTimetableForm
import ch.fasrv.fanotes.schulnetz.tamWeekMonday
import ch.fasrv.fanotes.schulnetz.weekMondayKey
import okhttp3.FormBody
import okhttp3.OkHttpClient
import okhttp3.Request
import java.time.Instant
import java.time.LocalDate
import java.util.concurrent.TimeUnit

data class TamRequest(val method: String, val url: String, val form: List<Pair<String, String>> = emptyList(), val headers: Map<String, String> = emptyMap())
data class TamResponse(val status: Int, val body: String, val finalUrl: String = "")

/** One exchange with the TAM intranet. The client checks every request against the read allow-list first. */
fun interface TamTransport {
    fun exchange(request: TamRequest): TamResponse
}

enum class TamProblem { NONE, SIGNED_OUT, FAILED }

/**
 * A read of one TAM connection: the session check, the student's own id, the planned timetable
 * weeks, absences, grades (from the rendered gradebook) and, when the user added it, their calendar
 * export. Anything that cannot be read keeps what the previous snapshot had.
 */
class TamClient(private val transport: TamTransport) {
    data class Read(val snapshot: SchulnetzSnapshot, val problem: TamProblem, val personId: String?)

    fun fetch(
        root: String,
        previous: SchulnetzSnapshot?,
        personId: String?,
        icsUrl: String?,
        today: LocalDate,
        nowIso: String,
        renderGradebook: (() -> String?)? = null,
        trace: (String) -> Unit = {},
    ): Read {
        val before = previous ?: SchulnetzSnapshot()
        fun call(method: String, url: String, form: List<Pair<String, String>> = emptyList()): TamResponse? {
            if (!tamReadAllowed(method, url, root)) {
                trace("tam blocked method=$method path=${pathOf(url)}")
                return null
            }
            val headers = if (method == "POST") mapOf("X-Requested-With" to "XMLHttpRequest", "Referer" to "$root/timetable/classbook") else emptyMap()
            return runCatching { transport.exchange(TamRequest(method, url, form, headers)) }
                .onFailure { trace("tam failed path=${pathOf(url)} error=${it.javaClass.simpleName}") }
                .getOrNull()
        }
        fun signedOut(page: TamResponse?) = page != null && (page.status == 401 || page.status == 403 || page.body.contains("name=\"loginpassword\""))

        val home = call("GET", "$root/timetable/classbook")
        if (home == null || home.status !in 200..299 && !signedOut(home)) return Read(before.copy(readErrors = listOf("TAM: nicht erreichbar")), TamProblem.FAILED, personId)
        if (signedOut(home)) return Read(before.copy(readErrors = listOf("Bei TAM neu anmelden")), TamProblem.SIGNED_OUT, personId)

        val person = personId?.takeIf { it.isNotBlank() } ?: tamPersonId(home.body)
            ?: call("GET", "$root/list/get-person-detail-list/list/30/id/0/noListData/1/selector/config-list-edit")?.body?.let(::tamPersonId)
        if (person == null) {
            trace("tam person not found")
            return Read(before.copy(readErrors = listOf("TAM: Person nicht gefunden")), TamProblem.FAILED, null)
        }

        // The same week planner as Schulnetz: near weeks every read, far weeks daily, a batch at a time.
        val current = tamWeekMonday(today)
        val mondays = (-1L..16L).map { current.plusWeeks(it) }
        val plan = planWeekFetches(
            mondays,
            before.weekFetched + confirmedLessonStamps(before.events, before.weekFetched, before.weekRead),
            "",
            Instant.parse(nowIso),
            today,
            false,
            emptyWeeks = before.weekRead.keys.filterTo(HashSet()) { week -> before.events.none { it.isLesson() && weekMondayKey(it.start) == week } },
            unreadWeeks = before.weekFetched.keys.filterTo(HashSet()) { it !in before.weekRead },
        )
        val lessons = mutableMapOf<String, List<ch.fasrv.fanotes.schulnetz.AgendaEvent>>()
        val exams = mutableMapOf<String, List<ch.fasrv.fanotes.schulnetz.AgendaEvent>>()
        val holidays = mutableListOf<ch.fasrv.fanotes.schulnetz.SchoolVacation>()
        val read = mutableSetOf<String>()
        val attempted = mutableSetOf<String>()
        for (monday in plan.fetch) {
            val key = monday.toString()
            attempted += key
            val answer = call("POST", "$root/timetable/ajax-get-timetable", tamTimetableForm(person, monday))
            val week = answer?.takeIf { it.status in 200..299 }?.body?.let(::parseTamTimetable)
            // Shape only: why a week has no lessons.
            trace("tam week=$key status=${answer?.status ?: 0} lessons=${week?.lessons?.size ?: -1}")
            if (week == null) {
                if (signedOut(answer)) return Read(before.copy(readErrors = listOf("Bei TAM neu anmelden")), TamProblem.SIGNED_OUT, person)
                continue
            }
            // Only lessons inside the requested week answer for it.
            lessons[key] = week.lessons.filter { weekMondayKey(it.start) == key }
            exams[key] = week.exams.filter { weekMondayKey(it.start) == key }
            holidays += week.holidays
            read += key
        }
        val refreshed = lessons.filterValues { it.isNotEmpty() }.keys
        var events = overlayLessons(before.events, lessons.values.flatten(), refreshed)
        val calendar = icsUrl?.takeIf { it.isNotBlank() }?.let { url -> call("GET", url)?.takeIf { it.status in 200..299 }?.body }
            ?.takeIf { it.contains("BEGIN:VCALENDAR") }?.let(::parseIcs)
            // The calendar export holds appointments (Termine); exams stay exams.
            ?.map { event -> event.copy(id = "tam-cal-${event.id}", eventType = if (event.isExamLike()) "exam" else "event") }
        if (calendar != null) events = events.filter { it.isLesson() } + calendar
        val absences = call("GET", "$root/list/index/list/112")?.takeIf { it.status in 200..299 }?.body?.let(::parseTamAbsences)
        val gradebook = runCatching { renderGradebook?.invoke() }.getOrNull()?.let(::parseTamGradebook)
        val stamps = before.weekFetched.toMutableMap().apply { for (week in attempted) put(week, nowIso) }
        val reads = before.weekRead.toMutableMap().apply { for (week in read) put(week, nowIso) }
        val examStamps = before.examWeekFetched.toMutableMap().apply { for (week in read) put(week, nowIso) }
        val vacations = (before.vacations.filterNot { v -> holidays.any { it.id == v.id } } + holidays).distinctBy { it.id }
        val snapshot = before.copy(
            revision = before.revision + 1,
            fetchedAt = nowIso,
            grades = keepGradeRead(before.grades, gradebook.orEmpty(), gradebook != null && gradebook.isNotEmpty()),
            gradesReadComplete = gradebook != null,
            gradeParser = GRADE_PARSER_VERSION,
            events = events,
            exams = overlayDated(before.exams, exams.values.flatten(), read),
            absences = absences ?: before.absences,
            vacations = vacations,
            weekFetched = stamps,
            weekRead = reads,
            examWeekFetched = examStamps,
            weekSpanStart = before.weekSpanStart.ifBlank { mondays.first().toString() },
            weekSpanEnd = mondays.last().plusDays(4).toString().let { end -> if (before.weekSpanEnd > end) before.weekSpanEnd else end },
            readErrors = buildList {
                if (absences == null) add("TAM: Absenzen nicht lesbar")
                if (renderGradebook != null && gradebook == null) add("TAM: Noten nicht lesbar")
            },
        )
        trace("tam parsed weeks=${read.size}/${plan.fetch.size} lessons=${events.count { it.isLesson() }} exams=${snapshot.exams.size} absences=${snapshot.absences.size} grades=${snapshot.grades.size} calendar=${calendar?.size ?: -1}")
        return Read(snapshot, TamProblem.NONE, person)
    }

    private fun pathOf(url: String): String = runCatching { java.net.URI(url).path }.getOrNull().orEmpty().take(80)

    companion object {
        /** Expands every course row of the Kendo gradebook so its grades load into the page. */
        const val EXPAND_GRADEBOOK_JS = """
            var jq = window.jQuery;
            if (jq) jq('.k-grid, .k-treelist').each(function(){
              var grid = jq(this).data('kendoGrid') || jq(this).data('kendoTreeList');
              if (grid && grid.expandRow) grid.tbody.find('tr.k-master-row').each(function(){ grid.expandRow(this); });
            });
            document.querySelectorAll('tr.k-master-row .k-hierarchy-cell a').forEach(function(a){
              if (!a.parentNode.parentNode.nextElementSibling || !a.parentNode.parentNode.nextElementSibling.classList.contains('k-detail-row')) { try { a.click(); } catch (e) {} }
            });
        """
    }
}

/** OkHttp with the connection's own cookie jar (its WebView profile); refreshed cookies go back into it. */
class OkHttpTamTransport(private val slot: String) : TamTransport {
    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(25, TimeUnit.SECONDS)
        .followRedirects(true)
        .build()

    override fun exchange(request: TamRequest): TamResponse {
        val cookies = SchoolCookies.manager(slot)
        val builder = Request.Builder().url(request.url).header("User-Agent", ch.fasrv.fanotes.schulnetz.SCHULNETZ_USER_AGENT)
        request.headers.forEach { (name, value) -> builder.header(name, value) }
        cookies.getCookie(request.url)?.takeIf { it.isNotBlank() }?.let { builder.header("Cookie", it) }
        if (request.method == "POST") {
            val form = FormBody.Builder().apply { request.form.forEach { (name, value) -> add(name, value) } }.build()
            builder.post(form)
        } else {
            builder.get()
        }
        http.newCall(builder.build()).execute().use { response ->
            for (line in response.headers("Set-Cookie")) cookies.setCookie(response.request.url.toString(), line)
            if (response.headers("Set-Cookie").isNotEmpty()) cookies.flush()
            return TamResponse(response.code, response.body?.string().orEmpty(), response.request.url.toString())
        }
    }
}
