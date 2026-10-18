package ch.fasrv.fanotes.desk

/**
 * Desktop `toggleTaskLine` / `toggleTasksInView`. An existing box flips.
 * A list item gains a box. A plain line becomes a task. Headings, quotes,
 * tables, rules, and fences stay put. Lines inside an open fence stay put
 * too, including a line that already looks like a task.
 */
private val TASK_LINE = Regex("""^(\s*)([-*+]|\d+[.)])\s+\[([ xX])\](.*)$""")
private val LIST_LINE = Regex("""^(\s*)([-*+]|\d+[.)])\s+(.*)$""")
private val STRUCTURAL_LINE = Regex("""^\s*(?:#{1,6}(?:\s|$)|>(?:\s|$)|[|]|```|~~~|-{3,}\s*$|_{3,}\s*$|\*{3,}\s*$)""")
private val FENCE_LINE = Regex("""^\s*(?:```|~~~)""")
private val LEADING_SPACE = Regex("""^\s*""")

fun toggleTaskLine(line: String): String {
    val task = TASK_LINE.matchEntire(line)
    if (task != null) {
        val mark = if (task.groupValues[3] == " ") "x" else " "
        return "${task.groupValues[1]}${task.groupValues[2]} [$mark]${task.groupValues[4]}"
    }
    if (STRUCTURAL_LINE.containsMatchIn(line)) return line
    val list = LIST_LINE.matchEntire(line)
    if (list != null) return "${list.groupValues[1]}${list.groupValues[2]} [ ] ${list.groupValues[3]}"
    val indent = LEADING_SPACE.find(line)?.value.orEmpty()
    if (line.isBlank()) return "$indent- [ ] "
    return "$indent- [ ] ${line.substring(indent.length)}"
}

fun isFenceLine(line: String): Boolean = FENCE_LINE.containsMatchIn(line)

/** Odd number of fence lines before this one means the fence is still open. */
fun fenceIsOpen(linesBefore: List<String>): Boolean {
    var open = false
    for (line in linesBefore) if (isFenceLine(line)) open = !open
    return open
}

private data class TaskLineSpan(val from: Int, val to: Int, val text: String)

private fun taskLineAt(text: String, pos: Int): TaskLineSpan {
    val safe = pos.coerceIn(0, text.length)
    val from = if (safe == 0) 0 else {
        val newline = text.lastIndexOf('\n', safe - 1)
        if (newline < 0) 0 else newline + 1
    }
    val newline = text.indexOf('\n', from)
    val to = if (newline < 0) text.length else newline
    return TaskLineSpan(from, to, text.substring(from, to))
}

/**
 * Toggles every selected line. A selection that ends on the first column of
 * a line leaves that line out. The caret lands at the end of the last line
 * when anything changed.
 */
fun toggleTasksInNote(text: String, from: Int, to: Int): MarkdownEdit {
    val length = text.length
    val anchor = from.coerceIn(0, length)
    val head = to.coerceIn(0, length)
    val startPos = minOf(anchor, head)
    val endPosRaw = maxOf(anchor, head)
    val startLine = taskLineAt(text, startPos)
    val endProbe = taskLineAt(text, endPosRaw)
    val endPos = if (endPosRaw > startPos && endPosRaw == endProbe.from) (endPosRaw - 1).coerceAtLeast(startPos) else endPosRaw
    val endLine = taskLineAt(text, endPos)

    val before = mutableListOf<String>()
    var scan = 0
    while (scan < startLine.from) {
        val line = taskLineAt(text, scan)
        before += line.text
        if (line.to >= text.length) break
        val next = line.to + 1
        if (next <= scan) break
        scan = next
    }
    var fence = fenceIsOpen(before)
    val lines = mutableListOf<Pair<TaskLineSpan, String>>()
    scan = startLine.from
    while (true) {
        val line = taskLineAt(text, scan)
        var next = line.text
        if (isFenceLine(line.text)) fence = !fence
        else if (!fence) next = toggleTaskLine(line.text)
        lines += line to next
        if (line.from == endLine.from || line.to >= text.length) break
        val nextScan = line.to + 1
        if (nextScan <= scan) break
        scan = nextScan
    }
    if (lines.none { (line, next) -> next != line.text }) return MarkdownEdit(text, anchor, head)

    var delta = 0
    var cursor = endLine.to
    val out = StringBuilder()
    out.append(text, 0, startLine.from)
    lines.forEachIndexed { index, (line, next) ->
        if (line.from == endLine.from) cursor = line.from + delta + next.length
        delta += next.length - line.text.length
        out.append(next)
        if (index != lines.lastIndex) out.append('\n')
    }
    out.append(text, endLine.to, text.length)
    val nextText = out.toString()
    val caret = cursor.coerceIn(0, nextText.length)
    return MarkdownEdit(nextText, caret, caret)
}
