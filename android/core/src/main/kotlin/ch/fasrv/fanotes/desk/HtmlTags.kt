package ch.fasrv.fanotes.desk

/**
 * HTML tag names offered by the desktop Markdown editor after `<`.
 * The order is the CodeMirror HTML schema. A fence, inline code span,
 * HTML comment, link, or image hides the list.
 */
data class HtmlTagCompletion(val from: Int, val options: List<String>, val inserts: List<String> = options)

fun htmlTagCompletion(text: String, cursor: Int): HtmlTagCompletion? {
    if (text.isEmpty()) return null
    val at = cursor.coerceIn(0, text.length)
    val window = text.substring((at - 25).coerceAtLeast(0), at)
    val match = TAG_PREFIX.find(window)
    if (match != null) {
        val from = at - match.value.length
        if (from < 0 || hidesHtmlCompletion(text, from)) return null
        val options = HTML_TAGS.filter { it.startsWith(match.value) }
        if (options.isEmpty()) return null
        return HtmlTagCompletion(from, options)
    }
    return htmlAttributeCompletion(text, at)
}

/**
 * Desktop `autoCloseTags` for a typed `>` or `/`.
 * `>` after an open tag inserts `</name>` and leaves the caret between the tags.
 * `/` right after `<` inserts the still-open tag name and `>`.
 */
fun htmlAutoClose(before: String, start: Int, deleted: Int, after: String): MarkdownEdit? {
    if (deleted != 0 || start < 0 || start > before.length) return null
    if (after.length != before.length + 1 || start >= after.length) return null
    if (after.substring(0, start) != before.substring(0, start)) return null
    if (after.substring(start + 1) != before.substring(start)) return null
    return when (after[start]) {
        '>' -> closeAfterGreaterThan(after, start)
        '/' -> closeAfterSlash(after, start)
        else -> null
    }
}

internal fun hidesHtmlCompletion(text: String, index: Int): Boolean {
    if (insideCodeFence(text, index)) return true
    if (insideInlineCode(text, index)) return true
    if (insideHtmlComment(text, index)) return true
    if (insideMarkdownLink(text, index)) return true
    return false
}

private fun insideCodeFence(text: String, index: Int): Boolean =
    codeFenceBlocks(text).any { index in it.from..it.to }

private fun insideInlineCode(text: String, index: Int): Boolean {
    val lineStart = if (index <= 0) 0 else {
        val newline = text.lastIndexOf('\n', index - 1)
        if (newline < 0) 0 else newline + 1
    }
    val lineEnd = text.indexOf('\n', lineStart).let { if (it < 0) text.length else it }
    val line = text.substring(lineStart, lineEnd)
    val local = index - lineStart
    return CODE.findAll(line).any { local in it.range }
}

private fun insideHtmlComment(text: String, index: Int): Boolean {
    var open = false
    var cursor = 0
    while (cursor < index) {
        if (text.startsWith("<!--", cursor)) {
            open = true
            cursor += 4
            continue
        }
        if (open && text.startsWith("-->", cursor)) {
            open = false
            cursor += 3
            continue
        }
        cursor += 1
    }
    return open
}

private fun insideMarkdownLink(text: String, index: Int): Boolean {
    val lineStart = if (index <= 0) 0 else {
        val newline = text.lastIndexOf('\n', index - 1)
        if (newline < 0) 0 else newline + 1
    }
    val lineEnd = text.indexOf('\n', lineStart).let { if (it < 0) text.length else it }
    val line = text.substring(lineStart, lineEnd)
    val local = index - lineStart
    return LINK.findAll(line).any { local in it.range }
}

private val TAG_PREFIX = Regex("""<[:\-.0-9A-Za-z_\u00B7-\uFFFF]*$""")
private val CODE = Regex("""(`+)([^`\n]+?)\1""")
private val LINK = Regex("""!?\[([^\]\n]+)]\(([^)\n]+)\)""")

