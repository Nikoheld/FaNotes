package ch.fasrv.fanotes.schulnetz

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.parseJson
import org.jsoup.Jsoup
import org.jsoup.nodes.Element
import java.time.Instant
import java.time.ZoneId

private val COURSE_TOKEN = Regex("""^[A-Za-zÄÖÜäöü0-9 ()]+-[A-Za-z0-9]+-[A-Za-zÄÖÜäöü0-9]+""")
private val DATE = Regex("""\d{2}\.\d{2}\.\d{4}""")
private val NUMBER = Regex("""-?\d+(?:[.,]\d+)?""")

data class PageRead<T>(val value: T, val error: String?, val html: String = "")

fun <T> PageRead<T>.ok(): Boolean = error == null

/** Grades page 21311. Course rows plus nested Einzelprüfungen. */
fun readGradesPage(html: String): PageRead<List<SchoolGrade>> {
    if (html.isBlank()) return PageRead(emptyList(), null)
    val problem = sessionProblem("", html)
    if (problem == SessionProblem.INTERACTIVE) return PageRead(emptyList(), sessionProblemText(problem))
    if (problem != SessionProblem.NONE) return PageRead(emptyList(), "Noten: ${sessionProblemText(problem)}", html)
    val grades = parseGradesPage(html).ifEmpty { parseSchulnetzCourseTable(html) }.ifEmpty { parseGradesByHeader(html) }
    if (grades.isNotEmpty()) return PageRead(grades, null)
    if (html.isNotBlank()) return PageRead(emptyList(), "Noten: Seite geladen, aber nicht lesbar", html)
    return PageRead(emptyList(), null)
}

fun parseGradesPage(html: String): List<SchoolGrade> {
    if (html.isBlank()) return emptyList()
    val doc = Jsoup.parse(html)
    val main = doc.selectFirst("main") ?: doc.body() ?: return emptyList()
    val outer = main.selectFirst("table") ?: return emptyList()
    val grades = mutableListOf<SchoolGrade>()
    val rows = outer.select("tr").filter { it.closestTable() == outer }
    val detailByCourse = linkedMapOf<Element, Element>()
    for (detail in outer.select("table")) {
        var row = detail.parent()?.closest("tr")
        var course: Element? = null
        while (row != null) {
            row = row.previousElementSibling()
            if (row == null || !row.tagName().equals("tr", true)) continue
            if (row.closestTable() != outer) continue
            val cells = ownCells(row, outer)
            if (cells.isNotEmpty() && COURSE_TOKEN.containsMatchIn(clean(cells[0].text())) && row.selectFirst("table") == null) {
                course = row
                break
            }
        }
        if (course != null) detailByCourse[course] = detail
    }
    for (row in rows) {
        if (row.selectFirst("table") != null) continue
        val cells = ownCells(row, outer)
        if (cells.isEmpty()) continue
        val token = cells[0].selectFirst("b")?.let { clean(it.text()) }
        val raw = clean(cells[0].text())
        val name = when {
            token != null && COURSE_TOKEN.containsMatchIn(token) -> clean(cells[0].text().replaceFirst(token, "")).ifBlank { token }
            COURSE_TOKEN.containsMatchIn(raw) -> raw
            else -> continue
        }
        val courseId = token?.takeIf { COURSE_TOKEN.containsMatchIn(it) } ?: name
        val average = cells.getOrNull(1)?.let { number(it.text()) }
        val detail = detailByCourse[row]
        val exams = detail?.let { examsFrom(it, name, courseId, average) }.orEmpty()
        grades += exams
    }
    return grades
}

fun readAbsencesPage(html: String): PageRead<List<SchoolAbsence>> {
    if (html.isBlank()) return PageRead(emptyList(), null)
    val problem = sessionProblem("", html)
    if (problem == SessionProblem.INTERACTIVE) return PageRead(emptyList(), sessionProblemText(problem))
    if (problem != SessionProblem.NONE) return PageRead(emptyList(), "Absenzen: ${sessionProblemText(problem)}", html)
    val rows = parseAbsencesPage(html).ifEmpty { parseAbsencesByHeader(html) }
    if (rows.isNotEmpty() || html.contains("Datum von")) return PageRead(rows, null)
    if (html.isNotBlank()) return PageRead(emptyList(), "Absenzen: Seite geladen, aber nicht lesbar", html)
    return PageRead(emptyList(), null)
}

