package ch.fasrv.fanotes.desk

/**
 * Editor measures from the desktop settings: font size, line height, content
 * width, zoom cap, and autosave delay.
 */
data class EditorMetrics(
    val fontSizePx: Int,
    val lineHeight: Double,
    val contentWidthPx: Int,
    val zoomMax: Double,
    val autosaveMs: Long,
)

fun editorMetrics(settings: Map<String, String>): EditorMetrics = EditorMetrics(
    fontSizePx = clampInt(settings["editor-font"], 16, 12, 26),
    lineHeight = clampDouble(settings["line-height"], 1.72, 1.3, 2.2),
    contentWidthPx = clampInt(settings["content-width"], 820, 560, 1200),
    zoomMax = clampInt(settings["zoom-max"], 325, 50, 600) / 100.0,
    autosaveMs = clampInt(settings["autosave"], 750, 250, 3000).toLong(),
)

private fun clampInt(raw: String?, fallback: Int, min: Int, max: Int): Int {
    val value = raw?.toIntOrNull() ?: fallback
    return value.coerceIn(min, max)
}

private fun clampDouble(raw: String?, fallback: Double, min: Double, max: Double): Double {
    val value = raw?.toDoubleOrNull() ?: fallback
    return value.coerceIn(min, max)
}
