package ch.fasrv.fanotes.schulnetz

import java.time.DateTimeException
import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.temporal.TemporalAdjusters

/** Public mobile client id of the official Schulnetz PWA. Not a secret. */
const val SCHULNETZ_CLIENT_ID = "ppyybShnMerHdtBQ"

/** Referer the official web app sends on token and REST calls. */
const val SCHULNETZ_REFERER = "https://schulnetz.web.app/"

const val SCHULNETZ_USER_AGENT =
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"

/** Alte Kantonsschule Aarau. Other schools can replace the base URL in settings. */
const val AKSA_SCHULNETZ_BASE = "https://www.schulnetz-ag.ch/aksa"

const val SCHULNETZ_API_PATH = "/api/v1/schulnetz"

val SUBJECT_PALETTE = listOf(
    "#7f6df2", "#3d8bfd", "#2f9e6b", "#e0ac39", "#e15b64", "#d06ad6", "#5aa6a6", "#c47b4a",
    "#2a6f97", "#0f7b6c", "#d9730d", "#9065b0",
)

data class SchoolProfile(
    val id: String = "",
    val firstName: String = "",
    val lastName: String = "",
    val className: String = "",
    val email: String = "",
) {
    val displayName: String
        get() = listOf(firstName, lastName).filter { it.isNotBlank() }.joinToString(" ").ifBlank { email }
}

data class SchoolGrade(
    val id: String,
    val course: String,
    val courseId: String,
    val subject: String,
    val title: String,
    val date: String,
    val mark: Double?,
    val weight: Double,
    val confirmed: Boolean,
    val courseGrade: Double?,
    val comment: String,
) {
    val courseKey: String get() = courseId.ifBlank { course.ifBlank { subject } }
    val courseLabel: String get() = course.ifBlank { subject }.ifBlank { courseId }
}

/** Readable subject, with the course code kept when it distinguishes two courses of one subject. */
fun SchoolGrade.displayCourseLabel(): String {
    val token = cleanSchulnetzText(course.ifBlank { courseId })
    val name = cleanSchulnetzText(subject)
    if (name.isBlank() || name.equals(token, ignoreCase = true)) return courseLabel
    return preferredSubjectTitle(token, name).ifBlank { courseLabel }
}

/** Course-average cells from page 21311, never a real Einzelprüfung. */
fun isSummaryGradeTitle(title: String): Boolean {
    val raw = title.trim()
    if (raw == "Ø" || raw == "ø") return true
    val folded = raw.lowercase()
        .replace("ä", "ae")
        .replace("ö", "oe")
        .replace("ü", "ue")
        .replace("ß", "ss")
        .replace(Regex("[^a-z0-9]+"), " ")
        .trim()
    if (folded.isEmpty()) return false
    if (folded == "o" || folded == "avg" || folded == "average") return true
    if (folded == "durchschnitt" || folded == "schnitt") return true
    if (folded == "notendurchschnitt" || folded == "notenschnitt") return true
    return folded.startsWith("aktueller durchschnitt")
}

fun SchoolGrade.isSummaryGrade(): Boolean = isSummaryGradeTitle(title)

fun List<SchoolGrade>.withoutSummaryGrades(): List<SchoolGrade> = filterNot { it.isSummaryGrade() }

data class AgendaEvent(
    val id: String,
    val start: String,
    val end: String,
    val text: String,
    val comment: String,
    val room: String,
    val teachers: List<String>,
    val courseId: String,
    val courseName: String,
    val status: String,
    val eventType: String,
    val color: String,
    val timetableText: String,
    /** Lesson mark from [lessonMarker]. null = stored before marks were read; "" = read with marks, none set. */
    val marker: String? = null,
    /** Substitute teacher named with a lesson mark; blank when none. */
    val substitute: String = "",
) {
    /** Computed once per event: lists, filters and exam slots read it for every lesson on every pass. */
    val label: String by lazy(LazyThreadSafetyMode.PUBLICATION) {
        listOf(courseName, text, timetableText).map(::cleanSchulnetzText).firstOrNull { it.isNotBlank() } ?: "Lektion"
    }
}

/**
 * Title for Planer, Noten and Prüfungen. [AgendaEvent.label] stays the identity string
 * (notification hashes and colours). A technical course code yields to a readable subject.
 */
