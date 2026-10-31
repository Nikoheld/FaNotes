package ch.fasrv.fanotes.vault

import ch.fasrv.fanotes.desk.ConfirmDialogShadow
import ch.fasrv.fanotes.desk.ConfirmShadowFrame
import ch.fasrv.fanotes.desk.confirmDialogShadow
import ch.fasrv.fanotes.desk.confirmShadowFrame
import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.escapeJson
import ch.fasrv.fanotes.json.parseJson
import java.security.MessageDigest
import java.security.SecureRandom
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Local note history in the desktop layout from `electron/note-history.cjs`.
 * A note gains one weekly snapshot and one snapshot every 12 hours. The
 * 12-hour snapshot is removed after two days. Markdown snapshots also keep
 * the `.famd` companion. The index is written before an old file is deleted,
 * so a crash cannot drop the newest revision.
 */
const val HISTORY_SHORT_INTERVAL_MS = 12L * 60L * 60L * 1000L
const val HISTORY_SHORT_RETENTION_MS = 2L * 24L * 60L * 60L * 1000L
const val HISTORY_WEEK_INTERVAL_MS = 7L * 24L * 60L * 60L * 1000L
const val HISTORY_MAX_BYTES = 16 * 1024 * 1024
private const val HISTORY_FORMAT = "fanotes-history-v1"
private val SNAPSHOT_ID = Regex("^[A-Za-z0-9._-]+$")
private val HISTORY_CLOCK: DateTimeFormatter =
    DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSSX").withZone(ZoneOffset.UTC)

data class HistorySnapshot(
    val id: String,
    val createdAt: String,
    val bytes: Int,
    val tier: String? = null,
    val ext: String? = null,
    val companion: Boolean = false,
)

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
    companion: String? = null,
) {
    val companionText = companion?.takeIf { it.isNotBlank() }.orEmpty()
    val nowMs = snapshotMillis(createdAt) ?: return
    val directory = historyDirectory(notePath)
    val index = readHistoryIndex(io, directory)
    if (content.isBlank() && companionText.isEmpty()) {
        if (io.read("$directory/index.json") == null) return
        val retained = retainHistory(index.snapshots, nowMs)
        commitHistory(io, directory, index, retained.kept, retained.removed)
        return
    }
    val bytes = content.encodeToByteArray()
    val companionBytes = companionText.encodeToByteArray()
    if (bytes.size > HISTORY_MAX_BYTES) return
    val retained = retainHistory(index.snapshots, nowMs)
    val ext = snapshotExtension(notePath)
    val last = retained.kept.lastOrNull()
    var changed = true
    if (last != null) {
        val previous = io.read(snapshotFile(directory, last))?.decodeToString()
        val previousCompanion = if (last.companion && last.ext != ".famd") {
            io.read("$directory/${last.id}.famd")?.decodeToString().orEmpty()
        } else {
            ""
        }
        changed = previous == null || previous != content || previousCompanion != companionText
    }
    val tier = if (changed) nextHistoryTier(retained.kept, nowMs) else null
    val storeCompanion = ext != ".famd" && companionText.isNotEmpty() && companionBytes.size <= HISTORY_MAX_BYTES
    if (!changed || tier == null || (bytes.isEmpty() && !storeCompanion)) {
        if (index.path == null) index.path = notePath.replace('\\', '/')
        commitHistory(io, directory, index, retained.kept, retained.removed)
        return
    }
    if (!SNAPSHOT_ID.matches(idSuffix)) throw IllegalArgumentException("Ungültiger Verlaufseintrag.")
    val id = "${createdAt.replace(':', '-').replace('.', '-')}-$idSuffix"
    if (!SNAPSHOT_ID.matches(id)) throw IllegalArgumentException("Ungültiger Verlaufseintrag.")
    val entry = HistorySnapshot(id, createdAt, bytes.size, tier, ext, storeCompanion)
    val primary = "$directory/$id$ext"
    io.write(primary, bytes)
    if (storeCompanion) {
        try {
            io.write("$directory/$id.famd", companionBytes)
        } catch (error: Exception) {
            io.delete(primary)
            throw error
        }
    }
    index.path = notePath.replace('\\', '/')
    try {
        commitHistory(io, directory, index, retained.kept + entry, retained.removed)
    } catch (error: Exception) {
        io.delete(primary)
        if (storeCompanion) io.delete("$directory/$id.famd")
        throw error
    }
}

