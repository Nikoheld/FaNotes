package ch.fasrv.fanotes.desk

import ch.fasrv.fanotes.text.PaperKind
import ch.fasrv.fanotes.text.paperImageCaption
import ch.fasrv.fanotes.text.paperImageSource
import ch.fasrv.fanotes.text.tableAlignWire
import ch.fasrv.fanotes.text.tableRows

/**
 * Marks for the desktop editor's live preview.
 * The line that holds the cursor keeps its Markdown markers. Every other line
 * hides those markers and styles what is left. The note text itself does not change.
 */
enum class LiveKind {
    HIDE,
    COLLAPSE,
    BULLET,
    TASK_OPEN,
    TASK_DONE,
    H1,
    H2,
    H3,
    H4,
    H5,
    H6,
    QUOTE,
    STRONG,
    EMPHASIS,
    STRIKE,
    CODE,
    CODE_FENCE,
    LINK,
    MATH,
    MATH_BLOCK,
    DETAILS_SUMMARY,
    DETAILS_BODY,
    DETAILS_END,
    TABLE_ROW,
    TABLE_RULE,
    RULE,
}

data class LiveMark(
    val start: Int,
    val end: Int,
    val kind: LiveKind,
    val label: String = "",
    val body: String = "",
    val open: Boolean = false,
    val continues: Boolean = false,
    val readingScales: List<Float> = emptyList(),
    val readingHeadings: List<Boolean> = emptyList(),
    val readingKinds: List<String> = emptyList(),
    val readingSources: List<String> = emptyList(),
    val readingInlines: List<List<DetailsInline>> = emptyList(),
)

/**
 * Other copies of the current selection, as the desktop editor highlights them.
 * Case-sensitive and non-overlapping. A match that touches the selection is left
 * to the selection itself. More than [limit] other copies means no highlight,
 * which is what CodeMirror does once the match list overflows.
 */
fun selectionMatchRanges(
    text: String,
    selectionStart: Int,
    selectionEnd: Int,
    limit: Int = 100,
): List<Pair<Int, Int>>? {
    if (limit < 0) return emptyList()
    val from = minOf(selectionStart, selectionEnd).coerceIn(0, text.length)
    val to = maxOf(selectionStart, selectionEnd).coerceIn(from, text.length)
    if (to - from < 1) return emptyList()
    val query = text.substring(from, to)
    if (query.isEmpty()) return emptyList()
    val hits = ArrayList<Pair<Int, Int>>()
    var cursor = 0
    while (cursor <= text.length) {
        val index = text.indexOf(query, cursor)
        if (index < 0) break
        val end = index + query.length
        if (end <= from || index >= to) {
            hits += index to end
            if (hits.size > limit) return null
        }
        cursor = end.coerceAtLeast(cursor + 1)
    }
    return hits
}

/** Desktop Mod-d. Shift-Ctrl-D is not that command. */
fun nextOccurrenceShortcut(ctrl: Boolean, shift: Boolean, alt: Boolean, meta: Boolean, letter: Char): Boolean =
    ctrl && !shift && !alt && !meta && letter.lowercaseChar() == 'd'

/**
 * The desktop Mod-d command for one selection.
 * A cursor expands to the surrounding word. A selection jumps to the next copy,
 * and wraps. A selection that is itself a whole word only lands on whole words.
 */
fun nextEditorOccurrence(text: String, selectionStart: Int, selectionEnd: Int): Pair<Int, Int>? {
    val forward = selectionEnd >= selectionStart
    val from = minOf(selectionStart, selectionEnd).coerceIn(0, text.length)
    val to = maxOf(selectionStart, selectionEnd).coerceIn(from, text.length)
    if (from == to) return editorWordRange(text, from)
    val query = text.substring(from, to)
    if (query.isEmpty()) return null
    val head = if (forward) to else from
    val around = editorWordRange(text, head)
    val wholeWord = around != null && around.first == from && around.second == to
    fun acceptable(start: Int): Boolean {
        if (!wholeWord) return true
        val word = editorWordRange(text, start)
        return word != null && word.first == start && word.second == start + query.length
    }
    fun scan(startAt: Int, stopBefore: Int): Pair<Int, Int>? {
        var cursor = startAt
        while (cursor < stopBefore) {
            val index = text.indexOf(query, cursor)
            if (index < 0 || index >= stopBefore) return null
            if (acceptable(index)) return index to index + query.length
            cursor = (index + query.length).coerceAtLeast(cursor + 1)
        }
        return null
    }
    return scan(to, text.length + 1) ?: scan(0, from)
}

