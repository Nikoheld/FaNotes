package ch.fasrv.fanotes.desk

/**
 * PDF text marks on the Android text layer.
 *
 * The desktop paints a mark on the pdf.js text spans that cover its quote (`spanIndexesForQuotes`,
 * `unmarkPdfSpans` in `fanotes/src/lib/pdfTextMarks.ts`). Android has no spans: `PdfRenderer` gives the page text
 * as one string and answers selections by character index. So the same rules run on character ranges here:
 *
 * - a quote is found in the page text regardless of white space (pdf.js and PDFium do not break lines and runs at
 *   the same places), case-sensitive like the desktop;
 * - a mark with `nth` paints only that occurrence (counted at every start, overlapping ones included), without it
 *   every non-overlapping occurrence;
 * - taking the highlight off a range keeps the rest of each touched passage as pieces pinned to their occurrence.
 *
 * Ranges are `[start, end)` indexes into the raw page text, the indexes `SelectionBoundary(int)` takes.
 */

/** One painted passage of a mark. */
data class PdfMarkRange(val markId: String, val kind: String, val start: Int, val end: Int)

/** The page text without white space, and where each kept character sits in the raw text. */
class PdfPageTextIndex(val raw: String) {
    val compact: String
    private val rawAt: IntArray

    init {
        val builder = StringBuilder(raw.length)
        val at = IntArray(raw.length)
        var count = 0
        for (index in raw.indices) {
            if (raw[index].isWhitespace()) continue
            builder.append(raw[index])
            at[count] = index
            count += 1
        }
        compact = builder.toString()
        rawAt = at.copyOf(count)
    }

    /** Raw range of the compact range `[from, to)`. */
    fun rawRange(from: Int, to: Int): IntRange? {
        if (from < 0 || to > rawAt.size || from >= to) return null
        return rawAt[from]..rawAt[to - 1]
    }

    /** First compact index at or after raw index [rawIndex]. */
    fun compactAtOrAfter(rawIndex: Int): Int {
        var low = 0
        var high = rawAt.size
        while (low < high) {
            val mid = (low + high) ushr 1
            if (rawAt[mid] < rawIndex) low = mid + 1 else high = mid
        }
        return low
    }
}

private fun compactOf(value: String) = value.filterNot { it.isWhitespace() }

/** Every start of [needle] in [text], overlapping ones included. */
internal fun quoteStarts(text: String, needle: String): List<Int> {
    if (needle.isEmpty()) return emptyList()
    val starts = ArrayList<Int>()
    var at = text.indexOf(needle)
    while (at >= 0) {
        starts += at
        at = text.indexOf(needle, at + 1)
    }
    return starts
}

/** Compact starts a mark paints: its one occurrence, or every non-overlapping one. */
private fun paintedStarts(index: PdfPageTextIndex, mark: PdfTextMark): Pair<String, List<Int>> {
    val needle = compactOf(mark.quote)
    // The desktop paints nothing for a quote under two characters.
    if (cleanQuote(mark.quote).length < 2 || needle.isEmpty()) return needle to emptyList()
    val nth = mark.nth
    if (nth != null) {
        val at = quoteStarts(index.compact, needle).getOrNull(nth)
        return needle to listOfNotNull(at)
    }
    val starts = ArrayList<Int>()
    var from = 0
    while (from < index.compact.length) {
        val at = index.compact.indexOf(needle, from)
        if (at < 0) break
        starts += at
        from = at + needle.length
    }
    return needle to starts
}

/** Raw ranges the marks of [page] paint on its text. */
fun pdfMarkRanges(pageText: String, marks: List<PdfTextMark>, page: Int): List<PdfMarkRange> =
    pdfMarkRanges(PdfPageTextIndex(pageText), marks, page)

fun pdfMarkRanges(index: PdfPageTextIndex, marks: List<PdfTextMark>, page: Int): List<PdfMarkRange> {
    val ranges = ArrayList<PdfMarkRange>()
    for (mark in marks) {
        if (mark.page != page) continue
        val (needle, starts) = paintedStarts(index, mark)
        for (start in starts) {
            val raw = index.rawRange(start, start + needle.length) ?: continue
            ranges += PdfMarkRange(mark.id, mark.kind, raw.first, raw.last + 1)
        }
    }
    return ranges
}

