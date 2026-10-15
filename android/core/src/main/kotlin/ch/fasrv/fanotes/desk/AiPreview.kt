package ch.fasrv.fanotes.desk

import ch.fasrv.fanotes.text.PaperKind
import ch.fasrv.fanotes.text.PaperLine
import ch.fasrv.fanotes.text.TableAlign
import ch.fasrv.fanotes.text.paperLines
import ch.fasrv.fanotes.text.tableAlignAt
import ch.fasrv.fanotes.text.tableRows

/**
 * The desktop AI result can be read as rendered Markdown („Schön“) or as
 * the source. Schön uses the same paper blocks as the note page and hides
 * the inline markers.
 */
fun aiPreviewLines(markdown: String): List<PaperLine> = paperLines(markdown)

fun aiPreviewLineText(line: PaperLine): String = when (line.kind) {
    PaperKind.TABLE -> tableRows(line.text).joinToString("\n") { row -> row.joinToString(" · ") }
    PaperKind.TASK -> {
        val done = line.text.startsWith("x|")
        val body = line.text.substringAfter('|')
        "${if (done) "☑" else "☐"} ${stripPreviewMarkers(body)}"
    }
    PaperKind.RULE, PaperKind.SPACER -> ""
    PaperKind.IMAGE -> ch.fasrv.fanotes.text.paperImageCaption(line.text)
    PaperKind.CODE, PaperKind.MATH -> line.text
    else -> stripPreviewMarkers(line.text)
}

/** Heading sizes from the desktop paper stylesheet, relative to the preview font. */
fun aiPreviewScale(kind: PaperKind): Float = when (kind) {
    PaperKind.H1 -> 2f
    PaperKind.H2 -> 1.55f
    PaperKind.H3 -> 1.28f
    PaperKind.H4 -> 1.1f
    else -> 1f
}

/** Heading sizes from `.markdown-preview`, which the desktop Schön view uses. */
fun aiPreviewReadingScale(kind: PaperKind): Float = when (kind) {
    PaperKind.H1 -> 2.15f
    PaperKind.H2 -> 1.55f
    PaperKind.H3 -> 1.22f
    PaperKind.H4 -> 1.02f
    else -> 1f
}

/**
 * Turns a table-cell separator into a visible divider and keeps inline marks
 * on the words they styled.
 */
fun expandFieldSeparators(text: String, marks: List<DetailsInline>): Pair<String, List<DetailsInline>> {
    if (!text.contains('\u001f')) return text to marks
    val out = StringBuilder()
    val shift = IntArray(text.length + 1)
    var added = 0
    text.forEachIndexed { index, char ->
        shift[index] = added
        if (char == '\u001f') {
            out.append(" · ")
            added += 2
        } else {
            out.append(char)
        }
    }
    shift[text.length] = added
    val moved = marks.mapNotNull { mark ->
        val start = mark.start.coerceIn(0, text.length)
        val end = mark.end.coerceIn(start, text.length)
        val newStart = start + shift[start]
        val newEnd = end + shift[end]
        if (newEnd > newStart) mark.copy(start = newStart, end = newEnd) else null
    }
    return out.toString() to moved
}

/** `.markdown-preview th { font-size: .9em }`. */
const val PREVIEW_TABLE_HEAD = 0.9f

/** `.markdown-preview code` is 0.88em of the surrounding text. */
const val PREVIEW_CODE_SCALE = 0.88f

data class PreviewCodeBox(val textPx: Float, val padX: Float, val padY: Float, val radius: Float, val border: Float)

/**
 * Reading-preview inline code chip. Padding is `em` of the smaller code font,
 * and the 5px corner is a CSS pixel, not an em.
 */
fun previewCodeBox(textSizePx: Float): PreviewCodeBox {
    val base = if (textSizePx <= 0f) 16f else textSizePx
    val text = base * PREVIEW_CODE_SCALE
    return PreviewCodeBox(
        textPx = text,
        padX = text * 0.38f,
        padY = text * 0.16f,
        radius = 5f,
        border = 1f,
    )
}

/** One inline-code chip in the laid-out preview string. The slot is a single object character. */
data class PreviewCodeSlot(val id: String, val label: String)

data class PreviewCodeDisplay(
    val text: String,
    val marks: List<DetailsInline>,
    val slots: List<PreviewCodeSlot>,
    val sourceAt: List<Int>,
    val markerEnd: Int,
)

/**
 * Replaces each inline code span with one object character so the preview can
 * draw the desktop chip. [sourceAt] maps a displayed offset back to the source.
 */
