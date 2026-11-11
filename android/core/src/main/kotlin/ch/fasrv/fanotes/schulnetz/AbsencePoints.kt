package ch.fasrv.fanotes.schulnetz

import org.jsoup.Jsoup
import org.jsoup.nodes.Element
import java.time.LocalDate
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

private val absenceWhitespace = Regex("""\s+""")
private val absenceNonWord = Regex("[^a-z0-9]+")

/*
 * Absence points (Absenzpunkte). The AKSA Absenzen page (pageid 21111, schulNetz 5.14) has two
 * tables: the booked statement ("Absenzenauszug", with points per row and the semester quota) and
 * the open reports ("Offene Absenzmeldungen", table#offeneAbsenzen: date, time, course, no points).
 * An open report has no points yet, so Kanti+ estimates them with the Absenzenreglement of the Alte
 * Kantonsschule Aarau (from August 2026) until Schulnetz books the real entry. The server
 * (fanotes-site/schulnetz-logic.mjs) carries the same parser and estimate; both are tested against
 * the same cases in core/src/test/resources/schulnetz/absence-points-cases.json.
 */

/** 2 reads the statement with points and quota, and the open reports with their times. */
const val ABSENCE_PARSER_VERSION = 2

data class AbsenceStatement(
    val absences: List<SchoolAbsence>,
    val quota: Double? = null,
    val remaining: Double? = null,
    /** True when the page showed the statement or the open reports, even with no rows. */
    val read: Boolean = false,
)

/** Estimate for one open report. Points belong to its block, which counts once in the totals. */
data class AbsenceEstimate(
    val points: Int,
    val lessons: Int,
    val reports: Int,
    /** lessons, exam, instrument, special, fallback or booked. */
    val rule: String,
    val block: Int,
    val first: Boolean,
)

data class AbsenceTally(
    val quota: Double?,
    val booked: Double,
    val estimated: Int,
    val remaining: Double?,
    val openReports: Int,
    val estimates: Map<String, AbsenceEstimate>,
) {
    val total: Double get() = booked + estimated
    val shown: Boolean get() = quota != null || booked > 0.0 || openReports > 0
}

/** Open (no points yet): an open report, or an older layout's row that is not excused. Booked rows are not open. */
fun SchoolAbsence.isOpen(): Boolean = pending || (points == null && !excused)

// ---------------------------------------------------------------------------------------------
// Page

private val SWISS_DATE = Regex("""(\d{1,2})\.(\d{1,2})\.(\d{4})""")
private val CLOCK = Regex("""([01]?\d|2[0-3]):([0-5]\d)""")
private val POINTS = Regex("""-?\d+(?:[.,]\d+)?""")
private val LEADING_DATE = Regex("""^\d{1,2}\.\d{1,2}\.\d{4}""")

private data class Column(val label: String, val start: Int, val span: Int)

private fun cleanText(raw: String) = raw.replace(' ', ' ').replace(absenceWhitespace, " ").trim()

private fun foldAbsenceLabel(raw: String): String =
    cleanText(raw).lowercase().replace("ä", "ae").replace("ö", "oe").replace("ü", "ue").replace(absenceNonWord, " ").trim()

private fun Element.nearestTable(): Element? {
    var node: Element? = this
    while (node != null) {
        if (node.tagName().equals("table", true)) return node
        node = node.parent()
    }
    return null
}

private fun ownRows(table: Element): List<Element> = table.select("tr").filter { it.nearestTable() == table }

private fun ownCellsOf(row: Element, table: Element): List<Element> = row.children().filter { it.tagName() == "td" || it.tagName() == "th" }.filter { it.nearestTable() == table }

private fun columns(row: Element, table: Element): List<Column> {
    var at = 0
    return ownCellsOf(row, table).map { cell ->
        val span = cell.attr("colspan").toIntOrNull()?.coerceIn(1, 20) ?: 1
        Column(cleanText(cell.text()), at, span).also { at += span }
    }
}

/** Lines of a cell split at its line breaks. */
private fun cellLines(cell: Element): List<String> =
    cell.html().split(Regex("""<br\s*/?>""", RegexOption.IGNORE_CASE)).map { cleanText(Jsoup.parse(it).text()) }.filter { it.isNotEmpty() }

private fun pointsNumber(raw: String): Double? = POINTS.find(cleanText(raw).replace(" ", ""))?.value?.replace(',', '.')?.toDoubleOrNull()

