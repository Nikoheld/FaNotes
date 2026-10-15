package ch.fasrv.fanotes.desk

/**
 * Washes from the desktop editor theme in `MarkdownEditor.tsx`.
 * The active line mixes the accent at 5% over transparency, and the
 * selection mixes it at 28%. The gutter stays clear.
 */
fun activeLineArgb(accent: Int): Int = accentWash(accent, 5)

fun selectionWashArgb(accent: Int): Int = accentWash(accent, 28)

/**
 * CodeMirror highlights the visual line of the selection head.
 * Android keeps that head in `selectionEnd`, which can sit before the anchor.
 */
fun activeLineHead(head: Int, length: Int): Int {
    if (length <= 0) return 0
    return head.coerceIn(0, length)
}

private fun accentWash(accent: Int, percent: Int): Int {
    val alpha = (255 * percent + 50) / 100
    return (alpha.coerceIn(0, 255) shl 24) or (accent and 0x00FFFFFF)
}
