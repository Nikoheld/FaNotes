package ch.fasrv.fanotes.schulnetz

import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.ZoneId
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
) {
    val label: String get() = listOf(courseName, text, timetableText).map(::cleanSchulnetzText).firstOrNull { it.isNotBlank() } ?: "Lektion"
}

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
    val startMessages: List<String> = emptyList(),
    val readErrors: List<String> = emptyList(),
    /** Monday (ISO date) to the instant that week was last read. */
    val weekFetched: Map<String, String> = emptyMap(),
    val weekSpanStart: String = "",
    val weekSpanEnd: String = "",
    val icalFetchedAt: String = "",
)

data class NotifySettings(
    val grades: Boolean = true,
    val timetable: Boolean = true,
    val exams: Boolean = true,
    val absences: Boolean = true,
    val events: Boolean = true,
    val deadlines: Boolean = true,
    /** When true, new-grade pushes and lists hide the mark until it is revealed. Default off. */
    val guessGrades: Boolean = false,
)

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
    runCatching { return Instant.parse(text) }
    runCatching { return OffsetDateTime.parse(text).toInstant() }
    runCatching { return LocalDateTime.parse(text).atZone(zone).toInstant() }
    runCatching { return LocalDate.parse(text.take(10)).atStartOfDay(zone).toInstant() }
    return null
}

fun AgendaEvent.startsAt(zone: ZoneId = ZoneId.of("Europe/Zurich")): Instant? = parseSchulnetzInstant(start, zone)

fun AgendaEvent.endsAt(zone: ZoneId = ZoneId.of("Europe/Zurich")): Instant? = parseSchulnetzInstant(end.ifBlank { start }, zone)

fun AgendaEvent.isCancelled(): Boolean {
    val blob = "$status $eventType $text $comment $timetableText".lowercase()
    return listOf(
        "cancel", "cancelled", "canceled", "abgesagt", "fällt", "faellt", "entfällt", "entfaellt",
        "ausgefallen", "cancellation", "annull",
    ).any { blob.contains(it) }
}

fun AgendaEvent.isSubstitution(): Boolean {
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
fun cleanSchulnetzText(raw: String): String =
    cdataClose.replace(cdataOpen.replace(unwrapSchulnetz(raw), ""), "")
        .replace(Regex("""\s+"""), " ")
        .trim()

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
