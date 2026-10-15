package ch.fasrv.fanotes.desk

/**
 * CodeMirror `simplifySelection` on a plain Escape.
 * A range collapses to the caret head, which Android stores in `selectionEnd`
 * (it can sit before the anchor). A caret returns null so the window can close
 * the topmost surface instead.
 */
fun simplifyEditorSelection(selectionStart: Int, selectionEnd: Int, length: Int): Int? {
    if (length < 0 || selectionStart < 0 || selectionEnd < 0) return null
    if (selectionStart == selectionEnd) return null
    return selectionEnd.coerceIn(0, length)
}
