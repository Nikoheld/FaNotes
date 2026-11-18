package ch.fasrv.fanotes.desk

/**
 * Touch layer of the editor toolbar (pen and finger). The desktop pixel constants in
 * `WorkspaceChrome.kt` stay pinned by their tests; these sit beside them.
 */
const val TOUCH_TARGET_DP = 48
/** Horizontal bar: a 48 dp target plus a 4 dp band above and below. */
const val TOUCH_TOOLBAR_DP = 56
/** Vertical rail width: room for an icon over a short label. */
const val TOUCH_RAIL_DP = 76
const val TOUCH_TOOL_ICON_DP = 22
const val TOUCH_TOOL_LABEL_SP = 10f
const val TOUCH_CHIP_TEXT_SP = 13f
const val TOUCH_SWATCH_DP = 30
const val TOUCH_GAP_DP = 4
const val TOUCH_GROUP_GAP_DP = 10
/** Floating cards (Zeichenstudio, width, figures): wide enough for four 64 dp brush tiles per row. */
const val TOUCH_PANEL_WIDTH_DP = 400
const val TOUCH_PANEL_RADIUS_DP = 16

/** Desktop setting `toolbarPosition`: "top" (horizontal) or "side" (vertical, left). Android adds "side-right". */
enum class ToolbarPosition(val id: String, val label: String) {
    TOP("top", "Oben (horizontal)"),
    SIDE("side", "Seitlich (vertikal)"),
    SIDE_RIGHT("side-right", "Rechts (vertikal)"),
    ;

    val vertical: Boolean get() = this != TOP
}

fun toolbarPosition(raw: String?): ToolbarPosition = ToolbarPosition.entries.firstOrNull { it.id == raw } ?: ToolbarPosition.TOP

/** Desk setting `pen-quick-hold`: a long press of the bare tip opens the quick menu (off by default). */
fun penQuickHoldEnabled(raw: String?): Boolean = raw == "on"

/**
 * Width presets offered beside the slider, per mode. Writing follows the desktop pen range (1–18),
 * drawing the art range (0.75–42).
 */
fun penWidthPresets(drawing: Boolean): List<Double> =
    if (drawing) listOf(2.0, 6.0, 12.0, 24.0) else listOf(1.5, 2.4, 4.0, 7.0)

/** Slider position 0..1000 for [value] in [min]..[max], and back. Keeps a plain SeekBar exact enough. */
fun widthToProgress(value: Double, min: Double, max: Double): Int =
    (((value - min) / (max - min)).coerceIn(0.0, 1.0) * 1000.0).toInt()

fun progressToWidth(progress: Int, min: Double, max: Double, step: Double): Double {
    val raw = min + (max - min) * progress.coerceIn(0, 1000) / 1000.0
    val snapped = Math.round(raw / step) * step
    return snapped.coerceIn(min, max)
}
