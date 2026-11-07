package ch.fasrv.fanotes.schulnetz

import java.time.LocalDate
import java.time.ZoneId
import java.util.ArrayDeque

/**
 * Opt-in diagnostic fixtures. They are built in memory for the diagnostic
 * screen and are never written into the school snapshot.
 */
enum class DiagnosticScenario {
    OFF,
    SCHOOL,
    STATES,
    MALFORMED,
    ALERTS,
    ;

    fun id(): String = name.lowercase()

    companion object {
        fun fromId(raw: String?): DiagnosticScenario = when (raw?.trim()?.lowercase()) {
            "school" -> SCHOOL
            "states" -> STATES
            "malformed" -> MALFORMED
            "alerts" -> ALERTS
            else -> OFF
        }
    }
}

data class DiagnosticPreview(val title: String, val detail: String)

data class DiagnosticEntry(
    val category: String,
    val name: String,
    val durationMs: Long,
    val result: String,
    val detail: String,
)

data class SyntheticRow(val id: String, val title: String, val start: String)

data class SyntheticCleanup(val kept: List<SyntheticRow>, val dropped: Int, val duplicates: Int)

/** Drops blank ids and undated rows, and keeps the first copy of a duplicate id. */
fun collapseSyntheticRows(rows: List<SyntheticRow>): SyntheticCleanup {
    val kept = ArrayList<SyntheticRow>()
    val seen = HashSet<String>()
    var dropped = 0
    var duplicates = 0
    for (row in rows) {
        if (row.id.isBlank() || eventDayKey(row.start).isBlank()) {
            dropped += 1
            continue
        }
        if (!seen.add(row.id)) {
            duplicates += 1
            continue
        }
        kept += row
    }
    return SyntheticCleanup(kept, dropped, duplicates)
}

/**
 * A display copy. The lists on [base] stay the same instances, so a caller
 * cannot persist the simulation by writing [base] back.
 */
fun isolateSchoolSnapshot(
    base: SchulnetzSnapshot,
    extraGrades: List<SchoolGrade>,
    extraEvents: List<AgendaEvent>,
): SchulnetzSnapshot = base.copy(
    grades = base.grades + extraGrades,
    events = base.events + extraEvents,
)

fun httpResultCategory(status: Int): String = when {
    status == 0 -> "offline"
    status == 401 || status == 403 -> "auth"
    status == 409 -> "conflict"
    status == 429 -> "limit"
    status in 500..599 -> "server"
    status in 200..299 -> "ok"
    else -> "http"
}

private val privateDiagnosticText = Regex(
    """(?i)bearer\s+\S+|eyJ[A-Za-z0-9_-]{10,}|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|\b[1-6][.,]\d{1,2}\b(?:\s+\p{L}{2,24})?|password\s*[:=]\s*\S+|token\s*[:=]\s*\S+""",
)

/** Removes marks, addresses, and credentials. Dates such as 07.11.2026 stay. */
fun sanitizeDiagnosticField(raw: String): String =
    privateDiagnosticText.replace(raw.take(180), "•").replace(Regex("""\s+"""), " ").trim()

fun diagnosticReport(build: String, status: List<String>, entries: List<DiagnosticEntry>): String = buildString {
    appendLine("Kanti+ Diagnose")
    append("Build: ").appendLine(sanitizeDiagnosticField(build))
    appendLine("Simulationen sind keine Schuldaten. Dieser Export enthält keine Notizen, Token oder Noten.")
    status.forEach { appendLine(sanitizeDiagnosticField(it)) }
    appendLine("---")
    entries.takeLast(DiagnosticTrace.CAPACITY).forEach { entry ->
        append(sanitizeDiagnosticField(entry.category))
        append(' ')
        append(sanitizeDiagnosticField(entry.name))
        append(' ')
        append(entry.durationMs)
        append("ms ")
        append(sanitizeDiagnosticField(entry.result))
        if (entry.detail.isNotBlank()) {
            append(' ')
            append(sanitizeDiagnosticField(entry.detail))
        }
        appendLine()
    }
}.take(12_000)

fun diagnosticPreview(
    scenario: DiagnosticScenario,
    zone: ZoneId,
    today: LocalDate,
    settings: NotifySettings = NotifySettings(),
): List<DiagnosticPreview> = when (scenario) {
    DiagnosticScenario.OFF -> emptyList()
    DiagnosticScenario.SCHOOL -> schoolPreview(zone, today)
    DiagnosticScenario.STATES -> statePreview()
    DiagnosticScenario.MALFORMED -> malformedPreview()
    DiagnosticScenario.ALERTS -> alertPreview(settings)
}

