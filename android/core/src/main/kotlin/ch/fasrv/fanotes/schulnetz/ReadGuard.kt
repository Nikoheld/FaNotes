package ch.fasrv.fanotes.schulnetz

import java.net.URI

/** A log token: screen names, callers, and exception classes. Never free text. */
fun safeLogToken(raw: String): String {
    val cleaned = raw.lowercase().replace(Regex("[^a-z0-9_.:/+-]"), "").take(48)
    return cleaned.ifBlank { "unknown" }
}

/** Page identity for a log line. Query values stay out. */
fun pageToken(url: String): String {
    val page = Regex("""pageid=(\d+)""").find(url)?.groupValues?.get(1)
    if (page != null) return "pageid=$page"
    val path = runCatching { URI(url).path }.getOrNull()?.substringAfterLast('/').orEmpty().lowercase()
    return when {
        path.contains("scheduler_processor") -> "scheduler"
        path.endsWith(".ics") -> "ical"
        path.isBlank() -> "page"
        else -> "path"
    }
}

/** Secrets, raw markup, and full URLs are removed before a line is stored or shared. */
fun redactDiagnostic(value: String): String {
    var text = redactSchulnetzSecrets(value)
    text = Regex("""https?://[^\s"'<>]+""").replace(text) { pageToken(it.value) }
    text = text.replace(Regex("""<[^>\n]{0,300}>"""), " ")
    return text.replace(Regex("""[ \t]{2,}"""), " ").trim().take(600)
}

fun safeFrame(frame: String): String {
    val match = Regex("""[A-Za-z0-9_$.]+\.[A-Za-z0-9_$<>]+:\d+""").find(frame) ?: return "frame"
    return match.value.take(120)
}

fun formatCrashRecord(
    at: String,
    version: String,
    versionCode: Int,
    thread: String,
    exceptionClass: String,
    frames: List<String>,
    context: String,
): String {
    val stack = frames.take(24).joinToString(" | ") { safeFrame(it) }.ifBlank { "none" }
    return "CRASH at=${safeLogToken(at)} version=${safeLogToken(version)} versionCode=$versionCode thread=${safeLogToken(thread)} exception=${safeLogToken(exceptionClass)} ${redactDiagnostic(context)} frames=$stack"
}

/** Keep a logcat line only when it is this app and an AndroidRuntime, FATAL, or ANR record. */
fun logcatLineKept(line: String): Boolean {
    val app = line.contains("ch.fasrv.kantiplus") || line.contains("ch.fasrv.fanotes")
    if (!app) return false
    val lower = line.lowercase()
    return lower.contains("androidruntime") || lower.contains("fatal") || lower.contains("anr")
}

fun redactLogcatExcerpt(raw: String): String {
    if (raw.isBlank()) return ""
    return raw.lineSequence()
        .map { it.trim() }
        .filter { it.isNotEmpty() && logcatLineKept(it) }
        .take(12)
        .joinToString(" | ") { line ->
            val app = if (line.contains("ch.fasrv.kantiplus")) "ch.fasrv.kantiplus" else "ch.fasrv.fanotes"
            val kind = if (line.contains("anr", ignoreCase = true)) "anr" else "fatal"
            "$kind process=$app" // Arbitrary logcat messages may contain names or note content.
        }
        .take(1800)
}

fun exitUnclean(token: String): Boolean = token in setOf(
    "anr",
    "crash",
    "crash-native",
    "low-memory",
    "excessive-resource",
    "signaled",
)

fun terminlisteRow(url: String): Int? =
    Regex("""sRow=(\d+)""").find(url)?.groupValues?.get(1)?.toIntOrNull()

/** A later Terminliste page that this refresh has not already requested. */
fun terminlisteShouldFetch(url: String, currentRow: Int, seenRows: Set<Int>): Boolean {
    val row = terminlisteRow(url) ?: return false
    return row > currentRow && row !in seenRows
}

/**
 * How many extra Terminliste pages a refresh would load.
 * The first list entry is the page already in hand. Later entries are the responses, in order.
 * A session change that returns the same rows does not keep walking sRow.
 */
fun terminlistePagesFetched(pages: List<String>, baseUrl: String): Int {
    if (pages.isEmpty()) return 0
    var fetched = 0
    var currentRow = 0
    val seenIds = parseTerminliste(pages[0]).map { it.id }.toMutableSet()
    val seenRows = mutableSetOf<Int>()
    var html = pages[0]
    var guard = 0
    while (guard < 8) {
        val next = terminlisteNextUrl(html, baseUrl, currentRow) ?: break
        if (!terminlisteShouldFetch(next, currentRow, seenRows)) break
        val row = terminlisteRow(next) ?: break
        val body = pages.getOrNull(fetched + 1) ?: break
        fetched += 1
        seenRows += row
        val ids = parseTerminliste(body).map { it.id }
        if (body.isBlank() || ids.isEmpty() || ids.all { it in seenIds }) break
        seenIds += ids
        currentRow = row
        html = body
        guard += 1
    }
    return fetched
}

