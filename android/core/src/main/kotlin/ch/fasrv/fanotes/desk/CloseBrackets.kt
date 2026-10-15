package ch.fasrv.fanotes.desk

/**
 * Typing `(`, `[`, `{`, `'`, or `"` inserts the closing partner, matching the
 * desktop editor (`closeBrackets`). A closing character typed in front of one
 * this just inserted moves past it. Backspace directly between a pair removes
 * both characters.
 *
 * Null means the typed change should stay as it is.
 */
data class BracketEdit(
    val text: String,
    val selectionStart: Int,
    val selectionEnd: Int,
    val closedAt: Set<Int>,
)

fun bracketTyping(
    before: String,
    start: Int,
    deleted: Int,
    after: String,
    closedAt: Set<Int>,
): BracketEdit? {
    if (start < 0 || deleted < 0 || start > before.length || start + deleted > before.length) return null
    val insertedLen = after.length - before.length + deleted
    if (insertedLen < 0 || start + insertedLen > after.length) return null
    if (after.substring(0, start) != before.substring(0, start)) return null
    if (after.substring(start + insertedLen) != before.substring(start + deleted)) return null
    val inserted = after.substring(start, start + insertedLen)

    if (deleted == 1 && insertedLen == 0) {
        val removed = before[start]
        val next = before.getOrNull(start + 1) ?: return null
        if (isOpener(removed) && next == closeOf(removed)) {
            val text = before.removeRange(start, start + 2)
            return BracketEdit(text, start, start, onLine(text, start, shiftClosedBrackets(closedAt, start, 2, 0)))
        }
        return null
    }
    if (insertedLen != 1) return null
    val typed = inserted[0]
    if (deleted == 0 && start in closedAt && before.getOrNull(start) == typed) {
        return BracketEdit(before, start + 1, start + 1, onLine(before, start + 1, closedAt - start))
    }
    if (!isOpener(typed)) return null
    if (deleted > 0) {
        val body = before.substring(start, start + deleted)
        val close = closeOf(typed)
        val text = before.substring(0, start) + typed + body + close + before.substring(start + deleted)
        val selectionStart = start + 1
        val selectionEnd = start + 1 + body.length
        val shifted = shiftClosedBrackets(closedAt, start, deleted, body.length + 2)
        return BracketEdit(text, selectionStart, selectionEnd, onLine(text, selectionStart, shifted + selectionEnd))
    }
    if (typed == '\'' || typed == '"') {
        if (!canStartQuote(before, start) || probablyInString(before, start, typed)) return null
        val next = before.getOrNull(start)
        if (next != null && isWord(next)) return null
    } else {
        val next = before.getOrNull(start)
        if (next != null && !next.isWhitespace() && next !in CLOSE_BEFORE) return null
    }
    val close = closeOf(typed)
    val text = before.substring(0, start) + typed + close + before.substring(start)
    val cursor = start + 1
    val shifted = shiftClosedBrackets(closedAt, start, 0, 2)
    return BracketEdit(text, cursor, cursor, onLine(text, cursor, shifted + cursor))
}

fun bracketsOnCursorLine(text: String, cursor: Int, positions: Set<Int>): Set<Int> =
    onLine(text, cursor.coerceIn(0, text.length), positions)

fun shiftClosedBrackets(closedAt: Set<Int>, start: Int, deleted: Int, inserted: Int): Set<Int> {
    val end = start + deleted
    return closedAt.mapNotNullTo(linkedSetOf()) { pos ->
        when {
            pos < start -> pos
            pos >= end -> pos - deleted + inserted
            else -> null
        }
    }
}

private const val CLOSE_BEFORE = ")]}:;>"

private fun isOpener(ch: Char) = ch == '(' || ch == '[' || ch == '{' || ch == '\'' || ch == '"'

private fun closeOf(open: Char) = when (open) {
    '(' -> ')'
    '[' -> ']'
    '{' -> '}'
    else -> open
}

private fun isWord(ch: Char) = ch.isLetterOrDigit() || ch == '_'

private fun canStartQuote(text: String, cursor: Int): Boolean {
    if (cursor <= 0) return true
    val previous = text[cursor - 1]
    return previous == '\n' || !isWord(previous)
}

private fun probablyInString(text: String, cursor: Int, quote: Char): Boolean {
    val lineStart = if (cursor <= 0) 0 else {
        val newline = text.lastIndexOf('\n', cursor - 1)
        if (newline < 0) 0 else newline + 1
    }
    var count = 0
    var index = lineStart
    while (index < cursor && index < text.length) {
        if (text[index] == '\\') {
            index += 2
            continue
        }
        if (text[index] == quote) count++
        index++
    }
    return count % 2 == 1
}

private fun onLine(text: String, cursor: Int, positions: Set<Int>): Set<Int> {
    val from = if (cursor <= 0) 0 else {
        val newline = text.lastIndexOf('\n', (cursor - 1).coerceAtMost(text.length - 1).coerceAtLeast(0))
        if (newline < 0) 0 else newline + 1
    }
    val newline = text.indexOf('\n', from.coerceAtMost(text.length))
    val to = if (newline < 0) text.length else newline
    return positions.filterTo(linkedSetOf()) { it in from until to }
}
