package ch.fasrv.fanotes.desk

import java.util.Locale

/**
 * The handwriting margin: positioned transcript lines and a one-word correction.
 * Ported from `fanotes/src/lib/marginTranscript.ts`.
 */

data class MarginLine(val y: Double?, val text: String)

fun formatTranscriptLine(y: Double, text: String): String {
    val clamped = y.coerceIn(0.0, 1.0)
    val body = text.replace(Regex("""\s+"""), " ").trim()
    return "${"%.4f".format(Locale.US, clamped)}\t$body"
}

fun marginLinesFromTranscript(transcript: String): List<MarginLine> =
    transcript.split('\n')
        .map { it.trim() }
        .filter { it.isNotEmpty() }
        .map { line ->
            val parsed = parseMarginLine(line)
            MarginLine(parsed.first, parsed.second)
        }
        .filter { it.text.isNotEmpty() }
        .take(80)

/** Replace the first whole-word occurrence. The page position on the line stays. */
fun replaceTranscriptWord(transcript: String, from: String, to: String): String {
    if (from.isEmpty()) return transcript
    val pattern = Regex("""(^|\s)${Regex.escape(from)}(?=\s|${'$'})""")
    return pattern.replaceFirst(transcript, "$1$to")
}

private fun parseMarginLine(line: String): Pair<Double?, String> {
    val match = Regex("""^(\d+(?:\.\d+)?)\t(.*)$""").find(line.trim()) ?: return null to line.trim()
    val y = match.groupValues[1].toDoubleOrNull() ?: return null to line.trim()
    if (!y.isFinite()) return null to line.trim()
    return y.coerceIn(0.0, 1.0) to match.groupValues[2].trim()
}
