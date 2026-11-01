package ch.fasrv.fanotes.schulnetz

private val ROW = Regex("""<tr\b[^>]*>(.*?)</tr>""", setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL))
private val CELL = Regex("""<t[dh]\b[^>]*>(.*?)</t[dh]>""", setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL))
private val DATE_CELL = Regex("""\d{1,2}\.\d{1,2}\.\d{2,4}""")
private val MESSAGE_BLOCK = Regex(
    """<(div|article|li|p)\b[^>]*class="[^"]*(mitteilung|message|news|ankündigung|ankuendigung|cls-start)[^"]*"[^>]*>(.*?)</\1>""",
    setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL),
)
private val TAG = Regex("""<[^>]+>""")
private val SCRIPT = Regex("""<(script|style)\b[^>]*>.*?</\1>""", setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL))

/**
 * Kontoauszug is not on the mobile REST API. The poller may GET page 21411 and
 * pass the HTML here. Rows that are not a date plus a label are ignored.
 */
fun parseKontoauszug(html: String): List<KontoLine> {
    if (html.isBlank()) return emptyList()
    val cleaned = SCRIPT.replace(html, " ")
    val lines = mutableListOf<KontoLine>()
    for (row in ROW.findAll(cleaned)) {
        val cells = CELL.findAll(row.groupValues[1]).map { htmlText(it.groupValues[1]) }.filter { it.isNotEmpty() }.toList()
        if (cells.size < 3) continue
        if (!DATE_CELL.containsMatchIn(cells[0])) continue
        lines += KontoLine(
            date = cells[0],
            label = cells[1],
            amount = cells[2],
            balance = cells.getOrElse(3) { "" },
        )
    }
    return lines
}

/** Start-page notices. Returns nothing when the HTML is a login wall or an unrelated page. */
fun parseStartMessages(html: String): List<String> {
    if (html.isBlank()) return emptyList()
    val cleaned = SCRIPT.replace(html, " ")
    val found = MESSAGE_BLOCK.findAll(cleaned).map { htmlText(it.groupValues[3]) }.filter { it.length in 3..500 }.distinct().toList()
    return found.take(20)
}

internal fun htmlText(raw: String): String = TAG.replace(raw, " ")
    .replace("&nbsp;", " ")
    .replace("&#160;", " ")
    .replace("&amp;", "&")
    .replace("&quot;", "\"")
    .replace("&#39;", "'")
    .replace(Regex("""\s+"""), " ")
    .trim()