fun parseAbsencesPage(html: String): List<SchoolAbsence> {
    if (html.isBlank()) return emptyList()
    val doc = Jsoup.parse(html)
    val main = doc.selectFirst("main") ?: doc.body() ?: return emptyList()
    val absences = mutableListOf<SchoolAbsence>()
    for (table in main.select("table")) {
        if (table.parent()?.tagName().equals("td", true)) continue
        val rows = table.select("tr").filter { it.closestTable() == table }
        if (rows.isEmpty()) continue
        val header = ownTexts(rows[0], table)
        if (header.isEmpty() || !header[0].startsWith("Datum von")) continue
        var index = 1
        while (index < rows.size) {
            val cells = ownTexts(rows[index], table)
            if (cells.size >= 11 && DATE.containsMatchIn(cells[0])) {
                val excused = when {
                    cells[6].lowercase().startsWith("ja") -> true
                    cells[6].lowercase().startsWith("nein") -> false
                    else -> false
                }
                absences += SchoolAbsence(
                    id = stableId("abs", cells[0], cells[1], cells[2]),
                    dateFrom = cells[0],
                    dateTo = cells[1],
                    hourFrom = "",
                    hourTo = "",
                    subject = "",
                    reason = cells[2],
                    excused = excused,
                    acknowledged = cells[10].isNotBlank(),
                    status = cells[5],
                )
            }
            index += 1
        }
    }
    return absences
}

fun readTerminliste(html: String): PageRead<List<AgendaEvent>> {
    if (html.isBlank()) return PageRead(emptyList(), null)
    val problem = sessionProblem("", html)
    if (problem == SessionProblem.INTERACTIVE) return PageRead(emptyList(), sessionProblemText(problem))
    if (problem != SessionProblem.NONE) return PageRead(emptyList(), "Termine: ${sessionProblemText(problem)}", html)
    val events = parseTerminliste(html)
    if (events.isNotEmpty() || html.contains("tblTerminliste")) return PageRead(events, null)
    if (html.isNotBlank()) return PageRead(emptyList(), "Termine: Seite geladen, aber nicht lesbar", html)
    return PageRead(emptyList(), null)
}

fun parseTerminliste(html: String): List<AgendaEvent> {
    if (html.isBlank()) return emptyList()
    val doc = Jsoup.parse(html)
    val events = mutableListOf<AgendaEvent>()
    for (table in doc.select("table")) {
        val rows = table.select("tr").filter { it.closestTable() == table }
        if (rows.size < 2) continue
        val header = ownTexts(rows[0], table).map { it.lowercase() }
        if (header.none { it.contains("datum") || it.contains("termin") || it.contains("bezeichnung") }) continue
        val dateAt = header.indexOfFirst { it.contains("datum von") }.let { if (it >= 0) it else header.indexOfFirst { it.contains("datum") } }.coerceAtLeast(0)
        val titleAt = header.indexOfFirst { it.contains("beschreibung") || it.contains("bezeichnung") || it.contains("termin") || it.contains("text") }.let { if (it < 0) 1 else it }
        for (row in rows.drop(1)) {
            val cells = ownTexts(row, table)
            if (cells.size <= dateAt) continue
            val joined = cells.joinToString(" ")
            if (joined.contains("Suchtext") || joined.contains("function ")) continue
            val date = cells.getOrNull(dateAt).orEmpty()
            if (!DATE.containsMatchIn(date) && !date.contains('-')) continue
            val title = cells.getOrNull(titleAt).orEmpty()
            if (title.isBlank()) continue
            events += AgendaEvent(
                id = stableId("term", date, title),
                start = date,
                end = date,
                text = title,
                comment = "",
                room = cells.getOrElse(titleAt + 1) { "" },
                teachers = emptyList(),
                courseId = "",
                courseName = title,
                status = "",
                eventType = "event",
                color = "",
                timetableText = title,
            )
        }
    }
    return events
}

