package ch.fasrv.fanotes.desk

/**
 * Ctrl-/ comments the selected lines with an HTML comment, matching the
 * desktop Markdown keymap (`toggleComment` → `toggleBlockCommentByLine`).
 * A second press removes the same `<!--` `-->` pair.
 */
fun toggleMarkdownComment(text: String, anchor: Int, head: Int): MarkdownEdit {
    val safeAnchor = anchor.coerceIn(0, text.length)
    val safeHead = head.coerceIn(0, text.length)
    val range = commentLineRange(text, safeAnchor, safeHead)
    return applyCommentToggle(text, safeAnchor, safeHead, range.from, range.to, insideEmpty = false)
}

/**
 * Alt-Shift-A comments the selection itself (`toggleBlockComment`).
 * An empty caret inserts `<!--  -->` with the caret between the markers,
 * so a second press removes it. Ctrl-/ still comments the whole line.
 */
fun toggleMarkdownBlockComment(text: String, anchor: Int, head: Int): MarkdownEdit {
    val safeAnchor = anchor.coerceIn(0, text.length)
    val safeHead = head.coerceIn(0, text.length)
    val from = minOf(safeAnchor, safeHead)
    val to = maxOf(safeAnchor, safeHead)
    return applyCommentToggle(text, safeAnchor, safeHead, from, to, insideEmpty = true)
}

private fun applyCommentToggle(
    text: String,
    safeAnchor: Int,
    safeHead: Int,
    from: Int,
    to: Int,
    insideEmpty: Boolean,
): MarkdownEdit {
    val found = findBlockComment(text, from, to)
    val edits = if (found == null) {
        listOf(CommentEdit(from, from, "$OPEN "), CommentEdit(to, to, " $CLOSE"))
    } else {
        listOf(CommentEdit(found.openFrom, found.openTo, ""), CommentEdit(found.closeFrom, found.closeTo, ""))
    }
    val next = applyEdits(text, edits)
    val lower = minOf(safeAnchor, safeHead)
    val upper = maxOf(safeAnchor, safeHead)
    val inverted = safeAnchor > safeHead
    val (newLower, newUpper) = if (lower == upper && found == null && insideEmpty) {
        val between = lower + OPEN.length + 1
        between to between
    } else if (lower == upper) {
        val mapped = mapPos(lower, edits, -1)
        mapped to mapped
    } else {
        mapPos(lower, edits, 1) to mapPos(upper, edits, -1)
    }
    return MarkdownEdit(
        next,
        if (lower == upper || !inverted) newLower else newUpper,
        if (lower == upper || !inverted) newUpper else newLower,
    )
}

private const val OPEN = "<!--"
private const val CLOSE = "-->"
private const val SEARCH_MARGIN = 50

private data class CommentEdit(val from: Int, val to: Int, val insert: String)

private data class CommentMarks(val openFrom: Int, val openTo: Int, val closeFrom: Int, val closeTo: Int)

private data class CommentLine(val from: Int, val to: Int)

private fun commentLineRange(text: String, anchor: Int, head: Int): CommentLine {
    val start = minOf(anchor, head)
    val end = maxOf(anchor, head)
    val fromLine = lineAt(text, start)
    var toLine = if (end <= fromLine.to) fromLine else lineAt(text, end)
    if (toLine.from > fromLine.from && toLine.from == end) {
        toLine = if (end == fromLine.to + 1) fromLine else lineAt(text, end - 1)
    }
    val indent = leadingWhitespace(text.substring(fromLine.from, fromLine.to))
    return CommentLine(fromLine.from + indent, toLine.to)
}

private fun findBlockComment(text: String, from: Int, to: Int): CommentMarks? {
    val textBefore = text.substring((from - SEARCH_MARGIN).coerceAtLeast(0), from)
    val textAfter = text.substring(to, (to + SEARCH_MARGIN).coerceAtMost(text.length))
    val spaceBefore = trailingWhitespace(textBefore)
    val spaceAfter = leadingWhitespace(textAfter)
    val beforeOff = textBefore.length - spaceBefore
    if (beforeOff >= OPEN.length &&
        textBefore.substring(beforeOff - OPEN.length, beforeOff) == OPEN &&
        textAfter.length >= spaceAfter + CLOSE.length &&
        textAfter.substring(spaceAfter, spaceAfter + CLOSE.length) == CLOSE
    ) {
        val openPos = from - spaceBefore
        val closePos = to + spaceAfter
        val openMargin = if (spaceBefore > 0) 1 else 0
        val closeMargin = if (spaceAfter > 0) 1 else 0
        return CommentMarks(openPos - OPEN.length, openPos + openMargin, closePos - closeMargin, closePos + CLOSE.length)
    }
    val startText: String
    val endText: String
    if (to - from <= 2 * SEARCH_MARGIN) {
        startText = text.substring(from, to)
        endText = startText
    } else {
        startText = text.substring(from, from + SEARCH_MARGIN)
        endText = text.substring(to - SEARCH_MARGIN, to)
    }
    val startSpace = leadingWhitespace(startText)
    val endSpace = trailingWhitespace(endText)
    val endOff = endText.length - endSpace - CLOSE.length
    if (startSpace + OPEN.length <= startText.length &&
        startText.substring(startSpace, startSpace + OPEN.length) == OPEN &&
        endOff >= 0 &&
        endText.substring(endOff, endOff + CLOSE.length) == CLOSE
    ) {
        val openMargin = if (startSpace + OPEN.length < startText.length && startText[startSpace + OPEN.length].isWhitespace()) 1 else 0
        val closeMargin = if (endOff > 0 && endText[endOff - 1].isWhitespace()) 1 else 0
        val openPos = from + startSpace + OPEN.length
        val closePos = to - endSpace - CLOSE.length
        return CommentMarks(openPos - OPEN.length, openPos + openMargin, closePos - closeMargin, closePos + CLOSE.length)
    }
    return null
}

private fun lineAt(text: String, pos: Int): CommentLine {
    val safe = pos.coerceIn(0, text.length)
    val from = if (safe == 0) 0 else {
        val newline = text.lastIndexOf('\n', safe - 1)
        if (newline < 0) 0 else newline + 1
    }
    val newline = text.indexOf('\n', from)
    return CommentLine(from, if (newline < 0) text.length else newline)
}

private fun leadingWhitespace(value: String): Int {
    var index = 0
    while (index < value.length && value[index].isWhitespace()) index++
    return index
}

private fun trailingWhitespace(value: String): Int {
    var index = value.length
    while (index > 0 && value[index - 1].isWhitespace()) index--
    return value.length - index
}

private fun applyEdits(text: String, edits: List<CommentEdit>): String {
    var next = text
    val ordered = edits.withIndex().sortedWith(
        compareByDescending<IndexedValue<CommentEdit>> { it.value.from }.thenByDescending { it.index },
    )
    for (edit in ordered) {
        next = next.substring(0, edit.value.from) + edit.value.insert + next.substring(edit.value.to)
    }
    return next
}

private fun mapPos(pos: Int, edits: List<CommentEdit>, assoc: Int): Int {
    var extra = 0
    for (edit in edits.sortedBy { it.from }) {
        val start = edit.from
        val end = edit.to
        val inserted = edit.insert.length
        if (pos < start) break
        if (start == end) {
            if (pos > start) extra += inserted
            else extra += if (assoc < 0) 0 else inserted
        } else if (pos == start) {
            continue
        } else if (pos < end) {
            return start + inserted + extra
        } else {
            extra += inserted - (end - start)
        }
    }
    return pos + extra
}
