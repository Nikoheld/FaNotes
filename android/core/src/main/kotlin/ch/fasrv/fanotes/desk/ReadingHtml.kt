package ch.fasrv.fanotes.desk

/**
 * Inline HTML the desktop preview renders through rehype-raw, turned into
 * the Markdown the reading view already draws. The source editor stays as
 * written. Scripts and unsafe links are dropped.
 */
fun readingHtml(source: String): String {
    val lines = source.replace("\r\n", "\n").split('\n')
    val out = StringBuilder()
    var fence: Char? = null
    lines.forEachIndexed { index, line ->
        if (index > 0) out.append('\n')
        val marker = readingFence(line)
        if (marker != null && (fence == null || marker == fence)) {
            fence = if (fence == null) marker else null
            out.append(line)
            return@forEachIndexed
        }
        out.append(if (fence != null) line else htmlOutsideCode(line))
    }
    return out.toString()
}

private fun htmlOutsideCode(line: String): String {
    val out = StringBuilder()
    var index = 0
    while (index < line.length) {
        if (line[index] != '`') {
            val tick = line.indexOf('`', index).let { if (it < 0) line.length else it }
            out.append(transformHtml(line.substring(index, tick)))
            index = tick
            continue
        }
        var ticks = 0
        while (index + ticks < line.length && line[index + ticks] == '`') ticks += 1
        val closer = indexOfReadingTicks(line, index + ticks, ticks)
        if (closer < 0) {
            out.append(line.substring(index))
            break
        }
        out.append(line, index, closer + ticks)
        index = closer + ticks
    }
    return out.toString()
}

private fun transformHtml(raw: String): String {
    var value = SCRIPT.replace(raw, "")
    repeat(6) {
        val next = applyHtml(value)
        if (next == value) return WRAP.replace(value, "")
        value = next
    }
    return WRAP.replace(value, "")
}

private fun applyHtml(value: String): String {
    var next = BR.replace(value, "\n")
    next = IMG.replace(next) { match -> imageMarkdown(match.groupValues[1]) }
    next = ANCHOR.replace(next) { match ->
        val href = match.groupValues[1].ifEmpty { match.groupValues[2] }
        val label = match.groupValues[3]
        val safe = safeReadingHref(href)
        if (safe == null) label else "[$label]($safe)"
    }
    next = HEADING.replace(next) { match ->
        val level = match.groupValues[1].toIntOrNull()?.coerceIn(1, 6) ?: 1
        "${"#".repeat(level)} ${match.groupValues[2].trim()}"
    }
    next = STRONG.replace(next) { "**${it.groupValues[1]}**" }
    next = EMPHASIS.replace(next) { "*${it.groupValues[1]}*" }
    next = STRIKE.replace(next) { "~~${it.groupValues[1]}~~" }
    next = CODE.replace(next) { "`${it.groupValues[1]}`" }
    next = P_CLOSE.replace(P_OPEN.replace(next, ""), "\n")
    return next
}

private fun imageMarkdown(attrs: String): String {
    val src = htmlAttr(attrs, "src") ?: return ""
    val safe = safeReadingHref(src) ?: return ""
    val alt = htmlAttr(attrs, "alt").orEmpty().replace("]", "\\]")
    return "![$alt]($safe)"
}

private fun htmlAttr(attrs: String, name: String): String? {
    val match = Regex("""(?:^|\s)$name\s*=\s*(?:"([^"]*)"|'([^']*)')""", RegexOption.IGNORE_CASE).find(attrs)
    return match?.let { it.groupValues[1].ifEmpty { it.groupValues[2] } }
}

private fun safeReadingHref(href: String): String? {
    val value = href.trim()
    if (value.isEmpty() || value.contains('\n') || value.contains(')')) return null
    val lower = value.lowercase()
    if (lower.startsWith("javascript:") || lower.startsWith("data:") || lower.startsWith("vbscript:")) return null
    return value
}

private fun readingFence(line: String): Char? =
    Regex("""^ {0,3}(`{3,}|~{3,})[^`~]*$""").find(line)?.groupValues?.get(1)?.firstOrNull()

private fun indexOfReadingTicks(line: String, from: Int, ticks: Int): Int {
    if (ticks <= 0) return -1
    var index = from
    while (index <= line.length - ticks) {
        if ((0 until ticks).all { line[index + it] == '`' }) return index
        index += 1
    }
    return -1
}

private val SCRIPT = Regex("""<(script|style|iframe|object|embed)\b[^>]*>[\s\S]*?</\1>""", RegexOption.IGNORE_CASE)
private val BR = Regex("""<br\s*/?>""", RegexOption.IGNORE_CASE)
private val IMG = Regex("""<img\b([^>]*)/?>""", RegexOption.IGNORE_CASE)
private val ANCHOR = Regex("""<a\b[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)</a>""", RegexOption.IGNORE_CASE)
private val HEADING = Regex("""<h([1-6])\b[^>]*>([\s\S]*?)</h[1-6]>""", RegexOption.IGNORE_CASE)
private val STRONG = Regex("""<(?:strong|b)\b[^>]*>([\s\S]*?)</(?:strong|b)>""", RegexOption.IGNORE_CASE)
private val EMPHASIS = Regex("""<(?:em|i)\b[^>]*>([\s\S]*?)</(?:em|i)>""", RegexOption.IGNORE_CASE)
private val STRIKE = Regex("""<(?:del|s|strike)\b[^>]*>([\s\S]*?)</(?:del|s|strike)>""", RegexOption.IGNORE_CASE)
private val CODE = Regex("""<code\b[^>]*>([\s\S]*?)</code>""", RegexOption.IGNORE_CASE)
private val P_OPEN = Regex("""<p\b[^>]*>""", RegexOption.IGNORE_CASE)
private val P_CLOSE = Regex("""</p>""", RegexOption.IGNORE_CASE)
private val WRAP = Regex(
    """</?(?:span|div|section|font|u|small|mark|sub|sup|kbd|center|article|header|footer|main|figure|figcaption)\b[^>]*>""",
    RegexOption.IGNORE_CASE,
)
