package ch.fasrv.fanotes.desk

/**
 * Enter and Backspace for lists, tasks, and quotes, matching the desktop
 * Markdown keymap (`insertNewlineContinueMarkup` and `deleteMarkupBackward`).
 * Null means the editor should keep a plain newline or delete.
 */
data class MarkdownCaretEdit(val text: String, val cursor: Int)

fun markdownEnterReplacement(before: String, after: String): MarkdownCaretEdit? {
    val at = insertedSingleNewline(before, after) ?: return null
    return continueMarkdownEnter(before, at)
}

fun markdownBackspaceReplacement(before: String, after: String): MarkdownCaretEdit? {
    val at = deletedSingleChar(before, after) ?: return null
    return deleteMarkdownMarkup(before, at)
}

private fun insertedSingleNewline(before: String, after: String): Int? {
    if (after.length != before.length + 1) return null
    var index = 0
    while (index < before.length && before[index] == after[index]) index++
    if (after.getOrNull(index) != '\n') return null
    if (after.substring(index + 1) != before.substring(index)) return null
    return index
}

private fun deletedSingleChar(before: String, after: String): Int? {
    if (before.length != after.length + 1) return null
    var index = 0
    while (index < after.length && before[index] == after[index]) index++
    if (before.substring(index + 1) != after.substring(index)) return null
    return index + 1
}

fun continueMarkdownEnter(text: String, cursor: Int): MarkdownCaretEdit? {
    if (cursor !in 0..text.length || insideFence(text, cursor)) return null
    val lineStart = lineStartAt(text, cursor)
    val lineEnd = text.indexOf('\n', cursor).let { if (it < 0) text.length else it }
    val line = text.substring(lineStart, lineEnd)
    val column = cursor - lineStart
    if (line.substring(column).any { !it.isWhitespace() }) return null
    val parsed = parseLeadingMarkup(line) ?: return null
    val contentEnd = parsed.markerEnd + parsed.body.trimEnd().length
    if (column < contentEnd) return null
    if (parsed.body.isBlank() && parsed.listMarker.isNotEmpty()) {
        val cleared = parsed.withoutInnermost()
        val next = text.substring(0, lineStart) + cleared + text.substring(cursor)
        return MarkdownCaretEdit(next, lineStart + cleared.length)
    }
    if (parsed.body.isBlank() && parsed.quotes.isNotEmpty()) {
        val previous = previousLine(text, lineStart)
        if (previous != null && quoteOnly(previous)) {
            val prevStart = lineStart - previous.length - 1
            val clearedPrev = previous.removeQuote()
            val cleared = parsed.withoutInnermost()
            val next = text.substring(0, prevStart) + clearedPrev + "\n" + cleared + text.substring(cursor)
            return MarkdownCaretEdit(next, prevStart + clearedPrev.length + 1 + cleared.length)
        }
    }
    val marker = parsed.continued()
    val next = text.substring(0, cursor) + "\n" + marker + text.substring(cursor)
    return MarkdownCaretEdit(next, cursor + 1 + marker.length)
}

/** Backspace directly after list or quote markup removes one level. A list marker becomes spaces first. */
fun deleteMarkdownMarkup(text: String, cursor: Int): MarkdownCaretEdit? {
    if (cursor !in 1..text.length || insideFence(text, cursor)) return null
    val lineStart = lineStartAt(text, cursor)
    val lineEnd = text.indexOf('\n', cursor).let { if (it < 0) text.length else it }
    val line = text.substring(lineStart, lineEnd)
    val column = cursor - lineStart
    val parsed = parseLeadingMarkup(line) ?: return null
    if (column != parsed.markerEnd) return null
    val replacement = if (parsed.listMarker.any { !it.isWhitespace() }) {
        parsed.quotes + parsed.indent + " ".repeat((parsed.markerEnd - parsed.quotes.length - parsed.indent.length).coerceAtLeast(0))
    } else {
        parsed.withoutInnermost()
    }
    val next = text.substring(0, lineStart) + replacement + text.substring(cursor)
    return MarkdownCaretEdit(next, lineStart + replacement.length)
}

private data class LeadingMarkup(
    val quotes: String,
    val indent: String,
    val listMarker: String,
    val body: String,
    val markerEnd: Int,
) {
    fun continued(): String {
        val nextList = when {
            listMarker.isEmpty() -> ""
            listMarker.first().isDigit() -> {
                val match = ORDERED.matchEntire(listMarker) ?: return quotes + indent + listMarker
                "${match.groupValues[1].toInt() + 1}${match.groupValues[2]}${match.groupValues[3]}"
            }
            else -> listMarker.replace(Regex("[xX]"), " ")
        }
        return quotes + indent + nextList
    }

    fun withoutInnermost(): String = when {
        listMarker.isNotEmpty() -> quotes + indent
        quotes.isNotEmpty() -> quotes.replace(Regex("""> ?$"""), "") + indent
        else -> indent
    }
}

private fun parseLeadingMarkup(line: String): LeadingMarkup? {
    var rest = line
    val quotes = StringBuilder()
    while (true) {
        val quote = QUOTE.find(rest) ?: break
        quotes.append(quote.value)
        rest = rest.substring(quote.value.length)
    }
    val indent = INDENT.find(rest)?.value.orEmpty()
    rest = rest.substring(indent.length)
    val bullet = BULLET.find(rest)
    val ordered = if (bullet == null) ORDERED.find(rest) else null
    val list = bullet?.value ?: ordered?.value.orEmpty()
    if (quotes.isEmpty() && list.isEmpty()) return null
    val body = rest.substring(list.length)
    return LeadingMarkup(quotes.toString(), indent, list, body, quotes.length + indent.length + list.length)
}

private val QUOTE = Regex("""^> ?""")
private val INDENT = Regex("""^[ \t]*""")
private val BULLET = Regex("""^[-+*](?: {1,4}\[[ xX]])?[ \t]+""")
private val ORDERED = Regex("""^(\d+)([.)])([ \t]+)""")

private fun lineStartAt(text: String, cursor: Int): Int {
    if (cursor == 0) return 0
    val found = text.lastIndexOf('\n', cursor - 1)
    return if (found < 0) 0 else found + 1
}

private fun previousLine(text: String, lineStart: Int): String? {
    if (lineStart <= 0) return null
    val prevEnd = lineStart - 1
    val prevStart = text.lastIndexOf('\n', (prevEnd - 1).coerceAtLeast(0)).let { if (it < 0) 0 else it + 1 }
    return text.substring(prevStart, prevEnd)
}

private fun quoteOnly(line: String): Boolean {
    val parsed = parseLeadingMarkup(line) ?: return false
    return parsed.listMarker.isEmpty() && parsed.quotes.isNotEmpty() && parsed.body.isBlank()
}

private fun String.removeQuote(): String {
    val parsed = parseLeadingMarkup(this) ?: return this
    return parsed.withoutInnermost() + parsed.body
}

private fun insideFence(text: String, cursor: Int): Boolean {
    val fence = Regex("""^ {0,3}```""")
    var open = false
    var index = 0
    while (index < cursor) {
        val end = text.indexOf('\n', index).let { if (it < 0 || it > cursor) cursor else it }
        val line = text.substring(index, end)
        if (fence.find(line)?.range?.first == 0) open = !open
        if (end >= cursor) break
        index = end + 1
    }
    return open
}
