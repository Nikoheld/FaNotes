package ch.fasrv.fanotes.ink

/**
 * Pen tool memory, after `fanotes/src/lib/toolMemory.ts` and the desktop art preferences: the writing
 * pen (Schreiben) and the drawing pen (Zeichnen) keep their own brush, colour, width, ink and
 * opacity, so switching modes restores each. Recent custom colours ride along. Stored in the desk
 * setting `tool-memory` as one short line.
 */
const val INK_MODE_WRITING = "writing"
const val INK_MODE_DRAWING = "drawing"
const val TOOL_MEMORY_RECENT_MAX = 8

/** Desktop `loadArtPreferences` fallback: fineliner, blue, 3 px. */
val DEFAULT_DRAWING_STYLE = StrokeStyle(
    color = "#3478df",
    baseWidth = 3.0,
    pressureEnabled = false,
    brush = "fineliner",
    opacity = null,
    colorEffect = "solid",
    purpose = "art",
)

/** Desktop pen palette sliders: writing 1–18 px, drawing 0.75–42 px. */
const val WRITING_WIDTH_MIN = 1.0
const val WRITING_WIDTH_MAX = 18.0
const val DRAWING_WIDTH_MIN = 0.75
const val DRAWING_WIDTH_MAX = 42.0
const val DRAWING_OPACITY_MIN = 0.12

data class InkToolMemory(
    val inkMode: String = INK_MODE_WRITING,
    /** Null until the writing pen was changed here: the desk pen settings stay in charge. */
    val writing: StrokeStyle? = null,
    val drawing: StrokeStyle = DEFAULT_DRAWING_STYLE,
    val recentColors: List<String> = emptyList(),
) {
    val drawingMode: Boolean get() = inkMode == INK_MODE_DRAWING
}

private val HEX = Regex("#[0-9a-f]{6}")

/** Lower-case `#rrggbb`, or null for anything else. `#abc` and `abcdef` are accepted. */
fun normalizeInkHex(raw: String?): String? {
    val text = raw?.trim()?.lowercase() ?: return null
    val body = text.removePrefix("#")
    val full = when {
        body.length == 3 && body.all { it.isDigit() || it in 'a'..'f' } -> body.map { "$it$it" }.joinToString("")
        else -> body
    }
    val hex = "#$full"
    return if (HEX.matches(hex)) hex else null
}

/** Clamps a style for its mode: writing keeps a solid handwriting stroke, drawing the desktop art ranges. */
fun sanitizeModeStyle(style: StrokeStyle, mode: String): StrokeStyle {
    val color = normalizeInkHex(style.color) ?: if (mode == INK_MODE_DRAWING) DEFAULT_DRAWING_STYLE.color else DEFAULT_PEN_COLOR
    val brush = artBrush(style.brush).id
    return if (mode == INK_MODE_DRAWING) {
        style.copy(
            color = color,
            brush = brush,
            baseWidth = style.baseWidth.takeIf { it.isFinite() }?.coerceIn(DRAWING_WIDTH_MIN, DRAWING_WIDTH_MAX) ?: DEFAULT_DRAWING_STYLE.baseWidth,
            opacity = style.opacity?.takeIf { it.isFinite() }?.coerceIn(DRAWING_OPACITY_MIN, 1.0),
            colorEffect = normalizeInkEffect(style.colorEffect),
            purpose = "art",
        )
    } else {
        style.copy(
            color = color,
            brush = brush,
            baseWidth = style.baseWidth.takeIf { it.isFinite() }?.coerceIn(WRITING_WIDTH_MIN, WRITING_WIDTH_MAX) ?: DEFAULT_PEN_WIDTH,
            opacity = null,
            colorEffect = "solid",
            purpose = "handwriting",
        )
    }
}

/** The current style is kept for the mode it was drawn in. */
fun InkToolMemory.remember(style: StrokeStyle): InkToolMemory =
    if (drawingMode) copy(drawing = sanitizeModeStyle(style, INK_MODE_DRAWING))
    else copy(writing = sanitizeModeStyle(style, INK_MODE_WRITING))