fun readExamsPage(html: String): PageRead<List<AgendaEvent>> {
    if (html.isBlank()) return PageRead(emptyList(), null)
    val problem = sessionProblem("", html)
    if (problem == SessionProblem.INTERACTIVE) return PageRead(emptyList(), sessionProblemText(problem))
    if (problem != SessionProblem.NONE) return PageRead(emptyList(), "Prüfungen: ${sessionProblemText(problem)}", html)
    val exams = parseRenderedTimetable(html).map { it.copy(eventType = "exam") }.ifEmpty {
        parseExamsByHeader(html).ifEmpty { parseTerminliste(html) }.map { it.copy(eventType = "exam") }
    }
    if (exams.isNotEmpty()) return PageRead(exams, null)
    if (html.contains("scheduler") || html.contains("Prüfungsplan") || html.contains("Pruefungsplan")) return PageRead(emptyList(), null)
    if (html.isNotBlank()) return PageRead(emptyList(), "Prüfungen: Seite geladen, aber nicht lesbar", html)
    return PageRead(emptyList(), null)
}

/** Course rows on page 21311: name, average (`--` is empty), then Einzelprüfungen from the nested table. */
fun parseSchulnetzCourseTable(html: String): List<SchoolGrade> {
    if (html.isBlank()) return emptyList()
    val doc = Jsoup.parse(html)
    val table = doc.select("table").firstOrNull { candidate ->
        val header = candidate.select("tr").firstOrNull { it.closestTable() == candidate }?.let { ownTexts(it, candidate).map { cell -> foldLabel(cell) } }.orEmpty()
        header.any { it == "kurs" || it.startsWith("kurs ") } && header.any { it.contains("durchschnitt") }
    } ?: return emptyList()
    val grades = mutableListOf<SchoolGrade>()
    var course = ""
    var courseId = ""
    var average: Double? = null
    for (row in table.select("tr").filter { it.closestTable() == table }) {
        val nested = row.selectFirst("table")
        if (nested != null) {
            if (course.isNotBlank()) grades += examsFrom(nested, course, courseId, average)
            continue
        }
        val cells = ownTexts(row, table)
        val name = cells.firstOrNull().orEmpty()
        if (name.isBlank() || foldLabel(name) == "kurs" || name == "--") continue
        course = name
        courseId = name.substringBefore(' ').ifBlank { name }
        val avgText = cells.getOrNull(1).orEmpty()
        average = if (avgText.isBlank() || avgText == "--") null else number(avgText)
    }
    return grades
}

/** Rendered dhtmlx events on the Schülerplan or Prüfungsplan page. */
fun parseRenderedTimetable(html: String): List<AgendaEvent> {
    if (html.isBlank()) return emptyList()
    val doc = Jsoup.parse(html)
    val zone = ZoneId.of("Europe/Zurich")
    val seen = linkedSetOf<String>()
    val events = mutableListOf<AgendaEvent>()
    for (element in doc.select("[event_id]")) {
        val id = element.attr("event_id")
        if (id.isBlank() || !seen.add(id)) continue
        val classes = element.className()
        if (!classes.contains("dhx_cal_event") && !classes.contains("stpt_event")) continue
        val text = clean(element.selectFirst(".stpt_event_text")?.text().orEmpty()).ifBlank { clean(element.attr("aria-label")) }
        if (text.isBlank()) continue
        val whenLine = clean(element.selectFirst(".stpt_event_date")?.text().orEmpty())
        val startMs = element.attr("data-bar-start").toLongOrNull()
        val endMs = element.attr("data-bar-end").toLongOrNull()
        val start = if (startMs != null) Instant.ofEpochMilli(startMs).atZone(zone).toLocalDateTime().toString() else whenLine
        val end = if (endMs != null) Instant.ofEpochMilli(endMs).atZone(zone).toLocalDateTime().toString() else start
        val room = Regex("""/\s*([A-Za-z0-9.-]+)""").find(whenLine)?.groupValues?.get(1).orEmpty()
        val teacher = Regex("""Lehrperson:\s*([^;<]+)""").find(element.attr("title"))?.groupValues?.get(1)?.trim().orEmpty()
        events += AgendaEvent(
            id = id,
            start = start,
            end = end,
            text = text,
            comment = "",
            room = room,
            teachers = listOf(teacher).filter { it.isNotBlank() },
            courseId = text.substringBefore(' '),
            courseName = text.substringBefore(" ("),
            status = "",
            eventType = renderedEventType(classes, tooltipLines(element)),
            color = "",
            timetableText = text,
        )
    }
    return events
}