fun preferredEventTitle(event: AgendaEvent): String {
    val code = cleanSchulnetzText(event.courseName)
    val readable = listOf(event.text, event.timetableText).map(::cleanSchulnetzText).firstOrNull { it.isNotBlank() }.orEmpty()
    return preferredSubjectTitle(code, readable).ifBlank { event.label }
}

/** Short Schulnetz course tokens such as `PHY` or `M4a`. Ordinary subject names are not codes. */
fun looksLikeCourseCode(raw: String): Boolean {
    val text = raw.trim()
    if (text.length !in 2..12 || text.any { it.isWhitespace() }) return false
    if (!text.all { it.isLetterOrDigit() || it == '_' || it == '.' || it == '-' || it == '/' }) return false
    val letters = text.filter { it.isLetter() }
    if (letters.isEmpty()) return false
    if (text.any { it.isDigit() || it == '_' || it == '/' }) return true
    if (text.any { it == '.' } && letters.length <= 6) return true
    return letters.length <= 6 && letters.all { it.isUpperCase() }
}

fun preferredSubjectTitle(code: String, readable: String): String {
    val token = cleanSchulnetzText(code)
    val name = cleanSchulnetzText(readable)
    if (name.isBlank()) return token
    if (token.isBlank() || token.equals(name, ignoreCase = true)) return name
    if (looksLikeCourseCode(token) && !looksLikeCourseCode(name)) {
        val words = name.split(Regex("""[\s,/]+""")).map { it.trim('(', ')') }
        if (words.any { it.equals(token, ignoreCase = true) }) return name
        return "$name ($token)"
    }
    return token
}

fun genericAppointmentTitle(title: String): Boolean {
    val folded = cleanSchulnetzText(title).lowercase()
    return folded == "termin" || folded == "appointment"
}

/** Aktuelles stores appointments under the generic title "Termin". The body is the real title. */
fun messageHeadline(title: String, body: String): String {
    val cleanTitle = cleanSchulnetzText(title)
    val cleanBody = cleanSchulnetzText(body)
    if (!genericAppointmentTitle(cleanTitle)) return cleanTitle.ifBlank { cleanBody }
    val line = cleanBody.lineSequence().map { it.trim() }.firstOrNull { it.isNotEmpty() }.orEmpty()
    return line.ifBlank { cleanTitle }
}

/** A blank clock is not a date. Swiss and ISO days count; nothing is invented. */
fun examHasDate(start: String): Boolean = eventDayKey(start).isNotBlank()

/** Dated exams stay chronological. Undated ones follow them instead of sorting as an empty string. */
fun examAlleKey(start: String): String = if (examHasDate(start)) eventDayKey(start) + " " + start else "~"

data class SchoolAbsence(
    val id: String,
    val dateFrom: String,
    val dateTo: String,
    val hourFrom: String,
    val hourTo: String,
    val subject: String,
    val reason: String,
    val excused: Boolean,
    val acknowledged: Boolean,
    val status: String,
    val excuseUntil: String = "",
    /** Booked Absenzpunkte from the statement. Null when Schulnetz shows none (open reports, older layouts). */
    val points: Double? = null,
    /** An open absence report (Offene Absenzmeldung): not booked yet, its points are estimated. */
    val pending: Boolean = false,
)

data class SchoolHomework(
    val id: String,
    val title: String,
    val description: String,
    val dueDate: String,
    val courseId: String,
    val courseName: String,
)

data class SchoolMessage(
    val id: String,
    val title: String,
    val body: String,
    val at: String,
)

data class SchoolVacation(
    val id: String,
    val name: String,
    val start: String,
    val end: String,
)

data class KontoLine(
    val date: String,
    val label: String,
    val amount: String,
    val balance: String,
)

