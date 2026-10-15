package ch.fasrv.fanotes.desk

/**
 * The smallest single span that turns [current] into [next], matching the
 * desktop editor. The shared prefix and suffix stay put, so a cursor after
 * the edit keeps its place instead of being clamped to the new length.
 * A surrogate pair is never split.
 */
data class TextReplacement(val from: Int, val to: Int, val insert: String)

fun minimalReplacement(current: String, next: String): TextReplacement {
    val limit = minOf(current.length, next.length)
    var prefix = 0
    while (prefix < limit && current[prefix] == next[prefix]) prefix += 1
    if (prefix > 0 && prefix < limit && current[prefix].isLowSurrogate()) prefix -= 1
    var suffix = 0
    val suffixLimit = limit - prefix
    while (
        suffix < suffixLimit &&
        current[current.length - 1 - suffix] == next[next.length - 1 - suffix]
    ) suffix += 1
    if (suffix > 0 && suffix < suffixLimit && current[current.length - suffix].isHighSurrogate()) suffix -= 1
    return TextReplacement(prefix, current.length - suffix, next.substring(prefix, next.length - suffix))
}

/**
 * Maps one offset through a replacement the way CodeMirror does.
 * Offsets inside the replaced span land at the end of the insert.
 */
fun mapThroughReplacement(change: TextReplacement, position: Int): Int {
    if (position < change.from) return position
    if (position > change.to) return position + change.insert.length - (change.to - change.from)
    return change.from + change.insert.length
}

/** Both ends of a selection, kept inside the resulting text. */
fun mapSelectionThroughReplacement(
    current: String,
    next: String,
    selectionStart: Int,
    selectionEnd: Int,
): Pair<Int, Int> {
    val change = minimalReplacement(current, next)
    val start = mapThroughReplacement(change, selectionStart.coerceAtLeast(0)).coerceIn(0, next.length)
    val end = mapThroughReplacement(change, selectionEnd.coerceAtLeast(0)).coerceIn(0, next.length)
    return start to end
}