/** The word touching [offset], using the desktop word classes: letters, digits, and `_`. */
fun editorWordRange(text: String, offset: Int): Pair<Int, Int>? {
    if (text.isEmpty()) return null
    val pos = offset.coerceIn(0, text.length)
    var start = pos
    var end = pos
    while (start > 0 && isEditorWordChar(text[start - 1])) start -= 1
    while (end < text.length && isEditorWordChar(text[end])) end += 1
    if (start == end) return null
    return start to end
}

private fun isEditorWordChar(ch: Char): Boolean =
    ch == '_' || Character.isLetter(ch) || Character.isDigit(ch)

/** One `<details>` block, in the same shape the desktop editor folds into a widget. */
data class DetailsBlock(
    val from: Int,
    val to: Int,
    val startLine: Int,
    val endLine: Int,
    val summary: String,
    val body: String,
    val open: Boolean,
)

fun livePreviewMarks(text: String, selectionStart: Int, selectionEnd: Int): List<LiveMark> {
    if (text.isEmpty()) return emptyList()
    val from = selectionStart.coerceIn(0, text.length)
    val to = selectionEnd.coerceIn(0, text.length)
    val active = setOf(lineNumberAtOffset(text, minOf(from, to)), lineNumberAtOffset(text, maxOf(from, to)))
    val lines = documentLines(text)
    val hidden = HashSet<Int>()
    val marks = ArrayList<LiveMark>()
    for (block in findDetailsBlocks(text)) {
        if (selectionEditsDetails(block, from, to)) continue
        val host = lines[block.startLine - 1]
        hidden += block.startLine
        for (number in (block.startLine + 1)..block.endLine) {
            concealLine(marks, text, lines[number - 1])
            hidden += number
        }
        if (host.to > host.from) {
            val reading = if (block.open) detailsReadingLines(block.body) else emptyList()
            marks += LiveMark(
                host.from,
                host.to,
                LiveKind.DETAILS_SUMMARY,
                block.summary,
                reading.joinToString("\n") { if (it.kind == "rule") "—" else it.text },
                open = block.open,
                readingScales = reading.map { it.scale },
                readingHeadings = reading.map { it.heading },
                readingKinds = reading.map { it.kind },
                readingSources = reading.map { it.source },
                readingInlines = reading.map { it.inlines },
            )
        }
    }
    for (block in codeFenceBlocks(text)) {
        if (to >= block.from && from <= block.to) continue
        if ((block.openLine..block.closeLine).any { it in hidden }) continue
        for (number in block.openLine..block.closeLine) {
            val line = lines[number - 1]
            if (line.to > line.from) marks += LiveMark(line.from, line.to, LiveKind.CODE_FENCE)
            hidden += number
        }
    }
    for (block in displayMathBlocks(text)) {
        if (displayMathIntersects(block, from, to)) continue
        if ((block.openLine..block.closeLine).any { it in hidden }) continue
        val host = lines[block.openLine - 1]
        if (host.to > host.from) marks += LiveMark(host.from, host.to, LiveKind.MATH_BLOCK, block.source)
        hidden += block.openLine
        for (number in (block.openLine + 1)..block.closeLine) {
            concealLine(marks, text, lines[number - 1])
            hidden += number
        }
    }
    for (line in lines) {
        if (line.number in hidden) continue
        markLine(marks, line.text, line.from, line.number in active)
    }
    return marks
}

/**
 * Reading text for an open details card. The source stays in the note and is
 * hidden, the same way the desktop card renders the body with MarkdownPreview.
 */
data class DetailsReadingLine(
    val text: String,
    val scale: Float,
    val heading: Boolean,
    val kind: String = "paragraph",
    val source: String = "",
    val inlines: List<DetailsInline> = emptyList(),
)

/** `.cm-live-details-content .markdown-preview { font-size: .96em }`. */
const val DETAILS_CARD_FONT = 0.96f

/**
 * Heading sizes inside that card. h1 and h2 are the live-preview overrides;
 * h3 and h4 follow `.markdown-preview`. The em is relative to the card font.
 */
fun detailsCardEm(kind: PaperKind): Float = when (kind) {
    PaperKind.H1 -> 1.45f
    PaperKind.H2 -> 1.25f
    PaperKind.H3 -> 1.22f
    PaperKind.H4 -> 1.02f
    else -> 1f
}

fun detailsCardScale(kind: PaperKind): Float = detailsCardEm(kind) * DETAILS_CARD_FONT

/**
 * `.markdown-preview img` is a block at most as wide as the card, with its
 * own aspect ratio, 12px corners, and 1.4em of space above and below.
 * A picture taller than eight card-widths is scaled down so one image cannot
 * stretch the editor without a bound.
 */
const val DETAILS_IMAGE_MAX_RATIO = 8f
const val DETAILS_IMAGE_MARGIN_EM = 1.4f

fun detailsImageMargin(textSizePx: Float): Float {
    val base = if (textSizePx <= 0f) 16f else textSizePx
    return base * DETAILS_CARD_FONT * DETAILS_IMAGE_MARGIN_EM
}

