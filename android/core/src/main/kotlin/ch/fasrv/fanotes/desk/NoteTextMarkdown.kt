package ch.fasrv.fanotes.desk

/**
 * Markdown for keyboard text boxes on notes and PDFs, the dialect of `fanotes/src/lib/noteTextMarkdown.ts` and
 * `NoteTextFieldMarkdown.tsx` (GFM through react-markdown, a little stricter):
 *
 * - a single line break stays a line break (as typed in the old textarea),
 * - indentation never turns a line into a code block,
 * - HTML is never interpreted; `<b>` stays the literal text `<b>`,
 * - images are never loaded; their alt text is shown,
 * - only web and mail links open.
 *
 * A box keeps its raw Markdown in `NoteTextField.text`; this only reads it for drawing. The result is a list of
 * blocks with styled inline text that the app turns into spans.
 */

enum class NoteTextInlineStyle { BOLD, ITALIC, STRIKE, CODE, LINK }

/** A style over `[start, end)` of a block's text. [href] is set for an openable link only. */
data class NoteTextSpan(val start: Int, val end: Int, val style: NoteTextInlineStyle, val href: String? = null)

data class NoteTextInline(val text: String, val spans: List<NoteTextSpan> = emptyList())

sealed class NoteTextBlock {
    data class Heading(val level: Int, val inline: NoteTextInline) : NoteTextBlock()
    data class Paragraph(val inline: NoteTextInline, val quoteDepth: Int = 0) : NoteTextBlock()

    /**
     * One list item. [depth] counts nested lists from 0. [number] is set for an ordered item. [task] is null for a
     * plain item, else whether it is ticked; [line] is its 1-based source line for [toggleNoteTextTask].
     */
    data class Item(
        val depth: Int,
        val number: Int?,
        val task: Boolean?,
        val line: Int,
        val inline: NoteTextInline,
        val quoteDepth: Int = 0,
    ) : NoteTextBlock()

    data class Code(val text: String, val quoteDepth: Int = 0) : NoteTextBlock()
    data class Rule(val quoteDepth: Int = 0) : NoteTextBlock()
    data class Table(val header: List<NoteTextInline>, val rows: List<List<NoteTextInline>>) : NoteTextBlock()
}

private val TASK_MARKER = Regex("""^(\s*(?:>\s*)*(?:[-*+]|\d{1,9}[.)])\s+\[)([ xX])(\])""")

/**
 * Flip the task checkbox on a 1-based source line. Returns the text unchanged when that line holds no task marker
 * (e.g. the text changed meanwhile).
 */
fun toggleNoteTextTask(text: String, line: Int): String {
    if (line < 1) return text
    val lines = text.split("\n").toMutableList()
    val index = line - 1
    if (index >= lines.size) return text
    val source = lines[index]
    val match = TASK_MARKER.find(source) ?: return text
    val mark = if (match.groupValues[2] == " ") "x" else " "
    lines[index] = match.groupValues[1] + mark + match.groupValues[3] + source.substring(match.range.last + 1)
    return lines.joinToString("\n")
}

/** Only web and mail links leave the app; anything else stays inert. Normalized like `new URL(href).href`. */
fun openableNoteTextLink(href: String?): String? {
    val value = href?.trim() ?: return null
    val scheme = Regex("^(https?)://", RegexOption.IGNORE_CASE).find(value)
    if (scheme != null) {
        val rest = value.substring(scheme.range.last + 1)
        val hostEnd = rest.indexOfAny(charArrayOf('/', '?', '#')).let { if (it < 0) rest.length else it }
        val host = rest.substring(0, hostEnd)
        if (host.isEmpty() || host.any { it.isWhitespace() || it == '\\' }) return null
        val tail = rest.substring(hostEnd).let { if (it.isEmpty() || !it.startsWith("/")) "/$it" else it }
        return scheme.groupValues[1].lowercase() + "://" + host.lowercase() + encodeUrlTail(tail)
    }
    if (Regex("^mailto:", RegexOption.IGNORE_CASE).containsMatchIn(value)) {
        val address = value.substring("mailto:".length)
        if (address.isEmpty()) return null
        return "mailto:" + encodeUrlTail(address)
    }
    return null
}

private fun encodeUrlTail(value: String): String = buildString {
    for (char in value) {
        when {
            char == ' ' -> append("%20")
            char == '"' -> append("%22")
            char == '<' -> append("%3C")
            char == '>' -> append("%3E")
            char == '`' -> append("%60")
            char.code < 0x20 -> Unit
            char.code > 0x7e -> char.toString().encodeToByteArray().forEach { append('%').append("%02X".format(it.toInt() and 0xff)) }
            else -> append(char)
        }
    }
}

