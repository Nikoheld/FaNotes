package ch.fasrv.fanotes.desk

import java.util.Locale

/**
 * Wiki links and the notes that point at the open note.
 * Ported from `fanotes/src/lib/backlinks.ts`.
 */

private val WIKILINK = Regex("""\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?]]""")
private val GERMAN = Locale.forLanguageTag("de-DE")

data class Backlink(val path: String, val title: String, val excerpt: String)

/** Titles a note points at with wiki links such as `[[Mechanik]]`. */
fun wikilinkTargets(markdown: String): List<String> {
    val found = linkedSetOf<String>()
    for (match in WIKILINK.findAll(markdown)) {
        val target = match.groupValues[1].trim()
        if (target.isNotEmpty()) found += target
    }
    return found.toList()
}

fun backlinksFor(path: String, notes: List<Pair<String, String>>): List<Backlink> {
    val stem = titleFromPath(path).lowercase(GERMAN)
    return notes.flatMap { (notePath, content) ->
        if (notePath == path) return@flatMap emptyList()
        val hit = wikilinkTargets(content).find { target ->
            target.lowercase(GERMAN) == stem || target == path
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

private fun excerptAround(markdown: String, needle: String): String {
    val index = markdown.lowercase(GERMAN).indexOf(needle.lowercase(GERMAN))
    if (index < 0) return ""
    val end = minOf(markdown.length, index + needle.length + 72)
    return markdown.substring(maxOf(0, index - 48), end).replace(Regex("\\s+"), " ").trim()
}
