package ch.fasrv.fanotes.desk

/**
 * HTML tag names offered by the desktop Markdown editor after `<`.
 * The order is the CodeMirror HTML schema. A fence, inline code span,
 * HTML comment, link, or image hides the list.
 */
data class HtmlTagCompletion(val from: Int, val options: List<String>)

fun htmlTagCompletion(text: String, cursor: Int): HtmlTagCompletion? {
    if (text.isEmpty()) return null
    val at = cursor.coerceIn(0, text.length)
    val window = text.substring((at - 25).coerceAtLeast(0), at)
    val match = TAG_PREFIX.find(window) ?: return null
    val from = at - match.value.length
    if (from < 0 || hidesHtmlCompletion(text, from)) return null
    val options = HTML_TAGS.filter { it.startsWith(match.value) }
    if (options.isEmpty()) return null
    return HtmlTagCompletion(from, options)
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
