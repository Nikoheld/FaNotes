package ch.fasrv.fanotes.schulnetz

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.parseJson
import org.jsoup.Jsoup
import java.net.URI
import java.time.DayOfWeek
import java.time.LocalDate
import java.time.temporal.TemporalAdjusters

/*
 * TAM intranet (https://intranet.tam.ch/<school>), the platform of the Zurich Sek II schools, as a
 * second provider next to Schulnetz. There is no official API. What this reads, and how, follows the
 * public markup of the login page and the open-source clients that document the same endpoints:
 *
 *  - sign-in: the user signs in on the school's own page in a WebView (password, Microsoft/Azure,
 *    "Zentrale Anmeldung", captcha or SMS code); Kanti+ never sees the password. Signed in means the
 *    password form is gone and the page carries `csrfToken='…'`. The session cookie is `sturmsession`.
 *  - timetable: POST <root>/timetable/ajax-get-timetable with startDate/endDate (epoch ms),
 *    studentId[]=<own person id>, holidaysOnly=0. A query: it changes nothing, but it is a POST, so it
 *    is the one POST the read allow-list permits.
 *  - own person id: GET <root>/list/get-person-detail-list/list/30/id/0/noListData/1/selector/config-list-edit
 *    (`personData = [{…"PersonID"…}]`).
 *  - absences: GET <root>/list/index/list/112 (`gridDataAndConfiguration:{…}` with data.data[]).
 *  - grades: GET <root>/gradebook, a Kendo grid (k-master-row per course, grade rows with
 *    data-field title/value/date/gradeWeight) once rendered.
 *  - appointments: the user's own TAM calendar export (…/rest/ics/…/calendar.ics), when they add it.
 */

const val TAM_HOST = "intranet.tam.ch"
private val TAM_SLUG = Regex("^[a-z0-9][a-z0-9-]{1,19}$")

/** "https://intranet.tam.ch/bmz", from that URL, a deeper page of it, or the bare school code "bmz". */
fun tamSchoolRoot(input: String?): String? {
    val raw = input?.trim().orEmpty()
    if (raw.isBlank()) return null
    val slug = if (!raw.contains('/') && !raw.contains('.')) raw.lowercase() else {
        val uri = runCatching { URI(if (raw.contains("://")) raw else "https://$raw") }.getOrNull() ?: return null
        if (!uri.host.equals(TAM_HOST, ignoreCase = true)) return null
        if (uri.scheme != null && !uri.scheme.equals("https", ignoreCase = true)) return null
        uri.path.orEmpty().trim('/').substringBefore('/').lowercase()
    }
    if (!slug.matches(TAM_SLUG) || slug in TAM_RESERVED) return null
    return "https://$TAM_HOST/$slug"
}

/** Path segments of intranet.tam.ch that are not schools. */
private val TAM_RESERVED = setOf("auth", "themes", "public", "rest", "js", "css", "img", "images", "default", "logout")

fun tamSlug(root: String): String = runCatching { URI(root).path.trim('/').substringBefore('/') }.getOrNull().orEmpty()

/** True on a signed-in intranet page of this school: the password form is gone, a CSRF token is set. */
fun tamSignedIn(url: String, html: String, root: String): Boolean {
    val uri = runCatching { URI(url) }.getOrNull() ?: return false
    if (!uri.host.equals(TAM_HOST, ignoreCase = true)) return false
    val slug = tamSlug(root)
    if (slug.isBlank() || !uri.path.orEmpty().trim('/').startsWith(slug)) return false
    if (Regex("""name\s*=\s*["']loginpassword["']""").containsMatchIn(html)) return false
    if (Regex("""id\s*=\s*["'](captcha|lo-sms-dialog)["']""").containsMatchIn(html) && html.contains("loginuser")) return false
    return tamCsrfToken(html) != null
}

fun tamCsrfToken(html: String): String? = Regex("""csrfToken\s*=\s*['"](\w+)['"]""").find(html)?.groupValues?.get(1)