fun listNoteHistory(io: VaultIo, notePath: String, nowMs: Long = System.currentTimeMillis()): List<HistorySnapshot> {
    val directory = historyDirectory(notePath)
    val index = readHistoryIndex(io, directory)
    val retained = retainHistory(index.snapshots, nowMs)
    if (retained.removed.isNotEmpty() || index.snapshots != retained.kept) {
        commitHistory(io, directory, index, retained.kept, retained.removed)
    }
    return retained.kept.asReversed()
}

fun readNoteHistory(io: VaultIo, notePath: String, snapshotId: String): HistorySnapshotFile {
    if (!SNAPSHOT_ID.matches(snapshotId)) throw IllegalArgumentException("Ungültiger Verlaufseintrag.")
    val directory = historyDirectory(notePath)
    val entry = readHistoryIndex(io, directory).snapshots.find { it.id == snapshotId }
        ?: throw IllegalArgumentException("Dieser Verlaufseintrag existiert nicht mehr.")
    val content = io.read(snapshotFile(directory, entry))?.decodeToString()
        ?: throw IllegalArgumentException("Dieser Verlaufseintrag existiert nicht mehr.")
    val companion = if (entry.companion && entry.ext != ".famd") {
        io.read("$directory/${entry.id}.famd")?.decodeToString()
            ?: throw IllegalArgumentException("Dieser Verlaufseintrag existiert nicht mehr.")
    } else {
        null
    }
    return HistorySnapshotFile(entry.id, entry.createdAt, content, companion)
}

data class HistorySnapshotFile(val id: String, val createdAt: String, val content: String, val companion: String? = null)

fun historyTimestamp(epochMs: Long): String = HISTORY_CLOCK.format(Instant.ofEpochMilli(epochMs))

private val HISTORY_LABEL: DateTimeFormatter = DateTimeFormatter.ofPattern("dd.MM.yyyy HH:mm")

/** Desktop inspector clock: `new Date(createdAt).toLocaleString`, day and minute. */
fun historyStampLabel(createdAt: String, zone: ZoneId = ZoneId.systemDefault()): String {
    val instant = runCatching { Instant.parse(createdAt) }.getOrNull() ?: return createdAt
    return HISTORY_LABEL.withZone(zone).format(instant)
}

/** Desktop history row: at least 1 KB, rounded like `Math.round(bytes / 1024)`. */
fun historySizeLabel(bytes: Int): String {
    val kb = (bytes.coerceAtLeast(0) / 1024.0).roundToInt().coerceAtLeast(1)
    return "$kb KB"
}

/** History dialog after the later chrome pass: 12px corners, min(520px, 92vw), min(70vh, 640px). */
const val HISTORY_DIALOG_MAX_DP = 520
const val HISTORY_DIALOG_WIDTH_FRACTION = 0.92f
const val HISTORY_DIALOG_MAX_HEIGHT_DP = 640
const val HISTORY_DIALOG_HEIGHT_FRACTION = 0.7f
const val HISTORY_DIALOG_RADIUS_DP = 12
const val HISTORY_DIALOG_HEADER_PAD_X_DP = 16
const val HISTORY_DIALOG_HEADER_PAD_TOP_DP = 16
const val HISTORY_DIALOG_HEADER_PAD_BOTTOM_DP = 10
const val HISTORY_DIALOG_HEADER_GAP_DP = 10
const val HISTORY_DIALOG_TITLE_SP = 16
const val HISTORY_DIALOG_META_SP = 12
const val HISTORY_DIALOG_ICON_DP = 18
const val HISTORY_DIALOG_CLOSE_ICON_DP = 17
const val HISTORY_DIALOG_LIST_PAD_DP = 16
const val HISTORY_DIALOG_LIST_GAP_DP = 8
const val HISTORY_DIALOG_ROW_PAD_DP = 10
const val HISTORY_DIALOG_ROW_GAP_DP = 12
const val HISTORY_DIALOG_ROW_RADIUS_DP = 10
const val HISTORY_DIALOG_EMPTY_PAD_TOP_DP = 8
const val HISTORY_DIALOG_EMPTY_PAD_BOTTOM_DP = 18
const val HISTORY_EYEBROW = "Lokaler Verlauf"
const val HISTORY_TITLE = "Frühere Versionen"
const val HISTORY_EMPTY = "Noch keine älteren Stände. Nach dem nächsten Speichern erscheint hier die vorherige Version."
const val HISTORY_LOADING = "Verlauf wird geladen …"
const val HISTORY_RESTORE = "Wiederherstellen"

