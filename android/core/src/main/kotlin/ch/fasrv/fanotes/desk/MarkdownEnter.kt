package ch.fasrv.fanotes.desk

/**
 * Enter and Backspace for lists, tasks, and quotes, matching the desktop
 * Markdown keymap (`insertNewlineContinueMarkup` and `deleteMarkupBackward`).
 * Enter also renumbers the following ordered items and splits a tight list
 * before it clears an empty marker. Null means a plain newline or delete.
 */
data class MarkdownCaretEdit(val text: String, val cursor: Int)

fun markdownEnterReplacement(before: String, after: String): MarkdownCaretEdit? {
    val at = insertedSingleNewline(before, after) ?: return null
    return continueMarkdownEnter(before, at)
}

fun markdownBackspaceReplacement(before: String, after: String): MarkdownCaretEdit? {
    val at = deletedSingleChar(before, after) ?: return null
    return deleteMarkdownMarkup(before, at)
}

private fun insertedSingleNewline(before: String, after: String): Int? {
    if (after.length != before.length + 1) return null
    var index = 0
    while (index < before.length && before[index] == after[index]) index++
    if (after.getOrNull(index) != '\n') return null
    if (after.substring(index + 1) != before.substring(index)) return null
    return index
}

private fun deletedSingleChar(before: String, after: String): Int? {
    if (before.length != after.length + 1) return null
    var index = 0
    while (index < after.length && before[index] == after[index]) index++
    if (before.substring(index + 1) != after.substring(index)) return null
    return index + 1
}

fun continueMarkdownEnter(text: String, cursor: Int): MarkdownCaretEdit? {
    if (cursor !in 0..text.length || insideFence(text, cursor)) return null
    val lineStart = lineStartAt(text, cursor)
    val lineEnd = text.indexOf('\n', cursor).let { if (it < 0) text.length else it }
    val line = text.substring(lineStart, lineEnd)
    val column = cursor - lineStart
    val clearedQuotes = clearAlignedEmptyQuotes(text, lineStart, line, cursor)
    if (clearedQuotes != null) return clearedQuotes
    val scan = EnterScan(text)
    val lineIndex = scan.lineIndexAt(lineStart)
    val active = scan.keptMarks(lineIndex).filter { it.fromCol < column }
    if (active.isNotEmpty()) {
        val inner = active.last()
        if (column < inner.contentCol) return null
        val item = active.lastOrNull { it.kind != EnterKind.QUOTE }
        if (item != null && line.substring(item.toCol.coerceAtMost(line.length)).none { !it.isWhitespace() }) {
            return emptyItemEnter(scan, item, cursor)
        }
        if (item == null) {
            val owner = openList(scan, lineIndex, contentColumn(line))
            if (owner != null) {
                if (contentColumn(line) >= owner.toCol && line.any { !it.isWhitespace() && it != '>' }) {
                    return continueIndentedLine(scan, lineIndex, line, lineStart, cursor)
                }
                return null
            }
        }
        return continueMarkedLine(scan, active, item, lineStart, cursor)
    }
    return continueIndentedLine(scan, lineIndex, line, lineStart, cursor)
}

private fun clearAlignedEmptyQuotes(text: String, lineStart: Int, line: String, cursor: Int): MarkdownCaretEdit? {
    val parsed = parseLeadingMarkup(line) ?: return null
    if (parsed.body.isNotBlank() || parsed.listMarker.isNotEmpty() || parsed.quotes.isEmpty()) return null
    val previous = previousLine(text, lineStart) ?: return null
    if (!quoteOnly(previous)) return null
    val prevStart = lineStart - previous.length - 1
    val clearedPrev = previous.removeQuote()
    val cleared = parsed.withoutInnermost()
    val next = text.substring(0, prevStart) + clearedPrev + "\n" + cleared + text.substring(cursor)
    return MarkdownCaretEdit(next, prevStart + clearedPrev.length + 1 + cleared.length)
}

