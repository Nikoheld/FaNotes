package ch.fasrv.fanotes.companion

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.parseJson
import java.io.File
import java.io.RandomAccessFile
import java.security.MessageDigest

/*
 * Read-only adapters for formats that other FaNotes clients own. Kanti+ never writes them.
 */

/** The desktop's scanned-PDF transcript (`fanotes-pdf-ocr-v1`), owned by FaNotes desktop. */
const val DESKTOP_PDF_OCR_FORMAT = "fanotes-pdf-ocr-v1"

fun desktopPdfOcrSidecar(relativePath: String): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(relativePath.toByteArray(Charsets.UTF_8))
    return ".fanotes/pdf-ocr/" + digest.joinToString("") { "%02x".format(it) }.take(32) + ".json"
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

/** [pdfByteStamp] without loading the file: the same sampled bytes, read with seeks. */
fun pdfFileStamp(file: File): String {
    RandomAccessFile(file, "r").use { raf ->
        val length = raf.length()
        if (length > Int.MAX_VALUE) return ""
        var hash = 0x811c9dc5.toInt()
        fun mix(value: Int) { hash = hash xor (value and 0xff); hash *= 0x01000193 }
        val n = length.toInt()
        mix(n); mix(n ushr 8); mix(n ushr 16); mix(n ushr 24)
        val step = maxOf(1, n / 4096)
        val buffer = ByteArray(64 * 1024)
        var index = 0
        if (step == 1) {
            raf.seek(0)
            while (true) { val read = raf.read(buffer); if (read <= 0) break; for (i in 0 until read) mix(buffer[i].toInt()) }
        } else {
            while (index < n) { raf.seek(index.toLong()); mix(raf.read()); index += step }
        }
        if (n > 0) { raf.seek((n - 1).toLong()); mix(raf.read()) }
        return "%08x".format(hash.toLong() and 0xffffffffL)
    }
}

/** Handwriting transcript lines are stored as "y<TAB>text"; only the words are searchable. */
fun transcriptText(raw: String): String = raw.lineSequence()
    .map { line -> line.substringAfter('\t', line).trim() }
    .filter { it.isNotBlank() }
    .joinToString("\n")

data class OcrResult(val text: String, val confidence: Double)

/** Picks the reading orientation with the most confident, non-empty result. Ties keep the upright page. */
fun bestOrientation(results: List<Pair<Int, OcrResult>>): Pair<Int, OcrResult>? =
    results.filter { it.second.text.isNotBlank() }
        .maxWithOrNull(compareBy<Pair<Int, OcrResult>> { it.second.confidence * minOf(1.0, it.second.text.count(Char::isLetter) / 40.0) }.thenBy { if (it.first == 0) 1 else 0 })

/** An OCR result counts as text when enough letters were recognised with fair confidence. */
fun ocrUsable(result: OcrResult): Boolean = result.text.count(Char::isLetter) >= 3 && result.confidence >= 0.35

/** Minimum characters for a PDF text layer to count, the same threshold as FaNotes desktop. */
const val PDF_MIN_TEXT = 20

/** OCR pages per document and pass, the same limit as FaNotes desktop. */
const val PDF_OCR_MAX_PAGES = 60
