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

/**
 * The body hidden when a heading is folded. The heading line stays, and the
 * next heading of the same or higher level stays. Matches the markdown fold
 * used by the desktop editor.
 */
data class HeadingFold(val from: Int, val to: Int)

fun headingFoldRange(markdown: String, line: Int): HeadingFold? {
    val text = normalizeNewlines(markdown)
    val headings = parseNoteOutline(text)
    val current = headings.find { it.line == line } ?: return null
    val lineStart = revealLineStart(text, current.line)
    val lineEnd = lineStart + text.substring(lineStart).substringBefore('\n').length
    val bodyStart = if (lineEnd < text.length && text[lineEnd] == '\n') lineEnd + 1 else lineEnd
    val next = headings.firstOrNull { it.line > current.line && it.level <= current.level }
    var end = if (next == null) text.length else revealLineStart(text, next.line)
    if (end > bodyStart && text[end - 1] == '\n') end -= 1
    if (bodyStart >= end) return null
    return HeadingFold(bodyStart, end)
}

/** The outermost folded heading whose body contains [line]. */
fun foldedHeadingHidingLine(markdown: String, foldedLines: Set<Int>, line: Int): Int? {
    if (foldedLines.isEmpty() || line <= 0) return null
    val text = normalizeNewlines(markdown)
    val lineStart = revealLineStart(text, line)
    var found: Int? = null
    for (heading in foldedLines) {
        val range = headingFoldRange(text, heading) ?: continue
        if (lineStart >= range.from && lineStart < range.to && (found == null || heading < found)) found = heading
    }
    return found
}

/** Glyphs for the fold gutter, one per visible line. Empty when that line is not a heading with a body. */
fun foldMarkerGlyphs(source: String, foldedLines: Set<Int>): List<String> {
    val text = normalizeNewlines(source)
    val visible = markdownWithFolds(text, foldedLines)
    val lines = if (visible.isEmpty()) 1 else visible.count { it == '\n' } + 1
    return (1..lines).map { visibleLine ->
        val heading = headingLineForFoldMarker(text, foldedLines, visibleLine) ?: return@map ""
        if (heading in foldedLines) "▸" else "▾"
    }
}

/**
 * Source heading line for a tap on visible line [visibleLine] (1-based).
 * Null when that line is not a foldable heading. A heading that is already
 * folded still returns so the gutter can open it.
 */
fun headingLineForFoldMarker(source: String, foldedLines: Set<Int>, visibleLine: Int): Int? {
    if (visibleLine < 1) return null
    val text = normalizeNewlines(source)
    val visible = markdownWithFolds(text, foldedLines)
    val count = if (visible.isEmpty()) 1 else visible.count { it == '\n' } + 1
    if (visibleLine > count) return null
    val sourceOffset = sourceOffsetForVisible(text, foldedLines, revealLineStart(visible, visibleLine))
    val sourceLine = text.take(sourceOffset).count { it == '\n' } + 1
    if (headingFoldRange(text, sourceLine) == null) return if (sourceLine in foldedLines) sourceLine else null
    return sourceLine
}

/** Source text with folded heading bodies removed. No folds returns the original string. */
fun markdownWithFolds(markdown: String, foldedLines: Set<Int>): String {
    if (foldedLines.isEmpty()) return markdown
    val text = normalizeNewlines(markdown)
    val hidden = hiddenMask(text, foldedLines)
    if (hidden.none { it }) return if (text == markdown) markdown else text
    return buildString(text.length) {
        for (index in text.indices) if (!hidden[index]) append(text[index])
    }
}

/** Maps an edit of the folded text back onto the full note. */
fun applyFoldedEdit(source: String, foldedLines: Set<Int>, previousVisible: String, nextVisible: String): String {
    if (previousVisible == nextVisible) return source
    if (foldedLines.isEmpty()) return nextVisible
    val normalized = normalizeNewlines(source)
    val change = minimalTextReplacement(previousVisible, nextVisible)
    val from = sourceOffsetForVisible(normalized, foldedLines, change.from)
    val to = sourceOffsetForVisible(normalized, foldedLines, change.to)
    return normalized.replaceRange(from, to.coerceAtLeast(from), change.insert)
}

/** Keeps folded headings on the same lines after an edit of the full note. */
fun shiftFoldedLines(before: String, after: String, foldedLines: Set<Int>): Set<Int> {
    if (foldedLines.isEmpty() || before == after) return foldedLines
    val change = minimalTextReplacement(before, after)
    val line = before.take(change.from).count { it == '\n' } + 1
    val removed = before.substring(change.from, change.to.coerceAtMost(before.length)).count { it == '\n' }
    val delta = change.insert.count { it == '\n' } - removed
    if (delta == 0) return foldedLines
    return foldedLines.map { heading -> if (heading > line) heading + delta else heading }.filter { it > 0 }.toSet()
}

/** Where a source offset lands in the folded text. */
fun visibleOffsetForSource(source: String, foldedLines: Set<Int>, sourceOffset: Int): Int {
    if (foldedLines.isEmpty()) return sourceOffset.coerceIn(0, source.length)
    val text = normalizeNewlines(source)
    val hidden = hiddenMask(text, foldedLines)
    val limit = sourceOffset.coerceIn(0, text.length)
    var visible = 0
    for (index in 0 until limit) if (!hidden[index]) visible += 1
    return visible
}

/**
 * Desktop Ctrl-Shift-[ folds the heading on the cursor line when that heading
 * has a body. The offset is in the text the editor is showing.
 */
fun foldHeadingAtCursor(markdown: String, foldedLines: Set<Int>, visibleOffset: Int): Set<Int>? {
    val text = normalizeNewlines(markdown)
    val line = sourceLineForVisibleOffset(text, foldedLines, visibleOffset)
    if (headingFoldRange(text, line) == null || line in foldedLines) return null
    return foldedLines + line
}