/** The signed-in person's id from `personData = [{…}]` (own-account list 30) or a resource list. */
fun tamPersonId(html: String): String? {
    val block = Regex("""personData\s*=\s*\[(\{[\s\S]*?\})\]""").find(html)?.groupValues?.get(1) ?: return null
    val obj = runCatching { parseJson(block) as? JsonValue.Obj }.getOrNull() ?: return null
    val id = obj.flexString("PersonID", "personId", "Person.PersonID")
    return id.takeIf { it.matches(Regex("^[0-9]{1,12}$")) }
}

/**
 * The read allow-list for TAM: GET on this school's pages, and the one query POST
 * (timetable/ajax-get-timetable). Sign-in, logout, password, save, send and delete never run.
 */
fun tamReadAllowed(method: String, url: String, root: String): Boolean {
    val uri = runCatching { URI(url) }.getOrNull() ?: return false
    if (!uri.scheme.equals("https", ignoreCase = true) || !uri.host.equals(TAM_HOST, ignoreCase = true)) return false
    val slug = tamSlug(root)
    val path = uri.path.orEmpty()
    if (slug.isBlank() || !path.startsWith("/$slug/") && path != "/$slug") return false
    if (tamActionBlocked(url)) return false
    return when (method.uppercase()) {
        "GET" -> true
        "POST" -> path == "/$slug/timetable/ajax-get-timetable"
        else -> false
    }
}

/** TAM URLs that change something or end the session; the sign-in page may not open them either. */
fun tamActionBlocked(url: String): Boolean {
    val path = runCatching { URI(url).path }.getOrNull().orEmpty().lowercase()
    if (!url.contains(TAM_HOST, ignoreCase = true)) return false
    return path.endsWith("/logout") || listOf(
        "ajax-save", "/save", "send-case", "send-mail", "sendmail", "/delete", "ajax-delete", "/update", "ajax-update",
        "temporary-password", "new-password", "change-password", "set-password", "bug-tracker",
    ).any { path.contains(it) }
}

/** The sign-in page may navigate the school's site and identity providers over https. */
fun tamLoginWebViewAllowed(url: String): Boolean {
    val uri = runCatching { URI(url) }.getOrNull() ?: return false
    if (uri.scheme.equals("about", ignoreCase = true)) return true
    return uri.scheme.equals("https", ignoreCase = true) && !uri.host.isNullOrBlank()
}

/** The form of one timetable week: Monday 00:00 to Sunday 23:59:59 in Zurich, as epoch milliseconds. */
fun tamTimetableForm(personId: String, monday: LocalDate): List<Pair<String, String>> {
    val start = monday.atStartOfDay(SCHOOL_ZONE).toInstant().toEpochMilli()
    val end = monday.plusDays(7).atStartOfDay(SCHOOL_ZONE).toInstant().toEpochMilli() - 1
    return listOf("startDate" to start.toString(), "endDate" to end.toString(), "studentId[]" to personId, "holidaysOnly" to "0")
}

fun tamWeekMonday(day: LocalDate): LocalDate = day.with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY))

data class TamWeek(val lessons: List<AgendaEvent>, val exams: List<AgendaEvent>, val holidays: List<SchoolVacation>)

/**
 * One ajax-get-timetable answer. Null when it is not a timetable answer at all (signed out, error
 * page), so the caller keeps what it had; an answer with an empty data array is a free week.
 */
