package ch.fasrv.fanotes.study

import ch.fasrv.fanotes.desk.PdfTextMark

/** Summary of the highlights made on a PDF, grouped by page (`lib/study/marks.ts`). */

data class MarkPage(val page: Int, val marks: List<PdfTextMark>)

fun groupMarksByPage(marks: List<PdfTextMark>): List<MarkPage> =
    marks.groupBy { it.page }.toSortedMap().map { (page, list) -> MarkPage(page, list) }

/** Marks as a Markdown note: one heading per page, one quote per highlight. */
fun marksToMarkdown(title: String, marks: List<PdfTextMark>): String {
    val out = ArrayList<String>()
    out += "# Markierungen: $title"
    out += ""
    for (group in groupMarksByPage(marks)) {
        out += "## Seite ${group.page}"
        out += ""
        for (mark in group.marks) {
            val fence = if (mark.kind == "underline") "__" else "=="
            out += "- $fence${mark.quote}$fence (S. ${mark.page})"
        }
        out += ""
    }
    return out.joinToString("\n").trim() + "\n"
}