/** Later rows with the same id get -2, -3 ... so a double lesson reported twice stays two rows. */
private fun distinctIds(rows: List<SchoolAbsence>): List<SchoolAbsence> {
    val seen = mutableMapOf<String, Int>()
    return rows.map { row ->
        val count = (seen[row.id] ?: 0) + 1
        seen[row.id] = count
        if (count == 1) row else row.copy(id = "${row.id}-$count")
    }
}

private fun swissDay(raw: String): String = SWISS_DATE.find(raw)?.let { "${it.groupValues[1].padStart(2, '0')}.${it.groupValues[2].padStart(2, '0')}.${it.groupValues[3]}" }.orEmpty()

private fun clockOf(raw: String, index: Int = 0): String =
    CLOCK.findAll(raw).elementAtOrNull(index)?.let { "${it.groupValues[1].padStart(2, '0')}:${it.groupValues[2]}" }.orEmpty()

/**
 * The AKSA statement and open reports, or null when the page has neither table (older layouts are
 * read by [parseAbsencesPage] and [parseAbsencesByHeader]).
 */
fun parseAbsenceStatement(html: String): AbsenceStatement? {
    if (html.isBlank()) return null
    val doc = Jsoup.parse(html)
    var read = false
    var quota: Double? = null
    var remaining: Double? = null
    val booked = mutableListOf<SchoolAbsence>()
    val open = mutableListOf<SchoolAbsence>()
    for (table in doc.select("table")) {
        if (table.parent()?.nearestTable() != null) continue
        val rows = ownRows(table)
        val headerRow = rows.firstOrNull { row -> ownCellsOf(row, table).any { it.tagName() == "th" } } ?: continue
        val header = columns(headerRow, table)
        val labels = header.map { foldAbsenceLabel(it.label) }
        val caption = foldAbsenceLabel(table.selectFirst("caption")?.text().orEmpty())
        val openTable = table.id() == "offeneAbsenzen" || caption.contains("offene absenzmeldungen") ||
            (labels.contains("datum") && labels.contains("zeit") && labels.contains("kurs"))
        val pointsAt = header.indexOfFirst { foldAbsenceLabel(it.label).startsWith("absenzpunkte") || foldAbsenceLabel(it.label) == "punkte" }
        val statementTable = !openTable && labels.firstOrNull() == "datum von" && pointsAt >= 0
        if (!openTable && !statementTable) continue
        read = true
        val body = rows.dropWhile { it != headerRow }.drop(1)
        if (openTable) {
            val dateAt = labels.indexOf("datum").takeIf { it >= 0 } ?: 0
            val timeAt = labels.indexOf("zeit").takeIf { it >= 0 } ?: 1
            val courseAt = labels.indexOf("kurs").takeIf { it >= 0 } ?: 2
            for (row in body) {
                val cells = ownCellsOf(row, table).map { cleanText(it.text()) }
                val day = swissDay(cells.getOrElse(dateAt) { "" })
                if (!LEADING_DATE.containsMatchIn(cells.getOrElse(dateAt) { "" })) continue
                val time = cells.getOrElse(timeAt) { "" }
                val course = cells.getOrElse(courseAt) { "" }
                open += SchoolAbsence(
                    id = stableId("abs-open", day, time, course),
                    dateFrom = day,
                    dateTo = day,
                    hourFrom = clockOf(time, 0),
                    hourTo = clockOf(time, 1),
                    subject = course,
                    reason = "",
                    excused = false,
                    acknowledged = false,
                    status = "offen",
                    pending = true,
                )
            }
        } else {
            val headerSpan = header.sumOf { it.span }
            val point = header[pointsAt]
            val reasonColumn = header.firstOrNull { foldAbsenceLabel(it.label).startsWith("grund") }
            for (row in body) {
                val cells = ownCellsOf(row, table)
                val laid = columns(row, table)
                if (laid.isEmpty()) continue
                val firstText = cleanText(cells[0].text())
                val day = swissDay(firstText)
                if (day.isEmpty() || cells.size < 3) continue
                val rowSpan = laid.sumOf { it.span }
                // A row wider than the header (a column Schulnetz adds for some entries) is aligned from the right.
                val shift = if (rowSpan > headerSpan) rowSpan - headerSpan else 0
                fun cellAt(column: Int): Element? = laid.indexOfFirst { column >= it.start && column < it.start + it.span }.takeIf { it >= 0 }?.let { cells[it] }
                val pointsCell = cellAt(point.start + shift)
                val points = pointsCell?.let { pointsNumber(it.text()) }
                    ?: cells.drop(2).mapNotNull { cell -> cleanText(cell.text()).takeIf { !SWISS_DATE.containsMatchIn(it) }?.let(::pointsNumber) }.lastOrNull()
                val reason = reasonColumn?.let { column ->
                    (column.start until column.start + column.span).mapNotNull { cellAt(it) }.distinct()
                        .map { cleanText(it.text()) }.filter { it.isNotEmpty() }.joinToString(" · ")
                }.orEmpty()
                val toText = cleanText(cells.getOrNull(1)?.text().orEmpty())
                booked += SchoolAbsence(
                    id = stableId("abs", firstText, toText, reason),
                    dateFrom = day,
                    dateTo = swissDay(toText).ifEmpty { day },
                    hourFrom = clockOf(firstText),
                    hourTo = clockOf(toText),
                    subject = "",
                    reason = reason,
                    excused = false,
                    acknowledged = true,
                    status = "gebucht",
                    points = points,
                )
            }
            for (cell in table.select("td")) {
                if (!cell.text().contains("Kontingent")) continue
                if (cell.select("td").size > 1) continue
                val labelsHere = cellLines(cell)
                val values = (cell.nextElementSibling()?.let(::cellLines).orEmpty()).mapNotNull(::pointsNumber)
                labelsHere.forEachIndexed { index, line ->
                    val inline = line.substringAfter(':', "").let(::pointsNumber)
                    val value = inline ?: values.getOrNull(index)
                    val key = foldAbsenceLabel(line.substringBefore(':'))
                    when (key) {
                        "kontingent" -> quota = value ?: quota
                        "verbleibendes kontingent" -> remaining = value ?: remaining
                    }
                }
            }
        }
    }
    if (!read) return null
    return AbsenceStatement(distinctIds(booked) + distinctIds(open), quota, remaining, read = true)
}