private fun tooltipLines(element: org.jsoup.nodes.Element): List<String> = buildList {
    if (element.attr("title").isNotBlank()) add(element.attr("title"))
    element.select("[title]").forEach { node ->
        val title = node.attr("title")
        if (title.isNotBlank()) add(title)
    }
}

/** A Prüfung or Test tooltip wins over the generic lesson block. All-day bars stay appointments. */
private fun renderedEventType(classes: String, tooltips: List<String>): String = when {
    tooltips.any(::examLead) -> "exam"
    classes.contains("event_line") -> "event"
    else -> "lesson"
}

fun parseStartRecentGrades(html: String): List<SchoolGrade> = sectionRows(html, "letzten noten").mapNotNull { cells ->
    if (cells.size < 4 || !DATE.containsMatchIn(cells[2])) return@mapNotNull null
    val mark = number(cells[3]) ?: return@mapNotNull null
    SchoolGrade(
        id = stableId("start", cells[0], cells[1], cells[2]),
        course = cells[0],
        courseId = cells[0],
        subject = cells[0],
        title = cells[1],
        date = isoDate(cells[2]),
        mark = mark,
        weight = 1.0,
        confirmed = true,
        courseGrade = null,
        comment = "",
    )
}

fun parseStartAppointments(html: String): List<AgendaEvent> = sectionRows(html, "termine").mapNotNull { cells ->
    val date = cells.firstOrNull { DATE.containsMatchIn(it) } ?: return@mapNotNull null
    val title = cells.getOrNull(3).orEmpty().ifBlank { cells.lastOrNull().orEmpty() }
    if (title.isBlank() || foldLabel(title) == "beschreibung") return@mapNotNull null
    AgendaEvent(
        id = stableId("start-term", date, title),
        start = date,
        end = cells.getOrNull(1).orEmpty().ifBlank { date },
        text = title,
        comment = "",
        room = cells.getOrNull(2).orEmpty(),
        teachers = emptyList(),
        courseId = "",
        courseName = title,
        status = "",
        eventType = "event",
        color = "",
        timetableText = title,
    )
}

fun terminlisteTotal(html: String): Int? =
    Regex("""von\s+(\d+)\s*</span>""", RegexOption.IGNORE_CASE).find(html)?.groupValues?.get(1)?.toIntOrNull()

/** Header texts and row counts for the Schulnetz log when a parser finds nothing. */
fun describeTables(html: String): String {
    if (html.isBlank()) return "tables=0"
    val doc = Jsoup.parse(html)
    val tables = doc.select("table")
    val sketches = tables.take(6).map { table ->
        val rows = table.select("tr").filter { it.closestTable() == table }
        val header = rows.firstOrNull()?.let { ownTexts(it, table).joinToString("/") { cell -> cell.take(24) } }.orEmpty()
        "rows=${rows.size}[${header.take(140)}]"
    }
    return "tables=${tables.size} " + sketches.joinToString(" | ")
}

fun parseGradesByHeader(html: String): List<SchoolGrade> = rowsByHeader(html) { header, cells ->
    val markAt = headerIndex(header, "note", "punkte")
    val dateAt = headerIndex(header, "datum")
    val courseAt = headerIndex(header, "fach", "kurs", "fachname")
    if (markAt < 0 || (dateAt < 0 && courseAt < 0)) return@rowsByHeader null
    val mark = number(cellAt(cells, markAt)) ?: return@rowsByHeader null
    val course = cellAt(cells, courseAt).ifBlank { "Kurs" }
    val date = cellAt(cells, dateAt)
    val title = cellAt(cells, headerIndex(header, "thema", "pruefung", "titel", "bezeichnung")).ifBlank { "Note" }
    if (isSummaryGradeTitle(title) || isSummaryGradeTitle(course)) return@rowsByHeader null
    val weight = number(cellAt(cells, headerIndex(header, "gewicht"))) ?: 1.0
    SchoolGrade(
        id = stableId("grade", course, date, title, numKey(mark)),
        course = course,
        courseId = course,
        subject = course,
        title = title,
        date = if (DATE.containsMatchIn(date)) isoDate(date) else "",
        mark = mark,
        weight = weight,
        confirmed = true,
        courseGrade = null,
        comment = "",
    )
}