fun detailsImageRadius(textSizePx: Float): Float {
    val base = if (textSizePx <= 0f) 16f else textSizePx
    return (12f * base / 16f).coerceAtLeast(1f)
}

fun detailsImageFrame(pixelWidth: Int, pixelHeight: Int, contentPx: Float): Pair<Float, Float> {
    val column = contentPx.coerceAtLeast(1f)
    if (pixelWidth <= 0 || pixelHeight <= 0) return column to 96f
    var frameW = column
    var frameH = column * pixelHeight.toFloat() / pixelWidth.toFloat()
    val limit = column * DETAILS_IMAGE_MAX_RATIO
    if (frameH > limit && frameH > 0f) {
        val scale = limit / frameH
        frameW *= scale
        frameH = limit
    }
    return frameW to frameH
}

private val DETAILS_NUMBER_MARKER = Regex("""^\d+\.\s+""")

fun detailsListIndent(text: String): String = text.takeWhile { it == ' ' || it == '\t' }

private fun detailsAfterIndent(text: String): String = text.drop(previewReadingListPrefix(text).length)

/** Ordered-list prefix inside a details card. The desktop preview paints this marker in the accent. */
fun detailsNumberMarker(text: String): String = DETAILS_NUMBER_MARKER.find(detailsAfterIndent(text))?.value.orEmpty()

/**
 * Task prefix inside a details card. `true` is checked, `false` is open,
 * and null means the line is not a task marker. Leading indent is skipped.
 */
fun detailsTaskChecked(text: String): Boolean? = when {
    detailsAfterIndent(text).startsWith("☑ ") -> true
    detailsAfterIndent(text).startsWith("☐ ") -> false
    else -> null
}

fun detailsTaskMarker(text: String): String {
    val body = detailsAfterIndent(text)
    return if (detailsTaskChecked(text) == null) "" else body.take(2)
}

/** Block kind drawn inside an open details card, matching the desktop preview. */
fun detailsReadingKind(kind: PaperKind): String = when (kind) {
    PaperKind.H1, PaperKind.H2, PaperKind.H3, PaperKind.H4, PaperKind.H5, PaperKind.H6 -> "heading"
    PaperKind.BULLET -> "bullet"
    PaperKind.NUMBER -> "number"
    PaperKind.QUOTE -> "quote"
    PaperKind.TASK -> "task"
    PaperKind.RULE -> "rule"
    PaperKind.CODE -> "code"
    PaperKind.MATH -> "math"
    PaperKind.IMAGE -> "image"
    PaperKind.TABLE -> "table"
    else -> "paragraph"
}

private fun shiftDetailsInlines(marks: List<DetailsInline>, by: Int): List<DetailsInline> =
    if (by == 0) marks else marks.map { it.copy(start = it.start + by, end = it.end + by) }

private fun styledTableRow(cells: List<String>): Pair<String, List<DetailsInline>> {
    val text = StringBuilder()
    val marks = ArrayList<DetailsInline>()
    cells.forEachIndexed { index, cell ->
        if (index > 0) text.append('\u001f')
        val (plain, inlines) = detailsPlain(cell, autolinks = true)
        val origin = text.length
        marks += inlines.map { it.copy(start = it.start + origin, end = it.end + origin) }
        text.append(plain)
    }
    return text.toString() to marks
}

fun detailsReadingLines(body: String): List<DetailsReadingLine> {
    val lines = readingLines(body, ::detailsCardScale)
    return if (lines.isEmpty()) {
        listOf(DetailsReadingLine("Dieser Klappbereich ist leer.", DETAILS_CARD_FONT, false))
    } else {
        lines
    }
}

/** Schön preview of a whole note: the desktop Markdown preview, not the nested details card. */
fun aiPreviewReading(markdown: String): List<DetailsReadingLine> = readingLines(markdown, ::aiPreviewReadingScale)

