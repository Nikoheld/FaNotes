package ch.fasrv.fanotes.desk

import kotlin.math.floor

/** Where CodeMirror's go-to-line dialog puts the cursor. Lines are 1-based. */
data class GotoLineCursor(val line: Int, val column: Int, val offset: Int)

/**
 * Parses the desktop go-to-line field.
 * A line number, a `+` or `-` offset from [currentLine], a `%` of the document,
 * and an optional `:column`. Returns null when the text is not that pattern.
 * [currentLine] is 1-based. The column is clamped to the target line.
 */
fun gotoLineCursor(markdown: String, input: String, currentLine: Int): GotoLineCursor? {
    val match = GOTO_LINE.matchEntire(input) ?: return null
    val sign = match.groupValues[1]
    val digits = match.groupValues[2]
    val columnPart = match.groupValues[3]
    val percent = match.groupValues[4]
    val text = markdown.replace("\r\n", "\n").replace('\r', '\n')
    val lines = markdownLineCount(text)
    val start = currentLine.coerceIn(1, lines).toLong()
    val typed = if (digits.isEmpty()) null else digits.toLongOrNull()?.coerceAtLeast(0)
    if (digits.isNotEmpty() && typed == null) return null
    var line = typed ?: start
    if (typed != null && percent.isNotEmpty()) {
        var fraction = line / 100.0
        if (sign.isNotEmpty()) {
            fraction = fraction * (if (sign == "-") -1.0 else 1.0) + (start.toDouble() / lines)
        }
        line = jsRound(lines * fraction).toLong()
    } else if (typed != null && sign.isNotEmpty()) {
        line = line * (if (sign == "-") -1 else 1) + start
    }
    val clamped = line.coerceIn(1, lines.toLong()).toInt()
    val startOffset = revealLineStart(text, clamped)
    val lineLength = text.substring(startOffset).substringBefore('\n').length
    val column = if (columnPart.isEmpty()) 0 else columnPart.drop(1).toLongOrNull()?.coerceIn(0, lineLength.toLong())?.toInt() ?: 0
    return GotoLineCursor(clamped, column, startOffset + column)
}

/** 1-based line at a character offset. A trailing newline counts as its own line. */
fun lineNumberAt(markdown: String, offset: Int): Int {
    val text = markdown.replace("\r\n", "\n").replace('\r', '\n')
    val clamped = offset.coerceIn(0, text.length)
    return text.substring(0, clamped).count { it == '\n' } + 1
}

fun markdownLineCount(markdown: String): Int {
    val text = markdown.replace("\r\n", "\n").replace('\r', '\n')
    return text.count { it == '\n' } + 1
}

/** JavaScript `Math.round`: halves go toward +∞. */
private fun jsRound(value: Double): Int {
    if (value.isNaN()) return 0
    if (value >= Int.MAX_VALUE) return Int.MAX_VALUE
    if (value <= Int.MIN_VALUE) return Int.MIN_VALUE
    return floor(value + 0.5).toInt()
}

private val GOTO_LINE = Regex("""^([+-])?(\d+)?(:\d+)?(%)?$""")
