package ch.fasrv.fanotes.ink

import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.sin

/**
 * A readable school script used until a GlyphenWerk training ZIP is imported.
 * Coordinates are 0–1 of the glyph box, y grows downward.
 */

private data class SchoolPath(val points: List<Pair<Double, Double>>)

fun schoolScript(): List<GlyphSample> = SCHOOL_GLYPHS

private val SCHOOL_GLYPHS: List<GlyphSample> by lazy { buildSchoolScript() }

private fun line(vararg xy: Double): SchoolPath {
    require(xy.size % 2 == 0 && xy.size >= 4)
    return SchoolPath((0 until xy.size step 2).map { xy[it] to xy[it + 1] })
}

private fun oval(cx: Double, cy: Double, rx: Double, ry: Double, steps: Int = 18): SchoolPath {
    val points = (0..steps).map { step ->
        val angle = -Math.PI / 2 + (Math.PI * 2 * step / steps)
        (cx + cos(angle) * rx) to (cy + sin(angle) * ry)
    }
    return SchoolPath(points)
}

private fun buildSchoolScript(): List<GlyphSample> {
    val letters = linkedMapOf<String, List<SchoolPath>>(
        "a" to listOf(oval(0.42, 0.74, 0.22, 0.16), line(0.62, 0.56, 0.62, 0.90)),
        "b" to listOf(line(0.30, 0.12, 0.30, 0.90), oval(0.50, 0.74, 0.20, 0.16)),
        "c" to listOf(line(0.68, 0.60, 0.50, 0.56, 0.28, 0.68, 0.28, 0.82, 0.50, 0.92, 0.68, 0.84)),
        "d" to listOf(line(0.68, 0.12, 0.68, 0.90), oval(0.46, 0.74, 0.20, 0.16)),
        "e" to listOf(line(0.26, 0.74, 0.70, 0.74, 0.66, 0.58, 0.42, 0.56, 0.26, 0.68, 0.26, 0.84, 0.48, 0.92, 0.68, 0.84)),
        "f" to listOf(line(0.62, 0.22, 0.46, 0.12, 0.34, 0.22, 0.34, 0.92), line(0.18, 0.46, 0.56, 0.46)),
        "g" to listOf(oval(0.46, 0.68, 0.20, 0.14), line(0.66, 0.56, 0.66, 0.96, 0.46, 1.04, 0.30, 0.96)),
        "h" to listOf(line(0.30, 0.12, 0.30, 0.92), line(0.30, 0.66, 0.46, 0.56, 0.66, 0.66, 0.66, 0.92)),
        "i" to listOf(line(0.40, 0.56, 0.40, 0.92), line(0.38, 0.34, 0.42, 0.38)),
        "j" to listOf(line(0.48, 0.56, 0.48, 0.98, 0.32, 1.06), line(0.46, 0.34, 0.50, 0.38)),
        "k" to listOf(line(0.30, 0.12, 0.30, 0.92), line(0.64, 0.56, 0.30, 0.74, 0.66, 0.92)),
        "l" to listOf(line(0.40, 0.12, 0.40, 0.88, 0.52, 0.92)),
        "m" to listOf(
            line(0.18, 0.92, 0.18, 0.58, 0.34, 0.54, 0.46, 0.66, 0.46, 0.92),
            line(0.46, 0.66, 0.60, 0.54, 0.74, 0.66, 0.74, 0.92),
        ),
        "n" to listOf(line(0.28, 0.92, 0.28, 0.58, 0.46, 0.54, 0.66, 0.66, 0.66, 0.92)),
        "o" to listOf(oval(0.48, 0.74, 0.22, 0.18)),
        "p" to listOf(line(0.30, 0.56, 0.30, 1.06), oval(0.50, 0.74, 0.20, 0.16)),
        "q" to listOf(line(0.66, 0.56, 0.66, 1.06), oval(0.46, 0.74, 0.20, 0.16)),
        "r" to listOf(line(0.30, 0.92, 0.30, 0.58, 0.48, 0.54, 0.64, 0.62)),
        "s" to listOf(line(0.66, 0.60, 0.46, 0.54, 0.30, 0.64, 0.40, 0.74, 0.62, 0.82, 0.48, 0.94, 0.28, 0.88)),
        "t" to listOf(line(0.40, 0.28, 0.40, 0.86, 0.54, 0.92), line(0.22, 0.50, 0.60, 0.50)),
        "u" to listOf(line(0.28, 0.56, 0.28, 0.82, 0.46, 0.92, 0.66, 0.80, 0.66, 0.56), line(0.66, 0.56, 0.66, 0.92)),
        "v" to listOf(line(0.22, 0.56, 0.48, 0.92, 0.74, 0.56)),
        "w" to listOf(line(0.14, 0.56, 0.30, 0.92, 0.48, 0.66, 0.66, 0.92, 0.82, 0.56)),
        "x" to listOf(line(0.24, 0.56, 0.70, 0.92), line(0.70, 0.56, 0.24, 0.92)),
        "y" to listOf(line(0.22, 0.56, 0.46, 0.82, 0.70, 0.56), line(0.46, 0.82, 0.46, 1.06)),
        "z" to listOf(line(0.24, 0.58, 0.70, 0.58, 0.24, 0.92, 0.70, 0.92)),
        "A" to listOf(line(0.16, 0.92, 0.50, 0.08, 0.84, 0.92), line(0.30, 0.58, 0.70, 0.58)),
        "B" to listOf(line(0.24, 0.08, 0.24, 0.92), oval(0.48, 0.32, 0.22, 0.18), oval(0.50, 0.72, 0.24, 0.18)),
        "C" to listOf(line(0.74, 0.24, 0.50, 0.10, 0.24, 0.32, 0.24, 0.72, 0.50, 0.92, 0.74, 0.76)),
        "D" to listOf(line(0.24, 0.08, 0.24, 0.92), oval(0.48, 0.50, 0.30, 0.40)),
        "E" to listOf(line(0.74, 0.10, 0.26, 0.10, 0.26, 0.92, 0.74, 0.92), line(0.26, 0.50, 0.62, 0.50)),
        "F" to listOf(line(0.26, 0.10, 0.26, 0.92), line(0.26, 0.10, 0.74, 0.10), line(0.26, 0.48, 0.60, 0.48)),
        "G" to listOf(line(0.74, 0.24, 0.50, 0.10, 0.24, 0.32, 0.24, 0.72, 0.50, 0.92, 0.74, 0.76, 0.74, 0.52, 0.52, 0.52)),
        "H" to listOf(line(0.26, 0.08, 0.26, 0.92), line(0.74, 0.08, 0.74, 0.92), line(0.26, 0.50, 0.74, 0.50)),
        "I" to listOf(line(0.50, 0.08, 0.50, 0.92), line(0.34, 0.08, 0.66, 0.08), line(0.34, 0.92, 0.66, 0.92)),
        "J" to listOf(line(0.68, 0.08, 0.68, 0.78, 0.50, 0.94, 0.30, 0.80)),
        "K" to listOf(line(0.28, 0.08, 0.28, 0.92), line(0.74, 0.10, 0.28, 0.50, 0.76, 0.92)),
        "L" to listOf(line(0.28, 0.08, 0.28, 0.92, 0.74, 0.92)),
        "M" to listOf(line(0.14, 0.92, 0.14, 0.10, 0.50, 0.58, 0.86, 0.10, 0.86, 0.92)),
        "N" to listOf(line(0.22, 0.92, 0.22, 0.10, 0.78, 0.92, 0.78, 0.10)),
        "O" to listOf(oval(0.50, 0.50, 0.30, 0.40)),
        "P" to listOf(line(0.28, 0.08, 0.28, 0.92), oval(0.50, 0.32, 0.24, 0.20)),
        "Q" to listOf(oval(0.48, 0.48, 0.28, 0.38), line(0.58, 0.68, 0.80, 0.94)),
        "R" to listOf(line(0.28, 0.08, 0.28, 0.92), oval(0.50, 0.30, 0.22, 0.18), line(0.48, 0.50, 0.76, 0.92)),
        "S" to listOf(line(0.72, 0.24, 0.50, 0.10, 0.28, 0.26, 0.40, 0.46, 0.64, 0.56, 0.74, 0.74, 0.52, 0.92, 0.26, 0.78)),
        "T" to listOf(line(0.16, 0.10, 0.84, 0.10), line(0.50, 0.10, 0.50, 0.92)),
        "U" to listOf(line(0.24, 0.08, 0.24, 0.72, 0.50, 0.92, 0.76, 0.72, 0.76, 0.08)),
        "V" to listOf(line(0.16, 0.08, 0.50, 0.92, 0.84, 0.08)),
        "W" to listOf(line(0.10, 0.08, 0.28, 0.92, 0.50, 0.36, 0.72, 0.92, 0.90, 0.08)),
        "X" to listOf(line(0.18, 0.08, 0.82, 0.92), line(0.82, 0.08, 0.18, 0.92)),
        "Y" to listOf(line(0.16, 0.08, 0.50, 0.46, 0.84, 0.08), line(0.50, 0.46, 0.50, 0.92)),
        "Z" to listOf(line(0.18, 0.10, 0.82, 0.10, 0.18, 0.92, 0.82, 0.92)),
        "0" to listOf(oval(0.50, 0.50, 0.26, 0.38)),
        "1" to listOf(line(0.34, 0.24, 0.50, 0.08, 0.50, 0.92), line(0.32, 0.92, 0.68, 0.92)),
        "2" to listOf(line(0.24, 0.28, 0.40, 0.12, 0.64, 0.12, 0.76, 0.28, 0.24, 0.92, 0.78, 0.92)),
        "3" to listOf(line(0.24, 0.18, 0.50, 0.08, 0.72, 0.22, 0.48, 0.46, 0.72, 0.70, 0.50, 0.92, 0.24, 0.80)),
        "4" to listOf(line(0.62, 0.08, 0.22, 0.62, 0.78, 0.62), line(0.62, 0.08, 0.62, 0.92)),
        "5" to listOf(line(0.72, 0.10, 0.28, 0.10, 0.28, 0.46, 0.56, 0.42, 0.74, 0.58, 0.56, 0.92, 0.26, 0.82)),
        "6" to listOf(line(0.66, 0.20, 0.42, 0.08, 0.26, 0.36, 0.26, 0.70), oval(0.48, 0.70, 0.22, 0.18)),
        "7" to listOf(line(0.22, 0.10, 0.78, 0.10, 0.36, 0.92)),
        "8" to listOf(oval(0.50, 0.30, 0.22, 0.16), oval(0.50, 0.70, 0.24, 0.18)),
        "9" to listOf(oval(0.50, 0.32, 0.22, 0.18), line(0.70, 0.32, 0.70, 0.72, 0.50, 0.92, 0.30, 0.80)),
        "." to listOf(line(0.46, 0.86, 0.52, 0.92)),
        "," to listOf(line(0.50, 0.82, 0.46, 0.92, 0.38, 1.00)),
        "!" to listOf(line(0.50, 0.08, 0.50, 0.68), line(0.48, 0.86, 0.54, 0.92)),
        "?" to listOf(line(0.28, 0.22, 0.46, 0.08, 0.70, 0.20, 0.50, 0.42, 0.50, 0.64), line(0.48, 0.86, 0.54, 0.92)),
        ":" to listOf(line(0.46, 0.36, 0.52, 0.42), line(0.46, 0.80, 0.52, 0.86)),
        ";" to listOf(line(0.46, 0.36, 0.52, 0.42), line(0.50, 0.78, 0.44, 0.92, 0.36, 1.00)),
        "'" to listOf(line(0.46, 0.10, 0.42, 0.28)),
        "\"" to listOf(line(0.36, 0.10, 0.32, 0.28), line(0.58, 0.10, 0.54, 0.28)),
        "-" to listOf(line(0.22, 0.62, 0.78, 0.62)),
        "(" to listOf(line(0.62, 0.08, 0.40, 0.28, 0.40, 0.74, 0.62, 0.92)),
        ")" to listOf(line(0.38, 0.08, 0.60, 0.28, 0.60, 0.74, 0.38, 0.92)),
        "/" to listOf(line(0.28, 0.92, 0.72, 0.08)),
        "+" to listOf(line(0.50, 0.28, 0.50, 0.78), line(0.24, 0.52, 0.76, 0.52)),
        "=" to listOf(line(0.24, 0.42, 0.76, 0.42), line(0.24, 0.64, 0.76, 0.64)),
        "%" to listOf(oval(0.30, 0.28, 0.12, 0.12), line(0.74, 0.12, 0.26, 0.88), oval(0.70, 0.74, 0.12, 0.12)),
        "&" to listOf(line(0.70, 0.22, 0.46, 0.08, 0.30, 0.28, 0.46, 0.48, 0.74, 0.92, 0.40, 0.92, 0.24, 0.74)),
        "*" to listOf(line(0.50, 0.20, 0.50, 0.70), line(0.28, 0.32, 0.72, 0.58), line(0.72, 0.32, 0.28, 0.58)),
        "#" to listOf(line(0.36, 0.08, 0.28, 0.92), line(0.70, 0.08, 0.62, 0.92), line(0.18, 0.38, 0.82, 0.38), line(0.14, 0.62, 0.78, 0.62)),
        "@" to listOf(oval(0.48, 0.52, 0.14, 0.14), line(0.62, 0.46, 0.62, 0.70, 0.78, 0.40, 0.50, 0.12, 0.22, 0.36, 0.22, 0.70, 0.50, 0.92, 0.74, 0.74)),
    )
    return letters.map { (label, paths) -> schoolGlyph(label, paths) }
}