private fun readingLines(body: String, scaleOf: (PaperKind) -> Float): List<DetailsReadingLine> {
    val prepared = prepareFootnotes(readingHtml(body))
    val lines = aiPreviewLines(prepared.body).flatMap { line ->
        val scale = scaleOf(line.kind)
        when (line.kind) {
            PaperKind.RULE -> listOf(DetailsReadingLine("", scale, false, "rule"))
            PaperKind.IMAGE -> listOf(
                DetailsReadingLine(
                    paperImageCaption(line.text),
                    scale,
                    false,
                    "image",
                    paperImageSource(line.text),
                ),
            )
            PaperKind.TABLE -> tableRows(line.text).mapIndexedNotNull { index, cells ->
                val row = styledTableRow(cells)
                if (row.first.isBlank()) null
                else DetailsReadingLine(
                    row.first,
                    scale,
                    index == 0,
                    "table",
                    tableAlignWire(line.text),
                    row.second,
                )
            }
            PaperKind.CODE, PaperKind.MATH -> {
                if (line.text.isBlank()) emptyList()
                else listOf(DetailsReadingLine(line.text, scale, false, detailsReadingKind(line.kind)))
            }
            PaperKind.TASK -> {
                val done = line.text.startsWith("x|")
                val rawBody = line.text.substringAfter('|')
                val indent = rawBody.takeWhile { it == ' ' || it == '\t' }
                val (plain, marks) = detailsPlain(rawBody.trimStart(), autolinks = true)
                val box = if (done) "☑ " else "☐ "
                val text = indent + box + plain
                if (plain.isBlank() && text.isBlank()) emptyList()
                else listOf(
                    DetailsReadingLine(
                        text,
                        scale,
                        false,
                        "task",
                        inlines = shiftDetailsInlines(marks, indent.length + box.length),
                    ),
                )
            }
            else -> {
                val bullet = line.kind == PaperKind.BULLET
                val indent = if (bullet) line.text.takeWhile { it == ' ' || it == '\t' } else ""
                val source = if (bullet) line.text.trimStart() else line.text
                val (plain, marks) = detailsPlain(source, autolinks = true)
                if (plain.isBlank()) emptyList()
                else {
                    val text = if (bullet) "$indent• $plain" else plain
                    listOf(
                        DetailsReadingLine(
                            text,
                            scale,
                            aiPreviewHeading(line.kind),
                            detailsReadingKind(line.kind),
                            inlines = if (bullet) shiftDetailsInlines(marks, indent.length + 2) else marks,
                        ),
                    )
                }
            }
        }
    }
    return applyPreviewListPads(lines + footnoteSection(prepared.notes))
}

/**
 * Replaces source spaces on list items with one 1.5em pad per nested level.
 * The preview chrome already insets the first level, so level 1 keeps no pad.
 */
private fun applyPreviewListPads(lines: List<DetailsReadingLine>): List<DetailsReadingLine> {
    val chosen = lines.indices.filter {
        val kind = lines[it].kind
        kind == "bullet" || kind == "number" || kind == "task"
    }
    if (chosen.isEmpty()) return lines
    val indents = chosen.map { lines[it].text.takeWhile { ch -> ch == ' ' || ch == '\t' } }
    val levels = previewListLevels(indents)
    val replaced = HashMap<Int, DetailsReadingLine>(chosen.size)
    chosen.forEachIndexed { position, index ->
        val indent = indents[position]
        val pad = previewListExtraPad(levels[position])
        if (indent == pad) return@forEachIndexed
        val line = lines[index]
        if (indent.isNotEmpty() && !line.text.startsWith(indent)) return@forEachIndexed
        val text = pad + line.text.drop(indent.length)
        val delta = pad.length - indent.length
        val marks = if (delta == 0) {
            line.inlines
        } else {
            line.inlines.mapNotNull { mark ->
                if (mark.end <= indent.length) return@mapNotNull null
                val start = (mark.start + delta).coerceAtLeast(pad.length)
                val end = mark.end + delta
                if (end <= start) null else mark.copy(start = start, end = end)
            }
        }
        replaced[index] = line.copy(text = text, inlines = marks)
    }
    if (replaced.isEmpty()) return lines
    return lines.mapIndexed { index, line -> replaced[index] ?: line }
}

private fun footnoteSection(notes: List<String>): List<DetailsReadingLine> {
    if (notes.isEmpty()) return emptyList()
    val out = ArrayList<DetailsReadingLine>()
    out += DetailsReadingLine("", FOOTNOTE_SCALE, false, "rule")
    notes.forEachIndexed { index, note ->
        val paragraphs = note.split('\n').filter { it.isNotBlank() }.ifEmpty { listOf("") }
        paragraphs.forEachIndexed { paragraphIndex, paragraph ->
            val (plain, marks) = detailsPlain(paragraph.trim(), autolinks = true)
            val prefix = if (paragraphIndex == 0) "${index + 1}. " else ""
            val core = if (prefix.isEmpty()) plain else prefix + plain
            val text = if (paragraphIndex == paragraphs.lastIndex) "$core $FOOTNOTE_RETURN".trim() else core
            out += DetailsReadingLine(
                text,
                FOOTNOTE_SCALE,
                false,
                "footnote",
                inlines = shiftDetailsInlines(marks, prefix.length),
            )
        }
    }
    return out
}

private val FOOTNOTE_HEAD = Regex("""^(\d+)\. """)

/**
 * Which definition a footnote line belongs to. The first paragraph starts with
 * `N. `; later paragraphs of the same note keep that number until the next one.
 */
