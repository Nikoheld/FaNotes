package ch.fasrv.fanotes.text

/**
 * Lines of a note as they sit on the desktop paper: headings, quotes, lists
 * and code, with the ink marker and other HTML comments left off the page.
 * Inline markers such as `**bold**` stay in the text for the renderer.
 */
enum class PaperKind { H1, H2, H3, H4, PARAGRAPH, BULLET, NUMBER, TASK, QUOTE, CODE, MATH, RULE, SPACER }

data class PaperLine(val kind: PaperKind, val text: String)

private val COMMENT = Regex("""<!--[\s\S]*?-->""")
private val BULLET = Regex("""^\s*[-*+]\s+""")
private val NUMBER = Regex("""^\s*(\d+)\.\s+""")
private val TASK = Regex("""^\s*[-*+]\s+\[([ xX])](?:\s+(.*))?$""")

fun paperLines(markdown: String): List<PaperLine> {
    val source = markdown.replace("\r\n", "\n").replace(COMMENT, "")
    val lines = source.split('\n')
    val out = ArrayList<PaperLine>(lines.size)
    var inCode = false
    var inMath = false
    val code = StringBuilder()
    val math = StringBuilder()
    for (raw in lines) {
        val fence = raw.trimStart().startsWith("```")
        if (fence) {
            if (inCode) {
                out += PaperLine(PaperKind.CODE, code.toString().trimEnd())
                code.clear()
                inCode = false
            } else {
                inCode = true
            }
            continue
        }
        if (inCode) {
            if (code.isNotEmpty()) code.append('\n')
            code.append(raw)
            continue
        }
        if (raw.trim() == "$$") {
            if (inMath) {
                out += PaperLine(PaperKind.MATH, math.toString().trimEnd())
                math.clear()
                inMath = false
            } else {
                inMath = true
            }
            continue
        }
        if (inMath) {
            if (math.isNotEmpty()) math.append('\n')
            math.append(raw)
            continue
        }
        val trimmed = raw.trim()
        val task = TASK.find(raw)
        when {
            trimmed.isEmpty() -> out += PaperLine(PaperKind.SPACER, "")
            trimmed.startsWith("###### ") -> out += PaperLine(PaperKind.H4, trimmed.drop(7).trim())
            trimmed.startsWith("##### ") -> out += PaperLine(PaperKind.H4, trimmed.drop(6).trim())
            trimmed.startsWith("#### ") -> out += PaperLine(PaperKind.H4, trimmed.drop(5).trim())
            trimmed.startsWith("### ") -> out += PaperLine(PaperKind.H3, trimmed.drop(4).trim())
            trimmed.startsWith("## ") -> out += PaperLine(PaperKind.H2, trimmed.drop(3).trim())
            trimmed.startsWith("# ") -> out += PaperLine(PaperKind.H1, trimmed.drop(2).trim())
            trimmed.startsWith("> ") -> out += PaperLine(PaperKind.QUOTE, trimmed.drop(2).trim())
            trimmed == ">" -> out += PaperLine(PaperKind.QUOTE, "")
            trimmed == "---" || trimmed == "***" || trimmed == "___" -> out += PaperLine(PaperKind.RULE, "")
            task != null -> out += PaperLine(PaperKind.TASK, "${if (task.groupValues[1].equals("x", true)) "x" else " "}|${task.groupValues[2]}")
            NUMBER.containsMatchIn(raw) -> out += PaperLine(PaperKind.NUMBER, raw.trim())
            BULLET.containsMatchIn(raw) -> out += PaperLine(PaperKind.BULLET, BULLET.replace(raw, "").trim())
            else -> out += PaperLine(PaperKind.PARAGRAPH, raw.trimEnd())
        }
    }
    if (inCode && code.isNotEmpty()) out += PaperLine(PaperKind.CODE, code.toString().trimEnd())
    if (inMath && math.isNotEmpty()) out += PaperLine(PaperKind.MATH, math.toString().trimEnd())
    return out
}
