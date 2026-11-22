package ch.fasrv.fanotes.desk

import java.text.Normalizer
import java.util.Locale

/**
 * Headings in a note, in the same shape as `noteOutline.ts`.
 * Line numbers are 1-based and point at the raw markdown line.
 */
data class NoteOutlineHeading(val level: Int, val title: String, val line: Int)

private val HEADING_LOCALE = Locale.forLanguageTag("de-DE")

/**
 * The id the desktop preview puts on a heading (`headingSlug` in MarkdownPreview).
 * A repeated title becomes `name-2`, then `name-3`.
 */
fun headingSlug(value: String): String {
    val folded = Normalizer.normalize(value, Normalizer.Form.NFKD)
        .replace(Regex("[\\u0300-\\u036f]"), "")
        .lowercase(HEADING_LOCALE)
    val cleaned = buildString {
        for (ch in folded) {
            if (ch.isLetterOrDigit() || ch == ' ' || ch == '-') append(ch)
        }
    }.trim().replace(Regex("\\s+"), "-").replace(Regex("-+"), "-")
    return cleaned.ifEmpty { "abschnitt" }
}

/** The 1-based line of the heading a wiki anchor names, or null. */
fun headingAnchorLine(markdown: String, anchor: String): Int? {
    val wanted = anchor.trim().removePrefix("#")
    if (wanted.isEmpty()) return null
    val headings = parseNoteOutline(markdown)
    val ids = ArrayList<String>(headings.size)
    val counts = HashMap<String, Int>()
    for (heading in headings) {
        val base = headingSlug(heading.title)
        val seen = counts.getOrDefault(base, 0)
        counts[base] = seen + 1
        ids += if (seen == 0) base else "$base-${seen + 1}"
    }
    // Preview links are prefixed once by rehype-sanitize. Try that slug first,
    // then the anchor as written so an authored id still resolves.
    val candidates = ArrayList<String>(2)
    if (wanted.startsWith("user-content-", ignoreCase = true)) {
        val stripped = wanted.substring("user-content-".length)
        if (stripped.isNotEmpty()) candidates += stripped
    }
    candidates += wanted
    for (candidate in candidates) {
        val index = ids.indexOfFirst { it.equals(candidate, ignoreCase = true) }
        if (index >= 0) return headings[index].line
        val titled = headings.indexOfFirst { it.title.equals(candidate, ignoreCase = true) }
        if (titled >= 0) return headings[titled].line
    }
    return null
}

private val FENCE = Regex("""^ {0,3}(`{3,}|~{3,})(.*)$""")
private val HEADING = Regex("^(#{1,6})[ \\t]+(.+?)(?:[ \\t]+#+)?[ \\t]*$")

/** Headings outside fenced code. A closing hash sequence needs a space before it, so `C#` stays. */
fun parseNoteOutline(content: String): List<NoteOutlineHeading> {
    val lines = content.replace("\r\n", "\n").replace('\r', '\n').split('\n')
    val headings = mutableListOf<NoteOutlineHeading>()
    var fenceMarker = ""
    var fenceLength = 0
    for ((index, line) in lines.withIndex()) {
        // A regex per line is slow on a long note: only lines that can be a fence or a heading reach one.
        val lead = line.firstOrNull { it != ' ' }
        if (lead != '`' && lead != '~' && fenceMarker.isEmpty() && !line.startsWith('#')) continue
        val fence = if (lead == '`' || lead == '~') FENCE.matchEntire(line) else null
        if (fence != null) {
            val token = fence.groupValues[1]
            val marker = token.first().toString()
            val rest = fence.groupValues[2]
            if (fenceMarker.isEmpty()) {
                if (marker != "`" || !rest.contains('`')) {
                    fenceMarker = marker
                    fenceLength = token.length
                }
            } else if (marker == fenceMarker && token.length >= fenceLength && rest.isBlank()) {
                fenceMarker = ""
                fenceLength = 0
            }
            continue
        }
        if (fenceMarker.isNotEmpty()) continue
        val match = HEADING.matchEntire(line) ?: continue
        headings += NoteOutlineHeading(match.groupValues[1].length, match.groupValues[2], index + 1)
    }
    return headings
}

/** Desktop `revealLine` keeps the target 48px below the top of the scroller. */
const val REVEAL_LINE_MARGIN_PX = 48

fun revealScrollTop(lineTop: Int, paddingTop: Int, marginPx: Int = REVEAL_LINE_MARGIN_PX): Int =
    (lineTop - paddingTop - marginPx).coerceAtLeast(0)

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

/**
 * Glyphs for the fold gutter, one per visible line. Empty when that line is not a heading with a body.
 * One pass over the note: the outline and the fold ranges are not recomputed per line.
 */
