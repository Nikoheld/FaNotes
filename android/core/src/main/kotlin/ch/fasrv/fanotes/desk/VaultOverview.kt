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

/** Files in the sidebar tree, including notes inside folders. PDFs count too. */
fun sidebarFileCount(nodes: List<VaultNode>): Int = nodes.sumOf { node ->
    if (node.kind == NoteKind.FOLDER) sidebarFileCount(node.children) else 1
}

/** Desktop sidebar footer: „1 Notiz“ or „N Notizen“. */
fun sidebarFileLabel(count: Int) = if (count == 1) "1 Notiz" else "$count Notizen"

/** Sidebar footer after the later chrome pass. */
const val SIDEBAR_FOOTER_DP = 34
const val SIDEBAR_FOOTER_PAD_X_DP = 12
const val SIDEBAR_FOOTER_PAD_Y_DP = 4

/** Sidebar header after the later chrome pass: 14px vault name, 30px actions. */
const val SIDEBAR_HEADER_PAD_TOP_DP = 14
const val SIDEBAR_HEADER_PAD_X_DP = 12
const val SIDEBAR_HEADER_PAD_BOTTOM_DP = 8
const val SIDEBAR_HEADER_GAP_DP = 8
const val SIDEBAR_VAULT_PAD_X_DP = 4
const val SIDEBAR_VAULT_PAD_Y_DP = 2
const val SIDEBAR_VAULT_SP = 14
const val SIDEBAR_VAULT_WEIGHT = 600
const val SIDEBAR_VAULT_TRACKING = -0.02f
const val SIDEBAR_ACTION_DP = 30
const val SIDEBAR_ACTION_RADIUS_DP = 6
const val SIDEBAR_ACTION_GAP_DP = 2
const val SIDEBAR_ACTION_ICON_DP = 16
const val SIDEBAR_PDF_MIN_DP = 34
const val SIDEBAR_PDF_PAD_DP = 7
const val SIDEBAR_PDF_TRACKING = 0.04f

/** Search field after the later chrome pass: quiet until hover or focus. */
const val SIDEBAR_SEARCH_MARGIN_X_DP = 8
const val SIDEBAR_SEARCH_MARGIN_BOTTOM_DP = 8
const val SIDEBAR_SEARCH_DP = 30
const val SIDEBAR_SEARCH_RADIUS_DP = 6
const val SIDEBAR_SEARCH_PAD_DP = 9
const val SIDEBAR_SEARCH_GAP_DP = 7
const val SIDEBAR_SEARCH_ICON_DP = 14
const val SIDEBAR_SEARCH_SP = 13
const val SIDEBAR_SEARCH_CLEAR_DP = 21
const val SIDEBAR_SEARCH_CLEAR_RADIUS_DP = 5
const val SIDEBAR_SEARCH_CLEAR_ICON_DP = 13

/** Tag chips. The later pass paints the active chip with `--panel-active`. */
const val TAG_FILTER_PAD_X_DP = 10
const val TAG_FILTER_PAD_TOP_DP = 6
const val TAG_FILTER_GAP_DP = 5
const val TAG_FILTER_HEIGHT_DP = 22
const val TAG_FILTER_PAD_H_DP = 8
const val TAG_FILTER_BORDER_ALPHA = 0.09f
const val TAG_FILTER_ACTIVE_BORDER_ALPHA = 0.16f

/** File tree inset from `.file-tree-wrap`. */
const val TREE_WRAP_PAD_TOP_DP = 2
const val TREE_WRAP_PAD_X_DP = 7
const val TREE_WRAP_PAD_BOTTOM_DP = 8

fun sidebarSearchFill(hot: Boolean) = if (hot) "panel-hover" else "clear"

fun tagFilterFill(active: Boolean) = if (active) "panel-active" else "panel"
