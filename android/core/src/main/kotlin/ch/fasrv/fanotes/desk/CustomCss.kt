package ch.fasrv.fanotes.desk

/**
 * Desktop `sanitizeCustomCss` plus the theme tokens that stylesheet variables
 * actually change: colors, radius, sidebar, row height, and editor measures.
 */

private val DANGEROUS_CSS = Regex(
    """(?:@import|@charset|@namespace|@font-face|expression\s*\(|url\s*\(|-moz-binding|behavior\s*:|javascript\s*:|vbscript\s*:|</)""",
    RegexOption.IGNORE_CASE,
)
private val COMMENT = Regex("""/\*[\s\S]*?\*/""")
private val HEX_ESCAPE = Regex("""\\[0-9a-fA-F]{1,6}\s?""")
private val CUSTOM_PROPERTY = Regex("""--([a-z0-9-]+)\s*:\s*([^;{}]+)""", RegexOption.IGNORE_CASE)
private val HEX_COLOR = Regex("""^#([0-9a-f]{3}|[0-9a-f]{6})$""")
private val PX_LENGTH = Regex("""^(-?\d+(?:\.\d+)?)px$""")

const val CUSTOM_CSS_MAX = 100_000

fun sanitizeCustomCss(value: String?): String {
    if (value.isNullOrBlank()) return ""
    val normalized = value
        .replace(COMMENT, "")
        .replace(HEX_ESCAPE, "")
        .replace("\\", "")
    if (DANGEROUS_CSS.containsMatchIn(normalized)) return ""
    return if (value.length > CUSTOM_CSS_MAX) value.substring(0, CUSTOM_CSS_MAX) else value
}

data class CustomChrome(
    val accent: String? = null,
    val accentSecondary: String? = null,
    val background: String? = null,
    val surface: String? = null,
    val text: String? = null,
    val radiusDp: Int? = null,
    val sidebarDp: Int? = null,
    val contentWidthPx: Int? = null,
    val editorFontPx: Int? = null,
    val previewFontPx: Int? = null,
    val lineHeight: Double? = null,
    val rowHeightDp: Int? = null,
)

fun parseCustomChrome(css: String?): CustomChrome {
    val safe = sanitizeCustomCss(css)
    if (safe.isEmpty()) return CustomChrome()
    val source = safe.replace(COMMENT, "")
    var accent: String? = null
    var accentSecondary: String? = null
    var background: String? = null
    var surface: String? = null
    var text: String? = null
    var radiusDp: Int? = null
    var sidebarDp: Int? = null
    var contentWidthPx: Int? = null
    var editorFontPx: Int? = null
    var previewFontPx: Int? = null
    var lineHeight: Double? = null
    var rowHeightDp: Int? = null
    for (match in CUSTOM_PROPERTY.findAll(source)) {
        val name = match.groupValues[1].lowercase()
        val raw = match.groupValues[2].trim()
        if (raw.contains("var(")) continue
        when (name) {
            "accent" -> cssColor(raw)?.let { accent = it }
            "accent-secondary" -> cssColor(raw)?.let { accentSecondary = it }
            "bg", "background" -> cssColor(raw)?.let { background = it }
            "bg-elevated", "panel" -> cssColor(raw)?.let { surface = it }
            "text" -> cssColor(raw)?.let { text = it }
            "radius" -> cssPx(raw, 0, 40)?.let { radiusDp = it }
            "sidebar-width" -> cssPx(raw, 160, 520)?.let { sidebarDp = it }
            "content-width" -> cssPx(raw, 320, 1400)?.let { contentWidthPx = it }
            "editor-size" -> cssPx(raw, 10, 40)?.let { editorFontPx = it }
            "preview-size" -> cssPx(raw, 10, 40)?.let { previewFontPx = it }
            "line-height" -> cssNumber(raw, 1.0, 3.0)?.let { lineHeight = it }
            "row-height" -> cssPx(raw, 20, 48)?.let { rowHeightDp = it }
        }
    }
    return CustomChrome(
        accent, accentSecondary, background, surface, text, radiusDp, sidebarDp,
        contentWidthPx, editorFontPx, previewFontPx, lineHeight, rowHeightDp,
    )
}

/** Overlay the tokens the rest of the desk already reads. Colors for the shell stay on [CustomChrome]. */
fun deskWithCustomCss(settings: Map<String, String>, css: String?): Map<String, String> {
    val chrome = parseCustomChrome(css)
    if (chrome == CustomChrome()) return settings
    val next = settings.toMutableMap()
    chrome.accent?.let { next["accent"] = it }
    chrome.accentSecondary?.let { next["accent-secondary"] = it }
    chrome.editorFontPx?.let { next["editor-font"] = it.toString() }
    chrome.previewFontPx?.let { next["preview-font"] = it.toString() }
    chrome.contentWidthPx?.let { next["content-width"] = it.toString() }
    chrome.lineHeight?.let { next["line-height"] = trimNumber(it) }
    return next
}

private fun cssColor(raw: String): String? {
    val value = raw.trim().lowercase()
    val match = HEX_COLOR.matchEntire(value) ?: return null
    val hex = match.groupValues[1]
    if (hex.length == 6) return "#$hex"
    return "#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}"
}

private fun cssPx(raw: String, min: Int, max: Int): Int? {
    val match = PX_LENGTH.matchEntire(raw.trim().lowercase()) ?: return null
    val number = match.groupValues[1].toDoubleOrNull() ?: return null
    return kotlin.math.floor(number + 0.5).toInt().coerceIn(min, max)
}

private fun cssNumber(raw: String, min: Double, max: Double): Double? {
    val number = raw.trim().removeSuffix("px").trim().toDoubleOrNull() ?: return null
    return number.coerceIn(min, max)
}

private fun trimNumber(value: Double): String {
    val text = "%.2f".format(java.util.Locale.US, value)
    return text.trimEnd('0').trimEnd('.')
}
