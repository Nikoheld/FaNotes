package ch.fasrv.fanotes.desk

import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale

/** Long German date for the calendar day section ("Sonntag, 22. November 2026"); the ISO form stays internal. */
fun calendarDayLabel(day: LocalDate): String =
    day.format(DateTimeFormatter.ofPattern("EEEE, d. MMMM yyyy", Locale.GERMAN))

/** Weekday labels of the study-time chart with their index into `dwellByWeekday` (0 = Sunday); Monday first like the calendar. */
val STUDY_WEEKDAY_ORDER: List<Pair<Int, String>> =
    listOf(1 to "Mo", 2 to "Di", 3 to "Mi", 4 to "Do", 5 to "Fr", 6 to "Sa", 0 to "So")

/** Subject rows without internal folders (`.fanotes`, `.trash`, ...): those are not Fächer. */
fun visibleStudySubjects(rows: List<StudySubject>): List<StudySubject> =
    rows.filterNot { it.subject.startsWith(".") }

/** Top-level folders that are infrastructure, not school subjects. */
fun isSubjectFolderName(name: String): Boolean {
    val trimmed = name.trim()
    return trimmed.isNotEmpty() && !trimmed.startsWith(".") && !trimmed.equals("assets", ignoreCase = true)
}

/** Every folder path of the vault tree, in tree order, skipping hidden/internal folders. */
fun vaultFolderPaths(nodes: List<ch.fasrv.fanotes.vault.VaultNode>): List<String> = buildList {
    fun visit(list: List<ch.fasrv.fanotes.vault.VaultNode>) {
        for (node in list) {
            if (node.kind == ch.fasrv.fanotes.vault.NoteKind.FOLDER && !node.name.startsWith(".")) {
                add(node.path)
                visit(node.children)
            }
        }
    }
    visit(nodes)
}

/** Every PDF path of the vault tree, in tree order. */
fun vaultPdfPaths(nodes: List<ch.fasrv.fanotes.vault.VaultNode>): List<String> = buildList {
    fun visit(list: List<ch.fasrv.fanotes.vault.VaultNode>) {
        for (node in list) {
            if (node.kind == ch.fasrv.fanotes.vault.NoteKind.FOLDER) {
                if (!node.name.startsWith(".")) visit(node.children)
            } else if (node.kind == ch.fasrv.fanotes.vault.NoteKind.PDF) {
                add(node.path)
            }
        }
    }
    visit(nodes)
}