private enum class EnterKind { QUOTE, BULLET, ORDERED }

private data class EnterMark(
    val lineIndex: Int,
    val lineStart: Int,
    val fromCol: Int,
    val toCol: Int,
    val contentCol: Int,
    val spaceBefore: String,
    val spaceAfter: String,
    val kind: EnterKind,
    val bullet: String,
    val task: String,
    val number: Int,
    val delim: String,
    val quotePrefix: String,
    val needsParent: Boolean,
) {
    fun nextCore(): String = when (kind) {
        EnterKind.ORDERED -> "${number + 1}$delim$spaceAfter"
        EnterKind.BULLET -> bullet + task.replace(Regex("[xX]"), " ") + spaceAfter
        EnterKind.QUOTE -> ">$spaceAfter"
    }
}

private data class EnterEdit(val from: Int, val to: Int, val insert: String)

private class EnterScan(val text: String) {
    val starts: List<Int>
    val lines: List<String>
    private val parsed: List<List<EnterMark>>

    init {
        val startList = ArrayList<Int>()
        startList += 0
        for (index in text.indices) if (text[index] == '\n') startList += index + 1
        starts = startList
        lines = starts.mapIndexed { index, start ->
            val end = if (index + 1 < starts.size) starts[index + 1] - 1 else text.length
            text.substring(start, end)
        }
        val raw = lines.mapIndexed { index, line -> parseEnterLine(line, index, starts[index]) }
        parsed = raw.mapIndexed { index, marks ->
            marks.filter { mark ->
                if (!mark.needsParent) true
                else (0 until index).any { prev ->
                    raw[prev].any {
                        it.kind != EnterKind.QUOTE && it.quotePrefix == mark.quotePrefix &&
                            it.toCol <= mark.fromCol && it.fromCol < mark.fromCol
                    }
                }
            }
        }
    }

    fun lineIndexAt(lineStart: Int): Int = starts.indexOf(lineStart).coerceAtLeast(0)

    fun keptMarks(lineIndex: Int): List<EnterMark> = parsed.getOrElse(lineIndex) { emptyList() }

    fun listMarks(lineIndex: Int): List<EnterMark> = keptMarks(lineIndex).filter { it.kind != EnterKind.QUOTE }

    fun findParent(item: EnterMark): EnterMark? {
        for (index in item.lineIndex - 1 downTo 0) {
            val parent = listMarks(index).lastOrNull {
                it.quotePrefix == item.quotePrefix && it.toCol <= item.fromCol && it.fromCol < item.fromCol
            }
            if (parent != null) return parent
        }
        return null
    }

    fun parentChain(item: EnterMark): List<EnterMark> {
        val chain = ArrayList<EnterMark>()
        var current = item
        while (true) {
            val parent = findParent(current) ?: break
            chain += parent
            current = parent
        }
        chain.reverse()
        return chain
    }

    fun previousSiblings(item: EnterMark): List<EnterMark> = collectSiblings(item, forward = false)

    fun followingSiblings(item: EnterMark): List<EnterMark> = collectSiblings(item, forward = true)

    private fun collectSiblings(item: EnterMark, forward: Boolean): List<EnterMark> {
        val found = ArrayList<EnterMark>()
        var index = if (forward) item.lineIndex + 1 else item.lineIndex - 1
        while (index in lines.indices) {
            when (val step = classify(index, item)) {
                is EnterSibling -> found += step.mark
                EnterSkip -> Unit
                EnterStop -> break
            }
            index += if (forward) 1 else -1
        }
        if (!forward) found.reverse()
        return found
    }

    private fun classify(lineIndex: Int, item: EnterMark): EnterStep {
        val lists = listMarks(lineIndex)
        val sibling = lists.firstOrNull { sameList(it, item) }
        if (sibling != null) return EnterSibling(sibling)
        if (lists.any { it.quotePrefix == item.quotePrefix && it.fromCol > item.fromCol }) return EnterSkip
        if (lists.any { it.fromCol < item.fromCol }) return EnterStop
        val line = lines[lineIndex]
        if (line.all { it.isWhitespace() || it == '>' }) return EnterSkip
        if (contentColumn(line) >= item.toCol) return EnterSkip
        return EnterStop
    }
}