fun previewCodeDisplay(text: String, marks: List<DetailsInline>, markerEnd: Int = 0): PreviewCodeDisplay {
    val codes = ArrayList<DetailsInline>()
    val ordered = marks.filter { it.kind == "code" }.sortedBy { it.start }
    for (mark in ordered) {
        val start = mark.start.coerceIn(0, text.length)
        val end = mark.end.coerceIn(start, text.length)
        if (end <= start) continue
        if (codes.isNotEmpty() && start < codes.last().end) continue
        codes += mark.copy(start = start, end = end)
    }
    if (codes.isEmpty()) {
        return PreviewCodeDisplay(text, marks, emptyList(), emptyList(), markerEnd.coerceIn(0, text.length))
    }
    val out = StringBuilder()
    val sourceAt = ArrayList<Int>(text.length)
    val slots = ArrayList<PreviewCodeSlot>(codes.size)
    var cursor = 0
    for (code in codes) {
        while (cursor < code.start) {
            sourceAt += cursor
            out.append(text[cursor])
            cursor += 1
        }
        slots += PreviewCodeSlot("c${slots.size}", text.substring(code.start, code.end))
        sourceAt += code.start
        out.append('\uFFFC')
        cursor = code.end
    }
    while (cursor < text.length) {
        sourceAt += cursor
        out.append(text[cursor])
        cursor += 1
    }
    sourceAt += text.length
    val displayedOf = IntArray(text.length + 1)
    var displayed = 0
    for (source in 0..text.length) {
        while (displayed < sourceAt.lastIndex && sourceAt[displayed] < source) displayed += 1
        displayedOf[source] = displayed.coerceAtMost(out.length)
    }
    val shifted = marks.mapNotNull { mark ->
        if (mark.kind == "code") return@mapNotNull null
        val start = displayedOf[mark.start.coerceIn(0, text.length)]
        val end = displayedOf[mark.end.coerceIn(0, text.length)]
        if (end <= start) null else mark.copy(start = start, end = end)
    }
    return PreviewCodeDisplay(
        out.toString(),
        shifted,
        slots,
        sourceAt,
        displayedOf[markerEnd.coerceIn(0, text.length)],
    )
}

/** Displayed caret back to the source string. An empty map means the text was not rewritten. */
fun previewSourceOffset(sourceAt: List<Int>, offset: Int): Int {
    if (sourceAt.isEmpty()) return offset.coerceAtLeast(0)
    return sourceAt[offset.coerceIn(0, sourceAt.lastIndex)]
}

/** One cell of a Schön table, with marks in that cell's own coordinates. */
data class PreviewTableCell(val text: String, val align: TableAlign, val inlines: List<DetailsInline>)

fun previewTableCells(text: String, inlines: List<DetailsInline>, alignTokens: String): List<PreviewTableCell> {
    val cells = if (text.isEmpty()) listOf("") else text.split('\u001f')
    var origin = 0
    return cells.mapIndexed { index, cell ->
        val end = origin + cell.length
        val marks = inlines.mapNotNull { mark ->
            if (mark.end <= origin || mark.start >= end) return@mapNotNull null
            mark.copy(
                start = (mark.start - origin).coerceAtLeast(0),
                end = (mark.end - origin).coerceAtMost(cell.length),
            )
        }.filter { it.end > it.start }
        origin = end + 1
        PreviewTableCell(cell, tableAlignAt(alignTokens, index), marks)
    }
}

/** Accent list marker from `.markdown-preview li::marker`, including the trailing space. */
fun previewMarkerEnd(text: String, kind: String): Int {
    val indent = text.takeWhile { it == ' ' || it == '\t' }.length
    val rest = text.drop(indent)
    val marker = when (kind) {
        "bullet" -> if (rest.startsWith("• ")) "• " else ""
        "number" -> Regex("""^\d+\.\s+""").find(rest)?.value.orEmpty()
        else -> ""
    }
    return if (marker.isEmpty()) 0 else indent + marker.length
}

fun aiPreviewHeading(kind: PaperKind): Boolean = kind == PaperKind.H1 || kind == PaperKind.H2 ||
    kind == PaperKind.H3 || kind == PaperKind.H4 || kind == PaperKind.H5 || kind == PaperKind.H6

fun stripPreviewMarkers(text: String): String = detailsPlain(text).first

/**
 * One inline mark inside a details card, in the coordinates of the stripped
 * line. Kinds match the desktop preview: strong, emphasis, strike, code, link.
 */
data class DetailsInline(val start: Int, val end: Int, val kind: String, val target: String = "")

/**
 * Strips the same markers as the preview and remembers where bold, italic,
 * strike, code, and links land in the text the card draws.
 */