fun historyDialogWidthDp(windowWidthDp: Int): Int {
    val fraction = (windowWidthDp.coerceAtLeast(0) * HISTORY_DIALOG_WIDTH_FRACTION).roundToInt()
    return min(HISTORY_DIALOG_MAX_DP, fraction)
}

fun historyDialogMaxHeightDp(windowHeightDp: Int): Int {
    val fraction = (windowHeightDp.coerceAtLeast(0) * HISTORY_DIALOG_HEIGHT_FRACTION).roundToInt()
    return min(HISTORY_DIALOG_MAX_HEIGHT_DP, fraction)
}

/**
 * `.history-dialog` keeps `box-shadow: var(--shadow)`.
 * The later "One dialog, button and type system" block only sets `border-radius: 12px`.
 * Light is `0 12px 40px rgba(15, 15, 15, .08)`.
 * Sepia is `0 12px 40px rgba(55, 48, 36, .08)`.
 * Dark is `0 16px 48px rgba(0, 0, 0, .28)`.
 * Midnight, forest, and aurora are `0 16px 48px rgba(0, 0, 0, .32)`.
 */
fun historyDialogShadow(themeId: String = "light"): ConfirmDialogShadow = confirmDialogShadow(themeId)

/** Shared confirm-dialog frame: x is 0, y is down, then blur. */
fun historyShadowFrame(widthPx: Float, heightPx: Float, density: Float, themeId: String = "light"): ConfirmShadowFrame? =
    confirmShadowFrame(widthPx, heightPx, density, themeId)

fun randomHistorySuffix(): String {
    val bytes = ByteArray(3)
    SecureRandom().nextBytes(bytes)
    return bytes.joinToString("") { "%02x".format(it) }
}

fun sha1Hex(value: String): String {
    val digest = MessageDigest.getInstance("SHA-1").digest(value.encodeToByteArray())
    return digest.joinToString("") { "%02x".format(it) }
}

private fun snapshotMillis(createdAt: String): Long? =
    runCatching { Instant.parse(createdAt).toEpochMilli() }.getOrNull()

private fun snapshotExtension(notePath: String): String {
    val normalized = notePath.replace('\\', '/')
    val slash = normalized.lastIndexOf('/')
    val dot = normalized.lastIndexOf('.')
    val ext = if (dot > slash) normalized.substring(dot).lowercase() else ""
    return if (ext == ".famd") ".famd" else ".md"
}

private fun storedExtension(snapshot: HistorySnapshot): String =
    if (snapshot.ext == ".famd") ".famd" else ".md"

private fun snapshotFile(directory: String, snapshot: HistorySnapshot): String =
    "$directory/${snapshot.id}${storedExtension(snapshot)}"

private data class RetainedHistory(val kept: List<HistorySnapshot>, val removed: List<HistorySnapshot>)

