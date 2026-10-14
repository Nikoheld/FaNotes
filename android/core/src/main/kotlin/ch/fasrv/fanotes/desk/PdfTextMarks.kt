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

data class PdfTextMark(val id: String, val page: Int, val quote: String, val kind: String)

fun readPdfMarks(markdown: String): List<PdfTextMark> {
    val start = markdown.indexOf(PDF_MARKS_START)
    if (start < 0) return emptyList()
    val end = markdown.indexOf(PDF_MARKS_END, start + PDF_MARKS_START.length)
    if (end < 0) return emptyList()
    return try {
        val parsed = parseJson(markdown.substring(start + PDF_MARKS_START.length, end).trim()) as? JsonValue.Obj
            ?: return emptyList()
        val marks = parsed.array("marks") ?: return emptyList()
        marks.items.mapNotNull { item ->
            val obj = item as? JsonValue.Obj ?: return@mapNotNull null
            val quote = cleanQuote(obj.string("quote").orEmpty())
            val page = wholePage(obj["page"])
            if (quote.isEmpty() || page == null) return@mapNotNull null
            val rawId = obj.string("id")
            PdfTextMark(
                id = if (rawId != null && rawId.length < 80) rawId else "mark-$page-${quote.take(12)}",
                page = page,
                quote = quote,
                kind = if (obj.string("kind") == "underline") "underline" else "highlight",
            )
        }.take(200)
    } catch (_: Exception) {
        emptyList()
    }
}

fun writePdfMarks(markdown: String, marks: List<PdfTextMark>): String {
    val start = markdown.indexOf(PDF_MARKS_START)
    val end = if (start >= 0) markdown.indexOf(PDF_MARKS_END, start) else -1
    val without = if (start >= 0 && end >= 0) {
        markdown.substring(0, start) + markdown.substring(end + PDF_MARKS_END.length)
    } else {
        markdown
    }
    val payload = marks.mapNotNull { mark ->
        val quote = cleanQuote(mark.quote)
        if (quote.isEmpty()) null else mark.copy(quote = quote, kind = if (mark.kind == "underline") "underline" else "highlight")
    }
    if (payload.isEmpty()) return without.replace(Regex("""\n{3,}"""), "\n\n")
    val block = "\n$PDF_MARKS_START\n${pdfMarksJson(payload)}\n$PDF_MARKS_END\n"
    return without.replace(Regex("""\s+$"""), "") + block
}

fun addPdfMark(marks: List<PdfTextMark>, page: Int, quote: String, kind: String = "highlight"): List<PdfTextMark> {
    val cleaned = cleanQuote(quote)
    if (cleaned.isEmpty() || page < 1) return marks.toList()
    if (marks.any { it.page == page && it.quote == cleaned }) return marks.toList()
    return (marks + PdfTextMark(
        id = "mark-${System.currentTimeMillis().toString(36)}",
        page = page,
        quote = cleaned,
        kind = if (kind == "underline") "underline" else "highlight",
    )).takeLast(200)
}

fun quotesOnPage(marks: List<PdfTextMark>, page: Int) = marks.filter { it.page == page }.map { it.quote }

private fun cleanQuote(value: String) = value.replace(Regex("""\s+"""), " ").trim().take(QUOTE_MAX)

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
      "kind": ${escapeJson(mark.kind)}
    }"""
    }
    return "{\n  \"marks\": [\n$body\n  ]\n}"
}
