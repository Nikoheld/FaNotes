package ch.fasrv.fanotes.desk

import java.util.Locale
import java.util.regex.Pattern
import java.util.regex.PatternSyntaxException

/**
 * One match in the note text the editor is showing.
 * [groups] is empty for a literal match. For a regular expression, group 0 is the
 * whole match and later entries are the capturing groups, as in CodeMirror.
 */
data class NoteSearchHit(
    val start: Int,
    val end: Int,
    val excerpt: String,
    val groups: List<String> = emptyList(),
)

/**
 * CodeMirror search-panel switches. Defaults match the panel when it first opens:
 * case-insensitive, literal, not limited to whole words.
 */
data class NoteSearchOptions(
    val caseSensitive: Boolean = false,
    val wholeWord: Boolean = false,
    val regexp: Boolean = false,
)

/**
 * Desktop search keymap. Ctrl-F opens the panel, Ctrl-G and F3 move to the
 * next hit, Shift reverses that, and Ctrl-Alt-G opens go-to-line.
 */
fun editorSearchShortcut(ctrl: Boolean, shift: Boolean, alt: Boolean, meta: Boolean, key: String): String? {
    if (meta) return null
    if (key == "f3" && !ctrl && !alt) return if (shift) "previous" else "next"
    if (!ctrl) return null
    if (key == "g" && alt && !shift) return "goto"
    if (alt) return null
    return when (key) {
        "f" -> if (shift) null else "open"
        "g" -> if (shift) "previous" else "next"
        else -> null
    }
}

/** A short selection becomes the search query. An empty or long selection keeps the current query. */
fun searchQueryFromSelection(current: String, selected: String): String {
    if (selected.isEmpty() || selected.length > 100) return current
    return selected.replace("\n", "\\n")
}

/** Next or previous hit relative to a source offset, wrapping like the desktop search. */
fun nextSearchHitIndex(hits: List<NoteSearchHit>, sourceOffset: Int, forward: Boolean): Int {
    if (hits.isEmpty()) return -1
    return if (forward) {
        val found = hits.indexOfFirst { it.start >= sourceOffset }
        if (found >= 0) found else 0
    } else {
        val found = hits.indexOfLast { it.end <= sourceOffset }
        if (found >= 0) found else hits.lastIndex
    }
}

/**
 * Find in the text the editor is showing.
 * German case folding when case does not matter, at most [limit] hits, with the
 * same excerpt window as PDF search. An invalid regular expression matches nothing.
 */
fun searchNoteText(
    content: String,
    query: String,
    limit: Int = 400,
    options: NoteSearchOptions = NoteSearchOptions(),
): List<NoteSearchHit> {
    if (limit <= 0) return emptyList()
    val needleRaw = query.trim()
    if (needleRaw.isEmpty()) return emptyList()
    return if (options.regexp) searchRegexp(content, needleRaw, limit, options)
    else searchLiteral(content, unquoteSearchText(needleRaw), limit, options)
}

/** Replaces one find hit. An empty [replacement] deletes the match. */
fun replaceNoteMatch(
    content: String,
    hit: NoteSearchHit,
    replacement: String,
    regexp: Boolean = false,
): String {
    if (hit.start < 0 || hit.end > content.length || hit.start > hit.end) return content
    return content.replaceRange(hit.start, hit.end, noteSearchInsert(replacement, hit, regexp))
}

/**
 * Replaces every match of [query], walking the original hits from the end.
 * A replacement that contains the query is not searched again. The find bar stops at
 * 400 hits; replace-all does not, matching CodeMirror's replace-all.
 */
fun replaceAllNoteMatches(
    content: String,
    query: String,
    replacement: String,
    options: NoteSearchOptions = NoteSearchOptions(),
): String {
    val hits = searchNoteText(content, query, limit = Int.MAX_VALUE, options = options)
    if (hits.isEmpty()) return content
    val builder = StringBuilder(content)
    for (hit in hits.asReversed()) {
        if (hit.start < 0 || hit.end > builder.length || hit.start > hit.end) continue
        builder.replace(hit.start, hit.end, noteSearchInsert(replacement, hit, options.regexp))
    }
    return builder.toString()
}

/** CodeMirror unquote of `\n`, `\r`, `\t`, and `\\` in a literal query or a replacement. */
fun unquoteSearchText(text: String): String {
    if (!text.contains('\\')) return text
    val out = StringBuilder(text.length)
    var index = 0
    while (index < text.length) {
        if (text[index] == '\\' && index + 1 < text.length) {
            when (text[index + 1]) {
                'n' -> out.append('\n')
                'r' -> out.append('\r')
                't' -> out.append('\t')
                '\\' -> out.append('\\')
                else -> {
                    out.append('\\')
                    out.append(text[index + 1])
                }
            }
            index += 2
        } else {
            out.append(text[index])
            index += 1
        }
    }
    return out.toString()
}