private sealed interface EnterStep
private class EnterSibling(val mark: EnterMark) : EnterStep
private data object EnterSkip : EnterStep
private data object EnterStop : EnterStep

private fun sameList(left: EnterMark, right: EnterMark): Boolean {
    if (left.kind == EnterKind.QUOTE || right.kind == EnterKind.QUOTE) return false
    if (left.quotePrefix != right.quotePrefix || left.fromCol != right.fromCol || left.kind != right.kind) return false
    return if (left.kind == EnterKind.ORDERED) left.delim == right.delim else left.bullet == right.bullet
}

private fun contentColumn(line: String): Int {
    var index = 0
    while (index < line.length) {
        when (line[index]) {
            '>' -> {
                index++
                if (index < line.length && line[index] == ' ') index++
            }
            ' ', '\t' -> index++
            else -> break
        }
    }
    return index
}

private fun parseEnterLine(line: String, lineIndex: Int, lineStart: Int): List<EnterMark> {
    val marks = ArrayList<EnterMark>()
    var index = 0
    var leading = ""
    while (index < line.length && line[index] == ' ') {
        leading += line[index]
        index++
    }
    if (index < line.length && line[index] == '>' && leading.length <= 3) {
        var quoteBefore = leading
        while (index < line.length && line[index] == '>') {
            val from = index
            index++
            var spaceAfter = ""
            if (index < line.length && line[index] == ' ') {
                spaceAfter = " "
                index++
            }
            marks += EnterMark(
                lineIndex, lineStart, from, index, from + 1, quoteBefore, spaceAfter,
                EnterKind.QUOTE, "", "", 0, "", "", false,
            )
            quoteBefore = ""
        }
    } else {
        index = 0
    }
    val quotePrefix = line.substring(0, index.coerceAtMost(line.length))
    val indentStart = index
    while (index < line.length && (line[index] == ' ' || line[index] == '\t')) index++
    val indent = line.substring(indentStart, index)
    if (index >= line.length) return marks
    val bullet = BULLET_MARK.matchAt(line, index)
    val ordered = if (bullet == null) ORDERED_MARK.matchAt(line, index) else null
    val match = bullet ?: ordered ?: return marks
    var spaceAfter = match.groupValues[3]
    var end = index + match.value.length
    if (spaceAfter.length >= 4) {
        val keep = spaceAfter.length - 4
        end -= 4
        spaceAfter = spaceAfter.substring(0, keep)
    }
    val from = index
    val task = if (bullet != null) match.groupValues[2] else ""
    marks += EnterMark(
        lineIndex,
        lineStart,
        from,
        end,
        end - spaceAfter.length,
        indent,
        spaceAfter,
        if (ordered != null) EnterKind.ORDERED else EnterKind.BULLET,
        if (bullet != null) match.groupValues[1] else "",
        task,
        ordered?.groupValues?.get(1)?.toIntOrNull() ?: 0,
        if (ordered != null) match.groupValues[2] else "",
        quotePrefix,
        indent.length >= 4,
    )
    return marks
}

private val BULLET_MARK = Regex("""([-+*])( {1,4}\[[ xX]])?([ \t]+)""")
private val ORDERED_MARK = Regex("""(\d+)([.)])([ \t]+)""")