data class SchulnetzSnapshot(
    val revision: Long = 0,
    val fetchedAt: String = "",
    val profile: SchoolProfile? = null,
    val grades: List<SchoolGrade> = emptyList(),
    val events: List<AgendaEvent> = emptyList(),
    val exams: List<AgendaEvent> = emptyList(),
    val absences: List<SchoolAbsence> = emptyList(),
    val homework: List<SchoolHomework> = emptyList(),
    val messages: List<SchoolMessage> = emptyList(),
    val vacations: List<SchoolVacation> = emptyList(),
    val konto: List<KontoLine> = emptyList(),
    /** Final Saldo row of the Kontoauszug as Schulnetz prints it; empty when absent. */
    val kontoSaldo: String = "",
    val startMessages: List<String> = emptyList(),
    val readErrors: List<String> = emptyList(),
    /** Monday (ISO date) to the instant that week was last read. */
    val weekFetched: Map<String, String> = emptyMap(),
    val weekSpanStart: String = "",
    val weekSpanEnd: String = "",
    val icalFetchedAt: String = "",
    /** False for blocked/partial reads; preserved in uploads so another device cannot adopt them. */
    val gradesReadComplete: Boolean = true,
    /** Only successfully read exam weeks; lesson coverage must not stand in for exam coverage. */
    val examWeekFetched: Map<String, String> = emptyMap(),
    /**
     * Monday to the instant the lesson scheduler actually answered.
     * An empty readable body is included. An iCal range is not.
     */
    val weekRead: Map<String, String> = emptyMap(),
    /**
     * Version of the grade parser that produced [grades]. Server snapshots below
     * [GRADE_PARSER_VERSION] came from a parser that dropped marks with an info tooltip, so the app
     * keeps its own grade list instead of adopting theirs.
     */
    val gradeParser: Int = 0,
    /** Semester quota (Kontingent) and remaining quota as the statement shows them. Null when not shown. */
    val absenceQuota: Double? = null,
    val absenceRemaining: Double? = null,
    /** [ABSENCE_PARSER_VERSION] of the page read that produced [absences]; 0 for REST and older reads. */
    val absenceParser: Int = 0,
)

/** 2: marks with an info tooltip and rows still waiting for a mark are read. */
const val GRADE_PARSER_VERSION = 2

data class NotifySettings(
    val grades: Boolean = true,
    val timetable: Boolean = true,
    val exams: Boolean = true,
    val absences: Boolean = true,
    val events: Boolean = true,
    val deadlines: Boolean = true,
    /** When true, new-grade pushes and lists hide the mark until it is revealed. Default off. */
    val guessGrades: Boolean = false,
    /** Master switch. Off suppresses every school alert and leaves the subtype choices stored. */
    val enabled: Boolean = true,
    val gradeNew: Boolean = true,
    val gradeChanged: Boolean = true,
    val lessonCancelled: Boolean = true,
    val lessonChanged: Boolean = true,
    val examNew: Boolean = true,
    val examMoved: Boolean = true,
    val examCancelled: Boolean = true,
    val examRoom: Boolean = true,
    val appointmentNew: Boolean = true,
    val messageNew: Boolean = true,
    /** Pendelstrecken alerts: the parent switch and its fine switches. Independent of [enabled]. */
    val commute: Boolean = true,
    val commuteDelay: Boolean = true,
    val commuteCancelled: Boolean = true,
    val commuteLessonEnd: Boolean = true,
)

/** Category flags follow the subtypes so an older server still receives a coherent switch. */
fun NotifySettings.aligned(): NotifySettings = copy(
    grades = gradeNew || gradeChanged,
    timetable = lessonCancelled || lessonChanged,
    exams = examNew || examMoved || examCancelled || examRoom,
    events = appointmentNew || messageNew,
    commute = commuteDelay || commuteCancelled || commuteLessonEnd,
)

/**
 * Preference file keys. Absent fine keys follow the older category switch, so an
 * update does not change which alerts an existing install already receives.
 */
object NotifyPrefs {
    const val FILE = "fanotes-companion"
    const val ENABLED = "notify-enabled"
    const val GRADES = "notify-grades"
    const val GRADE_NEW = "notify-grade-new"
    const val GRADE_CHANGED = "notify-grade-changed"
    const val TIMETABLE = "notify-timetable"
    const val LESSON_CANCELLED = "notify-lesson-cancelled"
    const val LESSON_CHANGED = "notify-lesson-changed"
    const val EXAMS = "notify-exams"
    const val EXAM_NEW = "notify-exam-new"
    const val EXAM_MOVED = "notify-exam-moved"
    const val EXAM_CANCELLED = "notify-exam-cancelled"
    const val EXAM_ROOM = "notify-exam-room"
    const val ABSENCES = "notify-absences"
    const val EVENTS = "notify-events"
    const val APPOINTMENT_NEW = "notify-appointment-new"
    const val MESSAGE_NEW = "notify-message-new"
    const val DEADLINES = "notify-deadlines"
    const val GUESS = "notify-guess-grades"
    const val COMMUTE = "notify-commute"
    const val COMMUTE_DELAY = "notify-commute-delay"
    const val COMMUTE_CANCELLED = "notify-commute-cancelled"
    const val COMMUTE_LESSON_END = "notify-commute-lesson-end"

