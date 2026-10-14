package ch.fasrv.fanotes.desk

/**
 * Line diff for the note version timeline.
 * Ported from `fanotes/src/lib/markdownDiff.ts`.
 */

enum class DiffKind { SAME, ADDED, REMOVED }

data class TimelineRow(val kind: DiffKind, val text: String)

fun diffNoteLines(before: String, after: String): List<TimelineRow> {
    val left = before.replace("\r\n", "\n").split('\n').take(400)
    val right = after.replace("\r\n", "\n").split('\n').take(400)
    val seen = HashMap<String, Int>()
    right.forEachIndexed { index, line -> if (line !in seen) seen[line] = index }
    val used = HashSet<Int>()
    val rows = mutableListOf<TimelineRow>()
    for (line in left) {
        val match = seen[line]
        if (match != null && match !in used) {
            used += match
            rows += TimelineRow(DiffKind.SAME, line)
        } else {
            rows += TimelineRow(DiffKind.REMOVED, line)
        }
    }
    right.forEachIndexed { index, line ->
        if (index !in used) rows += TimelineRow(DiffKind.ADDED, line)
    }
    return rows.filter { it.kind != DiffKind.SAME }.take(80)
}

fun formatNoteDiff(before: String, after: String): String {
    val text = diffNoteLines(before, after).joinToString("\n") { row ->
        "${if (row.kind == DiffKind.ADDED) "+" else "-"} ${row.text}"
    }
    return text.ifEmpty { "Kein Textunterschied." }
}

fun timelineHasInk(content: String) = Regex("""fanotes-ink:|searchTranscript|"strokes"""").containsMatchIn(content)