private fun emptyItemEnter(scan: EnterScan, item: EnterMark, cursor: Int): MarkdownCaretEdit {
    val line = scan.lines[item.lineIndex]
    val previous = if (item.lineIndex > 0) scan.lines[item.lineIndex - 1] else null
    val previousHasContent = previous != null && previous.any { it != ' ' && it != '\t' && it != '>' }
    if (scan.previousSiblings(item).size == 1 && previousHasContent) {
        val blank = ancestorBlank(scan, item)
        val insert = blank + "\n"
        val next = scan.text.substring(0, item.lineStart) + insert + scan.text.substring(item.lineStart)
        return MarkdownCaretEdit(next, cursor + insert.length)
    }
    val parent = scan.findParent(item)
    val insert = if (parent != null) parent.spaceBefore + parent.nextCore() else ""
    val fromCol = if (parent != null) parent.fromCol - parent.spaceBefore.length else quoteEnd(line)
    val from = item.lineStart + fromCol
    val edits = ArrayList<EnterEdit>()
    edits += EnterEdit(from, cursor, insert)
    edits += renumberEdits(item.number, scan.followingSiblings(item), -1)
    if (parent != null && parent.kind == EnterKind.ORDERED) {
        edits += renumberEdits(parent.number, scan.followingSiblings(parent), 1)
    }
    return finishEnter(scan.text, edits, edits.first())
}

private fun continueMarkedLine(
    scan: EnterScan,
    active: List<EnterMark>,
    item: EnterMark?,
    lineStart: Int,
    cursor: Int,
): MarkdownCaretEdit {
    var from = cursor
    while (from > lineStart && scan.text[from - 1].isWhitespace()) from--
    val marker = markedInsert(scan, active)
    val looseBlank = if (item != null && listIsLoose(scan, item)) ancestorBlank(scan, item) + "\n" else ""
    val inserted = "\n" + looseBlank + marker
    val edits = ArrayList<EnterEdit>()
    edits += EnterEdit(from, cursor, inserted)
    if (item != null && item.kind == EnterKind.ORDERED) {
        edits += renumberEdits(item.number, scan.followingSiblings(item), 1)
    }
    return finishEnter(scan.text, edits, edits.first())
}

private fun continueIndentedLine(
    scan: EnterScan,
    lineIndex: Int,
    line: String,
    lineStart: Int,
    cursor: Int,
): MarkdownCaretEdit? {
    if (line.none { !it.isWhitespace() }) return null
    val owner = openList(scan, lineIndex, contentColumn(line)) ?: return null
    var from = cursor
    while (from > lineStart && scan.text[from - 1].isWhitespace()) from--
    val prefix = if (owner.quotePrefix.isEmpty()) {
        " ".repeat(owner.toCol)
    } else {
        val filled = StringBuilder(owner.quotePrefix)
        while (filled.length < owner.toCol) filled.append(' ')
        filled.toString()
    }
    val inserted = "\n$prefix"
    val next = scan.text.substring(0, from) + inserted + scan.text.substring(cursor)
    return MarkdownCaretEdit(next, from + inserted.length)
}

private fun openList(scan: EnterScan, lineIndex: Int, column: Int): EnterMark? {
    for (index in lineIndex - 1 downTo 0) {
        val item = scan.listMarks(index).lastOrNull { column >= it.toCol } ?: continue
        if (column < item.toCol) continue
        var open = true
        for (between in index + 1 until lineIndex) {
            if (scan.classifyOpen(between, item)) continue
            open = false
            break
        }
        if (open) return item
    }
    return null
}

private fun EnterScan.classifyOpen(lineIndex: Int, item: EnterMark): Boolean {
    val lists = listMarks(lineIndex)
    if (lists.any { sameList(it, item) || it.fromCol <= item.fromCol }) return false
    val line = lines[lineIndex]
    if (line.all { it.isWhitespace() || it == '>' }) return true
    return contentColumn(line) >= item.toCol
}

private fun listIsLoose(scan: EnterScan, item: EnterMark): Boolean {
    val all = scan.previousSiblings(item) + item + scan.followingSiblings(item)
    if (all.size < 2) return false
    val first = all[0]
    val second = all[1]
    for (index in first.lineIndex + 1 until second.lineIndex) {
        if (scan.lines[index].all { it.isWhitespace() || it == '>' }) return true
    }
    return false
}