fun parseAbsencesByHeader(html: String): List<SchoolAbsence> {
    val found = mutableListOf<SchoolAbsence>()
    eachHeaderTable(html) { header, rows ->
        val dateAt = headerIndex(header, "datum")
        val reasonAt = headerIndex(header, "grund", "bemerkung")
        val statusAt = headerIndex(header, "status", "entschuldigt")
        val subjectAt = headerIndex(header, "lektion", "fach", "kurs")
        val timeAt = headerIndex(header, "zeit", "stunde")
        if (dateAt < 0 || (reasonAt < 0 && statusAt < 0 && subjectAt < 0)) return@eachHeaderTable
        for (cells in rows) {
            val date = cellAt(cells, dateAt)
            if (!DATE.containsMatchIn(date)) continue
            val status = cellAt(cells, statusAt)
            val deadlineAt = headerIndex(header, "entschuldig", "frist")
            found += SchoolAbsence(
                id = stableId("abs", date, cellAt(cells, reasonAt), cellAt(cells, subjectAt)),
                dateFrom = date,
                dateTo = date,
                hourFrom = cellAt(cells, timeAt),
                hourTo = "",
                subject = cellAt(cells, subjectAt),
                reason = cellAt(cells, reasonAt),
                excused = status.lowercase().startsWith("ja") || status.lowercase().contains("entschuldigt"),
                acknowledged = false,
                status = status,
                excuseUntil = cellAt(cells, deadlineAt),
            )
        }
    }
    return found
}

fun parseExamsByHeader(html: String): List<AgendaEvent> {
    val found = mutableListOf<AgendaEvent>()
    eachHeaderTable(html) { header, rows ->
        val dateAt = headerIndex(header, "datum")
        val courseAt = headerIndex(header, "kurs", "fach", "fachname")
        val topicAt = headerIndex(header, "thema", "pruefung", "titel", "bezeichnung")
        if (dateAt < 0 || (courseAt < 0 && topicAt < 0)) return@eachHeaderTable
        if (headerIndex(header, "note", "punkte") >= 0 && courseAt < 0) return@eachHeaderTable
        for (cells in rows) {
            val date = cellAt(cells, dateAt)
            if (!DATE.containsMatchIn(date)) continue
            val title = cellAt(cells, topicAt).ifBlank { cellAt(cells, courseAt).ifBlank { "Prüfung" } }
            val course = cellAt(cells, courseAt).ifBlank { title }
            found += AgendaEvent(
                id = stableId("exam", date, course, title),
                start = isoDate(date),
                end = isoDate(date),
                text = title,
                comment = "",
                room = "",
                teachers = emptyList(),
                courseId = course,
                courseName = course,
                status = "",
                eventType = "exam",
                color = "",
                timetableText = title,
            )
        }
    }
    return found
}

/** Events the Schülerplan page already drew, or a Zeit/Fach/Raum table. */
fun parseTimetableHtml(html: String): List<AgendaEvent> {
    if (html.isBlank()) return emptyList()
    val doc = Jsoup.parse(html)
    val drawn = doc.select(".dhx_cal_event").mapNotNull { event ->
        val title = clean(event.selectFirst(".dhx_title")?.text().orEmpty())
        val body = clean(event.selectFirst(".dhx_body")?.text().orEmpty())
        val label = body.ifBlank { title }
        if (label.isBlank()) return@mapNotNull null
        AgendaEvent(
            id = event.attr("event_id").ifBlank { stableId("dhx", title, label) },
            start = title,
            end = title,
            text = label,
            comment = "",
            room = "",
            teachers = emptyList(),
            courseId = "",
            courseName = label,
            status = "",
            eventType = if (examLead(label) || tooltipLines(event).any(::examLead)) "exam" else "lesson",
            color = "",
            timetableText = label,
        )
    }
    if (drawn.isNotEmpty()) return drawn
    val found = mutableListOf<AgendaEvent>()
    eachHeaderTable(html) { header, rows ->
        val timeAt = headerIndex(header, "zeit", "von", "stunde")
        val courseAt = headerIndex(header, "fach", "kurs", "lektion")
        val roomAt = headerIndex(header, "raum", "zimmer")
        if (timeAt < 0 || courseAt < 0) return@eachHeaderTable
        for (cells in rows) {
            val course = cellAt(cells, courseAt)
            if (course.isBlank()) continue
            val time = cellAt(cells, timeAt)
            found += AgendaEvent(
                id = stableId("plan", time, course, cellAt(cells, roomAt)),
                start = time,
                end = time,
                text = course,
                comment = "",
                room = cellAt(cells, roomAt),
                teachers = emptyList(),
                courseId = course,
                courseName = course,
                status = "",
                eventType = if (examLead(course)) "exam" else "lesson",
                color = "",
                timetableText = course,
            )
        }
    }
    return found
}