fun detailsPlain(text: String, collapseImages: Boolean = true, autolinks: Boolean = false): Pair<String, List<DetailsInline>> {
    var value = text
    var marks = emptyList<DetailsInline>()
    fun rewrite(
        pattern: Regex,
        kind: String,
        innerOf: (MatchResult) -> String,
        innerAtOf: (MatchResult) -> Int,
        targetOf: (MatchResult) -> String = { "" },
        skipInsideCode: Boolean = false,
        endTrim: (MatchResult) -> Int = { 0 },
        accept: (MatchResult) -> Boolean = { true },
    ) {
        val found = ArrayList<MatchResult>()
        var guard = 0
        for (match in pattern.findAll(value)) {
            val trim = endTrim(match).coerceIn(0, match.value.length)
            val from = match.range.first
            val to = match.range.last + 1 - trim
            if (to <= from) continue
            if (from < guard) continue
            if (skipInsideCode && marks.any { it.kind == "code" && from >= it.start && to <= it.end }) continue
            if (kind == "link" && marks.any { it.kind == "link" && from >= it.start && to <= it.end }) continue
            if (!accept(match)) continue
            found += match
            guard = to
        }
        if (found.isEmpty()) return
        val builder = StringBuilder()
        val slices = ArrayList<PlainSlice>()
        val added = ArrayList<DetailsInline>()
        var cursor = 0
        for (match in found) {
            val trim = endTrim(match).coerceIn(0, match.value.length)
            val from = match.range.first
            val to = match.range.last + 1 - trim
            builder.append(value, cursor, from)
            val inner = innerOf(match)
            val newStart = builder.length
            builder.append(inner)
            slices += PlainSlice(from, to, newStart, innerAtOf(match).coerceIn(0, (to - from).coerceAtLeast(0)), inner.length)
            if (kind.isNotEmpty() && inner.isNotEmpty()) added += DetailsInline(newStart, newStart + inner.length, kind, targetOf(match))
            cursor = to
        }
        builder.append(value, cursor, value.length)
        val remapped = ArrayList<DetailsInline>(marks.size)
        for (mark in marks) {
            val start = mapPlainPoint(mark.start, slices)
            val end = mapPlainPoint(mark.end, slices)
            if (end > start) remapped += mark.copy(start = start, end = end)
        }
        value = builder.toString()
        marks = remapped + added
    }
    if (collapseImages) rewrite(IMAGE, "", { it.groupValues[1] }, { 2 })
    rewrite(WIKI, "link", { it.groupValues[2].ifBlank { it.groupValues[1] } }, ::wikiInnerAt, { it.groupValues[1] })
    rewrite(LINK, "link", { it.groupValues[1] }, { 1 }, ::linkTarget)
    rewrite(BOLD, "strong", { it.groupValues[2] }, { it.groupValues[1].length })
    rewrite(STRIKE, "strike", { it.groupValues[1] }, { 2 })
    rewrite(CODE, "code", { it.groupValues[2] }, { it.groupValues[1].length })
    rewrite(MATH, "math", { it.groupValues[1] }, { 1 }, skipInsideCode = true)
    rewrite(FOOTNOTE_MARK, "footnote", { it.groupValues[1] }, { 1 }, skipInsideCode = true)
    if (autolinks) {
        rewrite(ANGLE_LINK, "link", { it.groupValues[1] }, { 1 }, { it.groupValues[1] }, skipInsideCode = true)
        rewrite(
            ANGLE_EMAIL,
            "link",
            { it.groupValues[1] },
            { 1 },
            { "mailto:${it.groupValues[1]}" },
            skipInsideCode = true,
        )
        rewrite(BARE_URL, "link", { it.value }, { 0 }, { it.value }, skipInsideCode = true)
        rewrite(
            WWW_RUN,
            "link",
            { it.value.dropLast(autolinkEndTrim(it.value)) },
            { 0 },
            { "http://${it.value.dropLast(autolinkEndTrim(it.value))}" },
            skipInsideCode = true,
            endTrim = { autolinkEndTrim(it.value) },
            accept = { wwwAutolinkOk(it.value) },
        )
        rewrite(
            EMAIL_RUN,
            "link",
            { it.value.dropLast(autolinkEndTrim(it.value)) },
            { 0 },
            { "mailto:${it.value.dropLast(autolinkEndTrim(it.value))}" },
            skipInsideCode = true,
            endTrim = { autolinkEndTrim(it.value) },
            accept = { emailAutolinkOk(it.value) },
        )
    }
    rewrite(ITALIC_STAR, "emphasis", { it.groupValues[1] }, { 1 })
    rewrite(ITALIC_UNDER, "emphasis", { it.groupValues[1] }, { 1 })
    return value to marks.filter { it.start >= 0 && it.end <= value.length && it.end > it.start }
}