private val FENCE = Regex("""^ {0,3}(`{3,}|~{3,})(.*)$""")
private val ATX = Regex("""^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$""")
private val RULE = Regex("""^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$""")
private val SETEXT = Regex("""^ {0,3}(=+|-+)[ \t]*$""")
private val QUOTE = Regex("""^ {0,3}> ?""")
private val ITEM = Regex("""^([ \t]*)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$""")
private val TASK = Regex("""^\[([ xX])\](?:[ \t]+(.*))?$""")
private val TABLE_DELIMITER = Regex("""^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$""")

private data class BoxSourceLine(val text: String, val number: Int, val quoteDepth: Int)

/** Blocks of a text box's Markdown. */
fun parseNoteTextMarkdown(text: String): List<NoteTextBlock> {
    val lines = text.replace("\r\n", "\n").replace('\r', '\n').split("\n").mapIndexed { index, raw ->
        var rest = raw
        var depth = 0
        while (true) {
            val quote = QUOTE.find(rest) ?: break
            rest = rest.substring(quote.range.last + 1)
            depth += 1
        }
        BoxSourceLine(rest, index + 1, depth)
    }
    val blocks = ArrayList<NoteTextBlock>()
    var index = 0
    // Item indentation per nesting depth, from the open list.
    val listIndents = ArrayList<Int>()
    while (index < lines.size) {
        val line = lines[index]
        val content = line.text
        if (content.isBlank()) {
            index += 1
            continue
        }
        val fence = FENCE.find(content)
        if (fence != null && !(fence.groupValues[1].startsWith("`") && fence.groupValues[2].contains('`'))) {
            val marker = fence.groupValues[1]
            val body = ArrayList<String>()
            index += 1
            while (index < lines.size) {
                val next = lines[index].text
                if (Regex("""^ {0,3}${Regex.escape(marker.substring(0, 1))}{${marker.length},}[ \t]*$""").matches(next)) {
                    index += 1
                    break
                }
                body += next
                index += 1
            }
            blocks += NoteTextBlock.Code(body.joinToString("\n"), line.quoteDepth)
            listIndents.clear()
            continue
        }
        val atx = ATX.find(content)
        if (atx != null) {
            blocks += NoteTextBlock.Heading(atx.groupValues[1].length, parseNoteTextInline(atx.groupValues[2].trim()))
            index += 1
            listIndents.clear()
            continue
        }
        // A thematic break wins over a list item ("- - -").
        if (RULE.matches(content)) {
            blocks += NoteTextBlock.Rule(line.quoteDepth)
            index += 1
            listIndents.clear()
            continue
        }
        val item = ITEM.find(content)
        if (item != null) {
            val indent = item.groupValues[1].replace("\t", "    ").length
            while (listIndents.isNotEmpty() && listIndents.last() > indent) listIndents.removeAt(listIndents.size - 1)
            if (listIndents.isEmpty() || listIndents.last() < indent) listIndents += indent
            val depth = listIndents.size - 1
            val marker = item.groupValues[2]
            var body = item.groupValues[3]
            var task: Boolean? = null
            TASK.find(body)?.let { found ->
                task = found.groupValues[1] != " "
                body = found.groupValues[2]
            }
            val parts = arrayListOf(body.trim())
            index += 1
            // Continuation lines: not blank and not the start of another block.
            while (index < lines.size && continuesParagraph(lines[index], line.quoteDepth)) {
                parts += lines[index].text.trim()
                index += 1
            }
            val ordered = marker.first().isDigit()
            val number = if (!ordered) null else orderedNumber(blocks, depth, marker.dropLast(1).toInt(), line.quoteDepth)
            blocks += NoteTextBlock.Item(depth, number, task, line.number, parseNoteTextInline(parts.joinToString("\n")), line.quoteDepth)
            continue
        }
        listIndents.clear()
        // A GFM table: a header row followed by the delimiter row.
        if (content.contains('|') && index + 1 < lines.size && TABLE_DELIMITER.matches(lines[index + 1].text)) {
            val header = tableCells(content)
            val columns = tableCells(lines[index + 1].text).size
            if (header.size == columns) {
                index += 2
                val rows = ArrayList<List<NoteTextInline>>()
                while (index < lines.size && lines[index].text.isNotBlank() && lines[index].text.contains('|')) {
                    val cells = tableCells(lines[index].text)
                    rows += (0 until columns).map { parseNoteTextInline(cells.getOrElse(it) { "" }) }
                    index += 1
                }
                blocks += NoteTextBlock.Table(header.map(::parseNoteTextInline), rows)
                continue
            }
        }
        val parts = arrayListOf(content.trim())
        index += 1
        var heading = 0
        while (index < lines.size) {
            val next = lines[index]
            val setext = SETEXT.find(next.text)
            if (setext != null && next.quoteDepth == line.quoteDepth) {
                heading = if (setext.groupValues[1].startsWith("=")) 1 else 2
                index += 1
                break
            }
            if (!continuesParagraph(next, line.quoteDepth)) break
            parts += next.text.trim()
            index += 1
        }
        val inline = parseNoteTextInline(parts.joinToString("\n"))
        blocks += if (heading > 0) NoteTextBlock.Heading(heading, inline) else NoteTextBlock.Paragraph(inline, line.quoteDepth)
    }
    return blocks
}