/** The Absenzen page with points and quota where Schulnetz shows them. */
fun readAbsenceStatement(html: String): PageRead<AbsenceStatement> {
    if (html.isBlank()) return PageRead(AbsenceStatement(emptyList()), null)
    val problem = sessionProblem("", html)
    if (problem == SessionProblem.INTERACTIVE) return PageRead(AbsenceStatement(emptyList()), sessionProblemText(problem))
    if (problem != SessionProblem.NONE) return PageRead(AbsenceStatement(emptyList()), "Absenzen: ${sessionProblemText(problem)}", html)
    parseAbsenceStatement(html)?.let { return PageRead(it, null) }
    val rows = parseAbsencesPage(html).ifEmpty { parseAbsencesByHeader(html) }
    if (rows.isNotEmpty() || html.contains("Datum von")) return PageRead(AbsenceStatement(rows, read = true), null)
    return PageRead(AbsenceStatement(emptyList()), "Absenzen: Seite geladen, aber nicht lesbar", html)
}

/** [snapshot] with a statement read from the Absenzen page. An unread page keeps what was there. */
fun SchulnetzSnapshot.withAbsenceStatement(statement: AbsenceStatement): SchulnetzSnapshot {
    if (!statement.read) return copy(absences = statement.absences.ifEmpty { absences })
    return copy(
        absences = statement.absences,
        absenceQuota = statement.quota,
        absenceRemaining = statement.remaining,
        absenceParser = ABSENCE_PARSER_VERSION,
    )
}

/**
 * [next] when it read the Absenzen page (even with no rows) or brought rows; otherwise the stored
 * absences with their quota. An unread page must not empty the list or drop the quota.
 */
fun keepAbsenceRead(previous: SchulnetzSnapshot, next: SchulnetzSnapshot): SchulnetzSnapshot = when {
    next.absenceParser >= ABSENCE_PARSER_VERSION -> next
    next.absences.isNotEmpty() && previous.absenceParser < ABSENCE_PARSER_VERSION -> next
    else -> next.copy(
        absences = previous.absences,
        absenceQuota = previous.absenceQuota,
        absenceRemaining = previous.absenceRemaining,
        absenceParser = previous.absenceParser,
    )
}

/** The absences part of an adopted server copy: the newer parser wins, then whichever has rows. */
fun adoptAbsences(phone: SchulnetzSnapshot, server: SchulnetzSnapshot): SchulnetzSnapshot {
    val source = when {
        server.absenceParser >= ABSENCE_PARSER_VERSION -> server
        phone.absenceParser >= ABSENCE_PARSER_VERSION -> phone
        server.absences.isNotEmpty() -> server
        else -> phone
    }
    return server.copy(absences = source.absences, absenceQuota = source.absenceQuota, absenceRemaining = source.absenceRemaining, absenceParser = source.absenceParser)
}

