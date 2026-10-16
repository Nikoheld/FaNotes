package ch.fasrv.fanotes.desk

import kotlin.math.floor
import kotlin.math.min

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

/** Small prompts after the later dialog pass: 12px card, min(440px, viewport − 32px). */
const val PROMPT_MAX_DP = 440
const val PROMPT_INSET_DP = 16
const val PROMPT_RADIUS_DP = 12
const val PROMPT_PAD_DP = 16
const val PROMPT_GAP_DP = 10
const val PROMPT_TITLE_SP = 16
const val PROMPT_FIELD_RADIUS_DP = 8
const val PROMPT_FIELD_PAD_X_DP = 8
const val PROMPT_FIELD_PAD_Y_DP = 6
const val PROMPT_BUTTON_DP = 31
const val PROMPT_BUTTON_RADIUS_DP = 6
const val PROMPT_ROW_DP = 34
const val PROMPT_ROW_RADIUS_DP = 8
const val GOTO_PLACEHOLDER = "12, +3, 50%, 8:4"
const val PROMPT_CANCEL = "Abbrechen"
const val PROMPT_GO = "Gehe"
const val PROMPT_MOVE = "Verschieben"
const val PROMPT_ROOT = "Vault-Wurzel"
const val PROMPT_NO_FOLDER = "Es gibt noch keinen anderen Ordner."

fun promptWidthDp(windowWidthDp: Int): Int = min(PROMPT_MAX_DP, (windowWidthDp - PROMPT_INSET_DP * 2).coerceAtLeast(0))
