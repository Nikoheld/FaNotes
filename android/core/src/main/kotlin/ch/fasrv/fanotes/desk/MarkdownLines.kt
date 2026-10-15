package ch.fasrv.fanotes.desk

/**
 * Move or copy the selected lines, matching the desktop keymap
 * (`moveLineUp`, `moveLineDown`, `copyLineUp`, `copyLineDown`).
 * Move returns null when the block is already at that edge.
 */
fun moveMarkdownLines(text: String, anchor: Int, head: Int, forward: Boolean): MarkdownEdit? {
    val safeAnchor = anchor.coerceIn(0, text.length)
    val safeHead = head.coerceIn(0, text.length)
    val block = selectedBlock(text, safeAnchor, safeHead)
    if (forward) {
        if (block.to == text.length) return null
        val next = lineAt(text, block.to + 1)
        val blockText = text.substring(block.from, block.to)
        val nextText = text.substring(next.from, next.to)
        val moved = text.substring(0, block.from) + nextText + "\n" + blockText + text.substring(next.to)
        val size = nextText.length + 1
        return MarkdownEdit(
            moved,
            (safeAnchor + size).coerceAtMost(text.length),
            (safeHead + size).coerceAtMost(text.length),
        )
    }
    if (block.from == 0) return null
    val previous = lineAt(text, block.from - 1)
    val blockText = text.substring(block.from, block.to)
    val previousText = text.substring(previous.from, previous.to)
    val moved = text.substring(0, previous.from) + blockText + "\n" + previousText + text.substring(block.to)
    val size = previousText.length + 1
    return MarkdownEdit(moved, safeAnchor - size, safeHead - size)
}

fun copyMarkdownLines(text: String, anchor: Int, head: Int, forward: Boolean): MarkdownEdit {
    val safeAnchor = anchor.coerceIn(0, text.length)
    val safeHead = head.coerceIn(0, text.length)
    val block = selectedBlock(text, safeAnchor, safeHead)
    val blockText = text.substring(block.from, block.to)
    val insertAt = if (forward) block.from else block.to
    val insert = if (forward) blockText + "\n" else "\n" + blockText
    val next = text.substring(0, insertAt) + insert + text.substring(insertAt)
    val lower = minOf(safeAnchor, safeHead)
    val upper = maxOf(safeAnchor, safeHead)
    val inverted = safeAnchor > safeHead
    val (newLower, newUpper) = if (lower == upper) {
        val mapped = mapInsert(lower, insertAt, insert.length, if (forward) 1 else -1)
        mapped to mapped
    } else {
        mapInsert(lower, insertAt, insert.length, 1) to mapInsert(upper, insertAt, insert.length, -1)
    }
    val selectionStart = if (lower == upper || !inverted) newLower else newUpper
    val selectionEnd = if (lower == upper || !inverted) newUpper else newLower
    return MarkdownEdit(next, selectionStart, selectionEnd)
}

private data class LineSpan(val from: Int, val to: Int)

private fun selectedBlock(text: String, anchor: Int, head: Int): LineSpan {
    val start = minOf(anchor, head)
    val end = maxOf(anchor, head)
    val startLine = lineAt(text, start)
    var endLine = lineAt(text, end)
    if (start != end && end == endLine.from) endLine = lineAt(text, end - 1)
    return LineSpan(startLine.from, endLine.to)
}

private fun lineAt(text: String, pos: Int): LineSpan {
    val safe = pos.coerceIn(0, text.length)
    val from = if (safe == 0) 0 else {
        val newline = text.lastIndexOf('\n', safe - 1)
        if (newline < 0) 0 else newline + 1
    }
    val newline = text.indexOf('\n', from)
    val to = if (newline < 0) text.length else newline
    return LineSpan(from, to)
}

private fun mapInsert(pos: Int, at: Int, inserted: Int, assoc: Int): Int = when {
    pos < at -> pos
    pos > at -> pos + inserted
    assoc < 0 -> pos
    else -> pos + inserted
}