/**
 * The occurrence a selection `[start, end)` of the page text stands for, for a new mark: null when the quote occurs
 * once on the page (stored without `nth`, the desktop's way), else its 0-based index among all starts.
 */
fun pdfSelectionOccurrence(pageText: String, start: Int, end: Int): Int? {
    val index = PdfPageTextIndex(pageText)
    val from = index.compactAtOrAfter(start)
    val to = index.compactAtOrAfter(end)
    if (to - from < 2) return null
    val needle = index.compact.substring(from, to)
    val starts = quoteStarts(index.compact, needle)
    if (starts.size <= 1) return null
    return starts.indexOf(from).takeIf { it >= 0 }
}

/** The selection `[start, end)` widened to whole words, so a stroke over part of a word takes the word. */
fun pdfWordAlignedRange(pageText: String, start: Int, end: Int): IntRange? {
    var from = start.coerceIn(0, pageText.length)
    var to = end.coerceIn(0, pageText.length)
    if (from >= to) return null
    while (from > 0 && !pageText[from - 1].isWhitespace()) from -= 1
    while (to < pageText.length && !pageText[to].isWhitespace()) to += 1
    while (from < to && pageText[from].isWhitespace()) from += 1
    while (to > from && pageText[to - 1].isWhitespace()) to -= 1
    return if (from < to) from until to else null
}

/** Words (runs without white space) of `[start, end)`, as raw ranges. */
fun pdfWordRanges(pageText: String, start: Int, end: Int): List<IntRange> {
    val words = ArrayList<IntRange>()
    var index = start.coerceAtLeast(0)
    val stop = end.coerceAtMost(pageText.length)
    while (index < stop) {
        while (index < stop && pageText[index].isWhitespace()) index += 1
        val wordStart = index
        while (index < stop && !pageText[index].isWhitespace()) index += 1
        if (index > wordStart) words += wordStart until index
    }
    return words
}

/** True when some painted mark covers a non-space character of `[start, end)`. */
fun pdfRangeTouchesMarks(pageText: String, ranges: List<PdfMarkRange>, start: Int, end: Int): Boolean =
    ranges.any { range ->
        val from = maxOf(range.start, start)
        val to = minOf(range.end, end)
        (from until to).any { !pageText[it].isWhitespace() }
    }

/**
 * Takes the highlight off the characters `[start, end)` of [page] and nothing else. A mark that only partly lies on
 * them keeps the rest of its passage as new marks pinned to that occurrence (`nth`). Returns [marks] itself when no
 * mark lay on the range.
 */
fun unmarkPdfRange(marks: List<PdfTextMark>, page: Int, pageText: String, start: Int, end: Int): List<PdfTextMark> {
    if (start >= end || marks.none { it.page == page }) return marks
    val index = PdfPageTextIndex(pageText)
    val eraseFrom = index.compactAtOrAfter(start)
    val eraseTo = index.compactAtOrAfter(end)
    if (eraseFrom >= eraseTo) return marks
    var changed = false
    val next = ArrayList<PdfTextMark>()
    for (mark in marks) {
        if (mark.page != page) {
            next += mark
            continue
        }
        val (needle, starts) = paintedStarts(index, mark)
        fun touched(at: Int) = at < eraseTo && at + needle.length > eraseFrom
        if (starts.none(::touched)) {
            next += mark
            continue
        }
        changed = true
        fun keep(from: Int, to: Int) {
            if (to - from < 2) return
            val raw = index.rawRange(from, to) ?: return
            val quote = cleanQuote(pageText.substring(raw.first, raw.last + 1))
            if (quote.length < 2) return
            val nth = quoteStarts(index.compact, index.compact.substring(from, to)).indexOf(from)
            if (nth < 0) return
            next += PdfTextMark(nextPdfMarkId(), page, quote, mark.kind, nth)
        }
        for (at in starts) {
            val stop = at + needle.length
            if (!touched(at)) {
                // Another occurrence of the same words keeps its highlight.
                keep(at, stop)
                continue
            }
            keep(at, minOf(stop, eraseFrom))
            keep(maxOf(at, eraseTo), stop)
        }
    }
    return if (changed) next else marks
}