fun foldMarkerGlyphs(source: String, foldedLines: Set<Int>): List<String> {
    val text = normalizeNewlines(source)
    val hidden = if (foldedLines.isEmpty()) null else hiddenMask(text, foldedLines)
    val headings = parseNoteOutline(text)
    val byLine = HashMap<Int, Int>(headings.size * 2)
    headings.forEachIndexed { index, heading -> byLine[heading.line] = index }
    var lineCount = 1
    for (index in text.indices) if (text[index] == '\n') lineCount += 1
    val lineStarts = IntArray(lineCount)
    var lineSlot = 1
    for (index in text.indices) if (text[index] == '\n') lineStarts[lineSlot++] = index + 1
    fun hasBody(heading: NoteOutlineHeading, position: Int): Boolean {
        val lineStart = lineStarts[heading.line - 1]
        val lineEnd = if (heading.line < lineStarts.size) lineStarts[heading.line] - 1 else text.length
        val bodyStart = if (lineEnd < text.length && text[lineEnd] == '\n') lineEnd + 1 else lineEnd
        var next: NoteOutlineHeading? = null
        for (i in position + 1 until headings.size) {
            if (headings[i].level <= heading.level) {
                next = headings[i]
                break
            }
        }
        var end = if (next == null) text.length else lineStarts[next.line - 1]
        if (end > bodyStart && text[end - 1] == '\n') end -= 1
        return lineStart >= 0 && bodyStart < end
    }
    // Source offset where each visible line starts (the first visible line starts at 0).
    val starts = ArrayList<Int>()
    starts += 0
    var afterBreak = false
    for (index in text.indices) {
        if (hidden != null && hidden[index]) continue
        if (afterBreak) starts += index
        afterBreak = text[index] == '\n'
    }
    if (afterBreak) starts += text.length
    return starts.map { offset ->
        var low = 0
        var high = lineStarts.size - 1
        while (low < high) {
            val mid = (low + high + 1) ushr 1
            if (lineStarts[mid] <= offset) low = mid else high = mid - 1
        }
        val sourceLine = low + 1
        val position = byLine[sourceLine]
        val foldable = position != null && hasBody(headings[position], position)
        when {
            foldable || sourceLine in foldedLines -> if (sourceLine in foldedLines) "▸" else "▾"
            else -> ""
        }
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
    val change = minimalReplacement(previousVisible, nextVisible)
    val from = sourceOffsetForVisible(normalized, foldedLines, change.from)
    val to = sourceOffsetForVisible(normalized, foldedLines, change.to)
    return normalized.replaceRange(from, to.coerceAtLeast(from), change.insert)
}

/** Keeps folded headings on the same lines after an edit of the full note. */
fun shiftFoldedLines(before: String, after: String, foldedLines: Set<Int>): Set<Int> {
    if (foldedLines.isEmpty() || before == after) return foldedLines
    val change = minimalReplacement(before, after)
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

private fun normalizeNewlines(markdown: String) =
    if (markdown.indexOf('\r') < 0) markdown else markdown.replace("\r\n", "\n").replace('\r', '\n')

/** Characters that can make or break a heading, a fence or a table when they start a line or are typed. */
private const val FOLD_RISK_CHARS = "#=-`~|<>"

/**
 * Whether one edit ([deleted] characters of [before] at [start] became [inserted] characters of [after]) is a small
 * change inside a plain line, so the fold gutter built before it still fits. A new line, a heading, rule, fence or
 * table mark typed or removed, or a line that starts like one says no unless the edit is in its text behind the mark. Looks at the edit only, never at the whole note.
 */
fun foldMarkersSurviveEdit(before: CharSequence, after: CharSequence, start: Int, deleted: Int, inserted: Int): Boolean {
    if (start < 0 || deleted < 0 || inserted < 0 || deleted > 40 || inserted > 40) return false
    if (start + deleted > before.length || start + inserted > after.length) return false
    for (index in 0 until deleted) {
        val ch = before[start + index]
        if (ch == '\n' || ch == '\r' || ch in FOLD_RISK_CHARS) return false
    }
    for (index in 0 until inserted) {
        val ch = after[start + index]
        if (ch == '\n' || ch == '\r' || ch in FOLD_RISK_CHARS) return false
    }
    var lineStart = start
    var steps = 0
    while (lineStart > 0 && after[lineStart - 1] != '\n') {
        lineStart -= 1
        steps += 1
        if (steps > 400) return false
    }
    var first = lineStart
    while (first < after.length && after[first] != '\n' && after[first].isWhitespace()) first += 1
    if (first >= after.length || after[first] == '\n' || after[first] !in FOLD_RISK_CHARS) return true
    // A heading, list or table line: only text typed after its mark and the space behind it leaves the gutter alone.
    var markEnd = first
    while (markEnd < after.length && after[markEnd] in FOLD_RISK_CHARS) markEnd += 1
    return markEnd < after.length && (after[markEnd] == ' ' || after[markEnd] == '\t') && start > markEnd
}
