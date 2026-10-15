package ch.fasrv.fanotes.text

/**
 * Lines of a note as they sit on the desktop paper: headings, quotes, lists
 * and code, with the ink marker and other HTML comments left off the page.
 * Inline markers such as `**bold**` stay in the text for the renderer.
 */
enum class PaperKind { H1, H2, H3, H4, H5, H6, PARAGRAPH, BULLET, NUMBER, TASK, QUOTE, CODE, MATH, RULE, TABLE, IMAGE, SPACER }

/** Column alignment from a GFM separator, the same `:---`, `:---:`, and `---:` the preview uses. */
enum class TableAlign { LEFT, CENTER, RIGHT }

data class PaperLine(val kind: PaperKind, val text: String, val sourceLine: Int = -1)

private val COMMENT = Regex("""<!--[\s\S]*?-->""")
private val BULLET = Regex("""^\s*[-*+]\s+""")
private val NUMBER = Regex("""^\s*(\d+)\.\s+""")
private val TASK = Regex("""^\s*[-*+]\s+\[([ xX])](?:\s+(.*))?$""")
private val TABLE_RULE = Regex("""^:?-{3,}:?$""")
private val IMAGE_LINE = Regex("""^!\[([^\]]*)]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$""")

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
            var aligns = emptyList<TableAlign>()
            while (index < lines.size && isTableRow(lines[index])) {
                val cells = tableCells(lines[index])
                if (cells.isNotEmpty() && cells.all { TABLE_RULE.matches(it) }) {
                    if (aligns.isEmpty()) aligns = cells.map(::tableColumnAlign)
                } else if (cells.isNotEmpty()) {
                    rows += cells
                }
                index += 1
            }
            if (rows.isNotEmpty()) out += PaperLine(PaperKind.TABLE, encodeTable(rows, aligns), tableStart)
            continue
        }
        val trimmed = raw.trim()
        val task = TASK.find(raw)
        when {
            trimmed.isEmpty() -> out += PaperLine(PaperKind.SPACER, "", index)
            trimmed.startsWith("###### ") -> out += PaperLine(PaperKind.H6, trimmed.drop(7).trim(), index)
            trimmed.startsWith("##### ") -> out += PaperLine(PaperKind.H5, trimmed.drop(6).trim(), index)
            trimmed.startsWith("#### ") -> out += PaperLine(PaperKind.H4, trimmed.drop(5).trim(), index)
            trimmed.startsWith("### ") -> out += PaperLine(PaperKind.H3, trimmed.drop(4).trim(), index)
            trimmed.startsWith("## ") -> out += PaperLine(PaperKind.H2, trimmed.drop(3).trim(), index)
            trimmed.startsWith("# ") -> out += PaperLine(PaperKind.H1, trimmed.drop(2).trim(), index)
            trimmed.startsWith("> ") || trimmed == ">" -> {
                val body = if (trimmed == ">") "" else trimmed.drop(2).trim()
                out += PaperLine(PaperKind.QUOTE, listIndent(raw) + body, index)
            }
            trimmed == "---" || trimmed == "***" || trimmed == "___" -> out += PaperLine(PaperKind.RULE, "", index)
            task != null -> out += PaperLine(
                PaperKind.TASK,
                "${if (task.groupValues[1].equals("x", true)) "x" else " "}|${listIndent(raw)}${task.groupValues[2]}",
                index,
            )
            NUMBER.containsMatchIn(raw) -> out += PaperLine(PaperKind.NUMBER, listIndent(raw) + raw.trim(), index)
            BULLET.containsMatchIn(raw) -> out += PaperLine(PaperKind.BULLET, listIndent(raw) + BULLET.replace(raw, "").trim(), index)
            IMAGE_LINE.matches(trimmed) -> {
                val image = IMAGE_LINE.matchEntire(trimmed)!!
                out += PaperLine(PaperKind.IMAGE, "${image.groupValues[1]}\u001f${image.groupValues[2]}", index)
            }
            else -> out += PaperLine(PaperKind.PARAGRAPH, raw.trimEnd(), index)
        }
        index += 1
    }
    if (inCode && code.isNotEmpty()) out += PaperLine(PaperKind.CODE, code.toString().trimEnd(), codeStart)
    if (inMath && math.isNotEmpty()) out += PaperLine(PaperKind.MATH, math.toString().trimEnd(), mathStart)
    return out
}

fun tableRows(text: String): List<List<String>> =
    text.split('\n').filterNot { it.startsWith(ALIGN_PREFIX) }.map { row -> row.split('\u001f') }

/** Column alignment stored with a paper table. Missing columns stay left. */
fun tableAlignments(text: String): List<TableAlign> {
    val line = text.lineSequence().firstOrNull { it.startsWith(ALIGN_PREFIX) } ?: return emptyList()
    return line.removePrefix(ALIGN_PREFIX).split('\u001f').map(::tableAlignToken)
}

