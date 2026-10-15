package ch.fasrv.fanotes.desk

/**
 * Moves the caret to the bracket that matches the one beside it, the way
 * the desktop command `cursorMatchingBracket` does for `()[]{}`.
 * Null means there is no partner within the scan.
 */
fun matchingBracketJump(text: String, anchor: Int, head: Int): MarkdownEdit? {
    val cursor = head.coerceIn(0, text.length)
    val match = bracketMatchAt(text, cursor, -1)
        ?: bracketMatchAt(text, cursor, 1)
        ?: if (cursor > 0) bracketMatchAt(text, cursor - 1, 1) else null
        ?: if (cursor < text.length) bracketMatchAt(text, cursor + 1, -1) else null
    if (match == null) return null
    val landing = if (match.startFrom == cursor) match.endTo else match.endFrom
    return MarkdownEdit(text, landing.coerceIn(0, text.length), landing.coerceIn(0, text.length))
}

private const val BRACKETS = "()[]{}"
private const val MAX_SCAN = 10_000

private data class BracketSpan(val startFrom: Int, val startTo: Int, val endFrom: Int, val endTo: Int)

private fun bracketMatchAt(text: String, pos: Int, dir: Int): BracketSpan? {
    if (dir < 0 && pos <= 0) return null
    if (dir > 0 && pos >= text.length) return null
    val startIndex = if (dir < 0) pos - 1 else pos
    val bracket = BRACKETS.indexOf(text[startIndex])
    if (bracket < 0 || (bracket % 2 == 0) != (dir > 0)) return null
    var depth = 0
    var index = startIndex
    var distance = 0
    val limit = if (dir > 0) text.length else -1
    while (index != limit && distance <= MAX_SCAN) {
        val found = BRACKETS.indexOf(text[index])
        if (found >= 0) {
            if ((found % 2 == 0) == (dir > 0)) {
                depth++
            } else if (depth == 1) {
                return BracketSpan(startIndex, startIndex + 1, index, index + 1)
            } else {
                depth--
            }
        }
        index += dir
        distance++
    }
    return null
}