    val fields: List<Pair<String, String>> = listOf(
        "enabled" to ENABLED,
        "grades" to GRADES,
        "gradeNew" to GRADE_NEW,
        "gradeChanged" to GRADE_CHANGED,
        "timetable" to TIMETABLE,
        "lessonCancelled" to LESSON_CANCELLED,
        "lessonChanged" to LESSON_CHANGED,
        "exams" to EXAMS,
        "examNew" to EXAM_NEW,
        "examMoved" to EXAM_MOVED,
        "examCancelled" to EXAM_CANCELLED,
        "examRoom" to EXAM_ROOM,
        "absences" to ABSENCES,
        "events" to EVENTS,
        "appointmentNew" to APPOINTMENT_NEW,
        "messageNew" to MESSAGE_NEW,
        "deadlines" to DEADLINES,
        "guessGrades" to GUESS,
        "commute" to COMMUTE,
        "commuteDelay" to COMMUTE_DELAY,
        "commuteCancelled" to COMMUTE_CANCELLED,
        "commuteLessonEnd" to COMMUTE_LESSON_END,
    )
}

/** Every stored boolean, including false. Used to prove a round trip. */
fun NotifySettings.storedFields(): Map<String, Boolean> = mapOf(
    "enabled" to enabled,
    "grades" to grades,
    "gradeNew" to gradeNew,
    "gradeChanged" to gradeChanged,
    "timetable" to timetable,
    "lessonCancelled" to lessonCancelled,
    "lessonChanged" to lessonChanged,
    "exams" to exams,
    "examNew" to examNew,
    "examMoved" to examMoved,
    "examCancelled" to examCancelled,
    "examRoom" to examRoom,
    "absences" to absences,
    "events" to events,
    "appointmentNew" to appointmentNew,
    "messageNew" to messageNew,
    "deadlines" to deadlines,
    "guessGrades" to guessGrades,
    "commute" to commute,
    "commuteDelay" to commuteDelay,
    "commuteCancelled" to commuteCancelled,
    "commuteLessonEnd" to commuteLessonEnd,
)

/**
 * Rebuilds switches from a partial store. A missing key is not a stored false:
 * the master and the older categories default on, a missing fine switch follows
 * its category, and hidden grades stay off until the key is explicitly true.
 * This does not call [aligned], which would turn a stored category back on.
 */
fun notifySettingsFromStored(stored: Map<String, Boolean>): NotifySettings {
    fun parent(name: String): Boolean = stored[name] ?: true
    val grades = parent("grades")
    val timetable = parent("timetable")
    val exams = parent("exams")
    val events = parent("events")
    val commute = parent("commute")
    fun fine(name: String, fallback: Boolean): Boolean = stored[name] ?: fallback
    return NotifySettings(
        grades = grades,
        timetable = timetable,
        exams = exams,
        absences = parent("absences"),
        events = events,
        deadlines = parent("deadlines"),
        guessGrades = stored["guessGrades"] == true,
        enabled = parent("enabled"),
        gradeNew = fine("gradeNew", grades),
        gradeChanged = fine("gradeChanged", grades),
        lessonCancelled = fine("lessonCancelled", timetable),
        lessonChanged = fine("lessonChanged", timetable),
        examNew = fine("examNew", exams),
        examMoved = fine("examMoved", exams),
        examCancelled = fine("examCancelled", exams),
        examRoom = fine("examRoom", exams),
        appointmentNew = fine("appointmentNew", events),
        messageNew = fine("messageNew", events),
        commute = commute,
        commuteDelay = fine("commuteDelay", commute),
        commuteCancelled = fine("commuteCancelled", commute),
        commuteLessonEnd = fine("commuteLessonEnd", commute),
    )
}

/** Reads only keys that are present, so an app update keeps the stored choices. */
fun notifySettingsFromPrefs(present: (String) -> Boolean, read: (String) -> Boolean): NotifySettings {
    val stored = buildMap {
        for ((field, key) in NotifyPrefs.fields) {
            if (present(key)) put(field, read(key))
        }
    }
    return notifySettingsFromStored(stored)
}

