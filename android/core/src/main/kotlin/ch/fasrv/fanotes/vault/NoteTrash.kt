package ch.fasrv.fanotes.vault

import ch.fasrv.fanotes.desk.formatNoteDate
import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.jsonBool
import ch.fasrv.fanotes.json.jsonString
import ch.fasrv.fanotes.json.parseJson
import ch.fasrv.fanotes.json.stringify
import java.time.LocalDate
import java.time.LocalTime

/** Local trash. Sync skips the whole directory, the same way it skips history. */
const val TRASH_ROOT = ".fanotes/trash"
const val TRASH_INDEX = ".fanotes/trash/index.json"
const val TRASH_NOTICE = "In den Papierkorb verschoben."
const val TRASH_EMPTY_NOTICE = "Papierkorb geleert."
const val TRASH_PURGED_NOTICE = "Endgültig gelöscht."
const val DUPLICATE_NOTICE = "Notiz dupliziert."
const val PDF_DUPLICATE_REFUSED = "Eine PDF-Notiz bleibt die Datei selbst."
const val STAMP_NEEDS_MARKDOWN = "Öffne eine Markdown-Notiz, um das Datum einzufügen."
const val STAMP_NEEDS_KEYBOARD = "Wechsle zur Tastatur, um das Datum in den Text zu setzen."
const val STAMP_FAILED = "Das Datum konnte nicht eingefügt werden."
const val WIKI_LINK_COPIED = "Wiki-Link kopiert."
const val STAMP_NOTICE = "Datum eingefügt."
const val TRASH_UNDO = "Rückgängig"

private val TRASH_ID = Regex("""^[a-zA-Z0-9_-]{1,80}$""")

data class TrashItem(
    val id: String,
    val path: String,
    val folder: Boolean,
    val deletedAt: String,
    val name: String,
)

fun trashBundle(id: String): String {
    if (!TRASH_ID.matches(id)) throw IllegalArgumentException("Ungültiger Papierkorb-Eintrag.")
    return "$TRASH_ROOT/$id"
}

fun trashRestoredNotice(name: String) = "„$name“ wiederhergestellt."

fun trashPurgeMessage(name: String) =
    "„$name“ endgültig löschen? Das kann nicht rückgängig gemacht werden."

fun trashEmptyMessage(count: Int): String = when {
    count <= 0 -> "Der Papierkorb ist leer."
    count == 1 -> "1 Eintrag endgültig löschen?"
    else -> "$count Einträge endgültig löschen?"
}

/**
 * The name a duplicate should ask for. A second copy of "Mechanik Kopie" still
 * asks for "Mechanik Kopie"; the vault adds the number. An older German or
 * English suffix is peeled off too. Matches `duplicatePreferredStem` in `noteQoL.ts`.
 */
fun duplicatePreferredStem(fileName: String, copyWord: String = "Kopie"): String {
    val suffix = copyWord.trim().ifBlank { "Kopie" }
    val words = listOf(suffix, "Kopie", "Copy").distinct()
    var base = fileName.replace(Regex("""\.(md|markdown|famd|pdf)$""", RegexOption.IGNORE_CASE), "").trim()
    var changed = true
    while (changed && base.isNotEmpty()) {
        changed = false
        for (word in words) {
            val next = base.replace(Regex(""" ${Regex.escape(word)}(?: \d+)?$"""), "").trim()
            if (next.isNotEmpty() && next != base) {
                base = next
                changed = true
            }
        }
    }
    return "${base.ifBlank { "Notiz" }} $suffix"
}

/** `[[Title]]` for the note. Brackets and pipes in the title would break the link. */
fun wikiLinkForNote(relativePath: String): String {
    val title = titleOf(relativePath).replace(Regex("""[\[\]|]"""), " ").replace(Regex("""\s+"""), " ").trim()
    return "[[${title.ifBlank { "Notiz" }}]]"
}

/** A stamp typed against a word gets one separating space. A line start stays flush. */
fun stampToInsert(textBeforeCursor: String, stamp: String): String {
    if (stamp.isEmpty()) return ""
    if (textBeforeCursor.isEmpty() || textBeforeCursor.last().isWhitespace()) return stamp
    return " $stamp"
}

/** Newest existing visits first, each path once. The open note can be left out. */
fun recentNotePaths(
    history: List<String>,
    exists: (String) -> Boolean,
    limit: Int = 5,
    skip: String? = null,
): List<String> {
    val seen = linkedSetOf<String>()
    val result = mutableListOf<String>()
    for (index in history.lastIndex downTo 0) {
        if (result.size >= limit) break
        val path = history[index]
        if (path.isEmpty() || path == skip || path in seen || !exists(path)) continue
        seen += path
        result += path
    }
    return result
}

