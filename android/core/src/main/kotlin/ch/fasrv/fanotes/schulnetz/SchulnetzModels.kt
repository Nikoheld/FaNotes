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
    val label: String get() = courseName.ifBlank { text }.ifBlank { timetableText }.ifBlank { "Lektion" }
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
)

data class NotifySettings(
    val grades: Boolean = true,
    val timetable: Boolean = true,
    val exams: Boolean = true,
    val absences: Boolean = true,
    val events: Boolean = true,
)

data class SchulnetzChange(
    val id: String,
    val category: String,
    val title: String,
    val body: String,
)

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

fun AgendaEvent.isExamLike(): Boolean {
    val kind = eventType.lowercase()
    return kind.contains("exam") || kind.contains("prüfung") || kind.contains("pruefung") || kind.contains("klausur")
}

/** Blank event types on the agenda endpoint are ordinary lessons. */
fun AgendaEvent.isLesson(): Boolean {
    if (isExamLike()) return false
    val kind = eventType.lowercase()
    if (kind.isBlank()) return true
    return kind.contains("lesson") || kind.contains("unterricht") || kind.contains("timetable") || kind == "period" || kind == "stunde"
}

fun subjectColor(name: String, explicit: String = ""): String {
    val given = explicit.trim().lowercase()
    if (Regex("^#[0-9a-f]{6}$").matches(given)) return given
    val basis = name.trim().lowercase().ifBlank { "fach" }
    var hash = 2166136261u
    for (char in basis) {
        hash = hash xor char.code.toUInt()
        hash *= 16777619u
    }
    return SUBJECT_PALETTE[(hash % SUBJECT_PALETTE.size.toUInt()).toInt()]
}

fun AgendaEvent.displayColor(): String = subjectColor(label, color)

/** Monday–Friday of the school week. Saturday and Sunday move to the next week. */
fun timetableAnchor(today: LocalDate): LocalDate = when (today.dayOfWeek) {
    DayOfWeek.SATURDAY, DayOfWeek.SUNDAY -> today.with(TemporalAdjusters.next(DayOfWeek.MONDAY))
    else -> today
}

fun schoolWeek(anchor: LocalDate): List<LocalDate> {
    val monday = anchor.with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY))
    return (0..4).map { monday.plusDays(it.toLong()) }
}

fun eventsOn(events: List<AgendaEvent>, day: LocalDate, zone: ZoneId = ZoneId.of("Europe/Zurich")): List<AgendaEvent> =
    events.filter { event ->
        val start = event.startsAt(zone) ?: return@filter false
        start.atZone(zone).toLocalDate() == day
    }.sortedBy { it.startsAt(zone) ?: Instant.EPOCH }

fun nextUp(events: List<AgendaEvent>, now: Instant, zone: ZoneId = ZoneId.of("Europe/Zurich")): AgendaEvent? =
    events.mapNotNull { event ->
        val end = event.endsAt(zone) ?: return@mapNotNull null
        if (end.isBefore(now) || event.isCancelled()) null else event
    }.minByOrNull { it.startsAt(zone) ?: Instant.EPOCH }

fun todayChanges(events: List<AgendaEvent>, day: LocalDate, zone: ZoneId = ZoneId.of("Europe/Zurich")): List<AgendaEvent> =
    eventsOn(events, day, zone).filter { it.isCancelled() || it.isSubstitution() }