/** The first read with [ABSENCE_PARSER_VERSION] gives rows new ids; it is a baseline, not news. */
fun absenceSeedRead(previous: SchulnetzSnapshot, next: SchulnetzSnapshot): Boolean =
    previous.absenceParser < ABSENCE_PARSER_VERSION && next.absenceParser >= ABSENCE_PARSER_VERSION

// ---------------------------------------------------------------------------------------------
// Estimate

private val INSTRUMENT = Regex(
    """(?iu)(?<![\p{L}])(instrument\p{L}*|klavier|piano|gitarre|e-gitarre|e-bass|violine|geige|viola|bratsche|cello|violoncello|kontrabass|querflöte|blockflöte|flöte|oboe|fagott|klarinette|saxophon|saxofon|trompete|posaune|waldhorn|horn|tuba|schlagzeug|perkussion|harfe|orgel|akkordeon|gesang|sologesang|sologesangsunterricht|stimmbildung|einzelunterricht|einzellektion)(?![\p{L}])"""
)
private val SPECIAL = Regex(
    """(?iu)(projektwoche|projekttag|klassenwoche|sonderwoche|studienwoche|spezialwoche|arbeitswoche|sporttag|sportwoche|exkursion|studienreise|maturareise|klassenlager|skilager|schneesportlager|lager|schulreise|besuchstag|ausflug)"""
)

private data class Slot(
    val index: Int,
    val absence: SchoolAbsence,
    val date: LocalDate?,
    val from: Int?,
    val to: Int?,
    val lessons: Int,
)

private data class Lesson(val event: AgendaEvent, val date: LocalDate, val from: Int, val to: Int)

private fun minutesOf(clock: String): Int? = CLOCK.find(clock)?.let { it.groupValues[1].toInt() * 60 + it.groupValues[2].toInt() }

/** Lessons in one report: a 45-minute row is one, a 95-minute double lesson two. */
private fun lessonsIn(from: Int?, to: Int?): Int = if (from != null && to != null && to > from) max(1, ((to - from + 5) / 50.0).roundToInt()) else 1

private fun overlaps(aFrom: Int, aTo: Int, bFrom: Int, bTo: Int) = aFrom < bTo && bFrom < aTo

private fun slotOf(index: Int, absence: SchoolAbsence): Slot {
    val date = eventDate(absence.dateFrom)
    var from = minutesOf(clockOf(absence.hourFrom))
    var to = minutesOf(clockOf(absence.hourTo))
    // Older reads kept "08:00 - 08:45" in hourFrom.
    if (to == null && clockOf(absence.hourFrom, 1).isNotEmpty()) to = minutesOf(clockOf(absence.hourFrom, 1))
    if (from != null && to != null && to <= from) { from = null; to = null }
    return Slot(index, absence, date, from, to, lessonsIn(from, to))
}

private fun lessonOf(event: AgendaEvent): Lesson? {
    val date = eventDate(event.start) ?: return null
    val from = minutesOf(schulnetzClock(event.start)) ?: return null
    val to = minutesOf(schulnetzClock(event.end))?.takeIf { it > from } ?: (from + 45)
    return Lesson(event, date, from, to)
}

private fun eventWords(event: AgendaEvent) = listOf(event.courseName, event.courseId, event.text, event.timetableText).joinToString(" ").lowercase()

private fun inChain(a: Slot, b: Slot, attended: List<Lesson>): Boolean {
    val aDate = a.date ?: return false
    val bDate = b.date ?: return false
    if (weekMonday(aDate) != weekMonday(bDate)) return false
    val aEnd = aDate.toEpochDay() * 1440 + (a.to ?: return false)
    val bStart = bDate.toEpochDay() * 1440 + (b.from ?: return false)
    return attended.none { lesson ->
        val start = lesson.date.toEpochDay() * 1440 + lesson.from
        start >= aEnd && start < bStart
    }
}

