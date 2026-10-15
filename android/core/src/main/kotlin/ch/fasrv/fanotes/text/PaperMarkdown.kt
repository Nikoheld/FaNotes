package ch.fasrv.fanotes.text

/**
 * Lines of a note as they sit on the desktop paper: headings, quotes, lists
 * and code, with the ink marker and other HTML comments left off the page.
 * Inline markers such as `**bold**` stay in the text for the renderer.
 */
enum class PaperKind { H1, H2, H3, H4, PARAGRAPH, BULLET, NUMBER, TASK, QUOTE, CODE, MATH, RULE, TABLE, SPACER }

data class PaperLine(val kind: PaperKind, val text: String, val sourceLine: Int = -1)

private val COMMENT = Regex("""<!--[\s\S]*?-->""")
private val BULLET = Regex("""^\s*[-*+]\s+""")
private val NUMBER = Regex("""^\s*(\d+)\.\s+""")
private val TASK = Regex("""^\s*[-*+]\s+\[([ xX])](?:\s+(.*))?$""")
private val TABLE_RULE = Regex("""^:?-{3,}:?$""")

fun paperLines(markdown: String): List<PaperLine> {
    val source = markdown.replace("\r\n", "\n").replace(COMMENT, "")
    val lines = source.split('\n')
    val out = ArrayList<PaperLine>(lines.size)
    var inCode = false
    var inMath = false
    var codeStart = -1
    var mathStart = -1
    val code = StringBuilder()
    val math = StringBuilder()
    var index = 0
    while (index < lines.size) {
        val raw = lines[index]
        val fence = raw.trimStart().startsWith("```")
        if (fence) {
            if (inCode) {
                out += PaperLine(PaperKind.CODE, code.toString().trimEnd(), codeStart)
                code.clear()
                inCode = false
            } else {
                inCode = true
                codeStart = index
            }
            index += 1
            continue
        }
        if (inCode) {
            if (code.isNotEmpty()) code.append('\n')
            code.append(raw)
            index += 1
            continue
        }
        if (raw.trim() == "$$") {
            if (inMath) {
                out += PaperLine(PaperKind.MATH, math.toString().trimEnd(), mathStart)
                math.clear()
                inMath = false
            } else {
                inMath = true
                mathStart = index
            }
            index += 1
            continue
        }
        if (inMath) {
            if (math.isNotEmpty()) math.append('\n')
            math.append(raw)
            index += 1
            continue
        }
        if (isTableRow(raw)) {
            val tableStart = index
            val rows = ArrayList<List<String>>()
            while (index < lines.size && isTableRow(lines[index])) {
                val cells = tableCells(lines[index])
                if (cells.isNotEmpty() && !cells.all { TABLE_RULE.matches(it) }) rows += cells
                index += 1
            }
            if (rows.isNotEmpty()) out += PaperLine(PaperKind.TABLE, encodeTable(rows), tableStart)
            continue
        }
        val trimmed = raw.trim()
        val task = TASK.find(raw)
        when {
            trimmed.isEmpty() -> out += PaperLine(PaperKind.SPACER, "", index)
            trimmed.startsWith("###### ") -> out += PaperLine(PaperKind.H4, trimmed.drop(7).trim(), index)
            trimmed.startsWith("##### ") -> out += PaperLine(PaperKind.H4, trimmed.drop(6).trim(), index)
            trimmed.startsWith("#### ") -> out += PaperLine(PaperKind.H4, trimmed.drop(5).trim(), index)
            trimmed.startsWith("### ") -> out += PaperLine(PaperKind.H3, trimmed.drop(4).trim(), index)
            trimmed.startsWith("## ") -> out += PaperLine(PaperKind.H2, trimmed.drop(3).trim(), index)
            trimmed.startsWith("# ") -> out += PaperLine(PaperKind.H1, trimmed.drop(2).trim(), index)
            trimmed.startsWith("> ") -> out += PaperLine(PaperKind.QUOTE, trimmed.drop(2).trim(), index)
            trimmed == ">" -> out += PaperLine(PaperKind.QUOTE, "", index)
            trimmed == "---" || trimmed == "***" || trimmed == "___" -> out += PaperLine(PaperKind.RULE, "", index)
            task != null -> out += PaperLine(PaperKind.TASK, "${if (task.groupValues[1].equals("x", true)) "x" else " "}|${task.groupValues[2]}", index)
            NUMBER.containsMatchIn(raw) -> out += PaperLine(PaperKind.NUMBER, raw.trim(), index)
            BULLET.containsMatchIn(raw) -> out += PaperLine(PaperKind.BULLET, BULLET.replace(raw, "").trim(), index)
            else -> out += PaperLine(PaperKind.PARAGRAPH, raw.trimEnd(), index)
        }
        index += 1
    }
    if (inCode && code.isNotEmpty()) out += PaperLine(PaperKind.CODE, code.toString().trimEnd(), codeStart)
    if (inMath && math.isNotEmpty()) out += PaperLine(PaperKind.MATH, math.toString().trimEnd(), mathStart)
    return out
}

fun tableRows(text: String): List<List<String>> = text.split('\n').map { row -> row.split('\u001f') }

private fun isTableRow(line: String): Boolean {
    val trimmed = line.trim()
    return trimmed.startsWith("|") && trimmed.indexOf('|', 1) > 0
}

private fun tableCells(line: String): List<String> {
    val body = line.trim().removePrefix("|").removeSuffix("|")
    val cells = ArrayList<String>()
    val current = StringBuilder()
    var escaped = false
    for (char in body) {
        when {
            escaped -> {
                current.append(char)
                escaped = false
            }
            char == '\\' -> escaped = true
            char == '|' -> {
                cells += current.toString().trim()
                current.clear()
            }
            else -> current.append(char)
        }
    }
    cells += current.toString().trim()
    return cells
}

private fun encodeTable(rows: List<List<String>>) = rows.joinToString("\n") { it.joinToString("\u001f") }
