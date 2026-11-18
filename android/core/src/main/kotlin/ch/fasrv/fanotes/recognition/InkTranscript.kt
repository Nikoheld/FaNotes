package ch.fasrv.fanotes.recognition

import ch.fasrv.fanotes.desk.formatTranscriptLine
import ch.fasrv.fanotes.ink.InkStroke
import java.util.Locale

/**
 * The invisible handwriting transcript (`searchTranscript` in the ink JSON) that the vault search,
 * the document index and the margin read. The rules follow `updateHiddenTranscript` in
 * `DrawingBoard.tsx`; each line carries its page position (`searchInkAnchor.ts`), so a hit on
 * any device scrolls to the written line.
 */
const val TRANSCRIPT_FULL_REBUILD_STROKES = 360
const val TRANSCRIPT_TAIL_STROKES = 240
const val TRANSCRIPT_OVERLAP_STROKES = 24
const val TRANSCRIPT_MAX_LINES = 2_000

/** Which handwriting strokes to read again, and whether the result replaces the transcript. */
data class TranscriptPlan(val start: Int, val replace: Boolean)

/**
 * `appendOnly`: only strokes were added since the last pass. Then the last 24 indexed strokes are
 * read again with the new ones. Otherwise a page of at most 360 strokes is read whole and
 * replaces the transcript; a longer page reads its last 240 strokes and adds to it.
 */
fun transcriptPlan(current: Int, previous: Int, needsFullRebuild: Boolean): TranscriptPlan {
    val appendOnly = !needsFullRebuild && current >= previous
    val start = when {
        appendOnly && previous > 0 -> maxOf(0, previous - TRANSCRIPT_OVERLAP_STROKES)
        current > TRANSCRIPT_FULL_REBUILD_STROKES -> current - TRANSCRIPT_TAIL_STROKES
        else -> 0
    }
    return TranscriptPlan(start, replace = !appendOnly && current <= TRANSCRIPT_FULL_REBUILD_STROKES)
}

private fun body(line: String): String = line.substringAfter('\t', line).replace(Regex("\\s+"), " ").trim().lowercase(Locale.GERMAN)

/**
 * Adds [latest] to [existing] (or replaces it). A line whose words are already there is replaced by
 * the newer reading, so an overlapping pass does not repeat a line at a slightly different height.
 * At most the last 2000 lines stay, as on the desktop.
 */
fun mergeTranscript(existing: String, latest: List<TranscriptEntry>, replace: Boolean): String {
    val fresh = latest.filter { it.text.isNotBlank() }.map { formatTranscriptLine(it.y, it.text) }
    val freshBodies = fresh.map(::body).toSet()
    val kept = if (replace) emptyList() else existing.split('\n').map { it.trim() }.filter { it.isNotEmpty() && body(it) !in freshBodies }
    val seen = HashSet<String>()
    val merged = (kept + fresh).filter { seen.add(body(it)) }
    return merged.takeLast(TRANSCRIPT_MAX_LINES).joinToString("\n")
}

/**
 * Cheap identity of the first [count] handwriting strokes. When it changes (erase, undo, move,
 * recolour), the next pass rebuilds the transcript instead of appending.
 */
fun strokePrefixSignature(strokes: List<InkStroke>, count: Int): Long {
    var hash = 1125899906842597L
    for (index in 0 until minOf(count, strokes.size)) {
        val stroke = strokes[index]
        hash = 31 * hash + stroke.points.size
        stroke.points.firstOrNull()?.let { hash = 31 * hash + java.lang.Double.doubleToLongBits(it.x) + 7 * java.lang.Double.doubleToLongBits(it.y) }
        stroke.points.lastOrNull()?.let { hash = 31 * hash + java.lang.Double.doubleToLongBits(it.x) + 7 * java.lang.Double.doubleToLongBits(it.y) }
    }
    return hash
}

/** The transcript after inserting a conversion: the desktop keeps only the inserted text. */
fun transcriptAfterInsert(inserted: String, y: Double): String =
    inserted.split('\n').map { it.trim() }.filter { it.isNotEmpty() }.joinToString("\n") { formatTranscriptLine(y, it) }
