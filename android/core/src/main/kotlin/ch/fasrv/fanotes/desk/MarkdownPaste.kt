package ch.fasrv.fanotes.desk

/**
 * Pasting a URL over selected text wraps that text as a Markdown link,
 * matching the desktop editor (`pasteURLAsLink` in `@codemirror/lang-markdown`).
 * Null means the paste should stay a plain insertion.
 */
fun pasteUrlAsMarkdownLink(text: String, rawStart: Int, rawEnd: Int, pasted: String): MarkdownEdit? {
    if (rawStart < 0 || rawEnd < 0 || rawStart > text.length || rawEnd > text.length) return null
    val start = minOf(rawStart, rawEnd)
    val end = maxOf(rawStart, rawEnd)
    if (start == end || !URL_START.containsMatchIn(pasted)) return null
    if (!plainSelection(text, start, end)) return null
    val link = if (pasted.startsWith("www.")) "https://$pasted" else pasted
    val label = text.substring(start, end)
    val insert = "[$label]($link)"
    val next = text.substring(0, start) + insert + text.substring(end)
    return MarkdownEdit(next, start + 1, start + 1 + label.length)
}

private val URL_START = Regex("""^(?:https?://|mailto:|xmpp:|www\.)""")

private fun plainSelection(text: String, start: Int, end: Int): Boolean {
    if (text.substring(start, end).contains('\n')) return false
    if (fenceIsOpen(text, start) || lineIsFence(text, start)) return false
    val lineFrom = lineStart(text, start)
    val lineTo = lineEnd(text, start)
    if (end > lineTo) return false
    val line = text.substring(lineFrom, lineTo)
    if (THEMATIC_BREAK.matches(line)) return false
    val relStart = start - lineFrom
    val relEnd = end - lineFrom
    if (relStart < blockPrefixLength(line)) return false
    val selected = line.substring(relStart, relEnd)
    if (selected.contains('`') || selected.contains("**") || selected.contains("__") || selected.contains("~~")) return false
    if (selected.length >= 2 && selected.first() in "*_" && selected.last() in "*_") return false
    return nonPlainRanges(line).none { (from, to) -> relStart < to && from < relEnd }
}

private val THEMATIC_BREAK = Regex(""" {0,3}([-*_])(?:\s*\1){2,}\s*""")
private val LIST_PREFIX = Regex("""^( {0,3})(?:[-+*](?:[ \t]+\[[ xX]][ \t]*|[ \t]+)|\d+[.)][ \t]+)""")
private val HEADING_PREFIX = Regex("""^ {0,3}#{1,6}(?=[ \t]|$)""")
private val AUTOLINK = Regex("""<(?:https?://|mailto:|xmpp:)[^<>\s]*>""")
private val HTML_TAG = Regex("""</?[A-Za-z][^<>]*>""")
private val ENTITY = Regex("""&(?:#x[0-9A-Fa-f]+|#\d+|[A-Za-z][A-Za-z0-9]+);""")

private fun blockPrefixLength(line: String): Int {
    var index = 0
    while (index < line.length && line[index] == '>') {
        index++
        if (index < line.length && line[index] == ' ') index++
    }
    val rest = line.substring(index)
    val list = LIST_PREFIX.find(rest)
    if (list != null) return index + list.value.length
    val heading = HEADING_PREFIX.find(rest) ?: return index
    var end = heading.value.length
    if (end < rest.length && (rest[end] == ' ' || rest[end] == '\t')) end++
    return index + end
}

private fun nonPlainRanges(line: String): List<Pair<Int, Int>> {
    val ranges = mutableListOf<Pair<Int, Int>>()
    var index = 0
    while (index < line.length) {
        val consumed = when {
            line[index] == '`' -> codeSpanEnd(line, index)
            line.startsWith("<!--", index) -> commentEnd(line, index)
            line.startsWith("<?", index) -> processingEnd(line, index)
            line[index] == '<' -> autolinkOrTagEnd(line, index)
            line[index] == '&' -> entityEnd(line, index)
            line[index] == '!' && index + 1 < line.length && line[index + 1] == '[' -> linkEnd(line, index + 1)
            line[index] == '[' -> linkEnd(line, index)
            else -> null
        }
        if (consumed != null && consumed > index) {
            ranges += index to consumed
            index = consumed
        } else {
            index++
        }
    }
    return ranges
}

private fun codeSpanEnd(line: String, open: Int): Int? {
    var ticks = 0
    while (open + ticks < line.length && line[open + ticks] == '`') ticks++
    var index = open + ticks
    while (index < line.length) {
        if (line[index] != '`') {
            index++
            continue
        }
        var close = 0
        while (index + close < line.length && line[index + close] == '`') close++
        if (close == ticks) return index + close
        index += close
    }
    return null
}

private fun commentEnd(line: String, open: Int): Int? {
    val close = line.indexOf("-->", open + 4)
    return if (close < 0) null else close + 3
}

private fun processingEnd(line: String, open: Int): Int? {
    val close = line.indexOf("?>", open + 2)
    return if (close < 0) null else close + 2
}

private fun autolinkOrTagEnd(line: String, open: Int): Int? {
    val rest = line.substring(open)
    val autolink = AUTOLINK.find(rest)
    if (autolink != null && autolink.range.first == 0) return open + autolink.value.length
    val tag = HTML_TAG.find(rest)
    if (tag != null && tag.range.first == 0) return open + tag.value.length
    return null
}

private fun entityEnd(line: String, open: Int): Int? {
    val match = ENTITY.find(line.substring(open)) ?: return null
    if (match.range.first != 0) return null
    return open + match.value.length
}

private fun linkEnd(line: String, openBracket: Int): Int? {
    if (openBracket >= line.length || line[openBracket] != '[') return null
    var index = openBracket + 1
    while (index < line.length && line[index] != ']') {
        if (line[index] == '\\' && index + 1 < line.length) index += 2 else index++
    }
    if (index >= line.length || line[index] != ']') return null
    val after = index + 1
    if (after >= line.length) return null
    if (line[after] == '(') {
        var cursor = after + 1
        while (cursor < line.length && line[cursor] != ')') {
            if (line[cursor] == '\\' && cursor + 1 < line.length) cursor += 2 else cursor++
        }
        return if (cursor < line.length && line[cursor] == ')') cursor + 1 else null
    }
    if (line[after] == '[') {
        val close = line.indexOf(']', after + 1)
        return if (close < 0) null else close + 1
    }
    return null
}

private fun fenceIsOpen(text: String, position: Int): Boolean {
    val fence = Regex("""^ {0,3}```""")
    var open = false
    var index = 0
    val stop = lineStart(text, position)
    while (index < stop) {
        val end = text.indexOf('\n', index).let { if (it < 0) text.length else it }
        val line = text.substring(index, end)
        if (fence.find(line)?.range?.first == 0) open = !open
        if (end >= text.length) break
        index = end + 1
    }
    return open
}

private fun lineIsFence(text: String, position: Int): Boolean {
    val start = lineStart(text, position)
    val end = lineEnd(text, position)
    return Regex("""^ {0,3}```""").find(text.substring(start, end))?.range?.first == 0
}

private fun lineStart(text: String, index: Int): Int {
    if (text.isEmpty() || index <= 0) return 0
    val at = index.coerceAtMost(text.length)
    val newline = text.lastIndexOf('\n', at - 1)
    return if (newline < 0) 0 else newline + 1
}

private fun lineEnd(text: String, index: Int): Int {
    val at = index.coerceIn(0, text.length)
    val newline = text.indexOf('\n', at)
    return if (newline < 0) text.length else newline
}