data class SchulnetzChange(
    val id: String,
    val category: String,
    val title: String,
    val body: String,
    val target: String = "",
    val targetId: String = "",
    val courseId: String = "",
    val date: String = "",
    val targetIds: List<String> = emptyList(),
    /** Opaque identity hashes. Dedup uses these, never the row id. */
    val gradeKeys: List<String> = emptyList(),
    /** ISO time the server created a delivery-test row. Blank for school changes. */
    val serverAt: String = "",
    /** `probe:` plus the server clock digits. Blank for school changes. */
    val correlation: String = "",
    /** Position in one delivery batch. Zero for school changes. */
    val sequence: Int = 0,
) {
    fun linkIds(): List<String> = targetIds.ifEmpty { listOf(targetId).filter { it.isNotBlank() } }
}

/** Raw mobile REST payloads before they are normalised. Missing bodies are skipped. */
data class SchulnetzRaw(
    val me: String? = null,
    val grades: String? = null,
    val events: String? = null,
    val exams: String? = null,
    val absences: String? = null,
    val homework: String? = null,
    val messages: String? = null,
    val vacations: String? = null,
    val lateness: String? = null,
    val kontoHtml: String? = null,
    val startHtml: String? = null,
    val eventMin: String = "",
    val eventMax: String = "",
    val weekSpanStart: String = "",
    val weekSpanEnd: String = "",
    val eventsFetched: Boolean = false,
)

fun parseSchulnetzInstant(raw: String, zone: ZoneId = ZoneId.of("Europe/Zurich")): Instant? {
    val text = raw.trim()
    if (text.isEmpty()) return null
    // Schulnetz local timestamps have no offset. Instant.parse and OffsetDateTime.parse throw
    // on that shape, and those throws on the main thread are the tab-entry freeze.
    parseLocalSchulnetzInstant(text, zone)?.let { return it }
    runCatching { return Instant.parse(text) }
    runCatching { return OffsetDateTime.parse(text).toInstant() }
    runCatching { return LocalDateTime.parse(text).atZone(zone).toInstant() }
    runCatching { return LocalDate.parse(text.take(10)).atStartOfDay(zone).toInstant() }
    return null
}

private fun parseLocalSchulnetzInstant(text: String, zone: ZoneId): Instant? {
    if (text.length < 10 || text[4] != '-' || text[7] != '-') return null
    val year = text.substring(0, 4).toIntOrNull() ?: return null
    val month = text.substring(5, 7).toIntOrNull() ?: return null
    val day = text.substring(8, 10).toIntOrNull() ?: return null
    if (month !in 1..12 || day !in 1..31) return null
    if (text.length == 10) return zonedStart(year, month, day, zone)
    if (text.length < 19 || text[10] != 'T' || text[13] != ':' || text[16] != ':') return null
    val hour = text.substring(11, 13).toIntOrNull() ?: return null
    val minute = text.substring(14, 16).toIntOrNull() ?: return null
    val second = text.substring(17, 19).toIntOrNull() ?: return null
    if (hour !in 0..23 || minute !in 0..59 || second !in 0..59) return null
    var index = 19
    var nano = 0
    if (index < text.length && text[index] == '.') {
        val start = ++index
        while (index < text.length && text[index].isDigit()) index++
        val digits = text.substring(start, index)
        if (digits.isEmpty()) return null
        nano = digits.padEnd(9, '0').take(9).toIntOrNull() ?: return null
    }
    val local = try {
        LocalDateTime.of(year, month, day, hour, minute, second, nano)
    } catch (_: DateTimeException) {
        return null
    }
    if (index >= text.length) return local.atZone(zone).toInstant()
    val offset = zoneOffsetAt(text, index) ?: return null
    return local.toInstant(offset)
}

private fun zonedStart(year: Int, month: Int, day: Int, zone: ZoneId): Instant? = try {
    LocalDate.of(year, month, day).atStartOfDay(zone).toInstant()
} catch (_: DateTimeException) {
    null
}

