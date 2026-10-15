package ch.fasrv.fanotes.desk

/**
 * Selects the whole lines touched by the caret, matching the desktop
 * command `selectLine`. The newline after the last line is included when
 * the document continues.
 */
fun selectMarkdownLine(text: String, anchor: Int, head: Int): MarkdownEdit {
    val start = minOf(anchor, head).coerceIn(0, text.length)
    val end = maxOf(anchor, head).coerceIn(0, text.length)
    val startLine = lineBounds(text, start)
    var endLine = lineBounds(text, end)
    if (start != end && end == endLine.first) endLine = lineBounds(text, (end - 1).coerceAtLeast(0))
    val from = startLine.first
    val to = (endLine.second + 1).coerceAtMost(text.length)
    return MarkdownEdit(text, from, to)
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
