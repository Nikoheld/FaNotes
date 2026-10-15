package ch.fasrv.fanotes.desk

import java.util.Locale

/** One match inside a PDF page, using the same excerpt window as the desktop viewer. */
data class PdfSearchHit(val page: Int, val index: Int, val excerpt: String)

/**
 * Case-insensitive search over one string per page.
 * Pages are numbered from 1. At most [limit] hits, matching `runSearch` in `PdfNoteView.tsx`.
 */
fun searchPdfPages(pages: List<String>, query: String, limit: Int = 400): List<PdfSearchHit> {
    val needleRaw = query.trim()
    if (needleRaw.isEmpty() || limit <= 0) return emptyList()
    val needle = needleRaw.lowercase(Locale.GERMAN)
    if (needle.isEmpty()) return emptyList()
    val hits = ArrayList<PdfSearchHit>()
    for ((pageIndex, page) in pages.withIndex()) {
        val haystack = page.lowercase(Locale.GERMAN)
        val source = if (haystack.length == page.length) page else haystack
        var cursor = 0
        var local = 0
        while (cursor < haystack.length && hits.size < limit) {
            val index = haystack.indexOf(needle, cursor)
            if (index < 0) break
            val start = (index - 28).coerceAtLeast(0)
            val end = (index + needleRaw.length + 42).coerceAtMost(source.length)
            val excerpt = source.substring(start, end.coerceAtLeast(start)).replace(Regex("\\s+"), " ").trim()
            hits += PdfSearchHit(pageIndex + 1, local, excerpt)
            local += 1
            cursor = index + needleRaw.length.coerceAtLeast(1)
        }
    }
    return hits
}
