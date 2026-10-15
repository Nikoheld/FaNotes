package ch.fasrv.fanotes.desk

/**
 * The destination under a rendered Markdown or wiki link.
 * A web address opens outside the app. Anything else is a note target.
 * [anchor] is the heading after `#`, kept so the note can scroll to it.
 */
data class FollowedLink(val target: String, val web: Boolean, val anchor: String? = null)

fun followedLinkAt(text: String, offset: Int): FollowedLink? {
    if (text.isEmpty()) return null
    val at = offset.coerceIn(0, text.length)
    for (match in MARKDOWN_LINK.findAll(text)) {
        val label = match.groupValues[1]
        val start = match.range.first + 1
        if (at in start until start + label.length) {
            val url = match.groupValues[2].trim()
            if (url.isEmpty()) continue
            if (isWebLink(url)) return FollowedLink(url, true)
            val file = url.substringBefore('#').trim()
            if (file.isEmpty()) continue
            return FollowedLink(file, false, headingAnchor(url))
        }
    }
    for (match in WIKI_LINK.findAll(text)) {
        val rawTarget = match.groupValues[1].trim()
        val alias = match.groupValues[2]
        val label = alias.ifEmpty { rawTarget }
        val start = if (alias.isNotEmpty()) match.range.first + match.value.indexOf(alias) else match.range.first + 2
        if (label.isEmpty() || at !in start until start + label.length) continue
        val file = rawTarget.substringBefore('#').trim()
        if (file.isEmpty()) continue
        return FollowedLink(file, false, headingAnchor(rawTarget))
    }
    return null
}

private fun headingAnchor(target: String): String? =
    target.substringAfter('#', "").trim().removePrefix("#").ifEmpty { null }

private fun isWebLink(target: String): Boolean {
    val value = target.lowercase()
    return value.startsWith("https://") || value.startsWith("http://") || value.startsWith("mailto:")
}

private val MARKDOWN_LINK = Regex("""\[([^\]\n]+)]\(([^)\n]+)\)""")
private val WIKI_LINK = Regex("""\[\[([^\]\n|]+)(?:\|([^\]\n]+))?]]""")