/**
 * Booked points, the estimate for open reports and the remaining quota.
 *
 * Rules (Absenzenreglement AKSA, from August 2026), applied to open reports only:
 * 1. n lessons missed without interruption cost n + 1 points. Free periods, cancelled lessons and
 *    the night are no interruption; an attended lesson in between is.
 * 2. Before and after a weekend are separate blocks.
 * 3. An instrumental (individual) lesson alone costs 3; in a chain it is an ordinary lesson.
 * 4. A block with an announced exam costs 10 flat, at most 10 per day.
 * 5. Special days outside the timetable (project week, sports day, excursion): 5 for a half day, 9 for a full day.
 * Illness limits are not applied. A report without a time or without a timetable for its week is
 * its own block (one lesson: 2 points). A report on a day that already has a booked entry is booked.
 */
fun absenceTally(snapshot: SchulnetzSnapshot): AbsenceTally {
    val pending = snapshot.absences.filter { it.pending }
    val booked = snapshot.absences.filter { !it.pending && it.points != null }
    val quota = snapshot.absenceQuota
    val shownRemaining = snapshot.absenceRemaining
    val bookedPoints = if (quota != null && shownRemaining != null) max(0.0, quota - shownRemaining) else booked.sumOf { it.points ?: 0.0 }

    val slots = pending.mapIndexed(::slotOf)
    val lessons = snapshot.events.filter { it.isLesson() && !it.isCancelled() }.mapNotNull(::lessonOf)
    val lessonWeeks = lessons.map { weekMonday(it.date) }.toSet()
    val exams = (snapshot.exams.filter { it.eventType.equals("exam", true) || it.isExamLike() } + snapshot.events.filter { it.isExamLike() })
        .filter { !it.isCancelled() }
    val appointments = (snapshot.events + snapshot.exams).filter { !it.isLesson() && !it.isExamLike() && !it.eventType.equals("exam", true) }

    fun lessonsAt(slot: Slot): List<Lesson> {
        val date = slot.date ?: return emptyList()
        val from = slot.from ?: return emptyList()
        val to = slot.to ?: return emptyList()
        return lessons.filter { it.date == date && overlaps(it.from, it.to, from, to) }
    }

    fun bookedCovers(slot: Slot): Boolean {
        val date = slot.date ?: return false
        return booked.any { entry ->
            val start = eventDate(entry.dateFrom) ?: return@any false
            val end = eventDate(entry.dateTo)?.takeIf { !it.isBefore(start) } ?: start
            if (date.isBefore(start) || date.isAfter(end)) return@any false
            val bFrom = minutesOf(entry.hourFrom)
            val bTo = minutesOf(entry.hourTo)
            if (start == end && bFrom != null && bTo != null && bTo > bFrom && slot.from != null && slot.to != null) overlaps(bFrom, bTo, slot.from, slot.to) else true
        }
    }

    fun special(slot: Slot): Boolean {
        val date = slot.date ?: return false
        if (SPECIAL.containsMatchIn(slot.absence.subject)) return true
        if (lessonsAt(slot).isNotEmpty() || slot.from == null) return false
        return appointments.any { event ->
            if (eventDate(event.start) != date || !SPECIAL.containsMatchIn(eventWords(event))) return@any false
            val from = minutesOf(schulnetzClock(event.start))
            val to = minutesOf(schulnetzClock(event.end))
            from == null || to == null || from == to || overlaps(from, to, slot.from, slot.to ?: slot.from)
        }
    }

    fun examAt(slot: Slot): Boolean {
        val date = slot.date ?: return false
        val course = slot.absence.subject.trim().lowercase()
        val courses = (listOf(course) + lessonsAt(slot).map { it.event.courseName.trim().lowercase() }).filter { it.length >= 2 }.distinct()
        return exams.any { exam ->
            if (eventDate(exam.start) != date) return@any false
            val from = minutesOf(schulnetzClock(exam.start))
            val to = minutesOf(schulnetzClock(exam.end))
            if (from != null && to != null && to > from) {
                if (slot.from != null && slot.to != null) overlaps(from, to, slot.from, slot.to) else courses.any { eventWords(exam).contains(it) }
            } else courses.any { eventWords(exam).contains(it) }
        }
    }

    fun instrumental(slot: Slot): Boolean =
        INSTRUMENT.containsMatchIn(slot.absence.subject) || lessonsAt(slot).any { INSTRUMENT.containsMatchIn(eventWords(it.event)) }

    val estimates = mutableMapOf<String, AbsenceEstimate>()
    var block = 0
    var estimated = 0
    fun assign(group: List<Slot>, points: Int, rule: String) {
        val lessonCount = group.sumOf { it.lessons }
        group.forEachIndexed { at, slot -> estimates[slot.absence.id] = AbsenceEstimate(points, lessonCount, group.size, rule, block, at == 0) }
        estimated += points
        block += 1
    }

    val open = slots.filter { slot ->
        if (!bookedCovers(slot)) true else {
            estimates[slot.absence.id] = AbsenceEstimate(0, slot.lessons, 1, "booked", -1, true)
            false
        }
    }
    val specials = open.filter(::special)
    val known = open.filter { it !in specials && it.date != null && it.from != null && it.to != null && weekMonday(it.date) in lessonWeeks }
    val fallback = open.filter { it !in specials && it !in known }

    // The timetable decides whether reports belong together: a lesson the student attended in between
    // separates two blocks. Missed lessons (any report covers them) do not.
    val missed = slots.filter { it.date != null && it.from != null && it.to != null }
    val attended = lessons.filter { lesson -> missed.none { it.date == lesson.date && overlaps(it.from!!, it.to!!, lesson.from, lesson.to) } }
    val ordered = known.sortedWith(compareBy<Slot>({ it.date }, { it.from }, { it.index }))
    val chains = mutableListOf<MutableList<Slot>>()
    for (slot in ordered) {
        val last = chains.lastOrNull()?.last()
        if (last != null && inChain(last, slot, attended)) chains.last() += slot else chains += mutableListOf(slot)
    }
    val examDay = mutableMapOf<LocalDate, Int>()
    val items = chains.map { it.toList() to "chain" } + specials.groupBy { it.date }.values.map { it to "special" } + fallback.map { listOf(it) to "fallback" }
    for ((group, kind) in items.sortedWith(compareBy<Pair<List<Slot>, String>>({ it.first.first().date }, { it.first.first().from ?: -1 }, { it.first.first().index }))) {
        when (kind) {
            "special" -> {
                val from = group.mapNotNull { it.from }.minOrNull()
                val to = group.mapNotNull { it.to }.maxOrNull()
                val fullDay = group.any { it.from == null || it.to == null } || (from != null && to != null && from < 12 * 60 && to > 13 * 60)
                assign(group, if (fullDay) 9 else 5, "special")
            }
            "fallback" -> assign(group, group.sumOf { it.lessons } + 1, "fallback")
            else -> {
                val examSlot = group.firstOrNull(::examAt)
                when {
                    examSlot != null -> {
                        val day = examSlot.date!!
                        val used = examDay[day] ?: 0
                        val points = min(10, max(0, 10 - used))
                        examDay[day] = used + points
                        assign(group, points, "exam")
                    }
                    group.all(::instrumental) -> assign(group, 3 * group.size, "instrument")
                    else -> assign(group, group.sumOf { it.lessons } + 1, "lessons")
                }
            }
        }
    }

    val remaining = when {
        shownRemaining != null -> shownRemaining - estimated
        quota != null -> quota - bookedPoints - estimated
        else -> null
    }
    return AbsenceTally(quota, bookedPoints, estimated, remaining, pending.size, estimates)
}

