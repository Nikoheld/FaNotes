package ch.fasrv.fanotes.desk

/** Swatches from the desktop appearance settings. */
val ACCENT_COLORS = listOf("#2a6f97", "#6b7280", "#0f7b6c", "#d9730d", "#c4554d", "#9065b0", "#ba9b4a")

const val DEFAULT_ACCENT = "#2a6f97"
const val DEFAULT_ACCENT_SECONDARY = "#6b7280"

private val ACCENT_HEX = Regex("^#[0-9a-f]{6}$")

/** Desktop ink colours from `colorContrast.ts`. */
const val ACCENT_DARK_INK = "#11131a"
const val ACCENT_LIGHT_INK = "#ffffff"

fun parseAccent(raw: String?): String? {
    val value = raw?.trim()?.lowercase().orEmpty()
    return value.takeIf { ACCENT_HEX.matches(it) }
}

fun normalizeAccent(raw: String?): String = parseAccent(raw) ?: DEFAULT_ACCENT

fun normalizeAccentSecondary(raw: String?): String = parseAccent(raw) ?: DEFAULT_ACCENT_SECONDARY

/**
 * True when `#11131a` has at least as much contrast on this accent as white.
 * Same choice as desktop `bestContrastText`.
 */
fun accentNeedsDarkText(raw: String?): Boolean {
    val surface = normalizeAccent(raw)
    return contrastRatio(ACCENT_DARK_INK, surface) >= contrastRatio(ACCENT_LIGHT_INK, surface)
}

fun accentInk(raw: String?): String = if (accentNeedsDarkText(raw)) ACCENT_DARK_INK else ACCENT_LIGHT_INK

/** Paper sheet colours from `.unified-paper` in the desktop stylesheet. */
val PAPER_CONTRAST_SURFACES = listOf("#ffffff", "#f7f7fa")

/**
 * Desktop `ensureReadableColor`. A colour that is already readable on every
 * surface stays as it is. Otherwise it is mixed toward the ink that contrasts
 * best, one percent at a time, until the contrast reaches 4.5.
 */
fun ensureReadableColor(foreground: String, backgrounds: List<String>, target: Double = 4.5): String {
    if (backgrounds.isEmpty()) return foreground
    fun minimum(candidate: String) = backgrounds.minOf { contrastRatio(candidate, it) }
    if (minimum(foreground) >= target) return foreground
    val destination = if (minimum(ACCENT_DARK_INK) >= minimum(ACCENT_LIGHT_INK)) ACCENT_DARK_INK else ACCENT_LIGHT_INK
    for (step in 1..100) {
        val candidate = mixHex(foreground, destination, step / 100.0)
        if (minimum(candidate) >= target) return candidate
    }
    return destination
}

/** Accent used for rules and links on the white paper sheet. */
fun paperAccentReadable(raw: String?): String = ensureReadableColor(normalizeAccent(raw), PAPER_CONTRAST_SURFACES)

/** Paper body text from `.unified-paper --text`. */
const val PAPER_TEXT = "#252630"

/** Paper chip fill from `.unified-paper --bg-elevated`. */
const val PAPER_CODE_BACKGROUND = 0xFFF3F4F7.toInt()

/**
 * Inline code on the paper sheet: 78% of the readable accent mixed with the
 * paper text, matching `color-mix` in the desktop stylesheet.
 */
fun paperCodeInk(raw: String?): String = mixColors(paperAccentReadable(raw), PAPER_TEXT, 0.78)

/** Table row fill: 2.5% of the readable accent mixed into white. */
fun paperTableFill(raw: String?): String = mixColors(paperAccentReadable(raw), "#ffffff", 0.025)

/** Paper panel used for a folded details card, 76% of `--panel-strong` over white. */
const val PAPER_PANEL_STRONG = "#f1f2f6"

fun paperDetailsFill(): String = mixColors(PAPER_PANEL_STRONG, "#ffffff", 0.76)

/** Open summary band: 6% of the readable accent mixed into white. */
fun paperDetailsOpenFill(raw: String?): String = mixColors(paperAccentReadable(raw), "#ffffff", 0.06)