private fun zoneOffsetAt(text: String, index: Int): ZoneOffset? {
    if (index >= text.length) return null
    if (text[index] == 'Z') return if (index == text.length - 1) ZoneOffset.UTC else null
    val sign = when (text[index]) {
        '+' -> 1
        '-' -> -1
        else -> return null
    }
    val rest = text.substring(index + 1)
    val hours: Int
    val minutes: Int
    val seconds: Int
    if (rest.length == 5 && rest[2] == ':') {
        hours = rest.substring(0, 2).toIntOrNull() ?: return null
        minutes = rest.substring(3, 5).toIntOrNull() ?: return null
        seconds = 0
    } else if (rest.length == 8 && rest[2] == ':' && rest[5] == ':') {
        hours = rest.substring(0, 2).toIntOrNull() ?: return null
        minutes = rest.substring(3, 5).toIntOrNull() ?: return null
        seconds = rest.substring(6, 8).toIntOrNull() ?: return null
    } else if (rest.length == 4 && rest.all { it.isDigit() }) {
        hours = rest.substring(0, 2).toIntOrNull() ?: return null
        minutes = rest.substring(2, 4).toIntOrNull() ?: return null
        seconds = 0
    } else {
        return null
    }
    if (hours > 18 || minutes > 59 || seconds > 59) return null
    val total = sign * (hours * 3600 + minutes * 60 + seconds)
    return if (total in -18 * 3600..18 * 3600) ZoneOffset.ofTotalSeconds(total) else null
}

fun AgendaEvent.startsAt(zone: ZoneId = ZoneId.of("Europe/Zurich")): Instant? = parseSchulnetzInstant(start, zone)

fun AgendaEvent.endsAt(zone: ZoneId = ZoneId.of("Europe/Zurich")): Instant? = parseSchulnetzInstant(end.ifBlank { start }, zone)

fun AgendaEvent.isChangedLesson(): Boolean = marker == "changed"
fun AgendaEvent.isMovedLesson(): Boolean = marker == "moved"
fun AgendaEvent.isAddedLesson(): Boolean = marker == "added"

val LESSON_MARKERS = listOf("cancelled", "added", "moved", "changed")

/**
 * The mark a school puts on a timetable lesson (`markierung`: none, new, moved, deleted and school-defined
 * labels such as "Geändert"). A deleted lesson is also drawn struck through (`textdeco` line-through).
 * Only lessons carry marks: on an exam the same field holds the exam material. Mirrors the server.
 */
fun lessonMarker(eventType: String, markierung: String, textdeco: String): String {
    val kind = cleanSchulnetzText(eventType).lowercase()
    if (kind.isNotBlank() && kind != "0_stp" && kind != "lesson") return ""
    val mark = cleanSchulnetzText(markierung).lowercase()
    if (mark == "deleted" || cleanSchulnetzText(textdeco).contains("line-through", ignoreCase = true)) return "cancelled"
    return when (mark) {
        "", "none" -> ""
        "new" -> "added"
        "moved" -> "moved"
        else -> "changed"
    }
}

fun AgendaEvent.isCancelled(): Boolean {
    val blob = "$status $eventType $text $comment $timetableText".lowercase()
    return listOf(
        "cancel", "cancelled", "canceled", "abgesagt", "fällt", "faellt", "entfällt", "entfaellt",
        "ausgefallen", "cancellation", "annull",
    ).any { blob.contains(it) }
}

fun AgendaEvent.isSubstitution(): Boolean {
    if (cleanSchulnetzText(substitute).isNotBlank()) return true
    val blob = "$status $eventType $comment $text $timetableText".lowercase()
    return listOf("substitution", "vertretung", "suppl", "supply", "stellvertretung").any { blob.contains(it) }
}

private val cdataWrapped = Regex("""(?is)^<!\[CDATA\[([\s\S]*)\]\]>$""")
private val cdataOpen = Regex("""(?i)<!\[CDATA\[""")
private val cdataClose = Regex("""\]\]>""")
private val clockToken = Regex("""(?:^|[\sT])([01]\d|2[0-3]):([0-5]\d)\b""")
private val isoDay = Regex("""(\d{4}-\d{2}-\d{2})""")
private val swissDay = Regex("""(\d{1,2})\.(\d{1,2})\.(\d{4})""")
private val examLeadRegex = Regex("""(?iu)^(prüfung|pruefung|klausur|test)\b""")
private val examTokenRegex = Regex("""(?i)(?:^|[^a-zäöü])test(?:[^a-zäöü]|$)""")
private val pruefungCodeRegex = Regex("""(?i)(?:^|_)pru(?:fung)?$""")

/** Schulnetz wraps scheduler fields in CDATA. The brackets are not part of the value. */
fun unwrapSchulnetz(raw: String): String {
    var value = raw.trim()
    while (true) {
        val match = cdataWrapped.find(value) ?: return value
        value = match.groupValues[1].trim()
    }
}

