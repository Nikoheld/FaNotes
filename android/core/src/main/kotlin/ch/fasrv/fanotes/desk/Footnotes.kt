package ch.fasrv.fanotes.desk

/**
 * GitHub-style footnotes, as remark-gfm renders them in the desktop preview.
 * Definitions leave the paragraph flow. Each reference becomes a superscript
 * number in the order it first appears, and the definition is listed below.
 */
data class FootnotePrep(val body: String, val notes: List<String>)

/** Footnote lines are smaller than the card body, close to the preview's 12px notes. */
const val FOOTNOTE_SCALE = 0.78f

private val FOOTNOTE_DEF = Regex("""^ {0,3}\[\^([^\]\s]+)]:[ \t]?(.*)$""")
private val FOOTNOTE_REF = Regex("""\[\^([^\]\s]+)](?!:)""")
private val FENCE_LINE = Regex("""^ {0,3}(`{3,}|~{3,})[^`~]*$""")

fun prepareFootnotes(markdown: String): FootnotePrep {
    val lines = markdown.replace("\r\n", "\n").split('\n')
    val drop = BooleanArray(lines.size)
    val definitions = LinkedHashMap<String, String>()
    var fence: Char? = null
    var index = 0
    while (index < lines.size) {
        val line = lines[index]
        val marker = fenceMarker(line)
        if (marker != null && (fence == null || marker == fence)) {
            fence = if (fence == null) marker else null
            index += 1
            continue
        }
        if (fence != null) {
            index += 1
            continue
        }
        val defined = FOOTNOTE_DEF.matchEntire(line) ?: run {
            index += 1
            continue
        }
        val id = defined.groupValues[1]
        val buffer = StringBuilder(defined.groupValues[2])
        drop[index] = true
        var next = index + 1
        while (next < lines.size) {
            val candidate = lines[next]
            if (candidate.isBlank()) {
                var look = next
                while (look < lines.size && lines[look].isBlank()) look += 1
                if (look < lines.size && isContinuation(lines[look])) {
                    for (blank in next until look) {
                        drop[blank] = true
                        buffer.append('\n')
                    }
                    next = look
                    continue
                }
                break
            }
            if (!isContinuation(candidate)) break
            drop[next] = true
            buffer.append('\n')
            buffer.append(stripContinuation(candidate))
            next += 1
        }
        if (id !in definitions) definitions[id] = buffer.toString().trimEnd()
        index = next
    }
    val order = LinkedHashMap<String, Int>()
    val replaced = StringBuilder()
    fence = null
    lines.forEachIndexed { lineIndex, line ->
        if (drop[lineIndex]) return@forEachIndexed
        if (replaced.isNotEmpty()) replaced.append('\n')
        val marker = fenceMarker(line)
        if (marker != null && (fence == null || marker == fence)) {
            fence = if (fence == null) marker else null
            replaced.append(line)
            return@forEachIndexed
        }
        if (fence != null) {
            replaced.append(line)
            return@forEachIndexed
        }
        replaced.append(replaceReferences(line, definitions, order))
    }
    return FootnotePrep(replaced.toString(), order.keys.map { definitions[it].orEmpty() })
}

private fun replaceReferences(
    line: String,
    definitions: Map<String, String>,
    order: LinkedHashMap<String, Int>,
): String {
    val out = StringBuilder()
    var index = 0
    while (index < line.length) {
        val tick = line.indexOf('`', index)
        val match = FOOTNOTE_REF.find(line, index)
        val tickAt = if (tick < 0) Int.MAX_VALUE else tick
        val refAt = match?.range?.first ?: Int.MAX_VALUE
        if (tickAt == Int.MAX_VALUE && refAt == Int.MAX_VALUE) {
            out.append(line.substring(index))
            break
        }
        if (tickAt <= refAt) {
            var ticks = 0
            while (tick + ticks < line.length && line[tick + ticks] == '`') ticks += 1
            val closer = indexOfTicks(line, tick + ticks, ticks)
            if (closer < 0) {
                out.append(line.substring(index))
                break
            }
            out.append(line, index, closer + ticks)
            index = closer + ticks
            continue
        }
        val found = match ?: break
        if (found.range.first > index) out.append(line, index, found.range.first)
        val id = found.groupValues[1]
        if (id in definitions) {
            val number = order.getOrPut(id) { order.size + 1 }
            out.append('\u0003').append(number).append('\u0003')
        } else {
            out.append(found.value)
        }
        index = found.range.last + 1
    }
    return out.toString()
}

private fun fenceMarker(line: String): Char? = FENCE_LINE.find(line)?.groupValues?.get(1)?.firstOrNull()

private fun isContinuation(line: String): Boolean = line.startsWith("    ") || line.startsWith("\t")

private fun stripContinuation(line: String): String = when {
    line.startsWith("\t") -> line.drop(1)
    line.startsWith("    ") -> line.drop(4)
    else -> line
}

private fun indexOfTicks(line: String, from: Int, ticks: Int): Int {
    if (ticks <= 0) return -1
    var index = from
    while (index <= line.length - ticks) {
        if ((0 until ticks).all { line[index + it] == '`' }) return index
        index += 1
    }
    return -1
}
