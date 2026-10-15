package ch.fasrv.fanotes.vault

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.escapeJson
import ch.fasrv.fanotes.json.parseJson
import java.security.MessageDigest
import java.security.SecureRandom
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

/**
 * Local note history in the desktop layout from `electron/note-history.cjs`.
 * Each note keeps at most [HISTORY_LIMIT] snapshots under
 * `.fanotes/history/<sha1(path)>`. The index is written before an old file is
 * deleted, so a crash cannot drop the newest revision.
 */
const val HISTORY_LIMIT = 30
const val HISTORY_MAX_BYTES = 16 * 1024 * 1024
private const val HISTORY_FORMAT = "fanotes-history-v1"
private val SNAPSHOT_ID = Regex("^[A-Za-z0-9._-]+$")
private val HISTORY_CLOCK: DateTimeFormatter =
    DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSSX").withZone(ZoneOffset.UTC)

data class HistorySnapshot(val id: String, val createdAt: String, val bytes: Int)

fun historyDirectory(notePath: String): String {
    val normalized = notePath.replace('\\', '/')
    return ".fanotes/history/${sha1Hex(normalized)}"
}

fun recordNoteHistory(
    io: VaultIo,
    notePath: String,
    content: String,
    createdAt: String = historyTimestamp(System.currentTimeMillis()),
    idSuffix: String = randomHistorySuffix(),
) {
    if (content.isBlank()) return
    val bytes = content.encodeToByteArray()
    if (bytes.isEmpty() || bytes.size > HISTORY_MAX_BYTES) return
    val directory = historyDirectory(notePath)
    val index = readHistoryIndex(io, directory)
    val last = index.snapshots.lastOrNull()
    if (last != null) {
        val previous = io.read("$directory/${last.id}.md")?.decodeToString()
        if (previous == content) return
    }
    if (!SNAPSHOT_ID.matches(idSuffix)) throw IllegalArgumentException("Ungültiger Verlaufseintrag.")
    val id = "${createdAt.replace(':', '-').replace('.', '-')}-$idSuffix"
    if (!SNAPSHOT_ID.matches(id)) throw IllegalArgumentException("Ungültiger Verlaufseintrag.")
    val snapshot = HistorySnapshot(id, createdAt, bytes.size)
    io.write("$directory/$id.md", bytes)
    index.path = notePath.replace('\\', '/')
    index.snapshots += snapshot
    try {
        writeHistoryIndex(io, directory, index)
    } catch (error: Exception) {
        io.delete("$directory/$id.md")
        throw error
    }
    if (index.snapshots.size <= HISTORY_LIMIT) return
    val removed = index.snapshots.take(index.snapshots.size - HISTORY_LIMIT)
    index.snapshots.subList(0, index.snapshots.size - HISTORY_LIMIT).clear()
    try {
        writeHistoryIndex(io, directory, index)
    } catch (_: Exception) {
        return
    }
    for (entry in removed) io.delete("$directory/${entry.id}.md")
}

fun listNoteHistory(io: VaultIo, notePath: String): List<HistorySnapshot> =
    readHistoryIndex(io, historyDirectory(notePath)).snapshots.asReversed()

fun readNoteHistory(io: VaultIo, notePath: String, snapshotId: String): HistorySnapshotFile {
    if (!SNAPSHOT_ID.matches(snapshotId)) throw IllegalArgumentException("Ungültiger Verlaufseintrag.")
    val directory = historyDirectory(notePath)
    val entry = readHistoryIndex(io, directory).snapshots.find { it.id == snapshotId }
        ?: throw IllegalArgumentException("Dieser Verlaufseintrag existiert nicht mehr.")
    val content = io.read("$directory/${entry.id}.md")?.decodeToString()
        ?: throw IllegalArgumentException("Dieser Verlaufseintrag existiert nicht mehr.")
    return HistorySnapshotFile(entry.id, entry.createdAt, content)
}

data class HistorySnapshotFile(val id: String, val createdAt: String, val content: String)

fun historyTimestamp(epochMs: Long): String = HISTORY_CLOCK.format(Instant.ofEpochMilli(epochMs))

private val HISTORY_LABEL: DateTimeFormatter = DateTimeFormatter.ofPattern("dd.MM.yyyy HH:mm")

/** Desktop inspector clock: `new Date(createdAt).toLocaleString`, day and minute. */
fun historyStampLabel(createdAt: String, zone: ZoneId = ZoneId.systemDefault()): String {
    val instant = runCatching { Instant.parse(createdAt) }.getOrNull() ?: return createdAt
    return HISTORY_LABEL.withZone(zone).format(instant)
}

fun randomHistorySuffix(): String {
    val bytes = ByteArray(3)
    SecureRandom().nextBytes(bytes)
    return bytes.joinToString("") { "%02x".format(it) }
}

fun sha1Hex(value: String): String {
    val digest = MessageDigest.getInstance("SHA-1").digest(value.encodeToByteArray())
    return digest.joinToString("") { "%02x".format(it) }
}

private class HistoryIndex(var path: String?, val snapshots: MutableList<HistorySnapshot>)

private fun readHistoryIndex(io: VaultIo, directory: String): HistoryIndex {
    val raw = io.read("$directory/index.json")?.decodeToString() ?: return HistoryIndex(null, mutableListOf())
    return try {
        val parsed = parseJson(raw) as? JsonValue.Obj ?: return HistoryIndex(null, mutableListOf())
        if (parsed.string("format") != HISTORY_FORMAT) return HistoryIndex(null, mutableListOf())
        val snapshots = parsed.array("snapshots")?.items.orEmpty().mapNotNull { item ->
            val obj = item as? JsonValue.Obj ?: return@mapNotNull null
            val id = obj.string("id") ?: return@mapNotNull null
            if (!SNAPSHOT_ID.matches(id)) return@mapNotNull null
            HistorySnapshot(id, obj.string("createdAt").orEmpty(), obj.double("bytes")?.toInt() ?: 0)
        }
        HistoryIndex(parsed.string("path"), snapshots.toMutableList())
    } catch (_: Exception) {
        HistoryIndex(null, mutableListOf())
    }
}

private fun writeHistoryIndex(io: VaultIo, directory: String, index: HistoryIndex) {
    val snapshots = index.snapshots.joinToString(",\n") { snapshot ->
        """
        |    {
        |      "id": ${escapeJson(snapshot.id)},
        |      "createdAt": ${escapeJson(snapshot.createdAt)},
        |      "bytes": ${snapshot.bytes}
        |    }
        """.trimMargin()
    }
    val pathField = index.path?.let { ",\n  \"path\": ${escapeJson(it)}" }.orEmpty()
    val json = "{\n  \"format\": \"$HISTORY_FORMAT\",\n  \"snapshots\": [\n$snapshots\n  ]$pathField\n}\n"
    io.write("$directory/index.json", json.encodeToByteArray())
}