/** Drop CDATA markup, including a wrapper that sits inside a longer field. */
fun cleanSchulnetzText(raw: String): String {
    // Nearly every field is plain text: no CDATA brackets and single spaces only. It skips four regex passes.
    if (plainSchulnetzText(raw)) return raw.trim()
    return cdataClose.replace(cdataOpen.replace(unwrapSchulnetz(raw), ""), "")
        .replace(whitespaceRun, " ")
        .trim()
}

private val whitespaceRun = Regex("""\s+""")

/** No `[`/`]` (so no CDATA markup) and no whitespace other than single spaces: cleaning only trims. */
private fun plainSchulnetzText(raw: String): Boolean {
    var previousSpace = false
    for (char in raw) {
        if (char == '[' || char == ']') return false
        if (char == ' ') {
            if (previousSpace) return false
            previousSpace = true
        } else {
            if (char.isWhitespace() || char.code < 0x20) return false
            previousSpace = false
        }
    }
    return true
}

/** A real HH:mm from the field. The T inside `<![CDATA[` is not a time, and a date alone is not 00:00. */
fun schulnetzClock(raw: String): String {
    val match = clockToken.find(cleanSchulnetzText(raw)) ?: return ""
    return "${match.groupValues[1]}:${match.groupValues[2]}"
}

fun eventDayKey(raw: String): String {
    val text = cleanSchulnetzText(raw)
    isoDay.find(text)?.let { return it.groupValues[1] }
    val swiss = swissDay.find(text) ?: return ""
    val day = swiss.groupValues[1].padStart(2, '0')
    val month = swiss.groupValues[2].padStart(2, '0')
    return "${swiss.groupValues[3]}-$month-$day"
}

/** Clock text for a notification. Midnight is shown only when the event also ends at a later time. */
fun displayClock(start: String, end: String = ""): String {
    val from = schulnetzClock(start)
    val to = schulnetzClock(end)
    if (from.isBlank() || (from == "00:00" && (to.isBlank() || to == "00:00"))) return ""
    if (to.isBlank() || to == from) return from
    return "$from–$to"
}

/** Scheduler codes such as `1_pru`, plus the words exam, Prüfung, Klausur, and Test. */
fun examMarker(raw: String): Boolean {
    val kind = cleanSchulnetzText(raw).lowercase()
    if (kind.isEmpty()) return false
    if (kind == "1_pru" || pruefungCodeRegex.containsMatchIn(kind)) return true
    if (kind.contains("prüfung") || kind.contains("pruefung") || kind.contains("klausur") || kind.contains("exam")) return true
    return examTokenRegex.containsMatchIn(kind)
}

/** A leading Test/Prüfung/Klausur on a title. Lesetest and other longer words do not match. */
fun examLead(raw: String): Boolean {
    val line = cleanSchulnetzText(raw).lineSequence().firstOrNull { it.isNotBlank() }?.trim().orEmpty()
    return examLeadRegex.containsMatchIn(line)
}

fun canonicalEventType(raw: String): String {
    val kind = cleanSchulnetzText(raw)
    if (kind.isEmpty()) return "lesson"
    if (examMarker(kind)) return "exam"
    return kind
}

fun AgendaEvent.isExamLike(): Boolean = examMarker(eventType) || examLead(text) || examLead(timetableText)

/** Blank event types on the agenda endpoint are ordinary lessons. `0_stp` is the scheduler's Stundenplan row. */
fun AgendaEvent.isLesson(): Boolean {
    if (isExamLike()) return false
    val kind = cleanSchulnetzText(eventType).lowercase()
    if (kind.isBlank() || kind == "0_stp") return true
    return kind.contains("lesson") || kind.contains("unterricht") || kind.contains("timetable") || kind == "period" || kind == "stunde"
}

/** Full label plus the leading course code, so a grade row and a timetable block share one colour. */
fun colorKeys(name: String): List<String> {
    val full = name.trim().lowercase()
    if (full.isEmpty()) return emptyList()
    val token = full.substringBefore(' ').substringBefore('(').trim()
    return listOf(full, token).filter { it.isNotEmpty() }.distinct()
}

private fun hexColor(value: String): String? {
    val color = value.trim().lowercase()
    return color.takeIf { Regex("^#[0-9a-f]{6}$").matches(it) }
}

