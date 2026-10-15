package ch.fasrv.fanotes.desk

import java.util.Locale

/** One literal match in the note text the editor is showing. */
data class NoteSearchHit(val start: Int, val end: Int, val excerpt: String)

/**
 * Case-insensitive find, the default CodeMirror search.
 * German case folding, at most [limit] hits, with the same excerpt window as PDF search.
 */
fun searchNoteText(content: String, query: String, limit: Int = 400): List<NoteSearchHit> {
    val needleRaw = query.trim()
    if (needleRaw.isEmpty() || limit <= 0) return emptyList()
    val haystack = content.lowercase(Locale.GERMAN)
    val needle = needleRaw.lowercase(Locale.GERMAN)
    if (needle.isEmpty()) return emptyList()
    val source = if (haystack.length == content.length) content else haystack
    val hits = ArrayList<NoteSearchHit>()
    var cursor = 0
    while (cursor < haystack.length && hits.size < limit) {
        val index = haystack.indexOf(needle, cursor)
        if (index < 0) break
        val matchEnd = (index + needle.length).coerceAtMost(source.length)
        val excerptStart = (index - 28).coerceAtLeast(0)
        val excerptEnd = (matchEnd + 42).coerceAtMost(source.length)
        val excerpt = source.substring(excerptStart, excerptEnd.coerceAtLeast(excerptStart)).replace(Regex("\\s+"), " ").trim()
        hits += NoteSearchHit(index, matchEnd, excerpt)
        cursor = index + needle.length.coerceAtLeast(1)
    }
    return hits
}

/** Replaces one find hit. An empty [replacement] deletes the match. */
fun replaceNoteMatch(content: String, hit: NoteSearchHit, replacement: String): String {
    if (hit.start < 0 || hit.end > content.length || hit.start > hit.end) return content
    return content.replaceRange(hit.start, hit.end, replacement)
}

/**
 * Replaces every literal match of [query], walking the original hits from the end.
 * A replacement that contains the query is not searched again. The find bar stops at
 * 400 hits; replace-all does not, matching CodeMirror's replace-all.
 */
fun replaceAllNoteMatches(content: String, query: String, replacement: String): String {
    val hits = searchNoteText(content, query, limit = Int.MAX_VALUE)
    if (hits.isEmpty()) return content
    val builder = StringBuilder(content)
    for (hit in hits.asReversed()) {
        if (hit.start < 0 || hit.end > builder.length || hit.start > hit.end) continue
        builder.replace(hit.start, hit.end, replacement)
    }
    return builder.toString()
}