fun parseTamTimetable(json: String): TamWeek? {
    val obj = runCatching { parseJson(json.trim()) as? JsonValue.Obj }.getOrNull() ?: return null
    val data = obj.array("data") ?: return null
    if (obj.fields.containsKey("status") && obj.flexString("status") == "0") return null
    val lessons = mutableListOf<AgendaEvent>()
    val exams = mutableListOf<AgendaEvent>()
    val holidays = mutableListOf<SchoolVacation>()
    for (item in data.items) {
        val row = item as? JsonValue.Obj ?: continue
        val id = row.flexString("id").ifBlank { continue }
        val date = row.flexString("lessonDate").take(10)
        if (!date.matches(Regex("""\d{4}-\d{2}-\d{2}"""))) continue
        val from = clock(row.flexString("lessonStart"))
        val to = clock(row.flexString("lessonEnd")).ifBlank { from }
        val subject = row.flexString("subjectName").ifBlank { row.flexString("courseName") }.ifBlank { row.flexString("title") }
        val holiday = row.flexString("holidayId").let { it.isNotBlank() && it != "0" } || row.flexBool("isAllDay") && subject.isBlank()
        if (holiday) {
            holidays += SchoolVacation(id = "tam-holiday-$id", name = row.flexString("title").ifBlank { "Ferien" }, start = date, end = date)
            continue
        }
        if (from.isBlank()) continue
        val kind = (row.flexString("timetableEntryTypeShort") + " " + row.flexString("timetableEntryTypeLong") + " " + row.flexString("timetableEntryType")).lowercase()
        val cancelled = kind.contains("cancel")
        val teachers = row.flexList("teacherFullName").ifEmpty { listOf(row.flexString("teacherAcronym")) }.filter { it.isNotBlank() }
        val note = listOfNotNull(
            "Raumänderung".takeIf { kind.contains("room changed") },
            "Vertretung".takeIf { kind.contains("teacher changed") || kind.contains("substitution") },
            row.flexString("message").takeIf { it.isNotBlank() && it != "null" },
        ).joinToString(" · ")
        val course = row.flexString("courseName").ifBlank { subject }
        val base = AgendaEvent(
            id = "tam-$id",
            start = "${date}T$from",
            end = "${date}T$to",
            text = subject.ifBlank { "Lektion" },
            comment = note,
            room = row.flexString("roomName").ifBlank { row.flexString("locationDescription") },
            teachers = teachers,
            courseId = row.flexString("courseId").ifBlank { course },
            courseName = course,
            status = if (cancelled) "entfällt" else "",
            eventType = "0_stp",
            color = "",
            timetableText = row.flexString("title").ifBlank { subject },
        )
        lessons += base
        if (row.flexBool("hasExam") || row.flexBool("isExamLesson")) {
            exams += base.copy(id = "tam-exam-$id", eventType = "exam", text = "Prüfung ${base.text}".trim(), timetableText = "Prüfung ${base.text}".trim(), status = base.status)
        }
    }
    return TamWeek(lessons, exams, holidays)
}

private fun clock(raw: String): String {
    val match = Regex("""(\d{1,2}):(\d{2})(?::(\d{2}))?""").find(raw) ?: return ""
    return "${match.groupValues[1].padStart(2, '0')}:${match.groupValues[2]}:${match.groupValues[3].ifBlank { "00" }}"
}

/** The rows of a TAM list page: the JSON object after `gridDataAndConfiguration:`, data.data[]. */
fun tamGridRows(html: String): List<JsonValue.Obj>? {
    val marker = html.indexOf("gridDataAndConfiguration")
    if (marker < 0) return null
    val open = html.indexOf('{', marker)
    if (open < 0) return null
    val close = matchingBrace(html, open) ?: return null
    val obj = runCatching { parseJson(html.substring(open, close + 1)) as? JsonValue.Obj }.getOrNull() ?: return null
    val data = obj.obj("data")?.array("data") ?: obj.array("data") ?: return null
    return data.items.mapNotNull { it as? JsonValue.Obj }
}

/** Index of the brace closing the one at [open], skipping string contents. */
private fun matchingBrace(text: String, open: Int): Int? {
    var depth = 0
    var inString = false
    var quote = '"'
    var index = open
    while (index < text.length) {
        val char = text[index]
        if (inString) {
            if (char == '\\') index += 1 else if (char == quote) inString = false
        } else when (char) {
            '"', '\'' -> { inString = true; quote = char }
            '{' -> depth += 1
            '}' -> { depth -= 1; if (depth == 0) return index }
        }
        index += 1
    }
    return null
}

