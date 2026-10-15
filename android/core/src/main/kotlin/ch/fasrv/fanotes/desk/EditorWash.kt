package ch.fasrv.fanotes.desk

/**
 * Washes from the desktop editor theme in `MarkdownEditor.tsx`.
 * The active line mixes the accent at 5% over transparency, and the
 * selection mixes it at 28%. The gutter stays clear.
 */
fun activeLineArgb(accent: Int): Int = accentWash(accent, 5)

fun selectionWashArgb(accent: Int): Int = accentWash(accent, 28)

/** Paper quote wash: the accent mixed at 7% over transparency. */
fun quoteWashArgb(accent: Int): Int = accentWash(accent, 7)

/** Paper quote ink from `.unified-paper --text-soft`. */
const val PAPER_QUOTE_INK = 0xFF555866.toInt()

/** `.unified-paper --border` at 14% opacity, used under a level-1 heading. */
const val PAPER_RULE_ARGB = 0x24232633

/** `.unified-paper --border-strong` at 25% opacity, the table rule's bottom edge. */
const val PAPER_RULE_STRONG_ARGB = 0x40232633

const val TABLE_PAD_PX = 10
const val TABLE_RULE_PX = 3

fun tablePadPx(textSizePx: Float): Int {
    val scale = if (textSizePx <= 0f) 1.0 else textSizePx / 16.0
    return kotlin.math.floor(TABLE_PAD_PX * scale + 0.5).toInt().coerceAtLeast(1)
}

fun tableRulePx(textSizePx: Float): Int {
    val scale = if (textSizePx <= 0f) 1.0 else textSizePx / 16.0
    return kotlin.math.floor(TABLE_RULE_PX * scale + 0.5).toInt().coerceAtLeast(1)
}

const val QUOTE_BAR_PX = 3
const val QUOTE_GAP_PX = 13

data class PaperCodeBox(val textPx: Float, val padX: Float, val padY: Float, val radius: Float, val border: Float)

/**
 * Inline code chip from the paper stylesheet: 0.9em type, 0.36em side
 * padding, 0.1em vertical padding, and a 5px corner.
 */
fun paperCodeBox(textSizePx: Float): PaperCodeBox {
    val base = if (textSizePx <= 0f) 16f else textSizePx
    val text = base * 0.9f
    return PaperCodeBox(
        textPx = text,
        padX = text * 0.36f,
        padY = text * 0.1f,
        radius = (5f * base / 16f).coerceAtLeast(1f),
        border = (base / 16f).coerceAtLeast(1f),
    )
}

/** Bar width and total leading margin for a quote, scaled with the editor font. */
fun quoteMargins(textSizePx: Float): Pair<Int, Int> {
    val scale = if (textSizePx <= 0f) 1.0 else textSizePx / 16.0
    val bar = kotlin.math.floor(QUOTE_BAR_PX * scale + 0.5).toInt().coerceAtLeast(1)
    val gap = kotlin.math.floor(QUOTE_GAP_PX * scale + 0.5).toInt()
    return bar to bar + gap
}

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
