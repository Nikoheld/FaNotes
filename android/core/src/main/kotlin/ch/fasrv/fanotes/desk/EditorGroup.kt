package ch.fasrv.fanotes.desk

/**
 * CodeMirror's group motion on Linux and Windows: Ctrl-Left and Ctrl-Right
 * move by a run of word characters, punctuation, or whitespace. A leading
 * space is skipped and the following group is taken with it. A non-empty
 * selection collapses to the edge in the direction of travel unless Shift
 * is holding the anchor.
 */
fun moveEditorGroup(text: String, head: Int, forward: Boolean): Int {
    val pos = head.coerceIn(0, text.length)
    val first = adjacentCluster(text, pos, forward) ?: return pos
    var cursor = first.end
    var category = editorCharCategory(first.text)
    while (true) {
        val next = adjacentCluster(text, cursor, forward) ?: return cursor
        var nextCategory = editorCharCategory(next.text)
        if (category == EditorCharCategory.SPACE) category = nextCategory
        if (category != nextCategory) return cursor
        cursor = next.end
    }
}

/**
 * Where Ctrl-Left, Ctrl-Right, and their Shift variants leave the selection.
 * [anchor] stays put when [extend] is set. Otherwise a range collapses.
 */
fun editorGroupSelection(
    text: String,
    anchor: Int,
    head: Int,
    forward: Boolean,
    extend: Boolean,
): Pair<Int, Int> {
    val safeAnchor = anchor.coerceIn(0, text.length)
    val safeHead = head.coerceIn(0, text.length)
    if (!extend && safeAnchor != safeHead) {
        val edge = if (forward) maxOf(safeAnchor, safeHead) else minOf(safeAnchor, safeHead)
        return edge to edge
    }
    val next = moveEditorGroup(text, safeHead, forward)
    return if (extend) safeAnchor to next else next to next
}

/**
 * Ctrl-Backspace and Ctrl-Delete. A single space in front of a group is
 * deleted with that group. A longer run of spaces is its own group. A
 * selection is deleted as it stands.
 */
fun deleteEditorGroup(text: String, anchor: Int, head: Int, forward: Boolean): MarkdownEdit {
    val from = minOf(anchor, head).coerceIn(0, text.length)
    val to = maxOf(anchor, head).coerceIn(from, text.length)
    if (from != to) {
        return MarkdownEdit(text.removeRange(from, to), from, from)
    }
    val dest = deleteGroupOffset(text, from, forward)
    val start = minOf(from, dest)
    val end = maxOf(from, dest)
    if (start == end) return MarkdownEdit(text, from, from)
    return MarkdownEdit(text.removeRange(start, end), start, start)
}

private enum class EditorCharCategory { WORD, SPACE, OTHER }

private fun editorCharCategory(cluster: String): EditorCharCategory {
    if (cluster.isEmpty() || cluster.all { it.isWhitespace() }) return EditorCharCategory.SPACE
    var index = 0
    while (index < cluster.length) {
        val code = cluster.codePointAt(index)
        if (code == '_'.code || Character.isLetter(code) || Character.isDigit(code)) return EditorCharCategory.WORD
        index += Character.charCount(code)
    }
    return EditorCharCategory.OTHER
}

private data class Cluster(val text: String, val end: Int)

private fun adjacentCluster(text: String, pos: Int, forward: Boolean): Cluster? {
    if (forward) {
        if (pos >= text.length) return null
        val count = Character.charCount(text.codePointAt(pos))
        val end = (pos + count).coerceAtMost(text.length)
        return Cluster(text.substring(pos, end), end)
    }
    if (pos <= 0) return null
    val start = Character.offsetByCodePoints(text, pos, -1)
    return Cluster(text.substring(start, pos), start)
}

private fun deleteGroupOffset(text: String, head: Int, forward: Boolean): Int {
    var pos = head.coerceIn(0, text.length)
    var category: EditorCharCategory? = null
    while (true) {
        val boundary = if (forward) lineContentEnd(text, pos) else lineContentStart(text, pos)
        if (pos == boundary) {
            if (pos == head) {
                if (forward && pos < text.length) pos += 1
                else if (!forward && pos > 0) pos -= 1
            }
            break
        }
        val next = adjacentCluster(text, pos, forward) ?: break
        val nextCategory = editorCharCategory(next.text)
        if (category != null && nextCategory != category) break
        if (next.text != " " || pos != head) category = nextCategory
        pos = next.end
    }
    return pos
}

