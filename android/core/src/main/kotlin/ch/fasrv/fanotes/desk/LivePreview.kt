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
}

data class LiveMark(val start: Int, val end: Int, val kind: LiveKind)

fun livePreviewMarks(text: String, selectionStart: Int, selectionEnd: Int): List<LiveMark> {
    if (text.isEmpty()) return emptyList()
    val from = selectionStart.coerceIn(0, text.length)
    val to = selectionEnd.coerceIn(0, text.length)
    val active = setOf(lineNumberAtOffset(text, minOf(from, to)), lineNumberAtOffset(text, maxOf(from, to)))
    val marks = ArrayList<LiveMark>()
    var lineStart = 0
    var lineNumber = 1
    while (lineStart <= text.length) {
        var lineEnd = lineStart
        while (lineEnd < text.length && text[lineEnd] != '\n') lineEnd += 1
        markLine(marks, text.substring(lineStart, lineEnd), lineStart, lineNumber in active)
        if (lineEnd >= text.length) break
        lineStart = lineEnd + 1
        lineNumber += 1
    }
    return marks
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
    val tableRule = heading == null && quote == null && !rule && TABLE_RULE.matches(line)
    when {
        heading != null -> {
            marks += LiveMark(origin, origin + line.length, headingKind(heading.groupValues[2].length))
            if (!active) hide(marks, origin, heading.groupValues[1].length, heading.value.length)
        }
        quote != null -> {
            marks += LiveMark(origin, origin + line.length, LiveKind.QUOTE)
            if (!active) hide(marks, origin, quote.groupValues[1].length, quote.value.length)
        }
        rule && !active -> marks += LiveMark(origin, origin + line.length, LiveKind.HIDE)
        tableRule -> marks += LiveMark(origin, origin + line.length, LiveKind.HIDE)
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
private val TABLE_RULE = Regex("""^\s*\|?(?:\s*:?-+:?\s*\|)+\s*$""")
private val TASK = Regex("""^(\s*)[-+*]\s+\[([ xX])]\s+""")
private val BULLET = Regex("""^(\s*)[-+*]\s+""")
private val CODE = Regex("""(`+)([^`\n]+?)\1""")
private val MATH = Regex("""(?<!\$)\$([^$\n]+?)\$(?!\$)""")
private val LINK = Regex("""\[([^\]\n]+)]\(([^)\n]+)\)""")
private val WIKI = Regex("""\[\[([^\]\n|]+)(?:\|([^\]\n]+))?]]""")
private val BOLD = Regex("""(\*\*|__)(?=\S)(.+?\S)\1""")
private val STRIKE = Regex("""~~(?=\S)(.+?\S)~~""")
private val ITALIC_STAR = Regex("""(?<!\*)\*(?!\*)(\S(?:.*?\S)?)\*(?!\*)""")
private val ITALIC_UNDER = Regex("""(?<!_)_(?!_)(\S(?:.*?\S)?)_(?!_)""")