/** `{url, events}` note captured from the live Schülerplan scheduler. */
fun parseSchedulerNote(note: String): Pair<String, List<AgendaEvent>> {
    if (note.isBlank()) return "" to emptyList()
    val obj = runCatching { parseJson(note) as? JsonValue.Obj }.getOrNull() ?: return "" to emptyList()
    val url = obj.string("url").orEmpty()
    val events = obj.array("events")?.items.orEmpty().mapNotNull { item ->
        val event = item as? JsonValue.Obj ?: return@mapNotNull null
        val text = event.string("text").orEmpty()
        val start = event.string("start").orEmpty()
        if (text.isBlank() && start.isBlank()) return@mapNotNull null
        AgendaEvent(
            id = event.string("id").orEmpty().ifBlank { stableId("sched", start, text) },
            start = schedulerTime(start),
            end = schedulerTime(event.string("end").orEmpty().ifBlank { start }),
            text = text,
            comment = "",
            room = event.string("room").orEmpty(),
            teachers = listOf(event.string("teacher").orEmpty()).filter { it.isNotBlank() },
            courseId = "",
            courseName = text,
            status = "",
            eventType = canonicalEventType(event.string("event_type").orEmpty().ifBlank { if (examLead(text)) "test" else "" }),
            color = "",
            timetableText = text,
        )
    }
    return url to events
}

fun parseSchedulerXml(xml: String): List<AgendaEvent> {
    if (xml.isBlank() || !xml.contains("<event")) return emptyList()
    return Regex("""(?is)<event\b([^>]*)>(.*?)</event>""").findAll(xml).mapNotNull { block ->
        val attrs = block.groupValues[1]
        val inner = block.groupValues[2]
        fun field(name: String): String {
            val match = Regex("""(?is)<$name\b[^>]*>(.*?)</$name>""").find(inner) ?: return ""
            return decodeXmlText(cleanSchulnetzText(match.groupValues[1]))
        }
        val start = schedulerStamp(field("start_date"), field("vdatum"), field("vzeit"))
        if (start.isBlank()) return@mapNotNull null
        val end = schedulerStamp(field("end_date"), field("bdatum"), field("bzeit")).ifBlank { start }
        val text = field("text")
        val course = field("kurskuerzel").ifBlank { field("fachkuerzel") }.ifBlank { text }
        val room = field("zimmerkuerzel").ifBlank { field("zimmer") }
        val teacher = field("lehrerkuerzelname")
        val comment = field("kommentar")
        val kind = field("event_type")
        val idAttr = Regex("""\bid\s*=\s*["']([^"']+)["']""").find(attrs)?.groupValues?.get(1).orEmpty()
        AgendaEvent(
            id = idAttr.ifBlank { field("identity") }.ifBlank { stableId("sched", start, text, course) },
            start = schedulerTime(start),
            end = schedulerTime(end),
            text = text,
            comment = comment,
            room = room,
            teachers = listOf(teacher).filter { it.isNotBlank() },
            courseId = field("kursid"),
            courseName = course.ifBlank { text },
            status = if (comment.lowercase().contains("fällt") || comment.lowercase().contains("faellt")) "cancelled" else "",
            eventType = canonicalEventType(kind),
            color = field("color"),
            timetableText = text,
        )
    }.toList()
}