/**
 * Switches to [mode]: the style in use is remembered for the old mode, and the style to use next is
 * returned with the new memory. A writing pen never changed here keeps [current] (desk pen settings),
 * made solid handwriting.
 */
fun InkToolMemory.switchMode(mode: String, current: StrokeStyle): Pair<InkToolMemory, StrokeStyle> {
    val target = if (mode == INK_MODE_DRAWING) INK_MODE_DRAWING else INK_MODE_WRITING
    val kept = remember(current).copy(inkMode = target)
    val next = if (target == INK_MODE_DRAWING) kept.drawing else kept.writing ?: sanitizeModeStyle(current, INK_MODE_WRITING)
    return kept to next
}

/** Newest first, no duplicates, at most [TOOL_MEMORY_RECENT_MAX]. Invalid colours are ignored. */
fun pushRecentColor(recent: List<String>, color: String): List<String> {
    val hex = normalizeInkHex(color) ?: return recent
    return (listOf(hex) + recent.filter { it != hex }).take(TOOL_MEMORY_RECENT_MAX)
}

/** Picks a brush the way the desktop art panel does: its default width and pressure, same colour. */
fun styleWithBrush(style: StrokeStyle, brushId: String): StrokeStyle {
    val brush = artBrush(brushId)
    return style.copy(brush = brush.id, baseWidth = brush.defaultWidth, pressureEnabled = brush.pressure)
}

private fun encodeStyle(style: StrokeStyle): String = listOf(
    style.color,
    trimNumber(style.baseWidth),
    if (style.pressureEnabled) "1" else "0",
    style.brush,
    style.opacity?.let { trimNumber(it) }.orEmpty(),
    style.colorEffect,
).joinToString(",")

private fun decodeStyle(raw: String, mode: String): StrokeStyle? {
    val parts = raw.split(',')
    if (parts.size < 6) return null
    val width = parts[1].toDoubleOrNull() ?: return null
    val style = StrokeStyle(
        color = parts[0],
        baseWidth = width,
        pressureEnabled = parts[2] == "1",
        brush = parts[3],
        opacity = parts[4].toDoubleOrNull(),
        colorEffect = parts[5],
    )
    return sanitizeModeStyle(style, mode)
}

private fun trimNumber(value: Double): String {
    val rounded = Math.round(value * 100.0) / 100.0
    return if (rounded == Math.floor(rounded)) rounded.toLong().toString() else rounded.toString()
}

/** `v1|mode|w=…|d=…|r=#…;#…`. Fields are optional; unknown text decodes to the defaults. */
fun encodeToolMemory(memory: InkToolMemory): String = buildList {
    add("v1")
    add(memory.inkMode)
    memory.writing?.let { add("w=" + encodeStyle(it)) }
    add("d=" + encodeStyle(memory.drawing))
    if (memory.recentColors.isNotEmpty()) add("r=" + memory.recentColors.joinToString(";"))
}.joinToString("|")

fun decodeToolMemory(raw: String?): InkToolMemory {
    if (raw.isNullOrBlank()) return InkToolMemory()
    val parts = raw.split('|')
    if (parts.firstOrNull() != "v1") return InkToolMemory()
    var memory = InkToolMemory(inkMode = if (parts.getOrNull(1) == INK_MODE_DRAWING) INK_MODE_DRAWING else INK_MODE_WRITING)
    for (part in parts.drop(2)) {
        when {
            part.startsWith("w=") -> decodeStyle(part.substring(2), INK_MODE_WRITING)?.let { memory = memory.copy(writing = it) }
            part.startsWith("d=") -> decodeStyle(part.substring(2), INK_MODE_DRAWING)?.let { memory = memory.copy(drawing = it) }
            part.startsWith("r=") -> memory = memory.copy(
                recentColors = part.substring(2).split(';').mapNotNull { normalizeInkHex(it) }.distinct().take(TOOL_MEMORY_RECENT_MAX),
            )
        }
    }
    return memory
}
