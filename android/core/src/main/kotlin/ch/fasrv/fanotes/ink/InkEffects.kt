package ch.fasrv.fanotes.ink

/**
 * Special inks from the desktop art panel. A non-solid effect is a page gradient,
 * the same stops as `SPECIAL_INKS` in DrawingBoard.
 */
data class InkEffect(val id: String, val label: String, val stops: List<Pair<Double, String>>)

val INK_EFFECTS = listOf(
    InkEffect("solid", "Einfarbig", emptyList()),
    InkEffect(
        "rainbow",
        "Regenbogen",
        listOf(0.0 to "#ff4d6d", 0.17 to "#ffb13b", 0.34 to "#e9e34a", 0.51 to "#48ce87", 0.68 to "#3aa8ff", 0.84 to "#815cff", 1.0 to "#e84dba"),
    ),
    InkEffect("aurora", "Aurora", listOf(0.0 to "#68f6ca", 0.34 to "#32b9ef", 0.68 to "#7968f4", 1.0 to "#e85bd2")),
    InkEffect("sunset", "Abendrot", listOf(0.0 to "#ffcf59", 0.36 to "#ff754e", 0.68 to "#d84dba", 1.0 to "#694ee8")),
    InkEffect("ocean", "Ozean", listOf(0.0 to "#62ead5", 0.36 to "#1eb6db", 0.7 to "#2671df", 1.0 to "#4036a9")),
    InkEffect("gold", "Gold", listOf(0.0 to "#7c5013", 0.24 to "#f7d779", 0.5 to "#b27620", 0.76 to "#fff0a8", 1.0 to "#8b5914")),
    InkEffect("silver", "Silber", listOf(0.0 to "#59616d", 0.24 to "#f5f7fb", 0.5 to "#8b929d", 0.76 to "#ffffff", 1.0 to "#626975")),
    InkEffect("neon", "Neon", listOf(0.0 to "#45ffe6", 0.34 to "#5e8bff", 0.68 to "#db55ff", 1.0 to "#ff4ba8")),
)

fun normalizeInkEffect(raw: String?): String = INK_EFFECTS.firstOrNull { it.id == raw }?.id ?: "solid"

fun inkEffectLabel(raw: String?): String = INK_EFFECTS.first { it.id == normalizeInkEffect(raw) }.label

fun nextInkEffect(raw: String?): String {
    val current = normalizeInkEffect(raw)
    val index = INK_EFFECTS.indexOfFirst { it.id == current }
    return INK_EFFECTS[(index + 1) % INK_EFFECTS.size].id
}

/** Positions and packed ARGB colors. Null means the stroke keeps its solid color. */
fun inkEffectGradient(raw: String?): Pair<FloatArray, IntArray>? {
    val effect = INK_EFFECTS.firstOrNull { it.id == raw } ?: return null
    if (effect.stops.isEmpty()) return null
    val positions = FloatArray(effect.stops.size) { effect.stops[it].first.toFloat() }
    val colors = IntArray(effect.stops.size) { inkHex(effect.stops[it].second) }
    return positions to colors
}

private fun inkHex(value: String): Int {
    val rgb = value.removePrefix("#").toInt(16)
    return (0xFF000000.toInt() or rgb)
}
