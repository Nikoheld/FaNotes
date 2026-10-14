package ch.fasrv.fanotes.desk

/**
 * Headings in a note, in the same shape as `noteOutline.ts`.
 * Line numbers are 1-based and point at the raw markdown line.
 */
data class NoteOutlineHeading(val level: Int, val title: String, val line: Int)

private val HEADING = Regex("""^(#{1,6})\s+(.+?)\s*#*$""")

fun parseNoteOutline(content: String): List<NoteOutlineHeading> {
    val lines = content.replace("\r\n", "\n").replace('\r', '\n').split('\n')
    return lines.mapIndexedNotNull { index, line ->
        val match = HEADING.matchEntire(line) ?: return@mapIndexedNotNull null
        NoteOutlineHeading(match.groupValues[1].length, match.groupValues[2], index + 1)
    }
}

/** Character offset where [line] starts. A line outside the note is clamped. */
fun revealLineStart(markdown: String, line: Int): Int {
    val text = markdown.replace("\r\n", "\n").replace('\r', '\n')
    val parts = text.split('\n')
    val count = parts.size.coerceAtLeast(1)
    val clamped = line.coerceIn(1, count)
    var offset = 0
    for (index in 0 until clamped - 1) {
        offset += parts[index].length + 1
    }
    return offset
}

/** The markdown line folded with the handwriting section at [sectionIndex]. */
fun headingLineForSection(markdown: String, sectionIndex: Int): Int? {
    if (sectionIndex < 0) return null
    return parseNoteOutline(markdown).getOrNull(sectionIndex)?.line
}

/** Index of the handwriting section that shares this heading line, or -1. */
fun sectionIndexForHeading(markdown: String, line: Int): Int =
    parseNoteOutline(markdown).indexOfFirst { it.line == line }