/** Short export line. It names switches, never a mark or a school payload. */
fun diagnosticAlertStatus(settings: NotifySettings): String {
    val off = ArrayList<String>()
    if (!settings.gradeNew) off += "neue Noten"
    if (!settings.gradeChanged) off += "Notenänderungen"
    if (!settings.examNew) off += "neue Prüfungen"
    if (!settings.examMoved) off += "Prüfungen verschoben"
    if (!settings.examCancelled) off += "Prüfungen abgesagt"
    if (!settings.examRoom) off += "Prüfungsraum"
    if (!settings.lessonCancelled) off += "Lektionen abgesagt"
    if (!settings.lessonChanged) off += "Stundenplan"
    if (!settings.appointmentNew) off += "neue Termine"
    if (!settings.messageNew) off += "Mitteilungen"
    if (!settings.absences) off += "Absenzen"
    if (!settings.deadlines) off += "Fristen"
    val master = if (settings.enabled) "an" else "aus"
    val hidden = if (settings.guessGrades) "an" else "aus"
    val tail = if (off.isEmpty()) "" else " · aus: ${off.joinToString(", ")}"
    return "Schulmeldungen: $master$tail · Noten verstecken: $hidden"
}

private val alertPreviewKinds = listOf(
    "grade-new" to "Neue Noten",
    "grade-changed" to "Notenänderungen",
    "exam-new" to "Neue Prüfungen",
    "exam-moved" to "Prüfungen verschoben",
    "exam-cancelled" to "Prüfungen abgesagt",
    "exam-room" to "Raumänderung bei Prüfungen",
    "lesson-cancelled" to "Lektionen abgesagt",
    "lesson-changed" to "Stundenplan geändert",
    "appointment-new" to "Neue Termine",
    "message-new" to "Neue Mitteilungen",
    "absence-new" to "Neue Absenzen",
    "deadline" to "Entschuldigungsfristen",
)

/** Local preview of the saved switches. It does not post a notice or write the snapshot. */
private fun alertPreview(settings: NotifySettings): List<DiagnosticPreview> {
    val lines = ArrayList<DiagnosticPreview>()
    lines += DiagnosticPreview(
        "Simulation: Hauptschalter",
        if (settings.enabled) "an · Schuldaten werden weiter gelesen" else "aus · Schuldaten werden weiter gelesen",
    )
    for ((kind, label) in alertPreviewKinds) {
        val gate = schoolAlertGate(settings, sampleSchoolAlert(kind), notificationsPermitted = true)
        lines += DiagnosticPreview("Simulation: $label", if (gate == AlertGate.DELIVER) "an" else "aus")
    }
    val probe = schoolAlertGate(
        settings,
        SchulnetzChange("probe:1", "grade", "Test: Neue Note", "Test"),
        notificationsPermitted = true,
    )
    lines += DiagnosticPreview(
        "Simulation: Zustelltest",
        if (probe == AlertGate.DELIVER) "an · ignoriert die Schulschalter" else "aus",
    )
    lines += DiagnosticPreview("Simulation: Vordergrund und Hintergrund", "gleiche Prüfung vor dem Anzeigen")
    lines += DiagnosticPreview(
        "Simulation: Noten verstecken",
        if (settings.guessGrades) "an · unabhängig vom Hauptschalter" else "aus · unabhängig vom Hauptschalter",
    )
    return lines
}

private fun schoolPreview(zone: ZoneId, today: LocalDate): List<DiagnosticPreview> {
    val day = today.toString()
    val future = today.plusDays(10).toString()
    val events = listOf(
        simEvent("sim:exam-moved", "${today.plusDays(1)}T10:15:00", "${today.plusDays(1)}T11:00:00", "Simulation: Prüfung verschoben", "exam"),
        simEvent("sim:exam-cancelled", "${day}T12:00:00", "${day}T12:45:00", "Simulation: Prüfung abgesagt", "exam", "cancelled"),
        simEvent("sim:lesson-cancelled", "${day}T08:15:00", "${day}T09:00:00", "Simulation: Lektion abgesagt", "lesson", "cancelled"),
        simEvent("sim:future", "${future}T10:00:00", "${future}T10:45:00", "Simulation: Lektion nächste Woche", "lesson"),
        simEvent("sim:zurich-late", "${day}T23:30:00", "${day}T23:45:00", "Simulation: Zürich 23:30", "lesson"),
        simEvent("sim:utc-late", "${day}T23:30:00Z", "${day}T23:45:00Z", "Simulation: UTC 23:30", "lesson"),
    )
    val byDay = eventsByLocalDay(events, zone)
    val lines = ArrayList<DiagnosticPreview>()
    lines += DiagnosticPreview(
        "Simulation: Testfach",
        "Neue Note · Datum ${formatProbeDay(day)}",
    )
    lines += DiagnosticPreview(
        "Simulation: Termin",
        messageHeadline("Termin", "Simulation: Elterngespräch"),
    )
    for (event in events) {
        val placed = byDay.entries.firstOrNull { (_, rows) -> event.id in rows.map { it.id } }?.key
        val placedDay = formatProbeDay(placed?.toString().orEmpty()).ifBlank { "ohne Datum" }
        val state = if (event.isCancelled()) "abgesagt" else "geplant"
        lines += DiagnosticPreview(preferredEventTitle(event), "$state · $placedDay")
    }
    return lines
}