fun footnoteOwners(texts: List<String>, kinds: List<String>): IntArray {
    val owners = IntArray(texts.size)
    var current = 0
    for (index in texts.indices) {
        if (kinds.getOrElse(index) { "" } != "footnote") {
            current = 0
            continue
        }
        val head = FOOTNOTE_HEAD.find(texts[index])
        if (head != null) current = head.groupValues[1].toInt()
        owners[index] = current
    }
    return owners
}

/** Reading line of definition [number], or null when that note is not listed. */
fun footnoteDefinitionIndex(lines: List<DetailsReadingLine>, number: Int): Int? {
    if (number < 1) return null
    val owners = footnoteOwners(lines.map { it.text }, lines.map { it.kind })
    val index = owners.indexOf(number)
    return index.takeIf { it >= 0 }
}

/** First reading line whose superscript is [number]. */
fun footnoteReferenceIndex(lines: List<DetailsReadingLine>, number: Int): Int? {
    if (number < 1) return null
    val label = number.toString()
    val index = lines.indexOfFirst { line -> footnoteNumberAt(line.text, line.inlines, label) }
    return index.takeIf { it >= 0 }
}

/**
 * Desktop preview anchors: a superscript scrolls to its definition, and the
 * return arrow scrolls back to the first reference. Other characters stay put.
 */
fun footnoteJumpIndex(lines: List<DetailsReadingLine>, lineIndex: Int, offset: Int): Int? {
    val line = lines.getOrNull(lineIndex) ?: return null
    if (offset < 0 || offset > line.text.length) return null
    val number = footnoteNumberAtOffset(line.text, line.inlines, offset)
    if (number != null) return footnoteDefinitionIndex(lines, number)
    if (line.kind != "footnote") return null
    val arrow = line.text.lastIndexOf(FOOTNOTE_RETURN)
    if (arrow < 0 || offset < arrow || offset >= arrow + FOOTNOTE_RETURN.length) return null
    val owner = footnoteOwners(lines.map { it.text }, lines.map { it.kind }).getOrElse(lineIndex) { 0 }
    if (owner < 1) return null
    return footnoteReferenceIndex(lines, owner)
}

private fun footnoteNumberAt(text: String, inlines: List<DetailsInline>, label: String): Boolean =
    inlines.any { mark ->
        mark.kind == "footnote" &&
            text.substring(mark.start.coerceIn(0, text.length), mark.end.coerceIn(0, text.length)) == label
    }

/** Superscript number under [offset], in the coordinates of [text]. */
fun footnoteNumberAtOffset(text: String, inlines: List<DetailsInline>, offset: Int): Int? {
    val mark = inlines.firstOrNull { it.kind == "footnote" && offset >= it.start && offset < it.end } ?: return null
    return text.substring(mark.start.coerceIn(0, text.length), mark.end.coerceIn(0, text.length)).toIntOrNull()
}

fun detailsReading(body: String): String {
    val visible = detailsReadingLines(body).mapNotNull { line ->
        when {
            line.kind == "rule" || line.text.isBlank() -> null
            line.kind == "table" -> line.text.split('\u001f').joinToString(" · ")
            else -> line.text
        }
    }
    return if (visible.isEmpty()) "Dieser Klappbereich ist leer." else visible.joinToString("\n")
}

/** Adds or removes the `open` attribute on the details block covering [offset]. */
fun toggleDetailsOpen(text: String, offset: Int): String? {
    val lines = documentLines(text)
    val block = findDetailsBlocks(text).firstOrNull { offset >= it.from && offset < it.to } ?: return null
    val host = lines.getOrNull(block.startLine - 1) ?: return null
    val match = DETAILS_TAG.find(host.text) ?: return null
    val replacement = if (match.groupValues[1].isNotBlank()) "<details" else "<details open"
    val newLine = host.text.replaceRange(match.range.first, match.range.last + 1, replacement)
    if (newLine == host.text) return null
    return text.replaceRange(host.from, host.to, newLine)
}

/**
 * Flips the task box under [offset], the same three characters the desktop checkbox writes.
 * A tap on the words after the box does not change them.
 */
fun toggleTaskMarker(text: String, offset: Int): String? {
    if (text.isEmpty()) return null
    val clamped = offset.coerceIn(0, text.length)
    val lineStart = if (clamped == 0) 0 else {
        val breakAt = text.lastIndexOf('\n', clamped - 1)
        if (breakAt < 0) 0 else breakAt + 1
    }
    val lineBreak = text.indexOf('\n', lineStart)
    val lineEnd = if (lineBreak < 0) text.length else lineBreak
    val line = text.substring(lineStart, lineEnd)
    val task = TASK.find(line) ?: return null
    val markerStart = lineStart + task.groupValues[1].length
    val markerEnd = lineStart + task.value.length
    if (clamped < markerStart || clamped >= markerEnd) return null
    val box = TASK_BOX.find(task.value.substring(task.groupValues[1].length)) ?: return null
    val at = markerStart + box.range.first
    if (at + 3 > text.length) return null
    val checked = text[at + 1].equals('x', true)
    return text.replaceRange(at, at + 3, if (checked) "[ ]" else "[x]")
}

