package ch.fasrv.fanotes.schulnetz

import org.jsoup.Jsoup
import org.jsoup.nodes.Element
import org.w3c.dom.Element as XmlElement
import javax.xml.parsers.DocumentBuilderFactory

private val COURSE_TOKEN = Regex("""^[A-Za-zÄÖÜäöü0-9 ()]+-[A-Za-z0-9]+-[A-Za-zÄÖÜäöü0-9]+""")
private val DATE = Regex("""\d{2}\.\d{2}\.\d{4}""")
private val NUMBER = Regex("""-?\d+(?:[.,]\d+)?""")

data class PageRead<T>(val value: T, val error: String?, val html: String = "")

fun <T> PageRead<T>.ok(): Boolean = error == null

/** Grades page 21311. Course rows plus nested Einzelprüfungen. */
fun readGradesPage(html: String): PageRead<List<SchoolGrade>> {
    val problem = sessionProblem("", html)
    if (problem != SessionProblem.NONE) return PageRead(emptyList(), "Noten: ${sessionProblemText(problem)}", html)
    val grades = parseGradesPage(html)
    val recognized = grades.isNotEmpty() || html.contains("Notendurchschnitt") || html.contains("Einzelprüfungen")
    if (!recognized) return PageRead(emptyList(), "Noten: Seite konnte nicht gelesen werden", html)
    return PageRead(grades, null)
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
        if (exams.isNotEmpty()) grades += exams
        else if (average != null) {
            grades += SchoolGrade(
                id = stableId("course", courseId, numKey(average)),
                course = name,
                courseId = courseId,
                subject = name,
                title = "Durchschnitt",
                date = "",
                mark = average,
                weight = 1.0,
                confirmed = clean(row.text()).lowercase().let { it.contains("bestätigt") && !it.contains("bestätigen") },
                courseGrade = average,
                comment = "",
            )
        }
    }
    return grades
}

fun readAbsencesPage(html: String): PageRead<List<SchoolAbsence>> {
    val problem = sessionProblem("", html)
    if (problem != SessionProblem.NONE) return PageRead(emptyList(), "Absenzen: ${sessionProblemText(problem)}", html)
    val rows = parseAbsencesPage(html)
    val recognized = rows.isNotEmpty() || html.contains("Datum von")
    if (!recognized) return PageRead(emptyList(), "Absenzen: Seite konnte nicht gelesen werden", html)
    return PageRead(rows, null)
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
    val problem = sessionProblem("", html)
    if (problem != SessionProblem.NONE) return PageRead(emptyList(), "Termine: ${sessionProblemText(problem)}", html)
    val events = parseTerminliste(html)
    val recognized = events.isNotEmpty() || html.contains("tblTerminliste") || html.contains("Termin")
    if (!recognized) return PageRead(emptyList(), "Termine: Seite konnte nicht gelesen werden", html)
    return PageRead(events, null)
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
        val dateAt = header.indexOfFirst { it.contains("datum") }.coerceAtLeast(0)
        val titleAt = header.indexOfFirst { it.contains("bezeichnung") || it.contains("termin") || it.contains("text") }.let { if (it < 0) 1 else it }
        for (row in rows.drop(1)) {
            val cells = ownTexts(row, table)
            if (cells.size <= dateAt) continue
            val date = cells.getOrNull(dateAt).orEmpty()
            if (!DATE.containsMatchIn(date) && !date.contains('-')) continue
            val title = cells.getOrNull(titleAt).orEmpty().ifBlank { "Termin" }
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
    val problem = sessionProblem("", html)
    if (problem != SessionProblem.NONE) return PageRead(emptyList(), "Prüfungen: ${sessionProblemText(problem)}", html)
    val exams = parseTerminliste(html).map { it.copy(eventType = "exam") }
    val recognized = exams.isNotEmpty() || html.contains("Prüfungsplan") || html.contains("Pruefungsplan")
    if (!recognized) return PageRead(emptyList(), "Prüfungen: Seite konnte nicht gelesen werden", html)
    return PageRead(exams, null)
}

fun parseSchedulerXml(xml: String): List<AgendaEvent> {
    if (xml.isBlank() || !xml.contains("<event")) return emptyList()
    return try {
        val factory = DocumentBuilderFactory.newInstance()
        factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true)
        factory.setFeature("http://xml.org/sax/features/external-general-entities", false)
        factory.setFeature("http://xml.org/sax/features/external-parameter-entities", false)
        val root = factory.newDocumentBuilder().parse(xml.byteInputStream()).documentElement
        val nodes = root.getElementsByTagName("event")
        buildList {
            for (index in 0 until nodes.length) {
                val event = nodes.item(index) as? XmlElement ?: continue
                val start = childText(event, "start_date")
                if (start.isBlank()) continue
                val text = childText(event, "text")
                val course = childText(event, "kurskuerzel").ifBlank { childText(event, "fachkuerzel") }
                val room = childText(event, "zimmerkuerzel").ifBlank { childText(event, "zimmer") }
                val teacher = childText(event, "lehrerkuerzelname")
                val comment = childText(event, "kommentar")
                val kind = childText(event, "event_type")
                add(
                    AgendaEvent(
                        id = event.getAttribute("id").ifBlank { stableId("sched", start, text, course) },
                        start = schedulerTime(start),
                        end = schedulerTime(childText(event, "end_date").ifBlank { start }),
                        text = text,
                        comment = comment,
                        room = room,
                        teachers = listOf(teacher).filter { it.isNotBlank() },
                        courseId = childText(event, "kursid"),
                        courseName = course.ifBlank { text },
                        status = if (comment.lowercase().contains("fällt") || comment.lowercase().contains("faellt")) "cancelled" else "",
                        eventType = kind.ifBlank { "lesson" },
                        color = childText(event, "color"),
                        timetableText = text,
                    ),
                )
            }
        }
    } catch (_: Exception) {
        emptyList()
    }
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
            eventType = "lesson",
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

private fun examsFrom(detail: Element, course: String, courseId: String, average: Double?): List<SchoolGrade> {
    val exams = mutableListOf<SchoolGrade>()
    for (row in detail.select("tr")) {
        val cells = row.select("th, td").map { clean(it.text()) }
        if (cells.isEmpty()) continue
        val first = cells[0]
        if (first == "Prüfungsgruppe" || first == "Einzelprüfungen" || first.startsWith("Aktueller Durchschnitt")) continue
        val values = if (cells[0].isBlank()) cells.drop(1) else cells
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

private fun schedulerTime(raw: String): String {
    val match = Regex("""(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})""").find(raw)
    return if (match == null) raw else "${match.groupValues[1]}T${match.groupValues[2]}:00"
}

private fun childText(event: XmlElement, name: String): String {
    val nodes = event.getElementsByTagName(name)
    if (nodes.length == 0) return ""
    return nodes.item(0).textContent?.trim().orEmpty()
}

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