private fun continuesParagraph(line: BoxSourceLine, quoteDepth: Int): Boolean {
    val text = line.text
    if (text.isBlank() || line.quoteDepth != quoteDepth) return false
    if (FENCE.containsMatchIn(text) || ATX.matches(text) || RULE.matches(text) || ITEM.matches(text)) return false
    return true
}

/** GFM numbers an ordered list from its first item. */
private fun orderedNumber(blocks: List<NoteTextBlock>, depth: Int, start: Int, quoteDepth: Int): Int {
    for (index in blocks.indices.reversed()) {
        val block = blocks[index]
        if (block !is NoteTextBlock.Item || block.quoteDepth != quoteDepth) return start
        if (block.depth < depth) return start
        if (block.depth == depth) return if (block.number != null) block.number + 1 else start
    }
    return start
}

private fun tableCells(row: String): List<String> {
    var body = row.trim()
    if (body.startsWith("|")) body = body.substring(1)
    if (body.endsWith("|") && !body.endsWith("\\|")) body = body.dropLast(1)
    val cells = ArrayList<String>()
    val current = StringBuilder()
    var index = 0
    while (index < body.length) {
        val char = body[index]
        if (char == '\\' && index + 1 < body.length && body[index + 1] == '|') {
            current.append('|')
            index += 2
            continue
        }
        if (char == '|') {
            cells += current.toString().trim()
            current.clear()
        } else {
            current.append(char)
        }
        index += 1
    }
    cells += current.toString().trim()
    return cells
}

private const val PUNCTUATION = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"
private val AUTOLINK = Regex("""^<((?:https?://|mailto:)[^\s<>]+)>""", RegexOption.IGNORE_CASE)
private val LITERAL_LINK = Regex("""^(?:https?://|www\.)[^\s<]*[^\s<?!.,:*_~'")\]]""", RegexOption.IGNORE_CASE)

/** Inline Markdown of one block: emphasis, strike, code, links, images as alt text. Soft breaks stay `\n`. */
fun parseNoteTextInline(source: String): NoteTextInline {
    val out = StringBuilder()
    val spans = ArrayList<NoteTextSpan>()
    InlineParser(source, out, spans).run(0, source.length)
    return NoteTextInline(out.toString(), spans.sortedWith(compareBy({ it.start }, { -it.end })))
}

private class InlineParser(val src: String, val out: StringBuilder, val spans: MutableList<NoteTextSpan>) {
    fun run(from: Int, to: Int) {
        var index = from
        while (index < to) {
            val char = src[index]
            when {
                char == '\\' && index + 1 < to && src[index + 1] in PUNCTUATION -> {
                    out.append(src[index + 1])
                    index += 2
                }
                char == '`' -> index = code(index, to)
                char == '!' && index + 1 < to && src[index + 1] == '[' -> index = link(index + 1, to, image = true) ?: run { out.append(char); index + 1 }
                char == '[' -> index = link(index, to, image = false) ?: run { out.append(char); index + 1 }
                char == '<' -> {
                    val auto = AUTOLINK.find(src.substring(index, to))
                    if (auto != null) {
                        val start = out.length
                        out.append(auto.groupValues[1])
                        spans += NoteTextSpan(start, out.length, NoteTextInlineStyle.LINK, openableNoteTextLink(auto.groupValues[1]))
                        index += auto.value.length
                    } else {
                        out.append(char)
                        index += 1
                    }
                }
                (char == 'h' || char == 'H' || char == 'w' || char == 'W') && (index == from || !src[index - 1].isLetterOrDigit()) -> {
                    val literal = LITERAL_LINK.find(src.substring(index, to))
                    if (literal != null) {
                        val start = out.length
                        out.append(literal.value)
                        val href = if (literal.value.startsWith("www.", ignoreCase = true)) "http://${literal.value}" else literal.value
                        spans += NoteTextSpan(start, out.length, NoteTextInlineStyle.LINK, openableNoteTextLink(href))
                        index += literal.value.length
                    } else {
                        out.append(char)
                        index += 1
                    }
                }
                char == '*' || char == '_' || char == '~' -> index = emphasis(index, to)
                else -> {
                    out.append(char)
                    index += 1
                }
            }
        }
    }

