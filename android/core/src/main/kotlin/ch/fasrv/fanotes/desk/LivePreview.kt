package ch.fasrv.fanotes.desk

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
        val visibleBody = ArrayList<Int>()
        hidden += block.startLine
        for (number in (block.startLine + 1)..block.endLine) {
            val line = lines[number - 1]
            val tag = SUMMARY_ONLY.matches(line.text) || DETAILS_CLOSE_LINE.matches(line.text)
            if (!block.open || tag) {
                concealLine(marks, text, line)
                hidden += number
            } else if (line.to > line.from) {
                visibleBody += number
            }
        }
        if (host.to > host.from) {
            val inlineBody = if (block.open && block.startLine == block.endLine) block.body else ""
            marks += LiveMark(
                host.from,
                host.to,
                LiveKind.DETAILS_SUMMARY,
                block.summary,
                inlineBody,
                open = block.open,
                continues = visibleBody.isNotEmpty(),
            )
        }
        visibleBody.forEachIndexed { index, number ->
            val line = lines[number - 1]
            val kind = if (index == visibleBody.lastIndex) LiveKind.DETAILS_END else LiveKind.DETAILS_BODY
            marks += LiveMark(line.from, line.to, kind)
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