fun parseIcs(text: String): List<AgendaEvent> {
    if (!text.contains("BEGIN:VEVENT")) return emptyList()
    return text.split("BEGIN:VEVENT").drop(1).mapNotNull { block ->
        val body = block.substringBefore("END:VEVENT")
        val summary = icsValue(body, "SUMMARY") ?: return@mapNotNull null
        val start = icsValue(body, "DTSTART") ?: return@mapNotNull null
        val end = icsValue(body, "DTEND") ?: start
        val uid = icsValue(body, "UID") ?: stableId("ics", start, summary)
        AgendaEvent(
            id = uid,
            start = icsTime(start),
            end = icsTime(end),
            text = summary,
            comment = icsValue(body, "DESCRIPTION").orEmpty(),
            room = icsValue(body, "LOCATION").orEmpty(),
            teachers = emptyList(),
            courseId = "",
            courseName = summary,
            status = "",
            eventType = if (examLead(summary) || examMarker(icsValue(body, "CATEGORIES").orEmpty())) "exam" else "lesson",
            color = "",
            timetableText = summary,
        )
    }
}

fun findIcalUrl(html: String, baseUrl: String): String? {
    val href = Regex("""(?i)href=["']([^"']+\.ics[^"']*)["']""").find(html)?.groupValues?.get(1)
    val call = Regex("""(?i)icalAbo\(\s*['"]([^'"]+)['"]""").find(html)?.groupValues?.get(1)
    val raw = href ?: call ?: return null
    if (raw.startsWith("http")) return raw
    if (raw.startsWith("//")) return "https:$raw"
    return baseUrl.trimEnd('/') + "/" + raw.trimStart('/')
}

private fun sectionRows(html: String, heading: String): List<List<String>> {
    val doc = Jsoup.parse(html)
    val head = doc.select("h1, h2, h3, h4").firstOrNull { foldLabel(it.text()).contains(heading) } ?: return emptyList()
    var node = head.parent()
    repeat(4) {
        val table = node?.selectFirst("table")
        if (table != null) {
            return table.select("tr").filter { it.closestTable() == table }.map { ownTexts(it, table) }.filter { it.any(String::isNotBlank) }
        }
        node = node?.parent()
    }
    return emptyList()
}

private fun cellAt(cells: List<String>, index: Int): String =
    if (index < 0 || index >= cells.size) "" else cells[index]

private fun <T> rowsByHeader(html: String, read: (List<String>, List<String>) -> T?): List<T> {
    val found = mutableListOf<T>()
    eachHeaderTable(html) { header, rows ->
        for (cells in rows) {
            val item = read(header, cells) ?: continue
            found += item
        }
    }
    return found
}

private fun eachHeaderTable(html: String, block: (List<String>, List<List<String>>) -> Unit) {
    if (html.isBlank()) return
    val doc = Jsoup.parse(html)
    for (table in doc.select("table")) {
        val rows = table.select("tr").filter { it.closestTable() == table }
        if (rows.size < 2) continue
        val header = ownTexts(rows[0], table).map { foldLabel(it) }
        if (header.all { it.isBlank() }) continue
        val body = rows.drop(1).map { ownTexts(it, table) }.filter { cells -> cells.any { it.isNotBlank() } }
        block(header, body)
    }
}

private fun headerIndex(header: List<String>, vararg keys: String): Int =
    header.indexOfFirst { cell ->
        cell.split(' ').any { word ->
            keys.any { key ->
                if (key == "note" && (word.startsWith("notendurch") || word.startsWith("notenschnitt"))) false
                else word == key || word.startsWith(key)
            }
        }
    }

private fun foldLabel(raw: String): String =
    raw.lowercase()
        .replace("ä", "ae")
        .replace("ö", "oe")
        .replace("ü", "ue")
        .replace("ß", "ss")
        .replace(Regex("[^a-z0-9]+"), " ")
        .trim()

