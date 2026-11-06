package ch.fasrv.fanotes.famd

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.JsonLimits
import ch.fasrv.fanotes.json.JsonLimitException
import ch.fasrv.fanotes.json.JsonShape
import ch.fasrv.fanotes.json.shape
import ch.fasrv.fanotes.json.jsonString

/** What a file is allowed to do on the next sync upload. */
enum class NoteSyncKind { PRESENT, BLANK, UNREADABLE }

/** Packed documents stay packed. Legacy JSON is bounded before building its DOM. */
const val MAX_SYNC_DOCUMENT_BYTES = 16 * 1024 * 1024

/** A normal note, including a short guest document, must not consult the live heap. */
const val MODEST_SYNC_DOCUMENT_BYTES = 1024 * 1024

/** Packed sync keeps points packed, so two copies are enough headroom for a large note. */
const val SYNC_DOCUMENT_HEADROOM = 2L

private val SYNC_JSON_LIMITS = JsonLimits(maxDepth = 64, maxNodes = 100_000)

/**
 * Hard cap misses are permanent for that document. A headroom miss on a legal
 * note is transient: the caller retries without treating the note as blank.
 */
class SyncDocumentLimitException(val transient: Boolean = false) : IllegalStateException(
    "Sync document exceeds the safe memory budget; local and remote copies were kept.",
)

enum class SyncBudget { ALLOW, REJECT }

/** Heap pressure is ignored for a modest document. Only an oversized or unsafe note is rejected. */
fun syncDocumentBudget(bytes: Long, availableBytes: Long): SyncBudget {
    if (bytes < 0L || bytes > MAX_SYNC_DOCUMENT_BYTES) return SyncBudget.REJECT
    if (bytes <= MODEST_SYNC_DOCUMENT_BYTES) return SyncBudget.ALLOW
    val room = availableBytes.coerceAtLeast(0L)
    if (room < bytes * SYNC_DOCUMENT_HEADROOM) return SyncBudget.REJECT
    return SyncBudget.ALLOW
}

fun requireSyncDocumentBudget(path: String, bytes: Long) {
    if (!isFamdSyncPath(path)) return
    // Modest notes never read the live heap. Packed sync does not need spare copies of them.
    if (bytes >= 0L && bytes <= MODEST_SYNC_DOCUMENT_BYTES) return
    if (bytes < 0L || bytes > MAX_SYNC_DOCUMENT_BYTES) throw SyncDocumentLimitException(transient = false)
    val runtime = Runtime.getRuntime()
    fun available() = runtime.maxMemory() - (runtime.totalMemory() - runtime.freeMemory())
    if (syncDocumentBudget(bytes, available()) == SyncBudget.ALLOW) return
    // One collection covers a transient spike. A note that still cannot fit is
    // retried by the engine; it is not stored and not reported as a blank note.
    runtime.gc()
    if (syncDocumentBudget(bytes, available()) == SyncBudget.REJECT) throw SyncDocumentLimitException(transient = true)
}

private fun storedDocument(path: String, bytes: ByteArray, text: String? = null): FamdDocument {
    requireSyncDocumentBudget(path, bytes.size.toLong())
    return parseFamd(text ?: bytes.toString(Charsets.UTF_8), unpackPoints = false, limits = SYNC_JSON_LIMITS)
}

private const val IDENTITY_STAMP = "1970-01-01T00:00:00.000Z"

fun isFamdSyncPath(path: String): Boolean {
    val lower = path.lowercase()
    return lower.endsWith(".md") || lower.endsWith(".markdown") || lower.endsWith(".famd")
}

fun noteSyncKind(path: String, bytes: ByteArray): NoteSyncKind {
    if (bytes.isEmpty()) return NoteSyncKind.BLANK
    if (!isFamdSyncPath(path)) return NoteSyncKind.PRESENT
    requireSyncDocumentBudget(path, bytes.size.toLong())
    val text = bytes.toString(Charsets.UTF_8)
    val parsed = try {
        storedDocument(path, bytes, text)
    } catch (error: JsonLimitException) {
        throw error
    } catch (error: SyncDocumentLimitException) {
        throw error
    } catch (_: Exception) {
        return NoteSyncKind.UNREADABLE
    }
    if ((text.contains("fanotes-famd:v1") || text.contains("fanotes-famd:v2")) && parsed.payload == null) {
        return NoteSyncKind.UNREADABLE
    }
    return if (documentIsBlank(parsed)) NoteSyncKind.BLANK else NoteSyncKind.PRESENT
}