private fun retainHistory(snapshots: List<HistorySnapshot>, nowMs: Long): RetainedHistory {
    val sorted = snapshots.sortedBy { snapshotMillis(it.createdAt) ?: 0L }
    val kept = mutableListOf<HistorySnapshot>()
    var lastWeek: Long? = null
    var lastAny: Long? = null
    for (snapshot in sorted) {
        val at = snapshotMillis(snapshot.createdAt)
        val ext = storedExtension(snapshot)
        if (at == null) {
            kept += snapshot.copy(tier = if (snapshot.tier == "short") "short" else "week", ext = ext)
            continue
        }
        if (snapshot.tier == "week") {
            kept += snapshot.copy(tier = "week", ext = ext)
            lastWeek = at
            lastAny = at
            continue
        }
        if (snapshot.tier == "short") {
            if (nowMs - at < HISTORY_SHORT_RETENTION_MS) {
                kept += snapshot.copy(tier = "short", ext = ext)
                lastAny = at
            }
            continue
        }
        if (lastWeek == null || at - lastWeek >= HISTORY_WEEK_INTERVAL_MS) {
            kept += snapshot.copy(tier = "week", ext = ext)
            lastWeek = at
            lastAny = at
            continue
        }
        if (nowMs - at < HISTORY_SHORT_RETENTION_MS && (lastAny == null || at - lastAny >= HISTORY_SHORT_INTERVAL_MS)) {
            kept += snapshot.copy(tier = "short", ext = ext)
            lastAny = at
        }
    }
    val keptIds = kept.map { it.id }.toSet()
    return RetainedHistory(kept, snapshots.filter { it.id !in keptIds })
}

private fun nextHistoryTier(snapshots: List<HistorySnapshot>, nowMs: Long): String? {
    var lastWeek: Long? = null
    var lastAny: Long? = null
    for (snapshot in snapshots) {
        val at = snapshotMillis(snapshot.createdAt) ?: continue
        if (snapshot.tier == "week") lastWeek = if (lastWeek == null) at else maxOf(lastWeek, at)
        if (snapshot.tier == "week" || snapshot.tier == "short") lastAny = if (lastAny == null) at else maxOf(lastAny, at)
    }
    if (lastWeek == null || nowMs - lastWeek >= HISTORY_WEEK_INTERVAL_MS) return "week"
    if (lastAny == null || nowMs - lastAny >= HISTORY_SHORT_INTERVAL_MS) return "short"
    return null
}

private fun deleteSnapshotFiles(io: VaultIo, directory: String, snapshot: HistorySnapshot) {
    io.delete("$directory/${snapshot.id}.md")
    io.delete("$directory/${snapshot.id}.famd")
}

private fun commitHistory(
    io: VaultIo,
    directory: String,
    index: HistoryIndex,
    kept: List<HistorySnapshot>,
    removed: List<HistorySnapshot>,
) {
    if (removed.isEmpty() && index.snapshots == kept) return
    val previous = index.snapshots.toList()
    index.snapshots.clear()
    index.snapshots.addAll(kept)
    try {
        writeHistoryIndex(io, directory, index)
    } catch (error: Exception) {
        index.snapshots.clear()
        index.snapshots.addAll(previous)
        throw error
    }
    for (entry in removed) deleteSnapshotFiles(io, directory, entry)
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
            HistorySnapshot(
                id,
                obj.string("createdAt").orEmpty(),
                obj.double("bytes")?.toInt() ?: 0,
                obj.string("tier"),
                obj.string("ext"),
                obj.bool("companion") == true,
            )
        }
        HistoryIndex(parsed.string("path"), snapshots.toMutableList())
    } catch (_: Exception) {
        HistoryIndex(null, mutableListOf())
    }
}

private fun writeHistoryIndex(io: VaultIo, directory: String, index: HistoryIndex) {
    val snapshots = index.snapshots.joinToString(",\n") { snapshot ->
        val companion = if (snapshot.companion) ",\n      \"companion\": true" else ""
        """
        |    {
        |      "id": ${escapeJson(snapshot.id)},
        |      "createdAt": ${escapeJson(snapshot.createdAt)},
        |      "bytes": ${snapshot.bytes},
        |      "tier": ${escapeJson(snapshot.tier ?: "week")},
        |      "ext": ${escapeJson(snapshot.ext ?: ".md")}$companion
        |    }
        """.trimMargin()
    }
    val pathField = index.path?.let { ",\n  \"path\": ${escapeJson(it)}" }.orEmpty()
    val json = "{\n  \"format\": \"$HISTORY_FORMAT\",\n  \"snapshots\": [\n$snapshots\n  ]$pathField\n}\n"
    io.write("$directory/index.json", json.encodeToByteArray())
}
