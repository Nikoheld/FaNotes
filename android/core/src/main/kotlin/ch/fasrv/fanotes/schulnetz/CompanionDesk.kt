package ch.fasrv.fanotes.schulnetz

import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit

data class CompanionBadge(val id: String, val title: String, val detail: String, val earned: Boolean)

/** Local profile. Nothing here is compared with another account. */
fun companionBadges(notesWritten: Int, streakDays: Int, highestMark: Double?): List<CompanionBadge> = listOf(
    CompanionBadge("notes-1", "Erste Notiz", "Eine Notiz geschrieben", notesWritten >= 1),
    CompanionBadge("notes-10", "Zehn Notizen", "Zehn Notizen im Konto", notesWritten >= 10),
    CompanionBadge("streak-3", "Drei Tage", "Die App an drei Tagen hintereinander geöffnet", streakDays >= 3),
    CompanionBadge("first-six", "Erste 6", "Eine Note mit der Bewertung 6", highestMark != null && highestMark >= 5.999),
)

fun openingStreak(days: Set<String>, today: LocalDate): Int {
    var cursor = today
    var count = 0
    while (days.contains(cursor.toString())) {
        count += 1
        cursor = cursor.minusDays(1)
    }
    return count
}

/**
 * Reminder before an excuse deadline. Excused absences and missing dates produce nothing.
 * The captured Schulnetz pages had no open absence, so this is driven by the date field when a page does contain one.
 */
fun excuseReminders(absences: List<SchoolAbsence>, today: LocalDate, withinDays: Int = 2): List<SchulnetzChange> {
    if (withinDays < 0) return emptyList()
    return absences.mapNotNull { absence ->
        if (absence.excused) return@mapNotNull null
        val deadline = parseSchoolDate(absence.excuseUntil) ?: return@mapNotNull null
        val days = ChronoUnit.DAYS.between(today, deadline)
        if (days < 0 || days > withinDays) return@mapNotNull null
        val whenText = if (days == 0L) "heute" else if (days == 1L) "morgen" else "in $days Tagen"
        SchulnetzChange(
            id = "deadline:${absence.id}:${deadline}",
            category = "deadline",
            title = "Entschuldigung läuft ab",
            body = listOf(absence.subject.ifBlank { "Absenz" }, absence.reason, "Frist $whenText (${deadline.format(DateTimeFormatter.ofPattern("d.M.yyyy"))})").filter { it.isNotBlank() }.joinToString(" · "),
        )
    }
}

fun parseSchoolDate(raw: String): LocalDate? {
    val match = Regex("""(\d{1,2})\.(\d{1,2})\.(\d{4})""").find(raw) ?: return null
    return runCatching {
        LocalDate.of(match.groupValues[3].toInt(), match.groupValues[2].toInt(), match.groupValues[1].toInt())
    }.getOrNull()
}
