package ch.fasrv.fanotes.desk

import java.util.Locale

/**
 * Wiki links and the notes that point at the open note.
 * Ported from `fanotes/src/lib/backlinks.ts`.
 */

private val WIKILINK = Regex("""\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?]]""")
private val FENCE = Regex("""^ {0,3}(`{3,}|~{3,})(.*)$""")
private val GERMAN = Locale.forLanguageTag("de-DE")

/**
 * Spaces stand in for fenced and inline code. The result has the same length,
 * so a match index still points at the same place in the original note.
 */
fun maskMarkdownCode(markdown: String): String {
    val chars = markdown.toCharArray()
    var offset = 0
    var fenceMarker = ""
    var fenceLength = 0
    for (rawLine in markdown.split('\n')) {
        val line = rawLine.removeSuffix("\r")
        val fence = FENCE.matchEntire(line)
        var hide = false
        if (fence != null) {
            val token = fence.groupValues[1]
            val marker = token.first().toString()
            val rest = fence.groupValues[2]
            if (fenceMarker.isEmpty()) {
                if (marker != "`" || !rest.contains('`')) {
                    fenceMarker = marker
                    fenceLength = token.length
                    hide = true
                }
            } else if (marker == fenceMarker && token.length >= fenceLength && rest.isBlank()) {
                fenceMarker = ""
                fenceLength = 0
                hide = true
            } else if (fenceMarker.isNotEmpty()) {
                hide = true
            }
        } else if (fenceMarker.isNotEmpty()) {
            hide = true
        }
        if (hide) {
            for (slot in rawLine.indices) chars[offset + slot] = ' '
        }
        offset += rawLine.length + 1
    }
    return maskInlineCode(chars)
}

private fun maskInlineCode(chars: CharArray): String {
    var index = 0
    while (index < chars.size) {
        if (chars[index] != '`') {
            index += 1
            continue
        }
        var length = 0
        while (index + length < chars.size && chars[index + length] == '`') length += 1
        var cursor = index + length
        var closed = -1
        while (cursor < chars.size) {
            if (chars[cursor] != '`') {
                cursor += 1
                continue
            }
            var run = 0
            while (cursor + run < chars.size && chars[cursor + run] == '`') run += 1
            if (run == length) {
                closed = cursor
                break
            }
            cursor += run
        }
        if (closed < 0) {
            index += length
            continue
        }
        for (slot in index until closed + length) chars[slot] = ' '
        index = closed + length
    }
    return String(chars)
}

data class Backlink(val path: String, val title: String, val excerpt: String)

/** Titles a note points at with wiki links such as `[[Mechanik]]`. Examples in code do not count. */
fun wikilinkTargets(markdown: String): List<String> {
    val found = linkedSetOf<String>()
    for (match in WIKILINK.findAll(maskMarkdownCode(markdown))) {
        val target = match.groupValues[1].trim()
        if (target.isNotEmpty()) found += target
    }
    return found.toList()
}

private val NOTE_EXT = Regex("""\.(md|markdown|pdf)$""", RegexOption.IGNORE_CASE)

/**
 * A wiki target names this note by title (`[[Algebra]]`, `[[Algebra.md]]`)
 * or by vault path (`[[Mathe/Algebra]]`). A path does not match a different
 * folder that happens to use the same title.
 */
fun wikiTargetMatchesNote(target: String, path: String): Boolean {
    val link = target.trim().replace('\\', '/').trim('/')
    val note = path.trim().replace('\\', '/').trim('/')
    if (link.isEmpty() || note.isEmpty()) return false
    val linkBare = NOTE_EXT.replace(link, "").lowercase(GERMAN)
    val noteBare = NOTE_EXT.replace(note, "").lowercase(GERMAN)
    if (link.contains('/')) return linkBare == noteBare
    return linkBare == titleFromPath(note).lowercase(GERMAN)
}

fun backlinksFor(path: String, notes: List<Pair<String, String>>): List<Backlink> {
    return notes.flatMap { (notePath, content) ->
        if (notePath == path) return@flatMap emptyList()
        val hit = wikilinkTargets(content).find { target ->
            wikiTargetMatchesNote(target, path)
        } ?: return@flatMap emptyList()
        listOf(Backlink(notePath, titleFromPath(notePath), excerptAround(content, "[[$hit")))
    }
}

/**
 * The note a wiki target opens. An exact path wins. Otherwise the file whose
 * title matches, preferring a note in the same folder as the source.
 */
fun resolveWikiTarget(target: String, paths: List<String>, sourcePath: String? = null): String? {
    val trimmed = target.trim()
    if (trimmed.isEmpty()) return null
    val withExtension = if (trimmed.lowercase(GERMAN).endsWith(".md") || trimmed.lowercase(GERMAN).endsWith(".markdown") || trimmed.lowercase(GERMAN).endsWith(".pdf")) {
        trimmed
    } else {
        "$trimmed.md"
    }
    paths.firstOrNull { it == trimmed || it == withExtension }?.let { return it }
    val wanted = trimmed.lowercase(GERMAN)
    val matches = paths.filter { titleFromPath(it).lowercase(GERMAN) == wanted }
    if (matches.isEmpty()) return null
    val folder = sourcePath?.substringBeforeLast('/', "").orEmpty()
    return matches.firstOrNull { it.substringBeforeLast('/', "") == folder } ?: matches.minBy { it.length }
}

private fun titleFromPath(path: String): String {
    val name = path.substringAfterLast('/')
    return name.replace(Regex("""\.(md|markdown|pdf)$""", RegexOption.IGNORE_CASE), "").ifEmpty { path }
}

/** Index in [text] of a German case match. `İ` lowercases to two units, so the folded index is not the original one. */
private fun localeIndex(text: String, needle: String): Int {
    val needleFold = needle.lowercase(GERMAN)
    if (needleFold.isEmpty()) return -1
    val origin = ArrayList<Int>(text.length)
    val folded = StringBuilder(text.length)
    text.forEachIndexed { index, character ->
        val piece = character.toString().lowercase(GERMAN)
        repeat(piece.length) { origin += index }
        folded.append(piece)
    }
    val found = folded.indexOf(needleFold)
    if (found < 0) return -1
    return origin[found]
}

private fun excerptAround(markdown: String, needle: String): String {
    val index = localeIndex(maskMarkdownCode(markdown), needle)
    if (index < 0) return ""
    val end = minOf(markdown.length, index + needle.length + 72)
    return markdown.substring(maxOf(0, index - 48), end).replace(Regex("\\s+"), " ").trim()
}