    private fun runLength(at: Int, to: Int, char: Char): Int {
        var end = at
        while (end < to && src[end] == char) end += 1
        return end - at
    }

    private fun code(at: Int, to: Int): Int {
        val ticks = runLength(at, to, '`')
        val fence = "`".repeat(ticks)
        var search = at + ticks
        while (true) {
            val close = src.indexOf(fence, search)
            if (close < 0 || close >= to) {
                out.append(fence)
                return at + ticks
            }
            if (runLength(close, to, '`') != ticks) {
                search = close + runLength(close, to, '`')
                continue
            }
            var body = src.substring(at + ticks, close).replace('\n', ' ')
            if (body.length > 2 && body.startsWith(" ") && body.endsWith(" ") && body.isNotBlank()) body = body.substring(1, body.length - 1)
            val start = out.length
            out.append(body)
            spans += NoteTextSpan(start, out.length, NoteTextInlineStyle.CODE)
            return close + ticks
        }
    }

    /** `[text](href)` from [open] (the `[`); null when it is not a link. */
    private fun link(open: Int, to: Int, image: Boolean): Int? {
        var depth = 0
        var close = -1
        var index = open
        while (index < to) {
            val char = src[index]
            if (char == '\\') {
                index += 2
                continue
            }
            if (char == '[') depth += 1
            if (char == ']') {
                depth -= 1
                if (depth == 0) {
                    close = index
                    break
                }
            }
            index += 1
        }
        if (close < 0 || close + 1 >= to || src[close + 1] != '(') return null
        var end = close + 2
        var parens = 1
        while (end < to) {
            val char = src[end]
            if (char == '\\') {
                end += 2
                continue
            }
            if (char == '(') parens += 1
            if (char == ')') {
                parens -= 1
                if (parens == 0) break
            }
            end += 1
        }
        if (end >= to) return null
        val target = src.substring(close + 2, end).trim()
        val href = target.removePrefix("<").substringBefore('>').substringBefore(' ').trim()
        val start = out.length
        if (image) {
            // Text boxes never load pictures; the alt text stands in.
            out.append(src.substring(open + 1, close).replace(Regex("""[*_~`]"""), ""))
            return end + 1
        }
        run(open + 1, close)
        spans += NoteTextSpan(start, out.length, NoteTextInlineStyle.LINK, openableNoteTextLink(href))
        return end + 1
    }

    private fun emphasis(at: Int, to: Int): Int {
        val char = src[at]
        val length = runLength(at, to, char)
        val use = when {
            char == '~' -> if (length <= 2) length else 0
            length >= 2 -> 2
            else -> 1
        }
        val before = if (at > 0) src[at - 1] else ' '
        val after = if (at + length < to) src[at + length] else ' '
        val opens = !after.isWhitespace() && (char != '_' || !before.isLetterOrDigit())
        if (use == 0 || !opens) {
            out.append(src, at, at + length)
            return at + length
        }
        val marker = char.toString().repeat(use)
        var search = at + use
        while (search < to) {
            val close = src.indexOf(marker, search)
            if (close < 0 || close >= to) break
            val closeBefore = src[close - 1]
            val closeAfter = if (close + use < to) src[close + use] else ' '
            val runAtClose = runLength(close, to, char)
            val validClose = close > at + use && !closeBefore.isWhitespace() && (char != '_' || !closeAfter.isLetterOrDigit())
            // Looking for a single `*`, a `**` belongs to a strong run nested inside.
            val strongInside = use == 1 && runAtClose == 2 && char != '~'
            if (!validClose || strongInside) {
                search = close + runAtClose
                continue
            }
            val start = out.length
            run(at + use, close)
            val style = when {
                char == '~' -> NoteTextInlineStyle.STRIKE
                use == 2 -> NoteTextInlineStyle.BOLD
                else -> NoteTextInlineStyle.ITALIC
            }
            spans += NoteTextSpan(start, out.length, style)
            return close + use
        }
        out.append(src, at, at + use)
        return at + use
    }
}

/** Plain text of a box for measuring and search: the rendered characters without markers. */
fun noteTextMarkdownPlain(text: String): String = parseNoteTextMarkdown(text).joinToString("\n") { block ->
    when (block) {
        is NoteTextBlock.Heading -> block.inline.text
        is NoteTextBlock.Paragraph -> block.inline.text
        is NoteTextBlock.Item -> block.inline.text
        is NoteTextBlock.Code -> block.text
        is NoteTextBlock.Rule -> ""
        is NoteTextBlock.Table -> (listOf(block.header) + block.rows).joinToString("\n") { row -> row.joinToString(" ") { it.text } }
    }
}
