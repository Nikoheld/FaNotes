package ch.fasrv.fanotes.companion

import java.text.Normalizer
import kotlin.math.ln

/*
 * Text folding, query parsing, snippets and ranking for Kanti+ document search.
 * Pure Kotlin: no Android types, so every rule is unit-tested on the JVM.
 *
 * Folding makes "Straße", "STRASSE" and "strasse" equal, "Übung", "Uebung" and "ubung" equal,
 * joins words hyphenated across PDF/OCR line breaks and turns punctuation into spaces. The index
 * stores folded text; snippets are cut from the original text through [FoldedText.origin].
 */

/** Folded text plus, for every folded char, the index of the original char it came from. */
class FoldedText(val text: String, val origin: IntArray)

private val foldCache = HashMap<Char, String>()

private fun foldChar(c: Char): String {
    if (c in 'a'..'z' || c in '0'..'9') return c.toString()
    if (c in 'A'..'Z') return (c + 32).toString()
    if (c == 'ß' || c == 'ẞ') return "ss"
    if (c.code < 128) return " "
    synchronized(foldCache) {
        return foldCache.getOrPut(c) {
            val decomposed = Normalizer.normalize(c.toString(), Normalizer.Form.NFKD)
            val kept = StringBuilder()
            for (d in decomposed) {
                if (Character.getType(d) == Character.NON_SPACING_MARK.toInt()) continue
                when {
                    d == 'ß' -> kept.append("ss")
                    Character.isLetterOrDigit(d) -> kept.append(d.lowercaseChar())
                    else -> kept.append(' ')
                }
            }
            kept.toString().ifEmpty { " " }
        }
    }
}

/**
 * Folds [raw] for indexing and matching. German digraphs ae/oe/ue fold to a/o/u on both sides,
 * so "Muenchen" and "München" meet. A soft hyphen is dropped; "Integral-\nrechnung" becomes one word.
 */
fun foldSearch(raw: String, limit: Int = Int.MAX_VALUE): FoldedText {
    val out = StringBuilder(minOf(raw.length, limit) + 8)
    val origin = IntArray(minOf(raw.length, limit) * 2 + 8)
    var count = 0
    fun push(ch: Char, from: Int) {
        if (count >= origin.size) return
        if (ch == ' ' && (count == 0 || out[count - 1] == ' ')) return
        if (ch == 'e' && count > 0 && out[count - 1] in "aou" && from > 0 && raw[from - 1].lowercaseChar() in "aou") return
        out.append(ch); origin[count] = from; count++
    }
    var i = 0
    val end = minOf(raw.length, limit)
    while (i < end) {
        val c = raw[i]
        if (c == '­') { i++; continue }
        if (c == '-' && i > 0 && raw[i - 1].isLetter()) {
            var j = i + 1
            while (j < end && (raw[j] == ' ' || raw[j] == '\t' || raw[j] == '\r')) j++
            if (j < end && raw[j] == '\n') {
                var k = j + 1
                while (k < end && (raw[k] == ' ' || raw[k] == '\t')) k++
                if (k < end && raw[k].isLowerCase()) { i = k; continue }
            }
        }
        val folded = foldChar(c)
        for (f in folded) push(f, i)
        i++
    }
    while (count > 0 && out[count - 1] == ' ') { out.setLength(count - 1); count-- }
    return FoldedText(out.toString(), origin.copyOf(count))
}

fun foldPlain(raw: String): String = foldSearch(raw).text

data class DocQuery(val raw: String, val terms: List<String>) {
    val isEmpty get() = terms.isEmpty()
}

/** Splits a typed query into folded terms. At most 8 terms; the last one also matches as a prefix. */
fun parseDocQuery(raw: String): DocQuery {
    val terms = foldPlain(raw.take(200)).split(' ').filter { it.isNotBlank() }.distinct().take(8)
    return DocQuery(raw, terms)
}

/** FTS4 MATCH expression: every term must appear, each as a prefix. Terms are [a-z0-9] only after folding. */
fun ftsMatch(query: DocQuery): String =
    query.terms.joinToString(" ") { term -> term.filter { it.isLetterOrDigit() }.let { if (it.isEmpty()) "" else "$it*" } }.trim()

data class Snippet(val text: String, val highlights: List<IntRange>)