private fun schoolGlyph(label: String, paths: List<SchoolPath>): GlyphSample {
    val sampled = paths.map { path -> samplePath(path.points) }
    val flat = sampled.flatten()
    val minX = flat.minOf { it.first }
    val minY = flat.minOf { it.second }
    val spanX = max(0.04, flat.maxOf { it.first } - minX)
    val spanY = max(0.04, flat.maxOf { it.second } - minY)
    fun place(value: Double, start: Double, span: Double) = 0.04 + (value - start) / span * 0.92
    val mapped = sampled.map { points -> points.map { (x, y) -> place(x, minX, spanX) to place(y, minY, spanY) } }
    val placed = mapped.flatten()
    val left = placed.minOf { it.first }
    val top = placed.minOf { it.second }
    val width = max(0.04, placed.maxOf { it.first } - left)
    val height = max(0.04, placed.maxOf { it.second } - top)
    val strokes = mapped.map { points ->
        GlyphInk(
            points = points.map { (x, y) ->
                StrokePoint(x, y, 0.0, 0.55, 0.0, 0.0, "pen")
            },
            baseWidth = 3.2,
            pressureEnabled = true,
        )
    }
    return GlyphSample(
        id = "school-$label",
        label = label,
        labelId = "school-$label",
        sessionId = "school-script",
        bbox = listOf(left, top, width, height),
        sourceWidth = 100.0,
        sourceHeight = 100.0,
        strokes = strokes,
    )
}

private fun samplePath(points: List<Pair<Double, Double>>): List<Pair<Double, Double>> {
    if (points.size < 2) return points
    val out = ArrayList<Pair<Double, Double>>()
    for (index in 0 until points.lastIndex) {
        val from = points[index]
        val to = points[index + 1]
        val steps = max(1, (hypot(to.first - from.first, to.second - from.second) * 28).toInt())
        for (step in 0 until steps) {
            val t = step.toDouble() / steps
            out += (from.first + (to.first - from.first) * t) to (from.second + (to.second - from.second) * t)
        }
    }
    out += points.last()
    return out
}