/** Desktop Ctrl-Shift-] opens the fold on the cursor line, or the fold hiding it. */
fun unfoldHeadingAtCursor(markdown: String, foldedLines: Set<Int>, visibleOffset: Int): Set<Int>? {
    if (foldedLines.isEmpty()) return null
    val text = normalizeNewlines(markdown)
    val line = sourceLineForVisibleOffset(text, foldedLines, visibleOffset)
    val target = if (line in foldedLines) line else foldedHeadingHidingLine(text, foldedLines, line)
    if (target == null || target !in foldedLines) return null
    return foldedLines - target
}

/**
 * Desktop Ctrl-Alt-[ folds every outermost heading and skips the headings
 * inside those bodies.
 */
fun foldAllHeadings(markdown: String, foldedLines: Set<Int>): Set<Int>? {
    val text = normalizeNewlines(markdown)
    val headings = parseNoteOutline(text)
    val next = foldedLines.toMutableSet()
    var changed = false
    var index = 0
    while (index < headings.size) {
        val heading = headings[index]
        val range = headingFoldRange(text, heading.line)
        if (range == null) {
            index += 1
            continue
        }
        if (heading.line !in next) {
            next += heading.line
            changed = true
        }
        index += 1
        while (index < headings.size && revealLineStart(text, headings[index].line) < range.to) index += 1
    }
    return if (changed) next else null
}

/** Desktop Ctrl-Alt-] opens every fold. */
fun unfoldAllHeadings(foldedLines: Set<Int>): Set<Int>? = if (foldedLines.isEmpty()) null else emptySet()

/** Desktop fold keymap: Ctrl-Shift-[/] fold or open, Ctrl-Alt-[/] fold or open everything. */
fun foldShortcut(ctrl: Boolean, shift: Boolean, alt: Boolean, meta: Boolean, bracket: Char): String? {
    if (!ctrl || meta) return null
    if (shift && !alt) {
        return when (bracket) {
            '[' -> "fold"
            ']' -> "unfold"
            else -> null
        }
    }
    if (alt && !shift) {
        return when (bracket) {
            '[' -> "all"
            ']' -> "none"
            else -> null
        }
    }
    return null
}

fun headingFoldCommand(markdown: String, foldedLines: Set<Int>, command: String, visibleOffset: Int): Set<Int>? =
    when (command) {
        "fold" -> foldHeadingAtCursor(markdown, foldedLines, visibleOffset)
        "unfold" -> unfoldHeadingAtCursor(markdown, foldedLines, visibleOffset)
        "all" -> foldAllHeadings(markdown, foldedLines)
        "none" -> unfoldAllHeadings(foldedLines)
        else -> null
    }

/**
 * Where the caret should sit after a fold change. A caret inside a newly
 * hidden body moves to the end of that heading line.
 */
fun visibleCursorAfterFold(markdown: String, before: Set<Int>, after: Set<Int>, visibleOffset: Int): Int {
    val text = normalizeNewlines(markdown)
    val sourceOffset = sourceOffsetForVisible(text, before, visibleOffset)
    val line = text.take(sourceOffset.coerceIn(0, text.length)).count { it == '\n' } + 1
    val hiding = foldedHeadingHidingLine(text, after, line)
    val target = if (hiding == null) {
        sourceOffset
    } else {
        val start = revealLineStart(text, hiding)
        start + text.substring(start).substringBefore('\n').length
    }
    return visibleOffsetForSource(text, after, target)
}

private fun sourceLineForVisibleOffset(text: String, foldedLines: Set<Int>, visibleOffset: Int): Int {
    val sourceOffset = sourceOffsetForVisible(text, foldedLines, visibleOffset)
    return text.take(sourceOffset.coerceIn(0, text.length)).count { it == '\n' } + 1
}

/** Where a folded-text offset lands in the full note. */
fun sourceOffsetForVisible(source: String, foldedLines: Set<Int>, visibleOffset: Int): Int {
    if (foldedLines.isEmpty()) return visibleOffset.coerceIn(0, source.length)
    val text = normalizeNewlines(source)
    val hidden = hiddenMask(text, foldedLines)
    if (visibleOffset <= 0) return 0
    var seen = 0
    for (index in text.indices) {
        if (hidden[index]) continue
        if (seen == visibleOffset) return index
        seen += 1
    }
    return text.length
}

private fun hiddenMask(text: String, foldedLines: Set<Int>): BooleanArray {
    val hidden = BooleanArray(text.length)
    for (line in foldedLines) {
        val range = headingFoldRange(text, line) ?: continue
        val start = range.from.coerceIn(0, text.length)
        val end = range.to.coerceIn(start, text.length)
        for (index in start until end) hidden[index] = true
    }
    return hidden
}

private fun normalizeNewlines(markdown: String) = markdown.replace("\r\n", "\n").replace('\r', '\n')

private data class TextReplacement(val from: Int, val to: Int, val insert: String)

private fun minimalTextReplacement(current: String, next: String): TextReplacement {
    val limit = minOf(current.length, next.length)
    var prefix = 0
    while (prefix < limit && current[prefix] == next[prefix]) prefix += 1
    if (prefix in 1 until limit && current[prefix].isLowSurrogate()) prefix -= 1
    var suffix = 0
    val suffixLimit = limit - prefix
    while (
        suffix < suffixLimit &&
        current[current.length - 1 - suffix] == next[next.length - 1 - suffix]
    ) suffix += 1
    if (suffix in 1 until suffixLimit && current[current.length - suffix].isHighSurrogate()) suffix -= 1
    return TextReplacement(prefix, current.length - suffix, next.substring(prefix, next.length - suffix))
}
