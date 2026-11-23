package ch.fasrv.fanotes.schulnetz

import java.time.Instant
import java.time.LocalDate

/** Absent teachers and teachers on an excursion as the start page's information card lists them. */
data class TeacherAbsences(val absent: List<String> = emptyList(), val excursion: List<String> = emptyList())

/** [TeacherAbsences] of one read, stamped with the Europe/Zurich [day] it was read. Display only; never a change notice. */
data class TeacherAbsenceDay(val day: String, val absent: List<String> = emptyList(), val excursion: List<String> = emptyList())

const val TEACHER_ABSENCE_MAX_ENTRIES = 40
const val TEACHER_ABSENCE_MAX_CHARS = 120

private val OPTS = setOf(RegexOption.IGNORE_CASE)
private const val SPACE = """(?:\s|&nbsp;|&#160;)+"""
private val ABSENT_LABEL = Regex("""Abwesende${SPACE}Lehrpersonen""", OPTS)
private val EXCURSION_LABEL = Regex("""Lehrpersonen${SPACE}auf${SPACE}Exkursion""", OPTS)
private val SECTION_BREAK = Regex("""<br\s*/?>|</?(?:p|li|div)\b[^>]*>""", OPTS)
private val SCRIPT_BLOCK = Regex("""<(script|style)\b[^>]*>.*?</\1>""", setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL))
private val PAGE_LINK = Regex("""pageid=\d""", OPTS)
private val NUMERIC_ENTITY = Regex("""&#(\d{1,5});""")
private val NAMED_ENTITY = Regex("""&([A-Za-z]+);""")
private val EDGE_PUNCTUATION = Regex("""^[\s:\-–—]+|[\s:\-–—]+$""")
private val NAMED = mapOf(
    "auml" to "ä", "ouml" to "ö", "uuml" to "ü", "Auml" to "Ä", "Ouml" to "Ö", "Uuml" to "Ü",
    "eacute" to "é", "egrave" to "è", "agrave" to "à", "ccedil" to "ç", "szlig" to "ß", "apos" to "'", "lt" to "<", "gt" to ">",
)

private fun teacherText(raw: String): String = htmlText(raw)
    .replace(NUMERIC_ENTITY) { String(Character.toChars(it.groupValues[1].toInt())) }
    .replace(NAMED_ENTITY) { NAMED[it.groupValues[1]] ?: it.value }
    .replace(EDGE_PUNCTUATION, "")

/** Text after [label] up to the other label, a "---" marker or the end of the card; split on <br> and paragraphs only. */
private fun teacherSection(html: String, label: Regex, other: Regex): List<String> {
    val start = label.find(html) ?: return emptyList()
    var rest = html.substring(start.range.last + 1)
    val stops = listOfNotNull(
        other.find(rest)?.range?.first,
        rest.indexOf("---").takeIf { it >= 0 },
        Regex("""</div\b""", OPTS).find(rest)?.range?.first,
    )
    if (stops.isNotEmpty()) rest = rest.substring(0, stops.min())
    return SECTION_BREAK.replace(rest, "\n").split('\n')
        .map { teacherText(it).take(TEACHER_ABSENCE_MAX_CHARS).trim() }
        .filter { it.isNotEmpty() }
        .take(TEACHER_ABSENCE_MAX_ENTRIES)
}

/**
 * Absent teachers and teachers on an excursion from the start page's information card.
 * Null for a blank body, a sign-in wall or a page without page links. A start page without the card gives empty lists.
 */
fun parseTeacherAbsences(html: String): TeacherAbsences? {
    if (html.isBlank() || sessionProblem("", html) != SessionProblem.NONE || !PAGE_LINK.containsMatchIn(html)) return null
    val cleaned = SCRIPT_BLOCK.replace(html, " ")
    return TeacherAbsences(
        absent = teacherSection(cleaned, ABSENT_LABEL, EXCURSION_LABEL),
        excursion = teacherSection(cleaned, EXCURSION_LABEL, ABSENT_LABEL),
    )
}

/** The Europe/Zurich date of a read stamp; today when the stamp is not a time. */
fun teacherAbsenceDay(readAt: String): String {
    val instant = runCatching { Instant.parse(readAt) }.getOrNull() ?: Instant.now()
    return instant.atZone(SCHOOL_ZONE).toLocalDate().toString()
}

/** The snapshot field for a start page read, or null when that page was not a start page. */
fun teacherAbsenceRead(html: String, readAt: String): TeacherAbsenceDay? =
    parseTeacherAbsences(html)?.let { TeacherAbsenceDay(teacherAbsenceDay(readAt), it.absent, it.excursion) }

private fun TeacherAbsenceDay?.validDay(): Boolean = this != null && runCatching { LocalDate.parse(day) }.isSuccess

/** The value with the newer day; on the same day [preferred] wins. A missing or malformed value loses. */
fun newerTeacherAbsences(preferred: TeacherAbsenceDay?, other: TeacherAbsenceDay?): TeacherAbsenceDay? = when {
    !preferred.validDay() -> other.takeIf { it.validDay() }
    !other.validDay() -> preferred
    other!!.day > preferred!!.day -> other
    else -> preferred
}