/** Bytes compared for "did this note change": page statistics and timestamps are ignored. */
fun identitySyncBytes(path: String, bytes: ByteArray, onShape: (JsonShape) -> Unit = {}): ByteArray? {
    if (!isFamdSyncPath(path)) return bytes
    requireSyncDocumentBudget(path, bytes.size.toLong())
    val text = bytes.toString(Charsets.UTF_8)
    val parsed = try {
        storedDocument(path, bytes, text)
    } catch (error: JsonLimitException) {
        throw error
    } catch (error: SyncDocumentLimitException) {
        throw error
    } catch (_: Exception) {
        return null
    }
    if ((text.contains("fanotes-famd:v1") || text.contains("fanotes-famd:v2")) && parsed.payload == null) return null
    val payload = parsed.payload ?: return canonicalSyncBytes(path, bytes)
    onShape(payload.shape(SYNC_JSON_LIMITS))
    val copy = JsonValue.Obj(LinkedHashMap(payload.fields))
    copy.put("pageStats", null)
    copy.put("updatedAt", jsonString(IDENTITY_STAMP))
    payload.obj("ink")?.let { ink ->
        copy.put("ink", JsonValue.Obj(LinkedHashMap(ink.fields)).put("updatedAt", jsonString(IDENTITY_STAMP)))
    }
    return serializeFamd(parsed.markdown, copy, famdEncodingForSave(text)).toByteArray(Charsets.UTF_8)
}

/** The bytes actually uploaded. Page statistics stay on the device. */
fun canonicalSyncBytes(path: String, bytes: ByteArray): ByteArray {
    if (!isFamdSyncPath(path)) return bytes
    requireSyncDocumentBudget(path, bytes.size.toLong())
    val text = bytes.toString(Charsets.UTF_8)
    val parsed = try {
        storedDocument(path, bytes, text)
    } catch (error: JsonLimitException) {
        throw error
    } catch (error: SyncDocumentLimitException) {
        throw error
    } catch (_: Exception) {
        return bytes
    }
    val payload = parsed.payload ?: return bytes
    if (payload.obj("pageStats") == null) return bytes
    val copy = JsonValue.Obj(LinkedHashMap(payload.fields))
    copy.put("pageStats", null)
    return serializeFamd(parsed.markdown, copy, famdEncodingForSave(text)).toByteArray(Charsets.UTF_8)
}

fun withLocalPageStats(downloaded: ByteArray, local: ByteArray, path: String): ByteArray {
    if (!isFamdSyncPath(path)) return downloaded
    val stats = try {
        storedDocument(path, local).payload?.obj("pageStats")
    } catch (error: JsonLimitException) {
        throw error
    } catch (error: SyncDocumentLimitException) {
        throw error
    } catch (_: Exception) {
        null
    } ?: return downloaded
    val remote = try {
        storedDocument(path, downloaded)
    } catch (error: JsonLimitException) {
        throw error
    } catch (error: SyncDocumentLimitException) {
        throw error
    } catch (_: Exception) {
        return downloaded
    }
    val payload = remote.payload ?: return downloaded
    val copy = JsonValue.Obj(LinkedHashMap(payload.fields))
    copy.put("pageStats", stats)
    return serializeFamd(remote.markdown, copy, famdEncodingForSave(downloaded.toString(Charsets.UTF_8))).toByteArray(Charsets.UTF_8)
}

private fun documentIsBlank(parsed: FamdDocument): Boolean {
    if (parsed.markdown.isNotBlank()) return false
    val payload = parsed.payload ?: return true
    if (inkHasMarks(payload)) return false
    val fields = payload.array("textFields")?.items.orEmpty()
    return fields.none { field ->
        val text = (field as? JsonValue.Obj)?.string("text")
        !text.isNullOrBlank()
    }
}


