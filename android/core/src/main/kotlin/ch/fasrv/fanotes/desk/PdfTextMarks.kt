package ch.fasrv.fanotes.desk

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.escapeJson
import ch.fasrv.fanotes.json.parseJson

/**
 * Highlights anchored to a PDF text quote and page, stored in the note.
 * Ported from `fanotes/src/lib/pdfTextMarks.ts`.
 */

const val PDF_MARKS_START = "<!-- fanotes-pdf-marks-v1"
const val PDF_MARKS_END = "-->"
private const val QUOTE_MAX = 400

/**
 * @property nth only this occurrence of the quote on the page (0-based, counted at every start, overlapping ones
 *   included). Null: every occurrence, as marks were stored before. Erasing part of a highlight writes the remaining
 *   parts with it, so a remnant does not light up the same words elsewhere on the page.
 */
data class PdfTextMark(val id: String, val page: Int, val quote: String, val kind: String, val nth: Int? = null)

/** Where a `<!-- marker {json} -->` block sits. User text inside the JSON may contain `-->`. */
internal data class EmbeddedJsonComment(val start: Int, val jsonStart: Int, val jsonEnd: Int, val end: Int)

/** Port of `locateEmbeddedJsonComment` (`fanotes/src/lib/embeddedJsonComment.ts`). */
internal fun locateEmbeddedJsonComment(source: String, marker: String): EmbeddedJsonComment? {
    val start = source.indexOf(marker)
    if (start < 0) return null
    var index = start + marker.length
    while (index < source.length && source[index].isWhitespace()) index += 1
    if (index >= source.length || source[index] != '{') return null
    val jsonStart = index
    var depth = 0
    var inString = false
    var escape = false
    while (index < source.length) {
        val char = source[index]
        if (inString) {
            when {
                escape -> escape = false
                char == '\\' -> escape = true
                char == '"' -> inString = false
            }
        } else if (char == '"') {
            inString = true
        } else if (char == '{') {
            depth += 1
        } else if (char == '}') {
            depth -= 1
            if (depth == 0) {
                val jsonEnd = index + 1
                var closer = jsonEnd
                while (closer < source.length && source[closer].isWhitespace()) closer += 1
                if (!source.startsWith(PDF_MARKS_END, closer)) return null
                return EmbeddedJsonComment(start, jsonStart, jsonEnd, closer + PDF_MARKS_END.length)
            }
        }
        index += 1
    }
    return null
}

fun readPdfMarks(markdown: String): List<PdfTextMark> {
    val block = locateEmbeddedJsonComment(markdown, PDF_MARKS_START) ?: return emptyList()
    return try {
        val parsed = parseJson(markdown.substring(block.jsonStart, block.jsonEnd)) as? JsonValue.Obj
            ?: return emptyList()
        val marks = parsed.array("marks") ?: return emptyList()
        marks.items.mapNotNull { item ->
            val obj = item as? JsonValue.Obj ?: return@mapNotNull null
            val quote = cleanQuote(obj.string("quote").orEmpty())
            val page = wholePage(obj["page"])
            if (quote.isEmpty() || page == null) return@mapNotNull null
            val rawId = obj.string("id")
            val nth = obj.double("nth")?.takeIf { it.isFinite() && it % 1.0 == 0.0 && it >= 0 && it < 100_000 }?.toInt()
            PdfTextMark(
                id = if (rawId != null && rawId.length < 80) rawId else "mark-$page-${quote.take(12)}",
                page = page,
                quote = quote,
                kind = if (obj.string("kind") == "underline") "underline" else "highlight",
                nth = nth,
            )
        }.take(200)
    } catch (_: Exception) {
        emptyList()
    }
}

fun writePdfMarks(markdown: String, marks: List<PdfTextMark>): String {
    val block = locateEmbeddedJsonComment(markdown, PDF_MARKS_START)
    val start = block?.start ?: markdown.indexOf(PDF_MARKS_START)
    // A block whose JSON does not parse is still replaced, not written a second time.
    val end = block?.end ?: if (start >= 0) markdown.indexOf(PDF_MARKS_END, start).let { if (it < 0) -1 else it + PDF_MARKS_END.length } else -1
    val without = if (start >= 0 && end >= 0) {
        markdown.substring(0, start) + markdown.substring(end)
    } else {
        markdown
    }
    val payload = marks.mapNotNull { mark ->
        val quote = cleanQuote(mark.quote)
        if (quote.isEmpty()) null else mark.copy(quote = quote, kind = if (mark.kind == "underline") "underline" else "highlight")
    }
    if (payload.isEmpty()) return without.replace(Regex("""\n{3,}"""), "\n\n")
    val written = "\n$PDF_MARKS_START\n${pdfMarksJson(payload)}\n$PDF_MARKS_END\n"
    return without.replace(Regex("""\s+$"""), "") + written
}

/** [nth] pins the mark to one occurrence of the quote on the page; null marks every occurrence (desktop default). */
fun addPdfMark(marks: List<PdfTextMark>, page: Int, quote: String, kind: String = "highlight", nth: Int? = null): List<PdfTextMark> {
    val cleaned = cleanQuote(quote)
    if (cleaned.isEmpty() || page < 1) return marks.toList()
    val safeKind = if (kind == "underline") "underline" else "highlight"
    if (marks.any { it.page == page && it.quote == cleaned && it.nth == null }) return marks.toList()
    if (nth != null && marks.any { it.page == page && it.quote == cleaned && it.nth == nth && it.kind == safeKind }) return marks.toList()
    return (marks + PdfTextMark(
        id = nextPdfMarkId(),
        page = page,
        quote = cleaned,
        kind = safeKind,
        nth = nth?.takeIf { it >= 0 },
    )).takeLast(200)
}

private var pdfMarkSerial = 0

/** Distinct ids within one millisecond too (an unmark writes several pieces at once). */
internal fun nextPdfMarkId(): String {
    pdfMarkSerial = (pdfMarkSerial + 1) % 1_000_000
    return "mark-${System.currentTimeMillis().toString(36)}-${pdfMarkSerial.toString(36)}"
}

fun quotesOnPage(marks: List<PdfTextMark>, page: Int) = marks.filter { it.page == page }.map { it.quote }

internal fun cleanQuote(value: String) = value.replace(Regex("""\s+"""), " ").trim().take(QUOTE_MAX)

private fun wholePage(value: JsonValue?): Int? {
    val number = when (value) {
        is JsonValue.Num -> value.value
        is JsonValue.Str -> value.value.toDoubleOrNull()
        else -> null
    } ?: return null
    if (!number.isFinite() || number < 1 || number > 5_000 || number % 1.0 != 0.0) return null
    return number.toInt()
}

private fun pdfMarksJson(marks: List<PdfTextMark>): String {
    val body = marks.joinToString(",\n") { mark ->
        """    {
      "id": ${escapeJson(mark.id)},
      "page": ${mark.page},
      "quote": ${escapeJson(mark.quote)},
      "kind": ${escapeJson(mark.kind)}${if (mark.nth != null) ",\n      \"nth\": ${mark.nth}" else ""}
    }"""
    }
    return "{\n  \"marks\": [\n$body\n  ]\n}"
}