fun findDetailsBlocks(text: String): List<DetailsBlock> {
    val lines = documentLines(text)
    val blocks = ArrayList<DetailsBlock>()
    var index = 0
    while (index < lines.size) {
        val line = lines[index]
        val inline = DETAILS_INLINE.matchEntire(line.text)
        if (inline != null) {
            blocks += DetailsBlock(
                line.from,
                line.to,
                line.number,
                line.number,
                cleanSummary(inline.groupValues[2]),
                inline.groupValues[3].trim(),
                inline.groupValues[1].isNotBlank(),
            )
            index += 1
            continue
        }
        val opener = DETAILS_OPENER.matchEntire(line.text)
        if (opener == null) {
            index += 1
            continue
        }
        var summary = if (opener.groupValues[2].isNotEmpty()) cleanSummary(opener.groupValues[2]) else ""
        var summaryNumber = line.number
        if (summary.isEmpty() && index + 1 < lines.size) {
            val summaryMatch = SUMMARY_ONLY.matchEntire(lines[index + 1].text)
            if (summaryMatch == null) {
                index += 1
                continue
            }
            summary = cleanSummary(summaryMatch.groupValues[1])
            summaryNumber = lines[index + 1].number
        }
        if (summary.isEmpty()) summary = "Details"
        val summaryIndex = lines.indexOfFirst { it.number == summaryNumber }
        var depth = 1
        var closing = -1
        var candidate = summaryIndex + 1
        while (candidate < lines.size) {
            val candidateText = lines[candidate].text
            depth += DETAILS_OPEN.findAll(candidateText).count() - DETAILS_CLOSE.findAll(candidateText).count()
            if (depth <= 0) {
                closing = candidate
                break
            }
            candidate += 1
        }
        if (closing < 0) {
            index += 1
            continue
        }
        val summaryLine = lines[summaryIndex]
        val closeLine = lines[closing]
        val bodyFrom = minOf(summaryLine.to + 1, closeLine.from).coerceIn(0, text.length)
        val bodyTo = maxOf(bodyFrom, closeLine.from - 1).coerceIn(bodyFrom, text.length)
        blocks += DetailsBlock(
            line.from,
            closeLine.to,
            line.number,
            closeLine.number,
            summary,
            text.substring(bodyFrom, bodyTo).trim(),
            opener.groupValues[1].isNotBlank(),
        )
        index = closing + 1
    }
    return blocks
}

private fun selectionEditsDetails(block: DetailsBlock, from: Int, to: Int): Boolean =
    if (from == to) from > block.from && from < block.to else from < block.to && to > block.from

private fun concealLine(marks: MutableList<LiveMark>, text: String, line: DocLine) {
    val spanEnd = if (line.to < text.length && text[line.to] == '\n') line.to + 1 else line.to
    if (line.to > line.from) marks += LiveMark(line.from, line.to, LiveKind.HIDE)
    if (spanEnd > line.from) marks += LiveMark(line.from, spanEnd, LiveKind.COLLAPSE)
}

private fun cleanSummary(value: String): String {
    val stripped = value.replace(SUMMARY_TAGS, "").replace(SUMMARY_STRONG, "\$1").trim()
    return stripped.ifEmpty { "Details" }
}

private data class DocLine(val number: Int, val from: Int, val to: Int, val text: String)

private fun documentLines(text: String): List<DocLine> {
    val lines = ArrayList<DocLine>()
    var start = 0
    var number = 1
    while (start <= text.length) {
        var end = start
        while (end < text.length && text[end] != '\n') end += 1
        lines += DocLine(number, start, end, text.substring(start, end))
        if (end >= text.length) break
        start = end + 1
        number += 1
    }
    return lines
}

private fun lineNumberAtOffset(text: String, offset: Int): Int {
    var line = 1
    val limit = offset.coerceIn(0, text.length)
    for (index in 0 until limit) if (text[index] == '\n') line += 1
    return line
}

