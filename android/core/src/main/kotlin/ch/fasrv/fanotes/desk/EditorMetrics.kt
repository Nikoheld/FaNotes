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
    val zoomSpeed: Int,
)

fun editorMetrics(settings: Map<String, String>): EditorMetrics = EditorMetrics(
    fontSizePx = clampInt(settings["editor-font"], 16, 12, 26),
    lineHeight = clampDouble(settings["line-height"], 1.72, 1.3, 2.2),
    contentWidthPx = clampInt(settings["content-width"], 820, 560, 1200),
    zoomMax = clampInt(settings["zoom-max"], 325, 50, 600) / 100.0,
    autosaveMs = clampInt(settings["autosave"], 750, 250, 3000).toLong(),
    zoomSpeed = clampViewZoomSpeed(settings["zoom-speed"]),
)

const val VIEW_ZOOM_SPEED_DEFAULT = 5

/** Desktop `clampViewZoomSpeed`: blank or zero falls back to 5, then 1–10. */
fun clampViewZoomSpeed(raw: String?): Int {
    val number = raw?.trim()?.toDoubleOrNull()
    val value = if (number == null || number == 0.0) VIEW_ZOOM_SPEED_DEFAULT.toDouble() else number
    return kotlin.math.floor(value + 0.5).toInt().coerceIn(1, 10)
}

/** Desktop `zoomSensitivityFromSpeed`. Level 5 is the previous wheel default. */
fun zoomSensitivityFromSpeed(speed: Int): Double {
    val level = speed.coerceIn(1, 10)
    return 0.28 + (level - 1) * (1.72 / 9.0)
}

/** Desktop `zoomStepFromSpeed`, rounded half away from zero the way `Math.round` does. */
fun zoomStepFromSpeed(speed: Int): Double {
    val raw = 0.12 * zoomSensitivityFromSpeed(speed)
    return kotlin.math.floor(raw * 1000.0 + 0.5) / 1000.0
}

/**
 * Two-finger pinch. Speed 5 keeps the zoom equal to the span ratio.
 * Slower and faster settings scale that exponent with the desktop sensitivity.
 */
fun pinchZoom(startZoom: Double, spanRatio: Double, speed: Int): Double {
    val ratio = spanRatio.coerceAtLeast(1e-4)
    val scale = zoomSensitivityFromSpeed(speed) / zoomSensitivityFromSpeed(VIEW_ZOOM_SPEED_DEFAULT)
    return startZoom * Math.pow(ratio, scale)
}

private fun clampInt(raw: String?, fallback: Int, min: Int, max: Int): Int {
    val value = raw?.toIntOrNull() ?: fallback
    return value.coerceIn(min, max)
}

private fun clampDouble(raw: String?, fallback: Double, min: Double, max: Double): Double {
    val value = raw?.toDoubleOrNull() ?: fallback
    return value.coerceIn(min, max)
}

data class PenSettings(
    val width: Double,
    val pressure: Boolean,
    val paper: String,
    val shapeSnap: Int,
    val scribble: Int,
    val smoothing: Double,
    val color: String,
)

fun penSettings(settings: Map<String, String>): PenSettings {
    val width = (settings["pen-width"]?.toDoubleOrNull() ?: 3.5).coerceIn(1.0, 18.0)
    val paper = settings["paper"]?.takeIf { ch.fasrv.fanotes.famd.isPaperStyle(it) } ?: "dots"
    val color = settings["pen-color"]?.trim()?.lowercase()?.takeIf { Regex("#[0-9a-f]{6}").matches(it) } ?: "#202333"
    return PenSettings(
        width = width,
        pressure = settings["pressure"] != "off",
        paper = paper,
        shapeSnap = (settings["shape-snap"]?.toIntOrNull() ?: 50).coerceIn(0, 100),
        scribble = (settings["scribble"]?.toIntOrNull() ?: 50).coerceIn(0, 100),
        smoothing = (settings["smoothing"]?.toDoubleOrNull() ?: 0.68).coerceIn(0.0, 1.0),
        color = color,
    )
}
