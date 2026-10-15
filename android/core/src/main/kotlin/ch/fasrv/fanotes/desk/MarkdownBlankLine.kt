package ch.fasrv.fanotes.desk

/**
 * Ctrl-Enter inserts a blank line under the current line, matching the
 * desktop command `insertBlankLine`. The new line keeps the current line's
 * indent, counted in columns with a tab width of four.
 */
fun insertMarkdownBlankLine(text: String, anchor: Int, head: Int): MarkdownEdit {
    val start = minOf(anchor, head).coerceIn(0, text.length)
    val end = maxOf(anchor, head).coerceIn(0, text.length)
    val startLine = lineBounds(text, start)
    val endLine = if (end <= startLine.second) startLine else lineBounds(text, end)
    val lineFrom = endLine.first
    val lineTo = endLine.second
    val line = text.substring(lineFrom, lineTo)
    val indent = " ".repeat(leadingColumns(line))
    var from = lineTo
    if (from > lineFrom && from < lineFrom + 100 && line.none { !it.isWhitespace() }) from = lineFrom
    val insert = "\n$indent"
    val next = text.substring(0, from) + insert + text.substring(lineTo)
    val cursor = (from + 1 + indent.length).coerceIn(0, next.length)
    return MarkdownEdit(next, cursor, cursor)
}

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