/** "3", "2,5": German number for notices. */
fun pointsText(value: Double): String {
    val rounded = (value * 10).roundToInt() / 10.0
    return if (abs(rounded - rounded.roundToInt()) < 1e-9) rounded.roundToInt().toString() else rounded.toString().replace('.', ',')
}

/** Notice body for a new absence. The server builds the same text (schulnetz-logic.mjs `absenceNoticeBody`). */
fun absenceNoticeBody(absence: SchoolAbsence, tally: AbsenceTally): String {
    val whenText = listOf(absence.dateFrom, absence.hourFrom).filter { it.isNotBlank() }.joinToString(" ")
    val quota = tally.quota
    val left = if (quota != null && tally.remaining != null) "Kontingent noch ${pointsText(tally.remaining)} von ${pointsText(quota)}" else ""
    val parts = when {
        absence.pending -> {
            val estimate = tally.estimates[absence.id]
            listOf(absence.subject.ifBlank { "Absenz" }, whenText, "Absenzmeldung offen", estimate?.takeIf { it.rule != "booked" }?.let { "geschätzt ${it.points} Punkte" }.orEmpty(), left)
        }
        absence.points != null -> listOf(absence.reason.ifBlank { "Absenz" }, whenText, "${pointsText(absence.points)} Punkte gebucht", left)
        else -> listOf(absence.subject.ifBlank { "Absenz" }, whenText, absence.reason, if (absence.excused) "entschuldigt" else "nicht entschuldigt")
    }
    return parts.filter { it.isNotBlank() }.joinToString(" · ")
}