/** Absences from list 112. Null when the page holds no absence list (signed out, other layout). */
fun parseTamAbsences(html: String): List<SchoolAbsence>? {
    val rows = tamGridRows(html) ?: return null
    return rows.mapNotNull { row ->
        val day = swissToIso(row.flexString("Datum").take(10)) ?: return@mapNotNull null
        val status = row.flexString("Status")
        val id = row.flexString("AbsenceEventID").ifBlank { stableId("tam-abs", day, row.flexString("Kurs_Anlass"), row.flexString("Zeit_Anzahl_Lekt")) }
        val excused = status.lowercase().let { it.contains("entschuldigt") && !it.contains("unentschuldigt") && !it.contains("nicht") || it.contains("bewilligt") }
        SchoolAbsence(
            id = "tam-abs-$id",
            dateFrom = day,
            dateTo = day,
            hourFrom = "",
            hourTo = "",
            subject = cleanSchulnetzText(row.flexString("Kurs_Anlass")),
            reason = cleanSchulnetzText(row.flexString("Absenztype").ifBlank { row.flexString("Absenzgruppe") }),
            excused = excused,
            acknowledged = status.isNotBlank() && !status.lowercase().contains("offen"),
            status = cleanSchulnetzText(status),
        )
    }
}

/**
 * Grades from the rendered gradebook: each course is a `tr.k-master-row` (data-field courseName),
 * its grades are the `tr[data-uid]` rows of the detail row after it, with data-field title, value,
 * date and gradeWeight. Rows without date and weight are averages or bonus lines, not grades. Null
 * when the page has no gradebook grid (signed out, not rendered).
 */
fun parseTamGradebook(html: String): List<SchoolGrade>? {
    val doc = Jsoup.parse(html)
    val masters = doc.select("tr.k-master-row")
    if (masters.isEmpty()) return null
    val grades = mutableListOf<SchoolGrade>()
    for (master in masters) {
        val course = cleanSchulnetzText(master.selectFirst("[data-field=courseName]")?.text().orEmpty())
        if (course.isBlank()) continue
        val detail = master.nextElementSibling()?.takeIf { it.hasClass("k-detail-row") } ?: continue
        for (row in detail.select("tr[data-uid]")) {
            fun field(name: String) = cleanSchulnetzText(row.selectFirst("[data-field=$name]")?.text().orEmpty())
            val title = field("title")
            val date = swissToIso(field("date"))
            val weightText = field("gradeWeight")
            val weight = weightText.replace(',', '.').toDoubleOrNull()
            if (date == null && weight == null) continue
            val mark = parseMark(field("value"))
            grades += SchoolGrade(
                id = stableId("tam-grade", course, date.orEmpty(), title, mark?.toString().orEmpty()),
                course = course,
                courseId = course,
                subject = course,
                title = title,
                date = date.orEmpty(),
                mark = mark,
                weight = weight ?: 1.0,
                confirmed = true,
                courseGrade = null,
                comment = "",
            )
        }
    }
    return grades
}

private fun swissToIso(raw: String): String? {
    val match = Regex("""(\d{1,2})\.(\d{1,2})\.(\d{4})""").find(raw) ?: Regex("""(\d{4})-(\d{2})-(\d{2})""").find(raw)?.let { iso ->
        return "${iso.groupValues[1]}-${iso.groupValues[2]}-${iso.groupValues[3]}"
    } ?: return null
    return "${match.groupValues[3]}-${match.groupValues[2].padStart(2, '0')}-${match.groupValues[1].padStart(2, '0')}"
}

private fun JsonValue.Obj.flexList(key: String): List<String> = when (val value = fields[key]) {
    is JsonValue.Arr -> value.items.mapNotNull { (it as? JsonValue.Str)?.value?.trim() }
    is JsonValue.Str -> listOf(value.value.trim())
    else -> emptyList()
}