private fun markLine(marks: MutableList<LiveMark>, line: String, origin: Int, active: Boolean) {
    if (line.isEmpty()) return
    if (METADATA_LINE.matches(line) || FAMD_LINE.containsMatchIn(line)) {
        marks += LiveMark(origin, origin + line.length, LiveKind.HIDE)
        marks += LiveMark(origin, origin + line.length, LiveKind.COLLAPSE)
        return
    }
    val heading = HEADING.find(line)
    val quote = if (heading == null) QUOTE.find(line) else null
    val rule = heading == null && quote == null && RULE.matches(line)
    val tableLine = heading == null && quote == null && !rule && TABLE_LINE.matches(line)
    val tableRule = tableLine && TABLE_RULE.matches(line)
    when {
        heading != null -> {
            marks += LiveMark(origin, origin + line.length, headingKind(heading.groupValues[2].length))
            if (!active) hide(marks, origin, heading.groupValues[1].length, heading.value.length)
        }
        quote != null -> {
            marks += LiveMark(origin, origin + line.length, LiveKind.QUOTE)
            if (!active) hide(marks, origin, quote.groupValues[1].length, quote.value.length)
        }
        rule -> {
            marks += LiveMark(origin, origin + line.length, LiveKind.RULE)
            if (!active) marks += LiveMark(origin, origin + line.length, LiveKind.HIDE)
        }
        tableRule -> {
            marks += LiveMark(origin, origin + line.length, LiveKind.TABLE_RULE)
            marks += LiveMark(origin, origin + line.length, LiveKind.HIDE)
        }
        tableLine -> marks += LiveMark(origin, origin + line.length, LiveKind.TABLE_ROW)
    }
    if (!active && !rule && !tableRule) markInline(marks, line, origin)
}

private fun hide(marks: MutableList<LiveMark>, origin: Int, from: Int, to: Int) {
    if (to > from) marks += LiveMark(origin + from, origin + to, LiveKind.HIDE)
}

private fun markInline(marks: MutableList<LiveMark>, line: String, origin: Int) {
    val occupied = ArrayList<Pair<Int, Int>>()
    fun reserve(from: Int, to: Int): Boolean {
        if (from >= to || occupied.any { from < it.second && to > it.first }) return false
        occupied += from to to
        return true
    }
    fun hideLocal(from: Int, to: Int) = hide(marks, origin, from, to)
    fun mark(from: Int, to: Int, kind: LiveKind) {
        if (to > from) marks += LiveMark(origin + from, origin + to, kind)
    }

    val task = TASK.find(line)
    if (task != null) {
        val from = task.groupValues[1].length
        val to = task.value.length
        if (reserve(from, to)) {
            val kind = if (task.groupValues[2].equals("x", true)) LiveKind.TASK_DONE else LiveKind.TASK_OPEN
            marks += LiveMark(origin + from, origin + to, kind)
        }
    } else {
        val bullet = BULLET.find(line)
        if (bullet != null) {
            val from = bullet.groupValues[1].length
            val to = bullet.value.length
            if (reserve(from, to)) marks += LiveMark(origin + from, origin + to, LiveKind.BULLET)
        }
    }
    for (match in CODE.findAll(line)) decorateWrapped(match,  match.groupValues[1].length, LiveKind.CODE, ::reserve, ::hideLocal, ::mark)
    for (match in MATH.findAll(line)) decorateWrapped(match, 1, LiveKind.MATH, ::reserve, ::hideLocal, ::mark)
    for (match in LINK.findAll(line)) {
        val from = match.range.first
        val to = match.range.last + 1
        if (!reserve(from, to)) continue
        val label = match.groupValues[1]
        hideLocal(from, from + 1)
        hideLocal(from + 1 + label.length, to)
        mark(from + 1, from + 1 + label.length, LiveKind.LINK)
    }
    for (match in WIKI.findAll(line)) {
        val from = match.range.first
        val to = match.range.last + 1
        if (!reserve(from, to)) continue
        val alias = match.groupValues[2]
        val label = alias.ifEmpty { match.groupValues[1] }
        val labelFrom = if (alias.isNotEmpty()) from + match.value.indexOf(alias) else from + 2
        hideLocal(from, labelFrom)
        hideLocal(labelFrom + label.length, to)
        mark(labelFrom, labelFrom + label.length, LiveKind.LINK)
    }
    for (match in BOLD.findAll(line)) decorateWrapped(match, 2, LiveKind.STRONG, ::reserve, ::hideLocal, ::mark)
    for (match in STRIKE.findAll(line)) decorateWrapped(match, 2, LiveKind.STRIKE, ::reserve, ::hideLocal, ::mark)
    for (pattern in listOf(ITALIC_STAR, ITALIC_UNDER)) {
        for (match in pattern.findAll(line)) decorateWrapped(match, 1, LiveKind.EMPHASIS, ::reserve, ::hideLocal, ::mark)
    }
}

private fun decorateWrapped(
    match: MatchResult,
    marker: Int,
    kind: LiveKind,
    reserve: (Int, Int) -> Boolean,
    hideLocal: (Int, Int) -> Unit,
    mark: (Int, Int, LiveKind) -> Unit,
) {
    val from = match.range.first
    val to = match.range.last + 1
    if (!reserve(from, to)) return
    hideLocal(from, from + marker)
    hideLocal(to - marker, to)
    mark(from + marker, to - marker, kind)
}

