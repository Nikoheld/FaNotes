package ch.fasrv.fanotes.recognition

import ch.fasrv.fanotes.ink.GlyphInk
import ch.fasrv.fanotes.ink.GlyphSample
import ch.fasrv.fanotes.ink.StrokePoint

/**
 * Characters the tablet's GlyphenWerk capture asks for, with the desktop catalog's label ids
 * (`src/data/catalog.ts`), so captured samples line up with samples imported from the desktop.
 */
data class GlyphLabel(val id: String, val char: String, val name: String, val category: String)

data class GlyphCategory(val id: String, val label: String, val shortLabel: String, val labels: List<GlyphLabel>)

private val MATH_CAPTURE = listOf(
    Triple("operator_plus", "+", "Plus"),
    Triple("operator_minus", "−", "Minus"),
    Triple("operator_multiply", "×", "Mal"),
    Triple("operator_dot", "·", "Malpunkt"),
    Triple("operator_divide", "÷", "Geteilt"),
    Triple("relation_equal", "=", "Gleich"),
    Triple("relation_less", "<", "Kleiner als"),
    Triple("relation_greater", ">", "Grösser als"),
    Triple("operator_sqrt", "√", "Wurzel"),
    Triple("operator_percent", "%", "Prozent"),
    Triple("operator_slash", "/", "Schrägstrich"),
    Triple("operator_caret", "^", "Hochzeichen"),
    Triple("decimal_point", ".", "Dezimalpunkt"),
    Triple("decimal_comma", ",", "Dezimalkomma"),
    Triple("punctuation_colon", ":", "Doppelpunkt"),
    Triple("punctuation_question", "?", "Fragezeichen"),
    Triple("operator_factorial", "!", "Fakultät"),
    Triple("bracket_left_round", "(", "Klammer links"),
    Triple("bracket_right_round", ")", "Klammer rechts"),
).map { (id, char, name) -> GlyphLabel(id, char, name, "math") }

val GLYPH_CATEGORIES: List<GlyphCategory> = listOf(
    GlyphCategory("lowercase", "Kleinbuchstaben", "a–z", ('a'..'z').map { GlyphLabel("latin_lower_$it", "$it", "Kleines ${it.uppercaseChar()}", "lowercase") }),
    GlyphCategory("uppercase", "Grossbuchstaben", "A–Z", ('A'..'Z').map { GlyphLabel("latin_upper_$it", "$it", "Grosses $it", "uppercase") }),
    GlyphCategory("digits", "Zahlen", "0–9", (0..9).map { GlyphLabel("digit_$it", "$it", "Ziffer $it", "digits") }),
    GlyphCategory(
        "german",
        "Deutsche Sonderzeichen",
        "Ä Ö Ü",
        listOf(
            GlyphLabel("german_upper_A_umlaut", "Ä", "Grosses Ä", "german"),
            GlyphLabel("german_upper_O_umlaut", "Ö", "Grosses Ö", "german"),
            GlyphLabel("german_upper_U_umlaut", "Ü", "Grosses Ü", "german"),
            GlyphLabel("german_lower_a_umlaut", "ä", "Kleines Ä", "german"),
            GlyphLabel("german_lower_o_umlaut", "ö", "Kleines Ö", "german"),
            GlyphLabel("german_lower_u_umlaut", "ü", "Kleines Ü", "german"),
            GlyphLabel("german_eszett", "ß", "Eszett", "german"),
        ),
    ),
    GlyphCategory("math", "Mathematik", "Mathe", MATH_CAPTURE),
)

/** How many samples of one character the capture suggests; the desktop trains well from three. */
const val GLYPH_SAMPLES_PER_LABEL = 3

/** Next label to write: the first one with fewer than [GLYPH_SAMPLES_PER_LABEL] samples, else null. */
fun nextGlyphToCapture(category: GlyphCategory, samples: List<GlyphSample>): GlyphLabel? {
    val counts = samples.groupingBy { it.labelId }.eachCount()
    return category.labels.firstOrNull { (counts[it.id] ?: 0) < GLYPH_SAMPLES_PER_LABEL }
}

/** One pen sample on the capture pad, in pad pixels. */
data class PadPoint(val x: Double, val y: Double, val t: Double, val pressure: Double, val tiltX: Double, val tiltY: Double, val pointerType: String)

class GlyphCaptureException(message: String) : IllegalArgumentException(message)

/**
 * A labelled sample from the capture pad. Points are normalized to the pad like an imported
 * GlyphenWerk `source_canvas`, the box is the ink bounds, so `PersonalHandwriting` and the
 * text-to-handwriting synthesis read it exactly like a desktop sample.
 */
fun captureGlyphSample(
    label: GlyphLabel,
    strokes: List<List<PadPoint>>,
    padWidth: Double,
    padHeight: Double,
    baseWidth: Double,
    pressureEnabled: Boolean,
    id: String,
    sessionId: String,
): GlyphSample {
    val usable = strokes.filter { it.isNotEmpty() }
    if (usable.isEmpty()) throw GlyphCaptureException("Schreibe zuerst das Zeichen in das Feld.")
    if (usable.size > 64 || usable.sumOf { it.size } > 4_000) throw GlyphCaptureException("Das Zeichen hat zu viele Striche.")
    require(padWidth > 0 && padHeight > 0)
    val ink = usable.map { stroke ->
        GlyphInk(
            points = stroke.map { point ->
                StrokePoint(
                    x = (point.x / padWidth).coerceIn(0.0, 1.0),
                    y = (point.y / padHeight).coerceIn(0.0, 1.0),
                    t = point.t,
                    pressure = point.pressure.coerceIn(0.0, 1.0),
                    tiltX = point.tiltX.coerceIn(-90.0, 90.0),
                    tiltY = point.tiltY.coerceIn(-90.0, 90.0),
                    pointerType = point.pointerType,
                )
            },
            baseWidth = baseWidth.coerceIn(0.25, 80.0),
            pressureEnabled = pressureEnabled,
        )
    }
    val points = ink.flatMap { it.points }
    val minX = points.minOf { it.x }
    val minY = points.minOf { it.y }
    val width = points.maxOf { it.x } - minX
    val height = points.maxOf { it.y } - minY
    if (width * padWidth < 2 && height * padHeight < 2 && label.char !in setOf(".", ",", "·")) {
        throw GlyphCaptureException("Das Zeichen ist zu klein. Schreibe es grösser in das Feld.")
    }
    return GlyphSample(
        id = id,
        label = label.char,
        labelId = label.id,
        sessionId = sessionId,
        bbox = listOf(minX, minY, width, height),
        sourceWidth = padWidth,
        sourceHeight = padHeight,
        strokes = ink,
    )
}
