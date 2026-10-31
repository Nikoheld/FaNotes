package ch.fasrv.fanotes.famd

import ch.fasrv.fanotes.json.JsonParseException
import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.deepCopy
import ch.fasrv.fanotes.json.jsonArray
import ch.fasrv.fanotes.json.jsonNull
import ch.fasrv.fanotes.json.jsonString
import ch.fasrv.fanotes.json.parseJson
import ch.fasrv.fanotes.json.stringify

/**
 * Sidecar written beside every note. v1 is
 * `<!-- fanotes-famd:v1 chars=N -->` plus N UTF-16 code units of JSON.
 * v2 keeps the markdown in front and packs ink; see [FamdV2].
 * `chars` matches JavaScript `String.length`, which is [String.length] on the JVM.
 */
const val FAMD_SCHEMA = "fanotes-famd-v1"
const val FAMD_EXTENSION = ".famd"
private val PAPER_STYLES = setOf("blank", "dots", "squares", "grid", "lines", "millimeter")
private val HEADER = Regex("""(?:^|\n)<!--\s*fanotes-famd:v1\s+chars=(\d+)\s*-->\n""")
private val WORKSHEET_MARKER = Regex("""<!--\s*fanotes-worksheet:([a-zA-Z0-9_-]{1,96})\s*-->""")
private val INK_MARKER = Regex("""<!--\s*fanotes-ink:([a-zA-Z0-9_-]{1,96})\s*-->""")
private const val MAX_JSON_CHARS = 32 * 1024 * 1024

data class FamdDocument(
    val markdown: String,
    /** Null when the file has no companion payload. The object keeps unknown nested fields. */
    val payload: JsonValue.Obj?,
)

fun isPaperStyle(value: String?): Boolean = value != null && value in PAPER_STYLES

fun noteStem(relativePath: String): String = relativePath.replace(Regex("""\.(md|markdown|famd|pdf)$""", RegexOption.IGNORE_CASE), "")

fun companionPath(relativePath: String, extension: String): String = noteStem(relativePath) + extension

fun worksheetIdsFromMarkdown(markdown: String): List<String> =
    WORKSHEET_MARKER.findAll(markdown).map { it.groupValues[1] }.toList()

private val WORKSHEET_ID = Regex("""^[a-zA-Z0-9_-]{1,96}$""")

/** Same attachment rule as `attachWorksheet` in the desktop client. */
fun attachWorksheet(content: String, id: String): String {
    if (!WORKSHEET_ID.matches(id)) return content
    if (id in worksheetIdsFromMarkdown(content)) return content
    val separator = when {
        content.isEmpty() -> ""
        content.endsWith("\n") -> "\n"
        else -> "\n\n"
    }
    return "$content$separator<!-- fanotes-worksheet:$id -->\n"
}

fun worksheetRecordPath(id: String): String? =
    if (WORKSHEET_ID.matches(id)) ".fanotes/worksheets/$id.json" else null

/**
 * The image or PDF next to a worksheet record. Anything outside
 * `.fanotes/worksheets/<id>.<ext>` is refused, including `..`.
 */
fun safeWorksheetSource(id: String, relative: String?): String? {
    if (!WORKSHEET_ID.matches(id)) return null
    val path = relative?.replace('\\', '/')?.trim()?.removePrefix("/") ?: return null
    val pattern = Regex("""^\.fanotes/worksheets/${Regex.escape(id)}\.(?:png|jpe?g|webp|gif|pdf|html)$""")
    return if (pattern.matches(path)) path else null
}

/** Removes one worksheet marker and collapses the blank lines it left behind. */
fun detachWorksheet(content: String, id: String): String {
    if (!WORKSHEET_ID.matches(id)) return content
    return Regex("""(?:\r?\n)*<!--\s*fanotes-worksheet:$id\s*-->\s*""")
        .replace(content, "\n")
        .replace(Regex("""\n{3,}"""), "\n\n")
        .replace(Regex("""^\n+"""), "")
}

fun noteInkId(markdown: String): String? = INK_MARKER.find(markdown)?.groupValues?.get(1)

/** Same attachment rule as `attachNoteInk` in the desktop client. */
fun attachNoteInk(content: String, id: String): String {
    if (noteInkId(content) != null) return content
    val separator = when {
        content.isEmpty() -> ""
        content.endsWith("\n") -> "\n"
        else -> "\n\n"
    }
    return "$content$separator<!-- fanotes-ink:$id -->\n"
}

fun stripFamdPayload(source: String): String {
    if (source.isEmpty()) return ""
    var text = source
    val match = HEADER.findAll(text).lastOrNull()
    var cut = match?.range?.first ?: -1
    val v2Cut = v2CutIndex(text)
    if (v2Cut >= 0 && v2Cut > cut) cut = v2Cut
    if (cut >= 0) text = text.substring(0, cut)
    text = text.trimEnd()
    if (isFamdSidecarJson(text)) return ""
    val trailing = Regex("""\n(\{[\s\S]*\})\s*$""").find(text)
    if (trailing != null && isFamdSidecarJson(trailing.groupValues[1])) {
        return text.substring(0, trailing.range.first).trimEnd()
    }
    return text
}

