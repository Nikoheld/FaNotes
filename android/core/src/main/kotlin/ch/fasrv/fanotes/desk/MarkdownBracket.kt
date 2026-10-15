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

/**
 * The bracket beside a collapsed caret, and its partner when the scan finds one.
 * [matched] is false for a lone bracket or a pair of the wrong shape, which the
 * desktop paints with `cm-nonmatchingBracket`. A scan that stops at the distance
 * limit returns null, the same as CodeMirror's `matchBrackets`.
 */
data class BracketHighlight(val start: Int, val partner: Int?, val matched: Boolean)

/** `#328c8252` from the focused `.cm-matchingBracket` rule. */
const val MATCHING_BRACKET_ARGB = 0x52328C82

/** `#bb555544` from the focused `.cm-nonmatchingBracket` rule. */
const val NONMATCHING_BRACKET_ARGB = 0x44BB5555

fun bracketHighlight(text: String, cursor: Int): BracketHighlight? {
    val head = cursor.coerceIn(0, text.length)
    return bracketHighlightAt(text, head, -1)
        ?: (if (head > 0) bracketHighlightAt(text, head - 1, 1) else null)
        ?: bracketHighlightAt(text, head, 1)
        ?: (if (head < text.length) bracketHighlightAt(text, head + 1, -1) else null)
}

private fun bracketHighlightAt(text: String, pos: Int, dir: Int): BracketHighlight? {
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
                return BracketHighlight(startIndex, index, (found shr 1) == (bracket shr 1))
            } else {
                depth--
            }
        }
        index += dir
        distance++
    }
    return if (index == limit) BracketHighlight(startIndex, null, false) else null
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
