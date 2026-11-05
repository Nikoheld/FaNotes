package ch.fasrv.fanotes.famd

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.deepCopy
import ch.fasrv.fanotes.json.jsonString

/** What a file is allowed to do on the next sync upload. */
enum class NoteSyncKind { PRESENT, BLANK, UNREADABLE }

private const val IDENTITY_STAMP = "1970-01-01T00:00:00.000Z"

fun isFamdSyncPath(path: String): Boolean {
    val lower = path.lowercase()
    return lower.endsWith(".md") || lower.endsWith(".markdown") || lower.endsWith(".famd")
}

fun noteSyncKind(path: String, bytes: ByteArray): NoteSyncKind {
    if (bytes.isEmpty()) return NoteSyncKind.BLANK
    if (!isFamdSyncPath(path)) return NoteSyncKind.PRESENT
    val text = bytes.toString(Charsets.UTF_8)
    val parsed = try {
        parseFamd(text)
    } catch (_: Exception) {
        return NoteSyncKind.UNREADABLE
    }
    if ((text.contains("fanotes-famd:v1") || text.contains("fanotes-famd:v2")) && parsed.payload == null) {
        return NoteSyncKind.UNREADABLE
    }
    return if (documentIsBlank(parsed)) NoteSyncKind.BLANK else NoteSyncKind.PRESENT
}

/** Bytes compared for "did this note change": page statistics and timestamps are ignored. */
fun identitySyncBytes(path: String, bytes: ByteArray): ByteArray? {
    if (noteSyncKind(path, bytes) == NoteSyncKind.UNREADABLE) return null
    if (!isFamdSyncPath(path)) return bytes
    val text = bytes.toString(Charsets.UTF_8)
    val parsed = parseFamd(text)
    val payload = parsed.payload ?: return canonicalSyncBytes(path, bytes)
    val copy = payload.deepCopy() as JsonValue.Obj
    copy.put("pageStats", null)
    copy.put("updatedAt", jsonString(IDENTITY_STAMP))
    copy.obj("ink")?.put("updatedAt", jsonString(IDENTITY_STAMP))
    return serializeFamd(parsed.markdown, copy, famdEncodingForSave(text)).toByteArray(Charsets.UTF_8)
}

/** The bytes actually uploaded. Page statistics stay on the device. */
fun canonicalSyncBytes(path: String, bytes: ByteArray): ByteArray {
    if (!isFamdSyncPath(path)) return bytes
    val text = bytes.toString(Charsets.UTF_8)
    val parsed = try {
        parseFamd(text)
    } catch (_: Exception) {
        return bytes
    }
    val payload = parsed.payload ?: return bytes
    if (payload.obj("pageStats") == null) return bytes
    val copy = payload.deepCopy() as JsonValue.Obj
    copy.put("pageStats", null)
    return serializeFamd(parsed.markdown, copy, famdEncodingForSave(text)).toByteArray(Charsets.UTF_8)
}

fun withLocalPageStats(downloaded: ByteArray, local: ByteArray, path: String): ByteArray {
    if (!isFamdSyncPath(path)) return downloaded
    val stats = try {
        parseFamd(local.toString(Charsets.UTF_8)).payload?.obj("pageStats")
    } catch (_: Exception) {
        null
    } ?: return downloaded
    val remote = try {
        parseFamd(downloaded.toString(Charsets.UTF_8))
    } catch (_: Exception) {
        return downloaded
    }
    val payload = remote.payload ?: return downloaded
    val copy = payload.deepCopy() as JsonValue.Obj
    copy.put("pageStats", stats.deepCopy())
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