private fun htmlAttributeCompletion(text: String, cursor: Int): HtmlTagCompletion? {
    val head = openTagHead(text, cursor) ?: return null
    if (hidesHtmlCompletion(text, head)) return null
    val inside = text.substring(head + 1, cursor)
    val spot = attributeSpot(inside) ?: return null
    val tag = inside.takeWhile { isTagChar(it) }
    return when (spot) {
        is AttributeSpot.Name -> {
            val options = htmlAttributeNames(tag).filter { it.startsWith(spot.prefix) }
            if (options.isEmpty()) return null
            HtmlTagCompletion(cursor - spot.prefix.length, options)
        }
        is AttributeSpot.Value -> {
            val values = htmlAttributeValues(tag, spot.name) ?: return null
            val options = values.filter { it.startsWith(spot.prefix) }
            if (options.isEmpty()) return null
            val closing = when {
                spot.quote == null -> null
                text.getOrNull(cursor) == spot.quote -> ""
                else -> spot.quote.toString()
            }
            val inserts = options.map { value ->
                if (closing == null) "\"$value\"" else value + closing
            }
            HtmlTagCompletion(cursor - spot.prefix.length, options, inserts)
        }
    }
}

private fun closeAfterGreaterThan(text: String, gt: Int): MarkdownEdit? {
    val head = openTagHead(text, gt) ?: return null
    if (hidesHtmlCompletion(text, head)) return null
    val body = text.substring(head + 1, gt)
    if (body.isEmpty() || !body[0].isLetter()) return null
    if (quoteStillOpen(body) || body.trimEnd().endsWith("/")) return null
    val name = body.takeWhile { isTagChar(it) }
    if (name.isEmpty() || name.lowercase() in HTML_SELF_CLOSERS) return null
    val closing = "</$name>"
    if (text.startsWith(closing, gt + 1)) return null
    val next = text.substring(0, gt + 1) + closing + text.substring(gt + 1)
    val cursor = gt + 1
    return MarkdownEdit(next, cursor, cursor)
}

private fun closeAfterSlash(text: String, slash: Int): MarkdownEdit? {
    if (slash == 0 || text[slash - 1] != '<') return null
    if (hidesHtmlCompletion(text, slash - 1)) return null
    val name = unclosedHtmlTag(text, slash - 1) ?: return null
    if (name.lowercase() in HTML_SELF_CLOSERS) return null
    if (text.startsWith("$name>", slash + 1)) return null
    val end = if (text.getOrNull(slash + 1) == '>') slash + 2 else slash + 1
    val insert = "$name>"
    val next = text.substring(0, slash + 1) + insert + text.substring(end)
    val cursor = slash + 1 + insert.length
    return MarkdownEdit(next, cursor, cursor)
}

private fun openTagHead(text: String, cursor: Int): Int? {
    var index = cursor - 1
    val floor = (cursor - 800).coerceAtLeast(0)
    while (index >= floor) {
        when (text[index]) {
            '>' -> return null
            '<' -> {
                val next = text.getOrNull(index + 1) ?: return null
                if (!next.isLetter()) return null
                return index
            }
        }
        index--
    }
    return null
}

private fun quoteStillOpen(body: String): Boolean {
    var quote: Char? = null
    for (char in body) {
        if (quote != null) {
            if (char == quote) quote = null
        } else if (char == '"' || char == '\'') {
            quote = char
        }
    }
    return quote != null
}

private fun unclosedHtmlTag(text: String, before: Int): String? {
    val stack = ArrayDeque<String>()
    var index = 0
    while (index < before) {
        if (text.startsWith("<!--", index)) {
            val end = text.indexOf("-->", index + 4)
            if (end < 0 || end >= before) break
            index = end + 3
            continue
        }
        if (text[index] != '<') {
            index++
            continue
        }
        val closer = index + 1 < before && text[index + 1] == '/'
        val nameStart = index + if (closer) 2 else 1
        val name = text.drop(nameStart).take(before - nameStart).takeWhile { isTagChar(it) }
        if (name.isEmpty() || !name[0].isLetter()) {
            index++
            continue
        }
        val gt = text.indexOf('>', index)
        if (!closer && (gt < 0 || gt >= before)) break
        if (closer) {
            while (stack.isNotEmpty() && !stack.last().equals(name, ignoreCase = true)) stack.removeLast()
            if (stack.isNotEmpty()) stack.removeLast()
        } else {
            val body = if (gt < 0) "" else text.substring(index + 1, gt)
            val self = name.lowercase() in HTML_SELF_CLOSERS || body.trimEnd().endsWith("/")
            if (!self) stack.addLast(name)
        }
        index = if (gt < 0 || gt >= before) before else gt + 1
    }
    return stack.lastOrNull()
}

