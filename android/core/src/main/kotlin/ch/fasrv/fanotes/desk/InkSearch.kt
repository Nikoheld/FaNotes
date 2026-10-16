package ch.fasrv.fanotes.desk

import java.util.Locale

/**
 * Handwriting search position from `searchInkAnchor.ts`.
 * A transcript line is `0.2500\ttext`, where the number is the page height.
 */
fun inkAnchorForQuery(transcript: String, query: String): Double? {
    val needle = foldSharpS(query.trim().lowercase(Locale.GERMAN))
    if (needle.length < 2 || transcript.isBlank()) return null
    val lines = transcript.split('\n').map { it.trim() }.filter { it.isNotEmpty() }
    if (lines.isEmpty()) return null
    val parsed = lines.map(::parseTranscriptLine)
    val index = parsed.indexOfFirst { foldSharpS(it.second.lowercase(Locale.GERMAN)).contains(needle) }
    if (index < 0) return null
    parsed[index].first?.let { return it }
    if (parsed.size == 1) return 0.15
    return index.toDouble() / (parsed.size - 1)
}

fun searchTranscriptHits(files: List<Pair<String, String>>, query: String): List<SearchHit> {
    val needle = query.trim()
    if (needle.length < 2) return emptyList()
    return files.mapNotNull { (path, transcript) ->
        val y = inkAnchorForQuery(transcript, needle) ?: return@mapNotNull null
        val line = transcript.split('\n').map { parseTranscriptLine(it.trim()) }.firstOrNull { it.second.contains(needle, ignoreCase = true) }
        SearchHit(
            path,
            0,
            line?.second?.take(180) ?: needle,
            y,
            title = searchHitTitle(path),
            matches = 1,
            kind = "drawing",
        )
    }
}

private fun parseTranscriptLine(line: String): Pair<Double?, String> {
    val match = Regex("""^(\d+(?:\.\d+)?)\t(.*)$""").find(line.trim()) ?: return null to line.trim()
    val y = match.groupValues[1].toDoubleOrNull() ?: return null to line.trim()
    return y.coerceIn(0.0, 1.0) to match.groupValues[2].trim()
}
