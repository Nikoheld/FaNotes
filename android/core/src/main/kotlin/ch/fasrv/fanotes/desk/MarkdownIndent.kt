package ch.fasrv.fanotes.desk

/**
 * Tab and Shift-Tab for the note editor, matching the desktop keymap
 * (`indentMore` and `indentLess` with the default two-space indent).
 */
fun indentMarkdownLines(text: String, anchor: Int, head: Int, outdent: Boolean): MarkdownEdit {
    val safeAnchor = anchor.coerceIn(0, text.length)
    val safeHead = head.coerceIn(0, text.length)
    val from = minOf(safeAnchor, safeHead)
    val to = maxOf(safeAnchor, safeHead)
    val edits = ArrayList<SpanEdit>()
    for (lineFrom in selectedLineStarts(text, from, to)) {
        val lineTo = text.indexOf('\n', lineFrom).let { if (it < 0) text.length else it }
        if (!outdent) {
            edits += SpanEdit(lineFrom, lineFrom, INDENT)
            continue
        }
        val line = text.substring(lineFrom, lineTo)
        val spaceLen = line.indexOfFirst { !it.isWhitespace() }.let { if (it < 0) line.length else it }
        if (spaceLen == 0) continue
        val inserted = " ".repeat((countColumn(line.substring(0, spaceLen)) - INDENT_COLUMNS).coerceAtLeast(0))
        var keep = 0
        while (keep < spaceLen && keep < inserted.length && line[keep] == inserted[keep]) keep++
        val replacement = inserted.substring(keep)
        val editFrom = lineFrom + keep
        val editTo = lineFrom + spaceLen
        if (editFrom == editTo && replacement.isEmpty()) continue
        if (text.substring(editFrom, editTo) == replacement) continue
        edits += SpanEdit(editFrom, editTo, replacement)
    }
    if (edits.isEmpty()) return MarkdownEdit(text, safeAnchor, safeHead)
    return MarkdownEdit(applyEdits(text, edits), mapPos(safeAnchor, edits), mapPos(safeHead, edits))
}

private const val INDENT = "  "
private const val INDENT_COLUMNS = 2
private const val TAB_SIZE = 4

private data class SpanEdit(val from: Int, val to: Int, val insert: String)

private fun selectedLineStarts(text: String, from: Int, to: Int): List<Int> {
    if (text.isEmpty()) return listOf(0)
    val starts = mutableListOf<Int>()
    var pos = from.coerceIn(0, text.length)
    val end = to.coerceIn(0, text.length)
    while (true) {
        val lineFrom = if (pos == 0) 0 else {
            val newline = text.lastIndexOf('\n', pos - 1)
            if (newline < 0) 0 else newline + 1
        }
        val newline = text.indexOf('\n', pos)
        val include = from == to || end > lineFrom
        if (include) starts += lineFrom
        if (newline < 0) break
        pos = newline + 1
        if (pos > end) break
    }
    return starts
}

private fun countColumn(text: String): Int {
    var column = 0
    for (ch in text) {
        column += if (ch == '\t') TAB_SIZE - (column % TAB_SIZE) else 1
    }
    return column
}

private fun applyEdits(text: String, edits: List<SpanEdit>): String {
    var next = text
    for (edit in edits.sortedByDescending { it.from }) {
        next = next.substring(0, edit.from) + edit.insert + next.substring(edit.to)
    }
    return next
}

/** CodeMirror maps the caret with assoc 1, so it lands after an insertion at its position. */
private fun mapPos(pos: Int, edits: List<SpanEdit>): Int {
    var extra = 0
    for (edit in edits.sortedBy { it.from }) {
        val start = edit.from
        val end = edit.to
        val inserted = edit.insert.length
        if (pos < start) break
        if (start == end) {
            if (pos >= start) extra += inserted
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