private fun examsFrom(detail: Element, course: String, courseId: String, average: Double?): List<SchoolGrade> {
    val exams = mutableListOf<SchoolGrade>()
    for (row in detail.select("tr")) {
        val cells = row.select("th, td").map { clean(it.text()) }
        if (cells.isEmpty()) continue
        val first = cells[0]
        if (first == "Prüfungsgruppe" || first == "Einzelprüfungen" || isSummaryGradeTitle(first) || first.startsWith("Aktueller Durchschnitt")) continue
        val values = if (cells[0].isBlank()) cells.drop(1) else cells
        if (values.any { isSummaryGradeTitle(it) } && !DATE.containsMatchIn(values.getOrElse(0) { "" })) continue
        if (values.size < 2 || !DATE.containsMatchIn(values[0])) continue
        val markCell = values.getOrElse(2) { "" }.substringBefore("Details")
        val mark = number(markCell)
        exams += SchoolGrade(
            id = stableId("exam", courseId, values[0], values[1], numKey(mark)),
            course = course,
            courseId = courseId,
            subject = course,
            title = values[1],
            date = isoDate(values[0]),
            mark = mark,
            weight = number(values.getOrElse(3) { "" }) ?: 1.0,
            confirmed = true,
            courseGrade = average,
            comment = "",
        )
    }
    return exams
}

private fun ownCells(row: Element, table: Element): List<Element> =
    row.select("th, td").filter { it.closestTable() == table }

private fun ownTexts(row: Element, table: Element): List<String> = ownCells(row, table).map { clean(it.text()) }

private fun Element.closestTable(): Element? {
    var node: Element? = this
    while (node != null) {
        if (node.tagName().equals("table", true)) return node
        node = node.parent()
    }
    return null
}

private fun clean(text: String) = text.replace(Regex("""\s+"""), " ").trim()

private fun number(text: String): Double? {
    val match = NUMBER.find(text.replace(" ", "")) ?: return null
    return parseMark(match.value) ?: match.value.replace(',', '.').toDoubleOrNull()
}

private fun isoDate(swiss: String): String {
    val match = Regex("""(\d{2})\.(\d{2})\.(\d{4})""").find(swiss) ?: return swiss
    return "${match.groupValues[3]}-${match.groupValues[2]}-${match.groupValues[1]}"
}

private fun decodeXmlText(raw: String): String = raw
    .replace("&lt;", "<")
    .replace("&gt;", ">")
    .replace("&quot;", "\"")
    .replace("&apos;", "'")
    .replace("&amp;", "&")

private fun schedulerTime(raw: String): String {
    val match = Regex("""(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})""").find(raw)
    return if (match == null) raw else "${match.groupValues[1]}T${match.groupValues[2]}:00"
}

/** `start_date` when it carries a day. Prüfungsplan rows often leave it blank and use von/bis instead. */
private fun schedulerStamp(direct: String, day: String, clock: String): String {
    val dated = if (hasSchedulerDay(direct)) direct else ""
    val raw = dated.ifBlank {
        if (!hasSchedulerDay(day)) "" else if (Regex("""\d{2}:\d{2}""").containsMatchIn(clock)) "$day $clock" else day
    }
    if (raw.isBlank()) return ""
    val swiss = Regex("""(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[ T](\d{2}:\d{2}))?""").find(raw) ?: return raw
    val date = "${swiss.groupValues[3]}-${swiss.groupValues[2].padStart(2, '0')}-${swiss.groupValues[1].padStart(2, '0')}"
    val time = swiss.groupValues[4]
    return if (time.isBlank()) date else "$date $time"
}

private fun hasSchedulerDay(raw: String): Boolean =
    Regex("""\d{4}-\d{2}-\d{2}|\d{1,2}\.\d{1,2}\.\d{4}""").containsMatchIn(raw)

private fun icsValue(block: String, name: String): String? =
    Regex("""(?m)^$name(?:;[^:]*)?:(.+)$""").find(block)?.groupValues?.get(1)?.trim()?.replace("\\n", "\n")?.replace("\\,", ",")

private fun icsTime(raw: String): String {
    val compact = Regex("""(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})""").find(raw)
    if (compact != null) {
        return "${compact.groupValues[1]}-${compact.groupValues[2]}-${compact.groupValues[3]}T${compact.groupValues[4]}:${compact.groupValues[5]}:00"
    }
    val day = Regex("""(\d{4})(\d{2})(\d{2})""").find(raw) ?: return raw
    return "${day.groupValues[1]}-${day.groupValues[2]}-${day.groupValues[3]}"
}