private fun headingKind(level: Int) = when (level) {
    1 -> LiveKind.H1
    2 -> LiveKind.H2
    3 -> LiveKind.H3
    4 -> LiveKind.H4
    5 -> LiveKind.H5
    else -> LiveKind.H6
}

data class CodeFenceBlock(val from: Int, val to: Int, val openLine: Int, val closeLine: Int)

/** Fenced code, including an unclosed fence through the end of the note. */
fun codeFenceBlocks(text: String): List<CodeFenceBlock> {
    if (text.isEmpty()) return emptyList()
    val lines = documentLines(text)
    val blocks = ArrayList<CodeFenceBlock>()
    var index = 0
    while (index < lines.size) {
        val opener = FENCE_OPEN.matchEntire(lines[index].text)
        if (opener == null) {
            index += 1
            continue
        }
        val marker = opener.groupValues[1]
        var close = lines.lastIndex
        var candidate = index + 1
        while (candidate < lines.size) {
            if (isClosingFence(lines[candidate].text, marker[0], marker.length)) {
                close = candidate
                break
            }
            candidate += 1
        }
        val endLine = lines[close]
        blocks += CodeFenceBlock(lines[index].from, endLine.to, lines[index].number, endLine.number)
        index = close + 1
    }
    return blocks
}

private fun isClosingFence(line: String, char: Char, length: Int): Boolean {
    val match = Regex("""^ {0,3}(${Regex.escape(char.toString())}{$length,})\s*$""").matchEntire(line) ?: return false
    return match.groupValues[1].all { it == char }
}

private val FENCE_OPEN = Regex("""^ {0,3}(`{3,}|~{3,})[^`~]*$""")

private val HEADING = Regex("""^(\s*)(#{1,6})\s+""")
private val QUOTE = Regex("""^(\s*)>\s?""")
private val RULE = Regex("""^\s*(?:-{3,}|\*{3,}|_{3,})\s*$""")
private val METADATA_LINE = Regex("""^\s*<!--\s*fanotes-(?:ink|worksheet):[a-zA-Z0-9_-]{1,96}\s*-->\s*$""")
private val FAMD_LINE = Regex("""^\s*<!--\s*fanotes-famd:v1\b""")
private val TABLE_LINE = Regex("""^\s*\|.*\|\s*$""")
private val TABLE_RULE = Regex("""^\s*\|?(?:\s*:?-+:?\s*\|)+\s*$""")
private val TASK = Regex("""^(\s*)[-+*]\s+\[([ xX])]\s+""")
private val TASK_BOX = Regex("""\[([ xX])]""")
private val BULLET = Regex("""^(\s*)[-+*]\s+""")
private val CODE = Regex("""(`+)([^`\n]+?)\1""")
private val MATH = Regex("""(?<!\$)\$([^$\n]+?)\$(?!\$)""")
private val LINK = Regex("""\[([^\]\n]+)]\(([^)\n]+)\)""")
private val WIKI = Regex("""\[\[([^\]\n|]+)(?:\|([^\]\n]+))?]]""")
private val BOLD = Regex("""(\*\*|__)(?=\S)(.+?\S)\1""")
private val STRIKE = Regex("""~~(?=\S)(.+?\S)~~""")
private val ITALIC_STAR = Regex("""(?<!\*)\*(?!\*)(\S(?:.*?\S)?)\*(?!\*)""")
private val ITALIC_UNDER = Regex("""(?<!_)_(?!_)(\S(?:.*?\S)?)_(?!_)""")
private val DETAILS_INLINE = Regex("""^\s*<details(\s+open)?\s*>\s*<summary>(.*?)</summary>\s*(.*?)\s*</details>\s*$""", RegexOption.IGNORE_CASE)
private val DETAILS_OPENER = Regex("""^\s*<details(\s+open)?\s*>(?:\s*<summary>(.*?)</summary>)?\s*$""", RegexOption.IGNORE_CASE)
private val SUMMARY_ONLY = Regex("""^\s*<summary>(.*?)</summary>\s*$""", RegexOption.IGNORE_CASE)
private val DETAILS_CLOSE_LINE = Regex("""^\s*</details\s*>\s*$""", RegexOption.IGNORE_CASE)
private val DETAILS_OPEN = Regex("""<details(?:\s|>)""", RegexOption.IGNORE_CASE)
private val DETAILS_CLOSE = Regex("""</details\s*>""", RegexOption.IGNORE_CASE)
private val DETAILS_TAG = Regex("""<details(\s+open)?""", RegexOption.IGNORE_CASE)
private val SUMMARY_TAGS = Regex("<[^>]*>")
private val SUMMARY_STRONG = Regex("""^(?:\*\*|__)(.*)(?:\*\*|__)$""")