/** Display-math card: 4% of the readable accent mixed into white. */
fun paperMathFill(raw: String?): String = mixColors(paperAccentReadable(raw), "#ffffff", 0.04)

/** Display-math rule: 14% of the readable accent mixed into the paper border ink. */
fun paperMathBorder(raw: String?): String = mixColors(paperAccentReadable(raw), "#232633", 0.14)

fun paperTableFillArgb(accent: Int): Int = colorArgb(paperTableFill("#%06x".format(accent and 0xFFFFFF)))

fun paperMathFillArgb(accent: Int): Int = colorArgb(paperMathFill("#%06x".format(accent and 0xFFFFFF)))

fun paperDetailsFillArgb(): Int = colorArgb(paperDetailsFill())

fun paperDetailsOpenFillArgb(accent: Int): Int = colorArgb(paperDetailsOpenFill("#%06x".format(accent and 0xFFFFFF)))

fun paperMathBorderArgb(accent: Int): Int = colorArgb(paperMathBorder("#%06x".format(accent and 0xFFFFFF)))

fun paperCodeInkArgb(accent: Int): Int = colorArgb(paperCodeInk("#%06x".format(accent and 0xFFFFFF)))

/** Paper strong text is weight 750, a step above a normal bold. */
const val PAPER_STRONG_WEIGHT = 750

/**
 * Link underline on the paper: 38% of the readable accent over transparency,
 * which is that colour at 38% alpha. The line sits 3px below the baseline.
 */
fun paperLinkUnderlineArgb(color: Int): Int {
    val alpha = kotlin.math.round(255 * 0.38).toInt().coerceIn(0, 255)
    return (alpha shl 24) or (color and 0x00FFFFFF)
}

fun paperLinkUnderlineOffset(textSizePx: Float): Float {
    val base = if (textSizePx <= 0f) 16f else textSizePx
    return 3f * base / 16f
}

/** `firstWeight` of [first] and the rest of [second], in sRGB. */
fun mixColors(first: String, second: String, firstWeight: Double): String =
    mixHex(second, first, firstWeight.coerceIn(0.0, 1.0))

fun paperAccentReadableArgb(accent: Int): Int = colorArgb(paperAccentReadable("#%06x".format(accent and 0xFFFFFF)))

fun colorArgb(hex: String): Int = (0xFF000000.toInt()) or hex.removePrefix("#").toInt(16)

private fun channelLuminance(value: Int): Double {
    val channel = value / 255.0
    return if (channel <= 0.04045) channel / 12.92 else Math.pow((channel + 0.055) / 1.055, 2.4)
}

private fun relativeLuminance(color: String): Double {
    val hex = color.removePrefix("#").toInt(16)
    val red = (hex shr 16) and 255
    val green = (hex shr 8) and 255
    val blue = hex and 255
    return channelLuminance(red) * 0.2126 + channelLuminance(green) * 0.7152 + channelLuminance(blue) * 0.0722
}

private fun mixHex(first: String, second: String, amount: Double): String {
    val from = rgbChannels(first) ?: return first
    val to = rgbChannels(second) ?: return first
    val mixed = from.indices.map { index ->
        val value = from[index] + (to[index] - from[index]) * amount
        kotlin.math.floor(value.coerceIn(0.0, 255.0) + 0.5).toInt()
    }
    return "#%02x%02x%02x".format(mixed[0], mixed[1], mixed[2])
}

private fun rgbChannels(color: String): IntArray? {
    val hex = color.removePrefix("#")
    if (hex.length != 6) return null
    return intArrayOf(
        hex.substring(0, 2).toInt(16),
        hex.substring(2, 4).toInt(16),
        hex.substring(4, 6).toInt(16),
    )
}

private fun contrastRatio(first: String, second: String): Double {
    val lighter = maxOf(relativeLuminance(first), relativeLuminance(second))
    val darker = minOf(relativeLuminance(first), relativeLuminance(second))
    return (lighter + 0.05) / (darker + 0.05)
}
