package ch.fasrv.fanotes.desk

/**
 * Shift-Enter splits the line and keeps its indent, matching the desktop
 * command `insertNewlineAndIndent`. A cursor directly between `()`, `[]`,
 * or `{}` also leaves a blank line for the closing bracket.
 */
fun insertMarkdownNewlineIndent(text: String, anchor: Int, head: Int): MarkdownEdit {
    val start = minOf(anchor, head).coerceIn(0, text.length)
    val end = maxOf(anchor, head).coerceIn(0, text.length)
    val (lineFrom, lineTo) = lineBounds(text, start)
    val line = text.substring(lineFrom, lineTo)
    val indent = " ".repeat(leadingColumns(line))
    if (start == end && start in 1 until text.length && text.substring(start - 1, start + 1) in BRACKET_PAIRS) {
        val insert = "\n$indent\n$indent"
        val next = text.substring(0, start) + insert + text.substring(end)
        val cursor = (start + 1 + indent.length).coerceIn(0, next.length)
        return MarkdownEdit(next, cursor, cursor)
    }
    var from = start
    var to = end
    while (to < lineTo && text[to].isWhitespace()) to++
    val beforeCursor = line.take((from - lineFrom).coerceAtLeast(0))
    if (from > lineFrom && from < lineFrom + 100 && beforeCursor.none { !it.isWhitespace() }) from = lineFrom
    val insert = "\n$indent"
    val next = text.substring(0, from) + insert + text.substring(to)
    val cursor = (from + 1 + indent.length).coerceIn(0, next.length)
    return MarkdownEdit(next, cursor, cursor)
}

private val BRACKET_PAIRS = setOf("()", "[]", "{}")

private fun lineBounds(text: String, pos: Int): Pair<Int, Int> {
    val safe = pos.coerceIn(0, text.length)
    val from = if (safe == 0) 0 else {
        val newline = text.lastIndexOf('\n', safe - 1)
        if (newline < 0) 0 else newline + 1
    }
    val newline = text.indexOf('\n', from)
    return from to if (newline < 0) text.length else newline
}

private fun leadingColumns(line: String): Int {
    var column = 0
    for (ch in line) {
        if (!ch.isWhitespace()) break
        column += if (ch == '\t') 4 - (column % 4) else 1
    }
    return column
}