/** One click folds every open folder, or opens every folder when all are shut. */
fun nextExpandedFolders(current: Set<String>, folders: List<String>): Set<String> {
    val anyOpen = folders.any { it in current }
    return if (anyOpen) emptySet() else folders.toSet()
}

/**
 * Where a trashed entry returns. The original path wins when it is free.
 * Otherwise the desktop move rule applies: `Name 2`, then `Name 3`.
 */
fun restoredVaultPath(original: String, folder: Boolean, occupied: (String) -> Boolean): String {
    val normalized = original.replace('\\', '/').trim('/')
    if (normalized.isEmpty()) throw IllegalArgumentException("Der Eintrag wurde nicht gefunden.")
    fun free(candidate: String): Boolean {
        if (occupied(candidate)) return false
        if (folder) return true
        val stem = restoredStem(candidate)
        return listOf(".md", ".famd", ".pdf").none { extension ->
            val companion = stem + extension
            companion != candidate && occupied(companion)
        }
    }
    if (free(normalized)) return normalized
    val parent = normalized.substringBeforeLast('/', "")
    val name = normalized.substringAfterLast('/')
    val extension = if (folder) "" else extensionOf(name)
    val base = if (extension.isEmpty()) name else name.removeSuffix(extension)
    fun join(leaf: String) = if (parent.isEmpty()) leaf else "$parent/$leaf"
    for (index in 2..10_000) {
        val candidate = join("$base $index$extension")
        if (free(candidate)) return candidate
    }
    throw IllegalArgumentException("Es konnte kein eindeutiger Name erzeugt werden.")
}

/** A file under the trashed entry follows the restored name. An ink asset keeps its path. */
fun remapRestoredFile(originalRoot: String, restoredRoot: String, file: String): String {
    val originalStem = restoredStem(originalRoot)
    val restored = restoredStem(restoredRoot)
    if (file == originalStem || file.startsWith("$originalStem/") || file.startsWith("$originalStem.")) {
        return restored + file.removePrefix(originalStem)
    }
    return file
}

private fun restoredStem(path: String): String {
    val name = path.substringAfterLast('/')
    val extension = listOf(".markdown", ".famd", ".pdf", ".md").firstOrNull { name.endsWith(it, ignoreCase = true) }
        ?: return path
    return path.dropLast(extension.length)
}

fun readTrashIndex(io: VaultIo): List<TrashItem> {
    val raw = io.read(TRASH_INDEX)?.decodeToString() ?: return emptyList()
    val root = runCatching { parseJson(raw) as? JsonValue.Obj }.getOrNull() ?: return emptyList()
    val items = root.array("items") ?: return emptyList()
    return items.items.mapNotNull { value ->
        val obj = value as? JsonValue.Obj ?: return@mapNotNull null
        val id = obj.string("id") ?: return@mapNotNull null
        val path = obj.string("path")?.replace('\\', '/')?.trim('/') ?: return@mapNotNull null
        if (!TRASH_ID.matches(id) || path.isEmpty()) return@mapNotNull null
        TrashItem(
            id = id,
            path = path,
            folder = obj.bool("folder") == true,
            deletedAt = obj.string("deletedAt").orEmpty(),
            name = obj.string("name").orEmpty().ifBlank { titleOf(path) },
        )
    }
}

fun writeTrashIndex(io: VaultIo, items: List<TrashItem>) {
    if (items.isEmpty()) {
        if (io.exists(TRASH_INDEX)) io.delete(TRASH_INDEX)
        return
    }
    val arr = JsonValue.Arr()
    for (item in items) {
        arr.items += JsonValue.Obj().apply {
            put("id", jsonString(item.id))
            put("path", jsonString(item.path))
            put("folder", jsonBool(item.folder))
            put("deletedAt", jsonString(item.deletedAt))
            put("name", jsonString(item.name))
        }
    }
    val root = JsonValue.Obj().apply { put("items", arr) }
    io.write(TRASH_INDEX, root.stringify().encodeToByteArray())
}

/** Newest first. */
fun listTrashItems(io: VaultIo): List<TrashItem> = readTrashIndex(io).asReversed()

/**
 * Date and time in the daily-note pattern, then `HH:mm`.
 * `YYYY-MM-DD` at 16:19 is `2026-10-16 16:19`.
 */
fun noteDateStamp(day: LocalDate, time: LocalTime, pattern: String): String {
    val date = formatNoteDate(pattern, day)
    return "$date %02d:%02d".format(time.hour, time.minute)
}

/** Puts the stamp on its own line at the end of the note. */
fun insertNoteStamp(markdown: String, stamp: String): String {
    val line = stamp.trim()
    if (line.isEmpty()) return markdown
    val body = markdown.trimEnd()
    return if (body.isEmpty()) "$line\n" else "$body\n\n$line\n"
}
