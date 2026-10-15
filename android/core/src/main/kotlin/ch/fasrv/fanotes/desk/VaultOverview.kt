package ch.fasrv.fanotes.desk

import ch.fasrv.fanotes.vault.NoteKind
import ch.fasrv.fanotes.vault.VaultNode
import java.text.Collator
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * Folder picture from the desktop vault overview: two levels of nesting,
 * notes under each folder, and loose root notes as „Allgemein“.
 */

private val HUES = intArrayOf(257, 174, 211, 33, 296, 145, 12, 228, 92, 326)
private const val MAX_FOLDER_DEPTH = 2
private val NAME_ORDER = Collator.getInstance(Locale.GERMAN)
private val MODIFIED = DateTimeFormatter.ofPattern("dd. MMM", Locale.GERMAN)

data class OverviewFolder(
    val id: String,
    val name: String,
    val depth: Int,
    val noteCount: Int,
    val latestPath: String?,
    val latestTitle: String?,
    val latestModifiedMs: Long,
    val subfolders: Int,
    val color: String?,
    val hue: Int,
)

data class OverviewPicture(
    val folders: List<OverviewFolder>,
    val noteCount: Int,
    val topFolders: Int,
)

fun vaultOverview(nodes: List<VaultNode>, colors: Map<String, String> = emptyMap()): OverviewPicture {
    val folders = collectFolderRows(nodes, 0, 0, colors).toMutableList()
    val loose = nodes.filter { it.kind == NoteKind.MARKDOWN }.sortedWith(noteOrder)
    if (loose.isNotEmpty()) {
        val latest = loose.first()
        folders += OverviewFolder(
            id = "__root-notes__",
            name = "Allgemein",
            depth = 0,
            noteCount = loose.size,
            latestPath = latest.path,
            latestTitle = latest.name,
            latestModifiedMs = latest.modifiedAt,
            subfolders = 0,
            color = null,
            hue = HUES[folders.size % HUES.size],
        )
    }
    val notes = collectNotes(nodes)
    return OverviewPicture(
        folders = folders,
        noteCount = notes.size,
        topFolders = folders.count { it.depth == 0 && it.id != "__root-notes__" },
    )
}

fun overviewStatsLine(topFolders: Int, notes: Int): String {
    val noteWord = if (notes == 1) "Notiz" else "Notizen"
    return "$topFolders Ordner · $notes $noteWord"
}

fun overviewFolderCountLabel(count: Int): String =
    if (count == 0) "Bereit für dein erstes Fach" else "$count Einträge"

fun overviewSubfolderLabel(count: Int): String? = if (count > 0) "$count Unterordner" else null

fun overviewLatestLabel(folder: OverviewFolder): String = folder.latestTitle ?: "Erste Notiz anlegen"

fun overviewActionLabel(folder: OverviewFolder): String =
    if (folder.latestPath != null) "${folder.name}: ${folder.latestTitle} öffnen" else "${folder.name}: erste Notiz erstellen"

fun overviewModifiedLabel(modifiedMs: Long, zone: ZoneId = ZoneId.systemDefault()): String {
    if (modifiedMs <= 0L) return "—"
    return MODIFIED.format(Instant.ofEpochMilli(modifiedMs).atZone(zone))
}

fun overviewPathParent(path: String): String {
    val parts = path.split('/').filter { it.isNotEmpty() }
    return if (parts.size > 1) parts.dropLast(1).joinToString(" / ") else "Vault"
}

/** Last opened first, duplicates dropped, at most eight. */
fun overviewRecent(paths: List<String>): List<String> {
    val seen = LinkedHashSet<String>()
    for (path in paths.asReversed()) {
        if (path.isEmpty() || !seen.add(path)) continue
        if (seen.size == 8) break
    }
    return seen.toList()
}

fun overviewRecentTitle(path: String): String {
    val name = path.substringAfterLast('/')
    return name.replace(Regex("""\.(md|markdown|famd)$""", RegexOption.IGNORE_CASE), "").ifBlank { "Unbenannte Notiz" }
}

private val noteOrder = compareByDescending<VaultNode> { it.modifiedAt }.thenBy { NAME_ORDER.getCollationKey(it.name) }

private fun collectNotes(nodes: List<VaultNode>): List<VaultNode> = nodes.flatMap { node ->
    when (node.kind) {
        NoteKind.MARKDOWN -> listOf(node)
        NoteKind.FOLDER -> collectNotes(node.children)
        else -> emptyList()
    }
}

private fun collectFolderRows(
    nodes: List<VaultNode>,
    depth: Int,
    hueOffset: Int,
    colors: Map<String, String>,
): List<OverviewFolder> {
    val folders = nodes.filter { it.kind == NoteKind.FOLDER }.sortedWith(compareBy { NAME_ORDER.getCollationKey(it.name) })
    return folders.flatMapIndexed { index, folder ->
        val notes = collectNotes(folder.children).sortedWith(noteOrder)
        val latest = notes.firstOrNull()
        val row = OverviewFolder(
            id = folder.path,
            name = folder.name,
            depth = depth,
            noteCount = notes.size,
            latestPath = latest?.path,
            latestTitle = latest?.name,
            latestModifiedMs = latest?.modifiedAt ?: 0L,
            subfolders = folder.children.count { it.kind == NoteKind.FOLDER },
            color = colors[folder.path],
            hue = HUES[(hueOffset + index) % HUES.size],
        )
        if (depth >= MAX_FOLDER_DEPTH) listOf(row)
        else listOf(row) + collectFolderRows(folder.children, depth + 1, hueOffset + index * 5 + 1, colors)
    }
}
