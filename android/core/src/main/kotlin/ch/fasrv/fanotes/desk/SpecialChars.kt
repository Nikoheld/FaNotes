package ch.fasrv.fanotes.desk

/**
 * A character CodeMirror's `highlightSpecialChars` replaces with a visible mark.
 * Newlines and tabs stay as themselves: the desktop highlighter walks each line,
 * and a browser that supports tab size leaves tabs alone.
 */
data class SpecialCharMark(val index: Int, val placeholder: String)

/** Light-theme `.cm-specialChar` is CSS `red`. */
const val SPECIAL_CHAR_ARGB = 0xFFFF0000.toInt()

fun specialCharMarks(text: String): List<SpecialCharMark> {
    if (text.isEmpty()) return emptyList()
    val marks = ArrayList<SpecialCharMark>()
    for (index in text.indices) {
        val code = text[index].code
        if (!isEditorSpecialChar(code)) continue
        marks += SpecialCharMark(index, specialCharPlaceholder(code))
    }
    return marks
}

internal fun isEditorSpecialChar(code: Int): Boolean {
    if (code == '\n'.code || code == '\t'.code) return false
    return code in 0x00..0x1F ||
        code in 0x7F..0x9F ||
        code == 0xAD ||
        code == 0x61C ||
        code == 0x200B ||
        code == 0x200E ||
        code == 0x200F ||
        code == 0x2028 ||
        code == 0x2029 ||
        code == 0x202D ||
        code == 0x202E ||
        code == 0x2066 ||
        code == 0x2067 ||
        code == 0x2069 ||
        code == 0xFEFF ||
        code in 0xFFF9..0xFFFC
}

internal fun specialCharPlaceholder(code: Int): String = when {
    code >= 32 -> "\u2022"
    code == 10 -> "\u2424"
    else -> (0x2400 + code).toChar().toString()
}
