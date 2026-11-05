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
private val SYNC_JSON_LIMITS = JsonLimits(maxDepth = 64, maxNodes = 100_000)
class SyncDocumentLimitException : IllegalStateException("Sync document exceeds the safe memory budget; local and remote copies were kept.")

fun requireSyncDocumentBudget(path: String, bytes: Long) {
    if (!isFamdSyncPath(path)) return
    val runtime = Runtime.getRuntime()
    if (bytes > MAX_SYNC_DOCUMENT_BYTES || bytes < 0) throw SyncDocumentLimitException()
    fun available() = runtime.maxMemory() - (runtime.totalMemory() - runtime.freeMemory())
    if (bytes * 8 > available()) {
        // Previous sequential transforms may be collectible. One collection avoids a false pause;
        // this runs on the sync worker, and genuinely low memory still fails before allocation.
        runtime.gc()
        if (bytes * 8 > available()) throw SyncDocumentLimitException()
    }
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
    if (jsonHasInk(payload)) return false
    val fields = payload.array("textFields")?.items.orEmpty()
    return fields.none { field ->
        val text = (field as? JsonValue.Obj)?.string("text")
        !text.isNullOrBlank()
    }
}

private fun jsonHasInk(value: JsonValue?, depth: Int = 0): Boolean {
    if (value == null || depth > 6) return false
    return when (value) {
        is JsonValue.Arr -> value.items.any { jsonHasInk(it, depth + 1) }
        is JsonValue.Obj -> {
            val packed = value.string("famdPts")
            if (!packed.isNullOrEmpty()) return true
            val points = value.array("points")
            if (points != null && points.items.isNotEmpty()) return true
            val figures = value.array("figurePaths")
            if (figures != null && figures.items.isNotEmpty()) return true
            val strokes = value.array("strokes")
            if (strokes != null && strokes.items.any { jsonHasInk(it, depth + 1) }) return true
            jsonHasInk(value["ink"], depth + 1) || jsonHasInk(value["hidden"], depth + 1) || jsonHasInk(value["sections"], depth + 1)
        }
        else -> false
    }
}