private fun searchLiteral(
    content: String,
    needle: String,
    limit: Int,
    options: NoteSearchOptions,
): List<NoteSearchHit> {
    if (needle.isEmpty()) return emptyList()
    val haystack = if (options.caseSensitive) content else content.lowercase(Locale.GERMAN)
    val folded = if (options.caseSensitive) needle else needle.lowercase(Locale.GERMAN)
    if (folded.isEmpty()) return emptyList()
    val aligned = haystack.length == content.length
    val source = if (aligned) content else haystack
    val hits = ArrayList<NoteSearchHit>()
    var cursor = 0
    while (cursor < haystack.length && hits.size < limit) {
        val found = if (options.caseSensitive) {
            val index = haystack.indexOf(folded, cursor)
            if (index < 0) null else index until (index + folded.length)
        } else {
            findSharpS(haystack, folded, cursor)
        } ?: break
        val index = found.first
        val matchEnd = (found.last + 1).coerceAtMost(source.length)
        if (options.wholeWord && (!aligned || !isWholeWord(content, index, matchEnd))) {
            cursor = index + 1
            continue
        }
        hits += NoteSearchHit(index, matchEnd, excerptAt(source, index, matchEnd))
        cursor = (found.last + 1).coerceAtLeast(index + 1)
    }
    return hits
}

private fun searchRegexp(
    content: String,
    pattern: String,
    limit: Int,
    options: NoteSearchOptions,
): List<NoteSearchHit> {
    val compiled = try {
        Pattern.compile(pattern, regexpFlags(options.caseSensitive))
    } catch (_: PatternSyntaxException) {
        return emptyList()
    }
    val hits = ArrayList<NoteSearchHit>()
    if (multilineRegexp.containsMatchIn(pattern)) {
        collectRegexp(compiled, content, 0, content, limit, options, hits)
        return hits
    }
    var lineStart = 0
    while (lineStart <= content.length && hits.size < limit) {
        var lineEnd = lineStart
        while (lineEnd < content.length && content[lineEnd] != '\n' && content[lineEnd] != '\r') lineEnd += 1
        collectRegexp(compiled, content.substring(lineStart, lineEnd), lineStart, content, limit, options, hits)
        if (lineEnd >= content.length) break
        lineStart = lineEnd + 1
        if (content[lineEnd] == '\r' && lineStart < content.length && content[lineStart] == '\n') lineStart += 1
    }
    return hits
}

private fun collectRegexp(
    pattern: Pattern,
    region: String,
    regionOffset: Int,
    full: String,
    limit: Int,
    options: NoteSearchOptions,
    hits: ArrayList<NoteSearchHit>,
) {
    val matcher = pattern.matcher(region)
    var cursor = 0
    while (cursor <= region.length && hits.size < limit) {
        if (!matcher.find(cursor)) break
        val start = matcher.start()
        val end = matcher.end()
        if (start < cursor) break
        val absStart = regionOffset + start
        val absEnd = regionOffset + end
        val next = if (end > start) end else start + 1
        if (!options.wholeWord || isWholeWord(full, absStart, absEnd)) {
            val groups = ArrayList<String>(matcher.groupCount() + 1)
            for (group in 0..matcher.groupCount()) groups += matcher.group(group) ?: ""
            hits += NoteSearchHit(absStart, absEnd, excerptAt(full, absStart, absEnd), groups)
        }
        cursor = next
    }
}

private fun regexpFlags(caseSensitive: Boolean): Int {
    var flags = Pattern.MULTILINE
    if (!caseSensitive) flags = flags or Pattern.CASE_INSENSITIVE or Pattern.UNICODE_CASE
    return flags
}

/** Same boundary rule as CodeMirror's "by word": a match that starts or ends on a word character needs a non-word neighbour. */
private fun isWholeWord(content: String, start: Int, end: Int): Boolean {
    if (start < 0 || end > content.length || start > end) return false
    if (start == end) return true
    val startsWithWord = isSearchWordChar(content[start])
    val endsWithWord = isSearchWordChar(content[end - 1])
    val beforeIsWord = start > 0 && isSearchWordChar(content[start - 1])
    val afterIsWord = end < content.length && isSearchWordChar(content[end])
    return (!beforeIsWord || !startsWithWord) && (!afterIsWord || !endsWithWord)
}

private fun isSearchWordChar(ch: Char): Boolean =
    ch == '_' || Character.isLetter(ch) || Character.isDigit(ch)

private fun excerptAt(source: String, start: Int, end: Int): String {
    val safeStart = start.coerceIn(0, source.length)
    val safeEnd = end.coerceIn(safeStart, source.length)
    val excerptStart = (safeStart - 28).coerceAtLeast(0)
    val excerptEnd = (safeEnd + 42).coerceAtMost(source.length)
    return source.substring(excerptStart, excerptEnd.coerceAtLeast(excerptStart)).replace(Regex("\\s+"), " ").trim()
}

private fun noteSearchInsert(replacement: String, hit: NoteSearchHit, regexp: Boolean): String {
    val unquoted = unquoteSearchText(replacement)
    if (!regexp) return unquoted
    return regexpReplacement.replace(unquoted) { match ->
        val token = match.groupValues[1]
        when (token) {
            "&" -> hit.groups.getOrElse(0) { "" }
            "$" -> "$"
            else -> expandGroup(token, hit.groups) ?: match.value
        }
    }
}

private fun expandGroup(token: String, groups: List<String>): String? {
    for (length in token.length downTo 1) {
        val number = token.substring(0, length).toIntOrNull() ?: continue
        if (number > 0 && number < groups.size) return groups[number] + token.substring(length)
    }
    return null
}

private val multilineRegexp = Regex("""\\[sWDnr]|\n|\r|\[\^""")
private val regexpReplacement = Regex("""\$(\$|&|\d+)""")
