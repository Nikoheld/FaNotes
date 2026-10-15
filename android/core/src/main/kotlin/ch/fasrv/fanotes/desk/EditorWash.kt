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

data class PaperMathBox(val radius: Float, val padX: Float, val padY: Float, val marginY: Float, val border: Float)

/**
 * Display-math card from the paper stylesheet: 10px corners, 1em by 1.25em
 * padding, and 0.75em of space above and below.
 */
fun paperMathBox(textSizePx: Float): PaperMathBox {
    val base = if (textSizePx <= 0f) 16f else textSizePx
    return PaperMathBox(
        radius = (10f * base / 16f).coerceAtLeast(1f),
        padX = base * 1.25f,
        padY = base,
        marginY = base * 0.75f,
        border = (base / 16f).coerceAtLeast(1f),
    )
}

data class PaperHeading(
    val scale: Float,
    val padTop: Float,
    val padBottom: Float,
    val letterSpacing: Float,
)

/**
 * Paper heading rhythm. Padding in the stylesheet is `em` of the heading's
 * own size, so a level-1 top pad of 0.5em is one body em. Tracking is -0.025em.
 */
fun paperHeading(level: Int, textSizePx: Float): PaperHeading {
    val base = if (textSizePx <= 0f) 16f else textSizePx
    val (scale, padTopEm, padBottomEm) = when (level) {
        1 -> Triple(2f, 0.5f, 0.28f)
        2 -> Triple(1.55f, 0.62f, 0f)
        3 -> Triple(1.28f, 0.45f, 0f)
        4 -> Triple(1.1f, 0.35f, 0f)
        else -> Triple(1f, 0.25f, 0f)
    }
    return PaperHeading(
        scale = scale,
        padTop = base * scale * padTopEm,
        padBottom = base * scale * padBottomEm,
        letterSpacing = -0.025f,
    )
}

data class PaperDetailsBox(
    val radius: Float,
    val marginY: Float,
    val padX: Float,
    val padY: Float,
    val border: Float,
)

/**
 * Folded details card from the paper stylesheet: 10px corners, 0.7em margin,
 * and summary padding of 0.72em by 0.9em.
 */
fun paperDetailsBox(textSizePx: Float): PaperDetailsBox {
    val base = if (textSizePx <= 0f) 16f else textSizePx
    return PaperDetailsBox(
        radius = (10f * base / 16f).coerceAtLeast(1f),
        marginY = base * 0.7f,
        padX = base * 0.9f,
        padY = base * 0.72f,
        border = (base / 16f).coerceAtLeast(1f),
    )
}

/**
 * A tap on the summary toggles the block. A tap on „Bearbeiten“, which sits
 * between the chevron and the title, opens the source instead.
 */
fun detailsTapAction(viewRight: Float, tapX: Float, textSizePx: Float): String {
    val base = if (textSizePx <= 0f) 16f else textSizePx
    val fromRight = viewRight - tapX
    val chevron = base * 2.2f
    val button = base * 4.6f
    if (fromRight <= chevron) return "toggle"
    if (fromRight <= chevron + button) return "edit"
    return "toggle"
}

/** Side padding of an inline formula, 0.14em. */
fun paperMathInlinePad(textSizePx: Float): Float {
    val base = if (textSizePx <= 0f) 16f else textSizePx
    return base * 0.14f
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