/** Headers are never subjects, even when a permissive fallback found numeric cells below them. */
fun placeholderCourse(value: String): Boolean {
    val words = value.lowercase().trim().split(Regex("[^a-zäöü]+" )).filter { it.isNotBlank() }
    return words.isEmpty() || words.all { it in setOf("fach", "kurs", "course", "subject") }
}

private val GRADE_READ_FAILURE = Regex("inaktivit|ip.adresse|neu anmelden|anmeldung|login|not(en|es):.*(nicht lesbar|failed)", RegexOption.IGNORE_CASE)
fun SchulnetzSnapshot.trustedGradeRead(): Boolean = gradesReadComplete && readErrors.none { GRADE_READ_FAILURE.containsMatchIn(it) }

fun keepGradeRead(previous: List<SchoolGrade>, next: List<SchoolGrade>, complete: Boolean): List<SchoolGrade> =
    if (!complete || next.isEmpty() || next.any { placeholderCourse(it.courseLabel) }) previous else next

/**
 * A blocked start page or a failed timetable read must not replace the stored plan.
 * [blocked] is an IP rejection, inactivity page, login wall, or empty start page.
 * [timetableFailed] is a timeout, cancellation, or parser failure for the timetable.
 */
fun keepStoredRead(
    previous: SchulnetzSnapshot?,
    next: SchulnetzSnapshot,
    blocked: Boolean,
    timetableFailed: Boolean,
    okPages: Int = 1,
    gradesComplete: Boolean = true,
): SchulnetzSnapshot {
    val trustedGrades = !blocked && okPages > 0 && gradesComplete
    val grades = keepGradeRead(previous?.grades.orEmpty(), next.grades, trustedGrades)
    val guarded = (if (previous != null) keepAbsenceRead(previous, next) else next).copy(grades = grades, gradesReadComplete = trustedGrades)
    val prior = previous ?: return guarded
    if (!blocked && okPages > 0 && !timetableFailed) return guarded
    var events = next.events
    var exams = next.exams
    var messages = next.messages
    var absences = guarded.absences
    var startMessages = next.startMessages
    var konto = next.konto
    var weekFetched = next.weekFetched
    var weekRead = next.weekRead
    var weekSpanStart = next.weekSpanStart
    var weekSpanEnd = next.weekSpanEnd
    if (blocked || okPages == 0) {
        if (exams.isEmpty()) exams = prior.exams
        if (messages.isEmpty()) messages = prior.messages
        if (absences.isEmpty()) absences = prior.absences
        if (startMessages.isEmpty()) startMessages = prior.startMessages
        if (konto.isEmpty()) konto = prior.konto
        if (events.isEmpty()) events = prior.events
        else if (events.none { it.isLesson() }) events = prior.events.filter { it.isLesson() } + events
        if (weekFetched.isEmpty()) weekFetched = prior.weekFetched
        if (weekRead.isEmpty()) weekRead = prior.weekRead
        if (weekSpanStart.isBlank()) weekSpanStart = prior.weekSpanStart
        if (weekSpanEnd.isBlank()) weekSpanEnd = prior.weekSpanEnd
    }
    if (timetableFailed) {
        val lessons = prior.events.filter { it.isLesson() }
        val carried = events.filter { !it.isLesson() }.ifEmpty { prior.events.filter { !it.isLesson() } }
        events = lessons + carried
        if (exams.isEmpty()) exams = prior.exams
        weekFetched = prior.weekFetched
        weekRead = prior.weekRead
        if (weekSpanStart.isBlank()) weekSpanStart = prior.weekSpanStart
        if (weekSpanEnd.isBlank()) weekSpanEnd = prior.weekSpanEnd
    }
    return guarded.copy(
        grades = grades,
        examWeekFetched = if (blocked || okPages == 0 || timetableFailed) prior.examWeekFetched else next.examWeekFetched,
        events = events,
        exams = exams,
        messages = messages,
        absences = absences,
        startMessages = startMessages,
        konto = konto,
        weekFetched = weekFetched,
        weekRead = weekRead,
        weekSpanStart = weekSpanStart,
        weekSpanEnd = weekSpanEnd,
    )
}