private fun isFamdSidecarJson(value: String): Boolean {
    val trimmed = value.trim()
    if (!trimmed.startsWith("{") || !trimmed.contains(FAMD_SCHEMA)) return false
    return try {
        (parseJson(trimmed) as? JsonValue.Obj)?.string("schema") == FAMD_SCHEMA
    } catch (_: JsonParseException) {
        false
    }
}

fun parseFamd(source: String): FamdDocument {
    val markdown = stripFamdPayload(source)
    if (source.isEmpty()) return FamdDocument("", null)
    if (isActiveV2(source)) return FamdDocument(markdown, readV2Payload(source))
    val match = HEADER.findAll(source).lastOrNull() ?: return FamdDocument(markdown, null)
    val length = match.groupValues[1].toIntOrNull() ?: return FamdDocument(markdown, null)
    if (length < 2 || length > MAX_JSON_CHARS) return FamdDocument(markdown, null)
    val start = match.range.last + 1
    if (start + length > source.length) return FamdDocument(markdown, null)
    val json = source.substring(start, start + length)
    if (json.length != length) return FamdDocument(markdown, null)
    val parsed = try {
        parseJson(json) as? JsonValue.Obj
    } catch (_: JsonParseException) {
        null
    } ?: return FamdDocument(markdown, null)
    if (parsed.string("schema") != FAMD_SCHEMA) return FamdDocument(markdown, null)
    return FamdDocument(markdown, parsed)
}

fun emptyFamdPayload(updatedAt: String): JsonValue.Obj = jsonObject(
    "schema" to jsonString(FAMD_SCHEMA),
    "updatedAt" to jsonString(updatedAt),
    "ink" to jsonNull(),
    "worksheets" to jsonArray(),
)

private fun jsonObject(vararg pairs: Pair<String, JsonValue>) = JsonValue.Obj().also { obj ->
    for ((key, value) in pairs) obj.fields[key] = value
}

/**
 * Rebuilds the payload in the desktop key order: schema, updatedAt, ink,
 * worksheets, then paper style, note links, backups, page stats and text
 * fields. Nested objects are copied through. `encoding` defaults to v1 so an
 * existing file is not migrated by an ordinary save. New notes pass `"v2"`.
 */
fun serializeFamd(markdown: String, payload: JsonValue.Obj, encoding: String = "v1"): String {
    val body = stripFamdPayload(markdown)
    val worksheets = payload.array("worksheets")?.items
        ?.mapNotNull { (it as? JsonValue.Str)?.value }
        ?.filter { Regex("""^[a-zA-Z0-9_-]{1,96}$""").matches(it) }
        .orEmpty()
    val fromBody = worksheetIdsFromMarkdown(body)
    val worksheetValues = (if (worksheets.isNotEmpty()) worksheets else fromBody)
        .map { jsonString(it) }
    val next = JsonValue.Obj()
    next.put("schema", jsonString(FAMD_SCHEMA))
    val updatedAt = payload.string("updatedAt")?.takeIf { it.isNotBlank() } ?: isoNow()
    next.put("updatedAt", jsonString(updatedAt))
    val ink = payload.obj("ink")
    next.put("ink", ink?.deepCopy() ?: jsonNull())
    next.put("worksheets", JsonValue.Arr(worksheetValues.toMutableList()))
    val paper = payload.string("paperStyle")
    if (isPaperStyle(paper)) next.put("paperStyle", jsonString(paper!!))
    copyIfArray(payload, next, "noteLinks")
    copyIfArray(payload, next, "noteBackups")
    payload["pageStats"]?.let { stats ->
        if (stats is JsonValue.Obj) next.put("pageStats", stats.deepCopy())
    }
    copyIfArray(payload, next, "textFields")
    if (encoding == "v2") return encodeV2Document(body, next)
    val json = next.stringify()
    val marker = "<!-- fanotes-famd:v1 chars=${json.length} -->\n$json\n"
    return if (body.isEmpty()) marker else "$body\n\n$marker"
}

private fun copyIfArray(from: JsonValue.Obj, to: JsonValue.Obj, key: String) {
    val value = from[key] as? JsonValue.Arr ?: return
    if (value.items.isEmpty()) return
    to.put(key, value.deepCopy())
}

fun isoNow(epochMs: Long = System.currentTimeMillis()): String {
    val instant = java.time.Instant.ofEpochMilli(epochMs)
    return java.time.format.DateTimeFormatter.ISO_INSTANT.format(instant)
}
