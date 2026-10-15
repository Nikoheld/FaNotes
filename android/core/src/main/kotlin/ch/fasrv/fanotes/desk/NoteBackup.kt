package ch.fasrv.fanotes.desk

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.jsonArray
import ch.fasrv.fanotes.json.jsonString
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

/** In-note snapshots stored as `payload.noteBackups`, matching `noteBackup.ts`. */
const val NOTE_BACKUP_LIMIT = 40
const val NOTE_BACKUP_MAX_CHARS = 2 * 1024 * 1024
private val BACKUP_ID = Regex("^[a-zA-Z0-9._-]{1,96}$")

data class NoteBackup(val id: String, val notePath: String, val createdAt: String, val content: String)

fun parseNoteBackups(value: JsonValue.Arr?): List<NoteBackup> {
    val seen = HashSet<String>()
    val snapshots = ArrayList<NoteBackup>()
    for (item in value?.items.orEmpty()) {
        val obj = item as? JsonValue.Obj ?: continue
        val snapshot = sanitizeNoteBackup(obj) ?: continue
        if (!seen.add(snapshot.id)) continue
        snapshots += snapshot
    }
    return snapshots.takeLast(NOTE_BACKUP_LIMIT)
}

fun createNoteBackup(existing: List<NoteBackup>, notePath: String, content: String, id: String = newNoteBackupId(), createdAt: String = Instant.now().toString()): List<NoteBackup> {
    val path = sanitizeBackupPath(notePath)
    if (path.isEmpty()) throw IllegalArgumentException("Das Backup konnte nicht erstellt werden.")
    val snapshot = NoteBackup(
        id = if (BACKUP_ID.matches(id)) id else newNoteBackupId(),
        notePath = path,
        createdAt = createdAt,
        content = content.take(NOTE_BACKUP_MAX_CHARS),
    )
    return (existing.filter { it.id != snapshot.id } + snapshot).takeLast(NOTE_BACKUP_LIMIT)
}

fun restoreNoteBackup(existing: List<NoteBackup>, id: String, notePath: String): String? {
    if (!BACKUP_ID.matches(id)) return null
    return existing.filter { it.notePath == sanitizeBackupPath(notePath) }.find { it.id == id }?.content
}

fun noteBackupsJson(list: List<NoteBackup>): JsonValue.Arr = jsonArray(
    *list.takeLast(NOTE_BACKUP_LIMIT).map { backup ->
        ch.fasrv.fanotes.json.jsonObject(
            "id" to jsonString(backup.id),
            "notePath" to jsonString(backup.notePath),
            "createdAt" to jsonString(backup.createdAt),
            "content" to jsonString(backup.content),
        )
    }.toTypedArray(),
)

fun newNoteBackupId(): String = "nb-${System.currentTimeMillis().toString(36)}-${(0..5).joinToString("") { ('a'..'z').random().toString() }}"

data class NoteBackupPolicy(val visible: Boolean, val snapshot: Boolean, val restore: Boolean)

/** Desktop toolbar: hidden until the experiment is on, and restore appears after the first snapshot. */
fun noteBackupControlPolicy(experimentalOn: Boolean, snapshotCount: Int): NoteBackupPolicy {
    if (!experimentalOn) return NoteBackupPolicy(visible = false, snapshot = false, restore = false)
    return NoteBackupPolicy(visible = true, snapshot = true, restore = snapshotCount.coerceAtLeast(0) >= 1)
}

/** Short date and time, the same fields the desktop backup menu shows. Unparseable stamps stay as written. */
fun noteBackupStamp(createdAt: String, zone: ZoneId = ZoneId.systemDefault()): String {
    val instant = runCatching { Instant.parse(createdAt) }.getOrNull() ?: return createdAt
    val formatter = DateTimeFormatter.ofLocalizedDateTime(FormatStyle.SHORT)
        .withLocale(Locale.forLanguageTag("de-CH"))
    return formatter.format(instant.atZone(zone))
}

private fun sanitizeNoteBackup(obj: JsonValue.Obj): NoteBackup? {
    val path = sanitizeBackupPath(obj.string("notePath").orEmpty())
    if (path.isEmpty()) return null
    val rawId = obj.string("id").orEmpty()
    return NoteBackup(
        id = if (BACKUP_ID.matches(rawId)) rawId else newNoteBackupId(),
        notePath = path,
        createdAt = obj.string("createdAt")?.takeIf { it.isNotBlank() } ?: Instant.now().toString(),
        content = obj.string("content").orEmpty().take(NOTE_BACKUP_MAX_CHARS),
    )
}

private fun sanitizeBackupPath(value: String): String {
    val path = value.replace('\\', '/').trimStart('/').trim()
    if (path.isEmpty() || path.length > 500 || path.contains("..") || path.contains('\u0000')) return ""
    return path
}