private fun ancestorBlank(scan: EnterScan, item: EnterMark): String {
    val quotes = scan.keptMarks(item.lineIndex).filter { it.kind == EnterKind.QUOTE && it.fromCol < item.fromCol }
    val ancestors = quotes + scan.parentChain(item)
    if (ancestors.isEmpty()) return ""
    val blank = StringBuilder()
    for (index in ancestors.indices) {
        val mark = ancestors[index]
        val last = index == ancestors.lastIndex
        if (mark.kind == EnterKind.QUOTE) {
            var piece = mark.spaceBefore + ">"
            if (!last) {
                val target = ancestors[index + 1].fromCol
                while (blank.length + piece.length < target) piece += " "
            }
            blank.append(piece)
        } else {
            val glyphs = if (mark.kind == EnterKind.ORDERED) "${mark.number}${mark.delim}" else mark.bullet + mark.task
            val width = mark.spaceBefore.length + glyphs.length + if (!last) mark.spaceAfter.length else 0
            blank.append(" ".repeat(width))
        }
    }
    return blank.toString()
}

private fun markedInsert(scan: EnterScan, marks: List<EnterMark>): String {
    val insert = StringBuilder()
    for (index in marks.indices) {
        val mark = marks[index]
        if (index == marks.lastIndex) {
            val space = inheritedQuoteSpace(scan, mark)
            val core = if (mark.kind == EnterKind.QUOTE && mark.spaceAfter.isEmpty()) ">$space" else mark.nextCore()
            if (index == 0) insert.append(mark.spaceBefore)
            insert.append(core)
        } else {
            val target = marks[index + 1].fromCol
            if (mark.kind == EnterKind.QUOTE) {
                var piece = mark.spaceBefore + ">"
                while (insert.length + piece.length < target) piece += " "
                insert.append(piece)
            } else {
                while (insert.length < target) insert.append(' ')
            }
        }
    }
    return insert.toString()
}

private fun inheritedQuoteSpace(scan: EnterScan, mark: EnterMark): String {
    if (mark.kind != EnterKind.QUOTE || mark.spaceAfter.isNotEmpty()) return mark.spaceAfter
    for (index in mark.lineIndex - 1 downTo 0) {
        val quote = scan.keptMarks(index).firstOrNull { it.kind == EnterKind.QUOTE && it.fromCol == mark.fromCol }
            ?: break
        if (quote.spaceAfter.isNotEmpty()) return quote.spaceAfter
    }
    return ""
}

private fun renumberEdits(startNumber: Int, items: List<EnterMark>, delta: Int): List<EnterEdit> {
    if (delta == 0) return emptyList()
    val edits = ArrayList<EnterEdit>()
    var previous = startNumber
    for (item in items) {
        if (item.kind != EnterKind.ORDERED) break
        if (item.number != previous + 1) break
        val digits = item.number.toString()
        val from = item.lineStart + item.fromCol
        edits += EnterEdit(from, from + digits.length, (item.number + delta).toString())
        previous = item.number
    }
    return edits
}

private fun quoteEnd(line: String): Int {
    var index = 0
    while (index < line.length && line[index] == ' ') index++
    var end = index
    if (index > 3) return 0
    while (index < line.length && line[index] == '>') {
        index++
        end = index
        if (index < line.length && line[index] == ' ') {
            index++
            end = index
        }
    }
    return end
}

private fun finishEnter(text: String, edits: List<EnterEdit>, primary: EnterEdit): MarkdownCaretEdit {
    var next = text
    for (edit in edits.sortedWith(compareByDescending<EnterEdit> { it.from }.thenByDescending { it.to })) {
        val to = edit.to.coerceIn(edit.from, next.length)
        next = next.substring(0, edit.from.coerceIn(0, next.length)) + edit.insert + next.substring(to)
    }
    var cursor = primary.from + primary.insert.length
    for (edit in edits) {
        if (edit === primary) continue
        if (edit.to <= primary.from) cursor += edit.insert.length - (edit.to - edit.from)
    }
    return MarkdownCaretEdit(next, cursor.coerceIn(0, next.length))
}