private data class PlainSlice(val from: Int, val to: Int, val newStart: Int, val innerAt: Int, val innerLen: Int)

private fun mapPlainPoint(index: Int, slices: List<PlainSlice>): Int {
    var removed = 0
    for (slice in slices) {
        val cut = (slice.to - slice.from) - slice.innerLen
        if (index <= slice.from) return index - removed
        if (index >= slice.to) {
            removed += cut
            continue
        }
        val innerFrom = slice.from + slice.innerAt
        val innerTo = innerFrom + slice.innerLen
        if (index <= innerFrom) return slice.newStart
        if (index >= innerTo) return slice.newStart + slice.innerLen
        return slice.newStart + (index - innerFrom)
    }
    return index - removed
}

private fun wikiInnerAt(match: MatchResult): Int {
    val alias = match.groupValues[2]
    return if (alias.isNotEmpty()) match.value.indexOf('|') + 1 else 2
}

private fun linkTarget(match: MatchResult): String {
    val raw = match.value
    val open = raw.indexOf("](")
    if (open < 0 || !raw.endsWith(")")) return ""
    return raw.substring(open + 2, raw.length - 1)
}

private val IMAGE = Regex("""!\[([^\]]*)]\([^)\n]*\)""")
private val WIKI = Regex("""\[\[([^\]|\n]+)(?:\|([^\]]+))?]]""")
private val LINK = Regex("""\[([^\]\n]+)]\([^)\n]*\)""")
private val BOLD = Regex("""(\*\*|__)(?=\S)(.+?\S)\1""")
private val STRIKE = Regex("""~~(?=\S)(.+?\S)~~""")
private val CODE = Regex("""(`+)([^`\n]+?)\1""")
private val MATH = Regex("""(?<!\$)\$([^$\n]+?)\$(?!\$)""")
private val FOOTNOTE_MARK = Regex("""\u0003(\d+)\u0003""")
private val ANGLE_LINK = Regex("""<((?:https?://|mailto:)[^>\s]+)>""")
private val ANGLE_EMAIL = Regex("""<([A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)>""")
private val BARE_URL = Regex("""(?<![A-Za-z0-9_/<])https?://[^\s<>]+?(?=[.,;:!?)]*(?:\s|$))""")
private val WWW_RUN = Regex("""(?<![A-Za-z0-9_/])www\.[^\s<]+""")
private val EMAIL_RUN = Regex("""(?<![A-Za-z0-9_@./])[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+""")
private const val AUTOLINK_TRAIL = "?!.,:*_~'\"”’"

/** Drops the punctuation GFM leaves outside a www or email autolink. */
private fun autolinkEndTrim(raw: String): Int {
    var end = raw.length
    while (end > 0 && raw[end - 1] in AUTOLINK_TRAIL) end--
    var opens = 0
    var closes = 0
    for (index in 0 until end) {
        when (raw[index]) {
            '(' -> opens++
            ')' -> closes++
        }
    }
    while (closes > opens && end > 0 && raw[end - 1] == ')') {
        end--
        closes--
    }
    return raw.length - end
}

private fun wwwAutolinkOk(raw: String): Boolean {
    val body = raw.dropLast(autolinkEndTrim(raw))
    if (!body.startsWith("www.")) return false
    val host = body.removePrefix("www.").takeWhile { it != '/' && it != '?' && it != '#' }
    if (host.isEmpty() || host.startsWith('.') || host.endsWith('.') || host.endsWith('-')) return false
    val labels = host.split('.')
    if (labels.size < 2) return false
    return labels.all { label ->
        label.isNotEmpty() && !label.startsWith('-') && !label.endsWith('-') &&
            label.all { it.isLetterOrDigit() || it == '-' }
    }
}

private fun emailAutolinkOk(raw: String): Boolean {
    val body = raw.dropLast(autolinkEndTrim(raw))
    val at = body.indexOf('@')
    if (at <= 0 || body.indexOf('@', at + 1) >= 0) return false
    val domain = body.substring(at + 1)
    return domain.contains('.') && !domain.startsWith('.') && !domain.endsWith('.')
}

private val ITALIC_STAR = Regex("""(?<!\*)\*(?!\*)(\S(?:.*?\S)?)\*(?!\*)""")
private val ITALIC_UNDER = Regex("""(?<!_)_(?!_)(\S(?:.*?\S)?)_(?!_)""")
