package ch.fasrv.fanotes.recognition

import ch.fasrv.fanotes.ink.GlyphSample
import ch.fasrv.fanotes.ink.NormalizedRect

/**
 * Where conversion and solver results go. Text and math conversions become Markdown in the note
 * (`insertConversion` in `DrawingBoard.tsx`: math as `$…$`); a solver result is written next to or
 * under the expression in the writer's handwriting (`runMathSolverAction`).
 */

/** `insertConversion`: the corrected value without surrounding `$`, math wrapped as inline TeX. */
fun conversionMarkdown(value: String, mode: String): String {
    val cleaned = value.trim().trim('$').trim()
    if (cleaned.isEmpty()) return ""
    return if (mode == "math") "\$$cleaned\$" else cleaned
}

/** The tablet inserts at the end of the note text (pen mode has no text cursor). */
fun appendMarkdownBlock(markdown: String, block: String): String {
    if (block.isBlank()) return markdown
    val base = markdown.trimEnd()
    return if (base.isEmpty()) "$block\n" else "$base\n\n$block\n"
}

enum class SolverPlacement { SAME_LINE, NEXT_LINE }

/** `continuationText`: one `= result` behind a term, or every step on its own line. */
fun solverContinuationText(result: MathSolverResult, placement: SolverPlacement): String {
    val lines = result.steps.map { it.display }
    if (result.action == "solve" || result.normalizedInput.contains('=') || (placement == SolverPlacement.NEXT_LINE && lines.size > 1)) {
        return lines.joinToString("\n")
    }
    return "= ${lines.lastOrNull().orEmpty()}"
}

/** `adaptMathTextToSamples`: only characters the writer's glyphs can draw. */
fun adaptMathTextToSamples(value: String, samples: List<GlyphSample>): String {
    val labels = samples.flatMap { listOf(it.label, it.labelId) }.toSet()
    val hasDot = "·" in labels || "operator_dot" in labels
    val hasTimes = "×" in labels || "operator_times" in labels
    var adapted = value
    if (!hasDot) adapted = if (hasTimes) adapted.replace("·", "×") else adapted.replace("·", "")
    if ("√" !in labels && "root" !in labels) adapted = adapted.replace(Regex("√\\(([^()]*)\\)"), "sqrt($1)")
    return adapted
}

/** Page geometry for the handwritten solver result, in page pixels. */
data class SolverLayout(
    val placement: SolverPlacement,
    val fontSize: Double,
    val marginLeft: Double,
    val startY: Double,
)

/**
 * `runMathSolverAction` without per-glyph boxes: the font size follows the expression height
 * (a glyph is ~73% of the font size), the baseline sits at 76% of the selection.
 */
fun solverLayout(result: MathSolverResult, rect: NormalizedRect, pageWidth: Double, pageHeight: Double, placement: SolverPlacement? = null): SolverLayout {
    val top = rect.y * pageHeight
    val bottom = rect.bottom * pageHeight
    val left = rect.x * pageWidth
    val right = rect.right * pageWidth
    val glyph = (bottom - top).takeIf { it > 4.0 } ?: 26.0
    val fontSize = (glyph / 0.73).coerceIn(22.0, 58.0)
    val estimatedWidth = solverContinuationText(result, SolverPlacement.SAME_LINE).length * fontSize * 0.48
    val chosen = placement ?: if (result.action == "solve" || result.normalizedInput.contains('=') || right + estimatedWidth + 52 > pageWidth) {
        SolverPlacement.NEXT_LINE
    } else {
        SolverPlacement.SAME_LINE
    }
    return if (chosen == SolverPlacement.SAME_LINE) {
        SolverLayout(chosen, fontSize, right + 14, top + (bottom - top) * 0.76)
    } else {
        SolverLayout(chosen, fontSize, maxOf(44.0, left), bottom + fontSize * 1.02)
    }
}

/** Box around the selected strokes, normalized. */
fun strokesRect(strokes: List<ch.fasrv.fanotes.ink.InkStroke>): NormalizedRect? {
    val points = strokes.flatMap { it.points }
    if (points.isEmpty()) return null
    val minX = points.minOf { it.x }
    val minY = points.minOf { it.y }
    return NormalizedRect(minX, minY, points.maxOf { it.x } - minX, points.maxOf { it.y } - minY)
}