/** Backspace directly after list or quote markup removes one level. A list marker becomes spaces first. */
fun deleteMarkdownMarkup(text: String, cursor: Int): MarkdownCaretEdit? {
    if (cursor !in 1..text.length || insideFence(text, cursor)) return null
    val lineStart = lineStartAt(text, cursor)
    val lineEnd = text.indexOf('\n', cursor).let { if (it < 0) text.length else it }
    val line = text.substring(lineStart, lineEnd)
    val column = cursor - lineStart
    val parsed = parseLeadingMarkup(line) ?: return null
    if (column != parsed.markerEnd) return null
    val replacement = if (parsed.listMarker.any { !it.isWhitespace() }) {
        parsed.quotes + parsed.indent + " ".repeat((parsed.markerEnd - parsed.quotes.length - parsed.indent.length).coerceAtLeast(0))
    } else {
        parsed.withoutInnermost()
    }
    val next = text.substring(0, lineStart) + replacement + text.substring(cursor)
    return MarkdownCaretEdit(next, lineStart + replacement.length)
}

private data class LeadingMarkup(
    val quotes: String,
    val indent: String,
    val listMarker: String,
    val body: String,
    val markerEnd: Int,
) {
    fun withoutInnermost(): String = when {
        listMarker.isNotEmpty() -> quotes + indent
        quotes.isNotEmpty() -> quotes.replace(Regex("""> ?$"""), "") + indent
        else -> indent
    }
}

private fun parseLeadingMarkup(line: String): LeadingMarkup? {
    var rest = line
    val quotes = StringBuilder()
    while (true) {
        val quote = QUOTE.find(rest) ?: break
        quotes.append(quote.value)
        rest = rest.substring(quote.value.length)
    }
    val indent = INDENT.find(rest)?.value.orEmpty()
    rest = rest.substring(indent.length)
    val bullet = BULLET.find(rest)
    val ordered = if (bullet == null) ORDERED.find(rest) else null
    val list = bullet?.value ?: ordered?.value.orEmpty()
    if (quotes.isEmpty() && list.isEmpty()) return null
    val body = rest.substring(list.length)
    return LeadingMarkup(quotes.toString(), indent, list, body, quotes.length + indent.length + list.length)
}

private val QUOTE = Regex("""^> ?""")
private val INDENT = Regex("""^[ \t]*""")
private val BULLET = Regex("""^[-+*](?: {1,4}\[[ xX]])?[ \t]+""")
private val ORDERED = Regex("""^(\d+)([.)])([ \t]+)""")

private fun lineStartAt(text: String, cursor: Int): Int {
    if (cursor == 0) return 0
    val found = text.lastIndexOf('\n', cursor - 1)
    return if (found < 0) 0 else found + 1
}

private fun previousLine(text: String, lineStart: Int): String? {
    if (lineStart <= 0) return null
    val prevEnd = lineStart - 1
    val prevStart = text.lastIndexOf('\n', (prevEnd - 1).coerceAtLeast(0)).let { if (it < 0) 0 else it + 1 }
    return text.substring(prevStart, prevEnd)
}

private fun quoteOnly(line: String): Boolean {
    val parsed = parseLeadingMarkup(line) ?: return false
    return parsed.listMarker.isEmpty() && parsed.quotes.isNotEmpty() && parsed.body.isBlank()
}

private fun String.removeQuote(): String {
    val parsed = parseLeadingMarkup(this) ?: return this
    return parsed.withoutInnermost() + parsed.body
}

private fun insideFence(text: String, cursor: Int): Boolean {
    val fence = Regex("""^ {0,3}```""")
    var open = false
    var index = 0
    while (index < cursor) {
        val end = text.indexOf('\n', index).let { if (it < 0 || it > cursor) cursor else it }
        val line = text.substring(index, end)
        if (fence.find(line)?.range?.first == 0) open = !open
        if (end >= cursor) break
        index = end + 1
    }
    return open
}
