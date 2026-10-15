package ch.fasrv.fanotes.desk

/**
 * Deletes the selected lines, matching the desktop command `deleteLine`
 * (Shift-Ctrl-K). The caret lands on the following line at the same column,
 * or at the end of the previous line when the deleted block was last.
 */
fun deleteMarkdownLines(text: String, anchor: Int, head: Int): MarkdownEdit {
    val safeAnchor = anchor.coerceIn(0, text.length)
    val safeHead = head.coerceIn(0, text.length)
    val block = selectedBlock(text, safeAnchor, safeHead)
    var from = block.from
    var to = block.to
    if (from > 0) from -= 1 else if (to < text.length) to += 1
    val next = text.substring(0, from) + text.substring(to)
    val headLine = lineAt(text, safeHead)
    val column = (safeHead - headLine.from).coerceAtLeast(0)
    val target = if (block.to < text.length) {
        val following = lineAt(text, block.to + 1)
        following.from + column.coerceAtMost(following.to - following.from)
    } else {
        block.to
    }
    val cursor = when {
        target < from -> target
        target >= to -> target - (to - from)
        else -> from
    }.coerceIn(0, next.length)
    return MarkdownEdit(next, cursor, cursor)
}

private data class DeleteLine(val from: Int, val to: Int)

private fun selectedBlock(text: String, anchor: Int, head: Int): DeleteLine {
    val start = minOf(anchor, head)
    val end = maxOf(anchor, head)
    val startLine = lineAt(text, start)
    var endLine = lineAt(text, end)
    if (start != end && end == endLine.from) endLine = lineAt(text, end - 1)
    return DeleteLine(startLine.from, endLine.to)
}

private fun lineAt(text: String, pos: Int): DeleteLine {
    val safe = pos.coerceIn(0, text.length)
    val from = if (safe == 0) 0 else {
        val newline = text.lastIndexOf('\n', safe - 1)
        if (newline < 0) 0 else newline + 1
    }
    val newline = text.indexOf('\n', from)
    return DeleteLine(from, if (newline < 0) text.length else newline)
}