/** Token line stored on a details-card table row: `left`, `center`, or `right` per column. */
fun tableAlignWire(text: String): String =
    tableAlignments(text).joinToString("\u001f") { alignWire(it) }

/** One column from the token line a details card keeps beside the cells. */
fun tableAlignAt(tokens: String, column: Int): TableAlign {
    if (column < 0 || tokens.isEmpty()) return TableAlign.LEFT
    return tableAlignToken(tokens.split('\u001f').getOrElse(column) { "left" })
}

/**
 * Where a cell's text starts inside its column. [pad] matches the inset the
 * paper and the details card already leave around the words.
 */
fun tableCellOrigin(align: TableAlign, columnLeft: Float, columnWidth: Float, textWidth: Float, pad: Float): Float {
    val inner = (columnWidth - pad * 2f).coerceAtLeast(0f)
    val used = textWidth.coerceIn(0f, inner)
    val shift = when (align) {
        TableAlign.CENTER -> (inner - used) / 2f
        TableAlign.RIGHT -> inner - used
        TableAlign.LEFT -> 0f
    }
    return columnLeft + pad + shift
}

private fun tableColumnAlign(cell: String): TableAlign {
    val token = cell.trim()
    val left = token.startsWith(':')
    val right = token.endsWith(':')
    return when {
        left && right -> TableAlign.CENTER
        right -> TableAlign.RIGHT
        else -> TableAlign.LEFT
    }
}

private fun tableAlignToken(token: String): TableAlign = when (token) {
    "center" -> TableAlign.CENTER
    "right" -> TableAlign.RIGHT
    else -> TableAlign.LEFT
}

private fun alignWire(align: TableAlign): String = when (align) {
    TableAlign.CENTER -> "center"
    TableAlign.RIGHT -> "right"
    TableAlign.LEFT -> "left"
}

/** Caption for a whole-line markdown image. The alt text wins; otherwise the file name. */
fun paperImageCaption(text: String): String {
    val alt = text.substringBefore('\u001f').trim()
    if (alt.isNotEmpty()) return alt
    val source = text.substringAfter('\u001f').substringBefore('?').substringAfterLast('/')
    return source.ifBlank { "Bild" }
}

fun paperImageSource(text: String): String = text.substringAfter('\u001f')

/** Spaces or tabs before a list marker or quote, kept so a nested item stays indented. */
private fun listIndent(raw: String): String = raw.takeWhile { it == ' ' || it == '\t' }

/**
 * Vault paths for a markdown image. A relative source is tried beside the note,
 * then from the vault root. Web and data URLs are left to the caption card.
 */
fun resolvePaperImagePaths(notePath: String, source: String): List<String> {
    val decoded = runCatching { java.net.URLDecoder.decode(source.trim(), Charsets.UTF_8.name()) }.getOrDefault(source.trim())
    val raw = decoded.removePrefix("./").replace('\\', '/').trim()
    if (raw.isEmpty()) return emptyList()
    val lower = raw.lowercase()
    if (lower.startsWith("http://") || lower.startsWith("https://") || lower.startsWith("data:") || lower.startsWith("blob:") || lower.startsWith("mailto:")) {
        return emptyList()
    }
    val cleaned = raw.trim('/')
    if (cleaned.isEmpty() || cleaned.split('/').any { it.isEmpty() || it == "." || it == ".." }) return emptyList()
    val folder = notePath.replace('\\', '/').substringBeforeLast('/', "")
    val beside = if (folder.isEmpty()) cleaned else "$folder/$cleaned"
    return listOf(beside, cleaned).distinct()
}

/** Display size inside the text column. Tall pictures stay within 1.35× the column width. */
fun paperImageFrame(pixelWidth: Int, pixelHeight: Int, columnPx: Float): Pair<Float, Float> {
    if (pixelWidth <= 0 || pixelHeight <= 0 || columnPx <= 0f) return columnPx.coerceAtLeast(1f) to 96f
    val height = columnPx * pixelHeight.toFloat() / pixelWidth.toFloat()
    return columnPx to height.coerceIn(48f, columnPx * 1.35f)
}

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

private const val ALIGN_PREFIX = "\u0002"

private fun encodeTable(rows: List<List<String>>, aligns: List<TableAlign>): String {
    val columns = maxOf(rows.maxOf { it.size }, aligns.size).coerceAtLeast(1)
    val used = List(columns) { index -> aligns.getOrElse(index) { TableAlign.LEFT } }
    val head = ALIGN_PREFIX + used.joinToString("\u001f", transform = ::alignWire)
    val body = rows.joinToString("\n") { it.joinToString("\u001f") }
    return "$head\n$body"
}