fun overrideColor(name: String, overrides: Map<String, String>): String? {
    val keys = colorKeys(name)
    for (key in keys) hexColor(overrides[key].orEmpty())?.let { return it }
    val code = keys.getOrNull(1) ?: keys.firstOrNull() ?: return null
    if (code.length < 3) return null
    return overrides.entries.mapNotNull { (stored, value) ->
        val color = hexColor(value) ?: return@mapNotNull null
        val storedCode = stored.substringBefore(' ').substringBefore('(').trim()
        if (storedCode.length < 3) return@mapNotNull null
        if (storedCode.startsWith(code) || code.startsWith(storedCode)) storedCode.length to color else null
    }.maxByOrNull { it.first }?.second
}

fun subjectColor(name: String, explicit: String = "", overrides: Map<String, String> = emptyMap()): String {
    overrideColor(name, overrides)?.let { return it }
    hexColor(explicit)?.let { return it }
    val basis = name.trim().lowercase().ifBlank { "fach" }
    var hash = 2166136261u
    for (char in basis) {
        hash = hash xor char.code.toUInt()
        hash *= 16777619u
    }
    return SUBJECT_PALETTE[(hash % SUBJECT_PALETTE.size.toUInt()).toInt()]
}

fun AgendaEvent.displayColor(overrides: Map<String, String> = emptyMap()): String = subjectColor(label, color, overrides)

/** Monday–Friday of the school week. Saturday and Sunday move to the next week unless the weekend is shown. */
fun timetableAnchor(today: LocalDate, includeWeekend: Boolean = false): LocalDate =
    if (includeWeekend) today else when (today.dayOfWeek) {
        DayOfWeek.SATURDAY, DayOfWeek.SUNDAY -> today.with(TemporalAdjusters.next(DayOfWeek.MONDAY))
        else -> today
    }

fun schoolWeek(anchor: LocalDate, includeWeekend: Boolean = false): List<LocalDate> {
    val monday = anchor.with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY))
    val last = if (includeWeekend) 6 else 4
    return (0..last).map { monday.plusDays(it.toLong()) }
}

fun eventsOn(events: List<AgendaEvent>, day: LocalDate, zone: ZoneId = ZoneId.of("Europe/Zurich")): List<AgendaEvent> =
    events.filter { event ->
        val start = event.startsAt(zone) ?: return@filter false
        start.atZone(zone).toLocalDate() == day
    }.sortedBy { it.startsAt(zone) ?: Instant.EPOCH }

/** One pass over the timetable. Heute and Planer used to repeat this for every day on the main thread. */
fun eventsByLocalDay(events: List<AgendaEvent>, zone: ZoneId = ZoneId.of("Europe/Zurich")): Map<LocalDate, List<AgendaEvent>> {
    if (events.isEmpty()) return emptyMap()
    val buckets = LinkedHashMap<LocalDate, MutableList<Pair<AgendaEvent, Instant>>>()
    for (event in events) {
        val start = event.startsAt(zone) ?: continue
        buckets.getOrPut(start.atZone(zone).toLocalDate()) { ArrayList() }.add(event to start)
    }
    return buckets.mapValues { (_, rows) ->
        rows.sortBy { it.second }
        rows.map { it.first }
    }
}

/** Next lesson start or end after [now]. Widget alarms use this once, then stop. */
fun nextLessonBoundary(events: List<AgendaEvent>, now: Instant, zone: ZoneId = ZoneId.of("Europe/Zurich")): Instant? {
    val earliest = now.plusSeconds(30)
    return events.asSequence()
        .flatMap { sequenceOf(it.startsAt(zone), it.endsAt(zone)) }
        .filterNotNull()
        .filter { it.isAfter(earliest) }
        .minOrNull()
}

fun nextUp(events: List<AgendaEvent>, now: Instant, zone: ZoneId = ZoneId.of("Europe/Zurich")): AgendaEvent? =
    events.mapNotNull { event ->
        val end = event.endsAt(zone) ?: return@mapNotNull null
        if (end.isBefore(now) || event.isCancelled()) null else event
    }.minByOrNull { it.startsAt(zone) ?: Instant.EPOCH }

fun todayChanges(events: List<AgendaEvent>, day: LocalDate, zone: ZoneId = ZoneId.of("Europe/Zurich")): List<AgendaEvent> =
    eventsOn(events, day, zone).filter { it.isCancelled() || it.isSubstitution() }
