package ch.fasrv.fanotes.desk

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.parseJson
import java.security.MessageDigest

/*
 * Read-only adapters for the PDF text files the desktop writes into the vault and that sync carries to the
 * other devices of the account. Android never writes them. Each file is named after the PDF's vault path and
 * is used only when its path, size and content stamp match the PDF at hand, so a record of another or an
 * edited file is ignored. Shared by the tablet app (task detection, PDF search) and Kanti+.
 */

/** The desktop's scanned-PDF transcript (`fanotes-pdf-ocr-v1`), owned by FaNotes desktop. */
const val DESKTOP_PDF_OCR_FORMAT = "fanotes-pdf-ocr-v1"

/** The desktop's per-page text of an indexed PDF (`fanotes-page-text-v1`), see `fanotes/docs/DOCUMENT_SEARCH.md`. */
const val DESKTOP_PAGE_TEXT_FORMAT = "fanotes-page-text-v1"

private fun sidecarName(relativePath: String): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(relativePath.toByteArray(Charsets.UTF_8))
    return digest.joinToString("") { "%02x".format(it) }.take(32) + ".json"
}

fun desktopPdfOcrSidecar(relativePath: String): String = ".fanotes/pdf-ocr/" + sidecarName(relativePath)

fun desktopPageTextSidecar(relativePath: String): String = ".fanotes/page-text/" + sidecarName(relativePath)

/** Content stamp compatible with the desktop `pdfByteStamp` (FNV-1a over sampled bytes). */
fun pdfByteStamp(bytes: ByteArray): String {
    var hash = 0x811c9dc5.toInt()
    fun mix(value: Int) { hash = hash xor (value and 0xff); hash *= 0x01000193 }
    val length = bytes.size
    mix(length); mix(length ushr 8); mix(length ushr 16); mix(length ushr 24)
    val step = maxOf(1, length / 4096)
    var index = 0
    while (index < length) { mix(bytes[index].toInt()); index += step }
    if (length > 0) mix(bytes[length - 1].toInt())
    return "%08x".format(hash.toLong() and 0xffffffffL)
}

/**
 * Page texts from a desktop sidecar, only when it belongs to this path and this exact PDF:
 * the size and the content stamp must match. Modification times are not compared, because a
 * synced copy on the phone has its own. Anything malformed or over the desktop limits is ignored.
 */
fun desktopPdfOcrPages(raw: String?, path: String, size: Long, stamp: String): Map<Int, String> {
    if (raw.isNullOrBlank() || raw.length > 512 * 1024) return emptyMap()
    val obj = runCatching { parseJson(raw) as? JsonValue.Obj }.getOrNull() ?: return emptyMap()
    if (obj.string("format") != DESKTOP_PDF_OCR_FORMAT || obj.string("path") != path) return emptyMap()
    if (obj.double("size")?.toLong() != size || obj.string("stamp") != stamp) return emptyMap()
    val pages = obj.array("pages")?.items ?: return emptyMap()
    if (pages.size > 60) return emptyMap()
    val out = LinkedHashMap<Int, String>()
    for (item in pages) {
        val entry = item as? JsonValue.Obj ?: return emptyMap()
        val page = entry.double("page")?.toInt() ?: return emptyMap()
        val text = entry.string("text") ?: return emptyMap()
        if (page < 1 || page > 2000 || text.length > 6_000 || page in out) return emptyMap()
        out[page] = text
    }
    return out
}

private const val PAGE_TEXT_MAX_BYTES = 4 * 1024 * 1024
private const val PAGE_TEXT_MAX_DOCUMENT = 96L * 1024 * 1024
private val PAGE_TEXT_SOURCES = setOf("text-layer", "ocr")
private val PAGE_TEXT_STATUSES = setOf("ok", "empty", "failed", "skipped")
private val PAGE_TEXT_ROTATIONS = setOf(0.0, 90.0, 180.0, 270.0)

private fun JsonValue.Obj.wholeNumber(key: String): Int? =
    double(key)?.takeIf { it % 1.0 == 0.0 && it >= 0.0 && it <= Int.MAX_VALUE }?.toInt()

/**
 * The usable page texts of a `fanotes-page-text-v1` record, by 1-based page number. The record counts only when it
 * is valid as a whole (every field as the contract lists it) and names this path, size and stamp. Pages that are
 * empty, failed or skipped are left out, as are pages the desktop has not read yet.
 */
fun desktopPageTextPages(raw: String?, path: String, size: Long, stamp: String): Map<Int, String> {
    if (raw.isNullOrBlank() || raw.length > PAGE_TEXT_MAX_BYTES) return emptyMap()
    val obj = runCatching { parseJson(raw) as? JsonValue.Obj }.getOrNull() ?: return emptyMap()
    if (obj.string("format") != DESKTOP_PAGE_TEXT_FORMAT || obj.string("path") != path) return emptyMap()
    val recordSize = obj.double("size")?.takeIf { it % 1.0 == 0.0 }?.toLong() ?: return emptyMap()
    if (recordSize < 1 || recordSize > PAGE_TEXT_MAX_DOCUMENT || recordSize != size || obj.string("stamp") != stamp) return emptyMap()
    val pageCount = obj.wholeNumber("pageCount")?.takeIf { it <= 100_000 } ?: return emptyMap()
    if (obj.string("producer").let { it == null || it.length > 200 }) return emptyMap()
    if (obj.string("createdAt").isNullOrEmpty()) return emptyMap()
    obj.fields["ocrEngine"]?.let { if (it !is JsonValue.Str || it.value.length > 100) return emptyMap() }
    val pages = obj.array("pages")?.items ?: return emptyMap()
    if (pages.size > 2000) return emptyMap()
    val out = LinkedHashMap<Int, String>()
    var previous = 0
    for (item in pages) {
        val entry = item as? JsonValue.Obj ?: return emptyMap()
        val page = entry.wholeNumber("page") ?: return emptyMap()
        if (page < 1 || page > pageCount || page <= previous) return emptyMap()
        previous = page
        if (entry.string("source") !in PAGE_TEXT_SOURCES || entry.string("status") !in PAGE_TEXT_STATUSES) return emptyMap()
        val text = entry.string("text")?.takeIf { it.length <= 6_000 } ?: return emptyMap()
        entry.fields["confidence"]?.let { value ->
            val confidence = (value as? JsonValue.Num)?.value
            if (confidence == null || confidence < 0.0 || confidence > 1.0) return emptyMap()
        }
        entry.fields["rotation"]?.let { value ->
            if ((value as? JsonValue.Num)?.value !in PAGE_TEXT_ROTATIONS) return emptyMap()
        }
        entry.fields["reason"]?.let { if (it !is JsonValue.Str || it.value.length > 120) return emptyMap() }
        if (entry.string("status") == "ok" && text.isNotBlank()) out[page] = text
    }
    return out
}

/**
 * The desktop's text of one PDF, page by page: the page-text record first (text layer and OCR of every indexed
 * page), then the OCR transcript for the pages it does not cover.
 */
fun syncedPdfPages(pageText: Map<Int, String>, ocr: Map<Int, String>): Map<Int, String> {
    if (ocr.isEmpty()) return pageText
    if (pageText.isEmpty()) return ocr
    val merged = LinkedHashMap<Int, String>(ocr)
    merged.putAll(pageText)
    return merged
}
