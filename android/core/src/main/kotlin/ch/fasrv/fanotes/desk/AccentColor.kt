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

private fun contrastRatio(first: String, second: String): Double {
    val lighter = maxOf(relativeLuminance(first), relativeLuminance(second))
    val darker = minOf(relativeLuminance(first), relativeLuminance(second))
    return (lighter + 0.05) / (darker + 0.05)
}