private fun statePreview(): List<DiagnosticPreview> = listOf(
    DiagnosticPreview("Leer", "Simulation: keine Zeilen. Gespeicherte Schuldaten bleiben."),
    DiagnosticPreview("Fehler", "Simulation: Kategorie read. Kein Schulnetz-Abruf."),
    DiagnosticPreview("Laden", "Simulation: die Ansicht wartet. Es läuft kein echter Abruf."),
    DiagnosticPreview("Offline", "Simulation: FaNotes ist offline. Die Schule bleibt getrennt."),
    DiagnosticPreview("Wieder verbunden", "Simulation: der Status wechselt zurück auf bereit."),
    DiagnosticPreview("Anmeldung abgelaufen", "Simulation. Die echte Sitzung wird nicht abgemeldet."),
    DiagnosticPreview("Sync-Konflikt", "Simulation. Keine Fassung wird überschrieben."),
)

private fun malformedPreview(): List<DiagnosticPreview> {
    val cleaned = collapseSyntheticRows(malformedFixture())
    return listOf(
        DiagnosticPreview("Behalten", cleaned.kept.joinToString(", ") { it.title }.ifBlank { "keine" }),
        DiagnosticPreview("Verworfen", "${cleaned.dropped} ungültig · ${cleaned.duplicates} doppelt"),
    )
}

internal fun malformedFixture(day: String = "2026-11-07"): List<SyntheticRow> = listOf(
    SyntheticRow("sim:keep", "Simulation: gültige Zeile", "${day}T08:15:00"),
    SyntheticRow("", "Simulation: ohne Kennung", "${day}T09:00:00"),
    SyntheticRow("sim:bad-date", "Simulation: ohne Datum", "kein-datum"),
    SyntheticRow("sim:keep", "Simulation: Duplikat", "${day}T10:00:00"),
)

private fun simEvent(id: String, start: String, end: String, text: String, type: String, status: String = ""): AgendaEvent =
    AgendaEvent(
        id = id,
        start = start,
        end = end,
        text = text,
        comment = "",
        room = "",
        teachers = emptyList(),
        courseId = "",
        courseName = "SIM",
        status = status,
        eventType = type,
        color = "",
        timetableText = text,
    )

/**
 * Small ring buffer. Recording is a no-op until [enabled] is set, and the
 * buffer never grows past [CAPACITY].
 */
object DiagnosticTrace {
    const val CAPACITY = 60
    const val STALL_MS = 32L

    @Volatile
    var enabled: Boolean = false

    private val processStartNs = System.nanoTime()
    private val lock = Any()
    private val entries = ArrayDeque<DiagnosticEntry>()

    fun clear() {
        synchronized(lock) { entries.clear() }
    }

    fun recent(): List<DiagnosticEntry> = synchronized(lock) { entries.toList() }

    fun failures(): List<DiagnosticEntry> = recent().filter {
        it.result == "error" || it.result == "slow" || it.result == "offline" || it.result == "conflict" || it.result == "dropped" || it.result == "auth" || it.result == "server"
    }

    fun record(category: String, name: String, durationMs: Long = 0, result: String = "ok", detail: String = "") {
        if (!enabled) return
        val entry = DiagnosticEntry(
            category.take(24),
            sanitizeDiagnosticField(name).take(48),
            durationMs.coerceAtLeast(0),
            sanitizeDiagnosticField(result).take(24),
            sanitizeDiagnosticField(detail),
        )
        synchronized(lock) {
            entries.addLast(entry)
            while (entries.size > CAPACITY) entries.removeFirst()
        }
    }

    fun noteEnabled() {
        enabled = true
        record("startup", "enabled", (System.nanoTime() - processStartNs) / 1_000_000L, "ok")
    }

    inline fun <T> span(category: String, name: String, block: () -> T): T {
        if (!enabled) return block()
        val started = System.nanoTime()
        return try {
            val value = block()
            val elapsed = (System.nanoTime() - started) / 1_000_000L
            if (category != "tab" || elapsed >= STALL_MS) {
                record(category, name, elapsed, if (elapsed >= STALL_MS) "slow" else "ok")
            }
            value
        } catch (error: Throwable) {
            record(category, name, (System.nanoTime() - started) / 1_000_000L, "error", error.javaClass.simpleName)
            throw error
        }
    }
}
