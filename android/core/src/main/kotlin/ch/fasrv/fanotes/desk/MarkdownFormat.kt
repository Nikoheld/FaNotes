package ch.fasrv.fanotes.desk

/**
 * Markdown formatting actions from the desktop keyboard toolbar.
 * The selection is replaced the same way CodeMirror wraps or prefixes lines.
 */

data class MarkdownEdit(val text: String, val selectionStart: Int, val selectionEnd: Int)

/**
 * Desktop editor shortcuts: Ctrl-B bold, Ctrl-I italic, Ctrl-K link.
 * Shift-Ctrl-K stays the delete-line command, so Shift does not format.
 */
fun markdownFormatShortcut(ctrl: Boolean, shift: Boolean, alt: Boolean, meta: Boolean, letter: Char): String? {
    if (!ctrl || shift || alt || meta) return null
    return when (letter.lowercaseChar()) {
        'b' -> "bold"
        'i' -> "italic"
        'k' -> "link"
        else -> null
    }
}

fun applyMarkdownFormat(text: String, rawStart: Int, rawEnd: Int, action: String): MarkdownEdit {
    val start = rawStart.coerceIn(0, text.length)
    val end = rawEnd.coerceIn(start, text.length)
    return when (action) {
        "heading1" -> transformLines(text, start, end) { line, _ -> "# ${stripBlockPrefix(line).trimStart()}" }
        "heading2" -> transformLines(text, start, end) { line, _ -> "## ${stripBlockPrefix(line).trimStart()}" }
        "heading3" -> transformLines(text, start, end) { line, _ -> "### ${stripBlockPrefix(line).trimStart()}" }
        "bold" -> wrap(text, start, end, "**", "**", "fetter Text")
        "italic" -> wrap(text, start, end, "*", "*", "kursiver Text")
        "strike" -> wrap(text, start, end, "~~", "~~", "durchgestrichener Text")
        "inlineCode" -> {
            if (text.substring(start, end).contains('\n')) insertTemplate(text, start, end, "\n```\n{{selection}}\n```\n", "Code")
            else wrap(text, start, end, "`", "`", "Code")
        }
        "link" -> {
            val label = text.substring(start, end).ifEmpty { "Linktext" }
            val url = "https://"
            val insert = "[$label]($url)"
            replace(text, start, end, insert, start + insert.length - url.length - 1, start + insert.length - 1)
        }
        "quote" -> transformLines(text, start, end) { line, _ -> "> ${stripBlockPrefix(line).trimStart()}" }
        "bulletList" -> transformLines(text, start, end) { line, _ -> "- ${stripBlockPrefix(line).trimStart()}" }
        "numberedList" -> transformLines(text, start, end) { line, index -> "${index + 1}. ${stripBlockPrefix(line).trimStart()}" }
        "checklist" -> transformLines(text, start, end) { line, _ -> "- [ ] ${stripBlockPrefix(line).trimStart()}" }
        "codeBlock" -> insertTemplate(text, start, end, "\n```\n{{selection}}\n```\n", "Code")
        "table" -> insertTemplate(text, start, end, "\n| Thema | Notiz |\n| --- | --- |\n| {{selection}} |  |\n", "Eintrag")
        "mathBlock" -> insertTemplate(text, start, end, "\n$$\n{{selection}}\n$$\n", "f(x) = x^2")
        "details" -> insertTemplate(text, start, end, "\n<details>\n<summary>Titel</summary>\n\n{{selection}}\n\n</details>\n", "Einklappbarer Inhalt")
        "horizontalRule" -> insertTemplate(text, start, end, "\n\n---\n\n{{selection}}", "")
        else -> MarkdownEdit(text, start, end)
    }
}

private fun wrap(text: String, start: Int, end: Int, before: String, after: String, placeholder: String): MarkdownEdit {
    val body = text.substring(start, end).ifEmpty { placeholder }
    val insert = "$before$body$after"
    return replace(text, start, end, insert, start + before.length, start + before.length + body.length)
}

private fun insertTemplate(text: String, start: Int, end: Int, template: String, placeholder: String): MarkdownEdit {
    val body = text.substring(start, end).ifEmpty { placeholder }
    val insert = template.replace("{{selection}}", body)
    val offset = insert.indexOf(body).coerceAtLeast(0)
    return replace(text, start, end, insert, start + offset, start + offset + body.length)
}

private fun transformLines(text: String, start: Int, end: Int, transform: (String, Int) -> String): MarkdownEdit {
    val lineAtEnd = lineStart(text, end)
    val effectiveEnd = if (end > start && end == lineAtEnd) end - 1 else end
    val from = lineStart(text, start)
    val to = lineEnd(text, maxOf(start, effectiveEnd))
    val next = text.substring(from, to).split('\n').mapIndexed { index, line -> transform(line, index) }.joinToString("\n")
    return replace(text, from, to, next, from, from + next.length)
}

private fun stripBlockPrefix(line: String): String =
    line.replace(Regex("""^(\s*)(?:#{1,6}\s+|>\s+|[-*+]\s+(?:\[[ xX]]\s+)?|\d+[.)]\s+)"""), "$1")

private fun lineStart(text: String, index: Int): Int {
    if (text.isEmpty() || index <= 0) return 0
    val at = index.coerceAtMost(text.length)
    val newline = text.lastIndexOf('\n', at - 1)
    return if (newline < 0) 0 else newline + 1
}

private fun lineEnd(text: String, index: Int): Int {
    val at = index.coerceIn(0, text.length)
    val newline = text.indexOf('\n', at)
    return if (newline < 0) text.length else newline
}

private fun replace(text: String, from: Int, to: Int, insert: String, selectionStart: Int, selectionEnd: Int): MarkdownEdit {
    val next = text.substring(0, from) + insert + text.substring(to)
    return MarkdownEdit(next, selectionStart.coerceIn(0, next.length), selectionEnd.coerceIn(0, next.length))
}
