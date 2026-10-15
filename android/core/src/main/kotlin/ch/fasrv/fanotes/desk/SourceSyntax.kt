package ch.fasrv.fanotes.desk

/**
 * Markdown tokens on the caret line, using CodeMirror's `defaultHighlightStyle`.
 * Inactive lines keep the paper live preview. A fenced block stays unparsed
 * except for the language name on its opening line.
 */
enum class SourceSyntax {
    HEADING,
    STRONG,
    EMPHASIS,
    ATOM,
    COMMENT,
    ESCAPE,
}

data class SyntaxMark(val start: Int, val end: Int, val style: SourceSyntax)

/** `#219` from the default style for URLs, link labels, and rules. */
const val SYNTAX_ATOM_ARGB = 0xFF221199.toInt()

/** `#940` for comments. */
const val SYNTAX_COMMENT_ARGB = 0xFF994400.toInt()

/** `#e40` for backslash escapes. */
const val SYNTAX_ESCAPE_ARGB = 0xFFEE4400.toInt()

fun sourceSyntaxMarks(text: String, selectionStart: Int, selectionEnd: Int): List<SyntaxMark> {
    if (text.isEmpty()) return emptyList()
    val from = selectionStart.coerceIn(0, text.length)
    val to = selectionEnd.coerceIn(0, text.length)
    val lines = sourceLines(text)
    val active = setOf(sourceLineAt(lines, minOf(from, to)), sourceLineAt(lines, maxOf(from, to)))
    val fenced = HashSet<Int>()
    for (block in codeFenceBlocks(text)) {
        for (number in block.openLine..block.closeLine) fenced += number
    }
    val occupied = ArrayList<Pair<Int, Int>>()
    val marks = ArrayList<SyntaxMark>()
    fun reserve(start: Int, end: Int): Boolean {
        if (start >= end || occupied.any { start < it.second && end > it.first }) return false
        occupied += start to end
        return true
    }
    fun add(start: Int, end: Int, style: SourceSyntax) {
        if (end > start) marks += SyntaxMark(start, end, style)
    }
    for (comment in COMMENT.findAll(text)) {
        val start = comment.range.first
        val end = comment.range.last + 1
        if (fenced.any { number ->
            val line = lines[number - 1]
            start < line.to && end > line.from
        }) continue
        if (!reserve(start, end)) continue
        for (line in lines) {
            if (line.number !in active || line.number in fenced) continue
            val clipStart = maxOf(start, line.from)
            val clipEnd = minOf(end, line.to)
            add(clipStart, clipEnd, SourceSyntax.COMMENT)
        }
    }
    for (line in lines) {
        if (line.number !in active) continue
        if (line.number in fenced) {
            val opener = FENCE_OPEN.matchEntire(line.text) ?: continue
            val info = opener.groupValues[2].trim()
            if (info.isEmpty()) continue
            val infoAt = line.text.indexOf(info, opener.groupValues[1].length)
            if (infoAt < 0) continue
            val start = line.from + infoAt
            val end = start + info.length
            if (reserve(start, end)) add(start, end, SourceSyntax.ATOM)
            continue
        }
        for (match in CODE.findAll(line.text)) reserve(line.from + match.range.first, line.from + match.range.last + 1)
        for (match in ESCAPE.findAll(line.text)) {
            val start = line.from + match.range.first
            val end = line.from + match.range.last + 1
            if (reserve(start, end)) add(start, end, SourceSyntax.ESCAPE)
        }
        for (match in LINK.findAll(line.text)) {
            val start = line.from + match.range.first
            val end = line.from + match.range.last + 1
            if (!reserve(start, end)) continue
            val label = match.groupValues[1]
            val url = match.groupValues[2].trim()
            add(start + 1, start + 1 + label.length, SourceSyntax.ATOM)
            val urlAt = match.value.lastIndexOf(url)
            if (url.isNotEmpty() && urlAt >= 0) add(start + urlAt, start + urlAt + url.length, SourceSyntax.ATOM)
        }
        for (match in BOLD.findAll(line.text)) markWrapped(line.from, match, 2, SourceSyntax.STRONG, ::reserve, ::add)
        for (pattern in listOf(ITALIC_STAR, ITALIC_UNDER)) {
            for (match in pattern.findAll(line.text)) markWrapped(line.from, match, 1, SourceSyntax.EMPHASIS, ::reserve, ::add)
        }
        val heading = HEADING.find(line.text)
        if (heading != null) {
            val content = line.from + heading.value.length
            for ((gapStart, gapEnd) in uncovered(content, line.to, occupied)) add(gapStart, gapEnd, SourceSyntax.HEADING)
        } else if (RULE.matches(line.text)) {
            if (reserve(line.from, line.to)) add(line.from, line.to, SourceSyntax.ATOM)
        }
    }
    return marks
}

private fun markWrapped(
    origin: Int,
    match: MatchResult,
    marker: Int,
    style: SourceSyntax,
    reserve: (Int, Int) -> Boolean,
    add: (Int, Int, SourceSyntax) -> Unit,
) {
    val start = origin + match.range.first
    val end = origin + match.range.last + 1
    if (!reserve(start, end)) return
    add(start + marker, end - marker, style)
}

private fun uncovered(from: Int, to: Int, occupied: List<Pair<Int, Int>>): List<Pair<Int, Int>> {
    if (from >= to) return emptyList()
    val gaps = ArrayList<Pair<Int, Int>>()
    var cursor = from
    val covering = occupied.filter { it.second > from && it.first < to }.sortedBy { it.first }
    for ((start, end) in covering) {
        val clippedStart = start.coerceAtLeast(from)
        val clippedEnd = end.coerceAtMost(to)
        if (cursor < clippedStart) gaps += cursor to clippedStart
        cursor = maxOf(cursor, clippedEnd)
    }
    if (cursor < to) gaps += cursor to to
    return gaps
}

private data class SourceLine(val number: Int, val from: Int, val to: Int, val text: String)

private fun sourceLines(text: String): List<SourceLine> {
    val lines = ArrayList<SourceLine>()
    var from = 0
    var number = 1
    while (from <= text.length) {
        val newline = text.indexOf('\n', from)
        val to = if (newline < 0) text.length else newline
        lines += SourceLine(number, from, to, text.substring(from, to))
        if (newline < 0) break
        from = newline + 1
        number += 1
    }
    return lines
}

private fun sourceLineAt(lines: List<SourceLine>, offset: Int): Int {
    val at = offset.coerceIn(0, lines.lastOrNull()?.let { if (offset >= it.to) it.to else offset } ?: 0)
    for (line in lines) if (at <= line.to) return line.number
    return lines.last().number
}

private val HEADING = Regex("""^(\s*)(#{1,6})\s+""")
private val RULE = Regex("""^\s*(?:-{3,}|\*{3,}|_{3,})\s*$""")
private val FENCE_OPEN = Regex("""^ {0,3}(`{3,}|~{3,})([^`~\n]*)$""")
private val CODE = Regex("""(`+)([^`\n]+?)\1""")
private val LINK = Regex("""\[([^\]\n]+)]\(([^)\n]+)\)""")
private val BOLD = Regex("""(\*\*|__)(?=\S)(.+?\S)\1""")
private val ITALIC_STAR = Regex("""(?<!\*)\*(?!\*)(\S(?:.*?\S)?)\*(?!\*)""")
private val ITALIC_UNDER = Regex("""(?<!_)_(?!_)(\S(?:.*?\S)?)_(?!_)""")
private val ESCAPE = Regex("""\\[^\n]""")
private val COMMENT = Regex("""<!--[\s\S]*?-->""")