/**
 * Home and End from the desktop keymap. End goes to the line's last character.
 * Home stops at the end of the indent, and a second press goes to column 0.
 * Shift keeps the anchor.
 */
fun editorLineBoundarySelection(
    text: String,
    anchor: Int,
    head: Int,
    forward: Boolean,
    extend: Boolean,
): Pair<Int, Int> {
    val safeAnchor = anchor.coerceIn(0, text.length)
    val safeHead = head.coerceIn(0, text.length)
    val next = lineBoundaryOffset(text, safeHead, forward)
    return if (extend) safeAnchor to next else next to next
}

/**
 * Ctrl-Home and Ctrl-End. The caret goes to the start or the end of the note.
 * Shift keeps the anchor. A selection without Shift is replaced by that caret.
 */
fun editorDocumentSelection(text: String, anchor: Int, forward: Boolean, extend: Boolean): Pair<Int, Int> {
    val dest = if (forward) text.length else 0
    val safeAnchor = anchor.coerceIn(0, text.length)
    return if (extend) safeAnchor to dest else dest to dest
}

/** How many editor lines fit in the visible page. At least one. */
fun editorPageLineCount(viewportPx: Int, lineHeightPx: Int): Int {
    if (lineHeightPx <= 0) return 1
    return (viewportPx / lineHeightPx).coerceAtLeast(1)
}

/**
 * Page Up and Page Down. The caret moves that many lines and keeps its column.
 * A selection without Shift collapses to the edge in the direction of travel.
 */
fun editorPageSelection(
    text: String,
    anchor: Int,
    head: Int,
    forward: Boolean,
    extend: Boolean,
    lines: Int,
): Pair<Int, Int> {
    val safeAnchor = anchor.coerceIn(0, text.length)
    val safeHead = head.coerceIn(0, text.length)
    if (!extend && safeAnchor != safeHead) {
        val edge = if (forward) maxOf(safeAnchor, safeHead) else minOf(safeAnchor, safeHead)
        return edge to edge
    }
    val next = pageOffset(text, safeHead, forward, lines.coerceAtLeast(1))
    return if (extend) safeAnchor to next else next to next
}

private fun pageOffset(text: String, head: Int, forward: Boolean, lines: Int): Int {
    val pos = head.coerceIn(0, text.length)
    var lineStart = lineContentStart(text, pos)
    val column = pos - lineStart
    var remaining = lines
    if (forward) {
        while (remaining > 0) {
            val end = lineContentEnd(text, lineStart)
            if (end >= text.length) break
            lineStart = end + 1
            remaining -= 1
        }
    } else {
        while (remaining > 0 && lineStart > 0) {
            lineStart = lineContentStart(text, lineStart - 1)
            remaining -= 1
        }
    }
    val end = lineContentEnd(text, lineStart)
    return lineStart + column.coerceAtMost((end - lineStart).coerceAtLeast(0))
}

private fun lineBoundaryOffset(text: String, head: Int, forward: Boolean): Int {
    val pos = head.coerceIn(0, text.length)
    val start = lineContentStart(text, pos)
    val end = lineContentEnd(text, pos)
    if (forward) return end
    if (pos == start) return start
    var indent = start
    while (indent < end && (text[indent] == ' ' || text[indent] == '\t')) indent += 1
    return if (indent != start && pos != indent) indent else start
}

private fun lineContentStart(text: String, pos: Int): Int {
    val at = pos.coerceIn(0, text.length)
    if (at == 0) return 0
    val breakAt = text.lastIndexOf('\n', at - 1)
    return if (breakAt < 0) 0 else breakAt + 1
}

private fun lineContentEnd(text: String, pos: Int): Int {
    val at = pos.coerceIn(0, text.length)
    val breakAt = text.indexOf('\n', at)
    return if (breakAt < 0) text.length else breakAt
}
