package ch.fasrv.fanotes.desk

/**
 * Alt-Left and Alt-Right move by a Markdown construct, the way the desktop
 * editor's `cursorSyntaxLeft` and `cursorSyntaxRight` leave a plain paragraph,
 * a link, code, or a fenced block. Shift keeps the anchor.
 */
fun editorSyntaxSelection(
    text: String,
    anchor: Int,
    head: Int,
    forward: Boolean,
    extend: Boolean,
): Pair<Int, Int> {
    val safeAnchor = anchor.coerceIn(0, text.length)
    val safeHead = head.coerceIn(0, text.length)
    val next = moveByMarkdownSyntax(text, safeHead, forward)
    return if (extend) safeAnchor to next else next to next
}

fun moveByMarkdownSyntax(text: String, head: Int, forward: Boolean): Int {
    if (text.isEmpty()) return 0
    val pos = head.coerceIn(0, text.length)
    val root = markdownSyntaxRoot(text)
    var node = resolveInner(root, pos)
    var at = pos
    while (true) {
        val next = if (forward) node.children.firstOrNull { it.to > at } else node.children.lastOrNull { it.from < at }
        if (next == null) break
        node = next
    }
    var landing = if (forward) node.to else node.from
    if (landing == pos) {
        var parent = node.parent
        while (parent != null && (if (forward) parent.to else parent.from) == pos) parent = parent.parent
        if (parent != null) landing = if (forward) parent.to else parent.from
    }
    return landing.coerceIn(0, text.length)
}

private class SynNode(
    val from: Int,
    val to: Int,
    val children: MutableList<SynNode> = mutableListOf(),
    var parent: SynNode? = null,
)

private fun resolveInner(root: SynNode, pos: Int): SynNode {
    var node = root
    while (true) {
        val child = node.children.firstOrNull { pos >= it.from && pos < it.to } ?: return node
        node = child
    }
}

private fun markdownSyntaxRoot(text: String): SynNode {
    val root = SynNode(0, text.length)
    val lines = syntaxLines(text)
    val fences = codeFenceBlocks(text)
    var index = 0
    while (index < lines.size) {
        val line = lines[index]
        val fence = fences.firstOrNull { line.from >= it.from && line.from < it.to }
        if (fence != null) {
            addNode(root, fence.from, fence.to)
            index = lines.indexOfFirst { it.from >= fence.to }.let { if (it < 0) lines.size else it }
            continue
        }
        if (line.text.isBlank()) {
            index += 1
            continue
        }
        if (HEADING.containsMatchIn(line.text) || RULE.matches(line.text) || OWN_LINE.containsMatchIn(line.text)) {
            addNode(root, line.from, line.to, inlineNodes(text, line.from, line.to))
            index += 1
            continue
        }
        val start = line.from
        var end = line.to
        index += 1
        while (index < lines.size) {
            val next = lines[index]
            if (next.text.isBlank()) break
            if (fences.any { next.from >= it.from && next.from < it.to }) break
            if (HEADING.containsMatchIn(next.text) || RULE.matches(next.text) || OWN_LINE.containsMatchIn(next.text)) break
            end = next.to
            index += 1
        }
        addNode(root, start, end, inlineNodes(text, start, end))
    }
    return root
}

private fun addNode(parent: SynNode, from: Int, to: Int, children: List<Pair<Int, Int>> = emptyList()) {
    if (to <= from) return
    val node = SynNode(from, to)
    node.parent = parent
    for ((childFrom, childTo) in children) {
        if (childTo <= childFrom) continue
        val child = SynNode(childFrom, childTo)
        child.parent = node
        node.children += child
    }
    parent.children += node
}

private fun inlineNodes(text: String, from: Int, to: Int): List<Pair<Int, Int>> {
    val occupied = ArrayList<Pair<Int, Int>>()
    val found = ArrayList<Pair<Int, Int>>()
    fun take(start: Int, end: Int) {
        if (start < from || end > to || start >= end) return
        if (occupied.any { start < it.second && end > it.first }) return
        occupied += start to end
        found += start to end
    }
    var lineFrom = from
    while (lineFrom < to) {
        val newline = text.indexOf('\n', lineFrom).let { if (it < 0 || it > to) to else it }
        val line = text.substring(lineFrom, newline)
        for (pattern in INLINE) {
            for (match in pattern.findAll(line)) {
                take(lineFrom + match.range.first, lineFrom + match.range.last + 1)
            }
        }
        if (newline >= to) break
        lineFrom = newline + 1
    }
    return found.sortedBy { it.first }
}

private data class SyntaxLine(val from: Int, val to: Int, val text: String)

private fun syntaxLines(text: String): List<SyntaxLine> {
    val lines = ArrayList<SyntaxLine>()
    var from = 0
    while (from <= text.length) {
        val newline = text.indexOf('\n', from)
        val to = if (newline < 0) text.length else newline
        lines += SyntaxLine(from, to, text.substring(from, to))
        if (newline < 0) break
        from = newline + 1
    }
    return lines
}

private val HEADING = Regex("""^(\s*)(#{1,6})\s+""")
private val RULE = Regex("""^\s*(?:-{3,}|\*{3,}|_{3,})\s*$""")
private val OWN_LINE = Regex("""^\s*(?:>|[-+*]|\d+[.)])\s+""")
private val INLINE = listOf(
    Regex("""(`+)([^`\n]+?)\1"""),
    Regex("""!?\[[^\]\n]+]\([^)\n]+\)"""),
    Regex("""(\*\*|__)(?=\S)(.+?\S)\1"""),
    Regex("""(?<!\*)\*(?!\*)(\S(?:.*?\S)?)\*(?!\*)"""),
    Regex("""(?<!_)_(?!_)(\S(?:.*?\S)?)_(?!_)"""),
)
