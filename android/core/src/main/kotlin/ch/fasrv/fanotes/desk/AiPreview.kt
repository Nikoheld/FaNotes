package ch.fasrv.fanotes.desk

import ch.fasrv.fanotes.text.PaperKind
import ch.fasrv.fanotes.text.PaperLine
import ch.fasrv.fanotes.text.paperLines
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
    ) {
        val found = ArrayList<MatchResult>()
        var guard = 0
        for (match in pattern.findAll(value)) {
            val from = match.range.first
            val to = match.range.last + 1
            if (from < guard) continue
            if (skipInsideCode && marks.any { it.kind == "code" && from >= it.start && to <= it.end }) continue
            if (kind == "link" && marks.any { it.kind == "link" && from >= it.start && to <= it.end }) continue
            found += match
            guard = to
        }
        if (found.isEmpty()) return
        val builder = StringBuilder()
        val slices = ArrayList<PlainSlice>()
        val added = ArrayList<DetailsInline>()
        var cursor = 0
        for (match in found) {
            val from = match.range.first
            val to = match.range.last + 1
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
    if (autolinks) {
        rewrite(ANGLE_LINK, "link", { it.groupValues[1] }, { 1 }, { it.groupValues[1] }, skipInsideCode = true)
        rewrite(BARE_URL, "link", { it.value }, { 0 }, { it.value }, skipInsideCode = true)
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
private val ANGLE_LINK = Regex("""<((?:https?://|mailto:)[^>\s]+)>""")
private val BARE_URL = Regex("""(?<![A-Za-z0-9_/<])https?://[^\s<>]+?(?=[.,;:!?)]*(?:\s|$))""")
private val ITALIC_STAR = Regex("""(?<!\*)\*(?!\*)(\S(?:.*?\S)?)\*(?!\*)""")
private val ITALIC_UNDER = Regex("""(?<!_)_(?!_)(\S(?:.*?\S)?)_(?!_)""")