/** Ranges of whole folded terms (or prefixes) inside [folded], as indices into the folded text. */
fun matchRanges(folded: String, terms: List<String>, max: Int = 64): List<IntRange> {
    if (terms.isEmpty() || folded.isEmpty()) return emptyList()
    val ranges = mutableListOf<IntRange>()
    for (term in terms) {
        var from = 0
        while (ranges.size < max) {
            val at = folded.indexOf(term, from)
            if (at < 0) break
            val wordStart = at == 0 || folded[at - 1] == ' '
            if (wordStart) {
                var end = at + term.length
                while (end < folded.length && folded[end] != ' ') end++
                ranges += at until end
            }
            from = at + 1
        }
    }
    return ranges.sortedBy { it.first }
}

/**
 * A snippet of at most [width] original characters around the first match, with highlight ranges
 * relative to the snippet. Whitespace is collapsed; nothing outside the page text is ever used.
 */
fun buildSnippet(original: String, terms: List<String>, width: Int = 160): Snippet {
    val folded = foldSearch(original)
    val ranges = matchRanges(folded.text, terms)
    if (ranges.isEmpty() || folded.origin.isEmpty()) {
        val head = original.replace(Regex("\\s+"), " ").trim().take(width)
        return Snippet(head, emptyList())
    }
    val firstStart = folded.origin[ranges.first().first]
    val start = (firstStart - width / 3).coerceAtLeast(0).let { s ->
        if (s == 0) 0 else original.indexOf(' ', s).takeIf { it in s until firstStart }?.plus(1) ?: s
    }
    val stop = (start + width).coerceAtMost(original.length)
    val prefix = if (start > 0) "…" else ""
    val suffix = if (stop < original.length) "…" else ""
    // Collapse whitespace while tracking where each kept char lands.
    val text = StringBuilder(prefix)
    val position = IntArray(stop - start + 1) { -1 }
    var lastSpace = true
    for (i in start until stop) {
        val c = original[i]
        val space = c.isWhitespace()
        if (space && lastSpace) { position[i - start] = text.length; continue }
        position[i - start] = text.length
        text.append(if (space) ' ' else c)
        lastSpace = space
    }
    position[stop - start] = text.length
    val highlights = ranges.mapNotNull { r ->
        val a = folded.origin[r.first]
        val b = folded.origin[r.last] + 1
        if (a < start || b > stop) null else position[a - start] until position[b - start]
    }.filter { !it.isEmpty() }
    return Snippet(text.toString().trimEnd() + suffix, highlights)
}

/** Original-text ranges of every match of [terms] in [original], for highlighting in a reader. */
fun highlightRanges(original: String, terms: List<String>): List<IntRange> {
    if (terms.isEmpty() || original.isEmpty()) return emptyList()
    val folded = foldSearch(original)
    return matchRanges(folded.text, terms).mapNotNull { r ->
        if (r.last >= folded.origin.size) null else folded.origin[r.first]..folded.origin[r.last]
    }
}

enum class PageSource(val id: String, val weight: Double) {
    Markdown("markdown", 1.0), TextLayer("text", 1.0), Transcript("transcript", 0.85), DesktopOcr("desktop-ocr", 0.8), Ocr("ocr", 0.8), None("none", 0.0);
    companion object { fun of(id: String?) = entries.firstOrNull { it.id == id } ?: None }
}

/**
 * Score for one page: term frequency with a length norm (BM25-like), exact words above prefixes,
 * title matches above body matches, text layers above OCR, and OCR scaled by its confidence.
 */
fun scorePage(foldedBody: String, foldedTitle: String, terms: List<String>, source: PageSource, confidence: Double, documents: Int = 1000, documentFrequency: Map<String, Int> = emptyMap()): Double {
    if (terms.isEmpty()) return 0.0
    val words = foldedBody.count { it == ' ' } + 1
    val norm = 0.25 + 0.75 * (words / 300.0)
    var score = 0.0
    for (term in terms) {
        val ranges = matchRanges(foldedBody, listOf(term))
        val exact = ranges.count { it.last - it.first + 1 == term.length }
        val tf = ranges.size + exact * 0.5
        val df = documentFrequency[term] ?: 1
        val idf = ln(1.0 + (documents - df + 0.5) / (df + 0.5))
        score += idf * (tf * 2.2) / (tf + 1.2 * norm)
        if (foldedTitle.split(' ').any { it.startsWith(term) }) score += idf * 1.5
        if (foldedTitle.split(' ').any { it == term }) score += idf * 0.5
    }
    val sourceFactor = source.weight * (if (source == PageSource.Ocr || source == PageSource.DesktopOcr) (0.6 + 0.4 * confidence.coerceIn(0.0, 1.0)) else 1.0)
    return score * sourceFactor
}

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
