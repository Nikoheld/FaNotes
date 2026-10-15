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

fun stripPreviewMarkers(text: String): String {
    var value = IMAGE.replace(text) { it.groupValues[1] }
    value = WIKI.replace(value) { match -> match.groupValues[2].ifBlank { match.groupValues[1] } }
    value = LINK.replace(value) { it.groupValues[1] }
    value = BOLD.replace(value) { it.groupValues[2] }
    value = STRIKE.replace(value) { it.groupValues[1] }
    value = CODE.replace(value) { it.groupValues[1] }
    value = ITALIC_STAR.replace(value) { it.groupValues[1] }
    value = ITALIC_UNDER.replace(value) { it.groupValues[1] }
    return value
}

private val IMAGE = Regex("""!\[([^\]]*)]\([^)\n]*\)""")
private val WIKI = Regex("""\[\[([^\]|\n]+)(?:\|([^\]]+))?]]""")
private val LINK = Regex("""\[([^\]\n]+)]\([^)\n]*\)""")
private val BOLD = Regex("""(\*\*|__)(?=\S)(.+?\S)\1""")
private val STRIKE = Regex("""~~(?=\S)(.+?\S)~~""")
private val CODE = Regex("""`([^`\n]+)`""")
private val ITALIC_STAR = Regex("""(?<!\*)\*(?!\*)(\S(?:.*?\S)?)\*(?!\*)""")
private val ITALIC_UNDER = Regex("""(?<!_)_(?!_)(\S(?:.*?\S)?)_(?!_)""")