private sealed class AttributeSpot {
    data class Name(val prefix: String) : AttributeSpot()
    data class Value(val name: String, val prefix: String, val quote: Char?) : AttributeSpot()
}

private fun attributeSpot(inside: String): AttributeSpot? {
    val tagEnd = inside.indexOfFirst { !isTagChar(it) }
    if (tagEnd <= 0) return null
    var index = tagEnd
    while (true) {
        while (index < inside.length && inside[index].isWhitespace()) index++
        if (index >= inside.length) return AttributeSpot.Name("")
        val char = inside[index]
        if (char == '/' || char == '>') return null
        if (!isAttrStart(char)) return null
        val nameStart = index
        index++
        while (index < inside.length && isAttrChar(inside[index])) index++
        val name = inside.substring(nameStart, index)
        val afterName = index
        while (index < inside.length && inside[index].isWhitespace()) index++
        if (index >= inside.length) {
            return AttributeSpot.Name(if (afterName == inside.length) name else "")
        }
        if (inside[index] != '=') continue
        index++
        while (index < inside.length && inside[index].isWhitespace()) index++
        if (index >= inside.length) return AttributeSpot.Value(name, "", null)
        val quote = inside[index]
        if (quote == '"' || quote == '\'') {
            val valueStart = index + 1
            var end = valueStart
            while (end < inside.length && inside[end] != quote) end++
            if (end >= inside.length) return AttributeSpot.Value(name, inside.substring(valueStart), quote)
            index = end + 1
            continue
        }
        val valueStart = index
        while (index < inside.length && !inside[index].isWhitespace()) index++
        if (index >= inside.length) return AttributeSpot.Value(name, inside.substring(valueStart), null)
    }
}

private fun isTagChar(char: Char) = char.isLetterOrDigit() || char == '-' || char == '_' || char == ':' || char == '.'

private fun isAttrStart(char: Char) = char.isLetter() || char == '_' || char == ':'

private fun isAttrChar(char: Char) = isAttrStart(char) || char.isDigit() || char == '-' || char == '.'

internal val HTML_TAGS = listOf(
    "<a", "<abbr", "<address", "<area", "<article", "<aside", "<audio",
    "<b", "<base", "<bdi", "<bdo", "<blockquote", "<body", "<br", "<button",
    "<canvas", "<caption", "<center", "<cite", "<code", "<col", "<colgroup", "<command",
    "<data", "<datagrid", "<datalist", "<dd", "<del", "<details", "<dfn", "<div", "<dl", "<dt",
    "<em", "<embed", "<eventsource",
    "<fieldset", "<figcaption", "<figure", "<footer", "<form",
    "<h1", "<h2", "<h3", "<h4", "<h5", "<h6", "<head", "<header", "<hgroup", "<hr", "<html",
    "<i", "<iframe", "<img", "<input", "<ins",
    "<kbd", "<keygen",
    "<label", "<legend", "<li", "<link",
    "<map", "<mark", "<menu", "<meta", "<meter",
    "<nav", "<noscript",
    "<object", "<ol", "<optgroup", "<option", "<output",
    "<p", "<param", "<pre", "<progress",
    "<q",
    "<rp", "<rt", "<ruby",
    "<samp", "<script", "<section", "<select", "<slot", "<small", "<source", "<span", "<strong", "<style", "<sub", "<summary", "<sup",
    "<table", "<tbody", "<td", "<template", "<textarea", "<tfoot", "<th", "<thead", "<time", "<title", "<tr", "<track",
    "<ul",
    "<var", "<video",
    "<wbr",
)
