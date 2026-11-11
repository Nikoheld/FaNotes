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

private val TR_SPLIT = Regex("""<tr\b""", RegexOption.IGNORE_CASE)
private val TABLE_END = Regex("""</table\b""", RegexOption.IGNORE_CASE)
private val CELL_SPLIT = Regex("""<t[dh]\b[^>]*>""", RegexOption.IGNORE_CASE)
private val OPEN_TAG_TAIL = Regex("""^[^>]*>""")
private val SALDO_LABEL = Regex("""^saldo:?$""", RegexOption.IGNORE_CASE)

/**
 * Page 21411 leaves <tr>/<td> unclosed, so rows are split on the opening tags.
 * Anything after the closing </table> (such as the "confirm balance" action link) is dropped unread.
 */
private fun kontoRows(html: String): List<List<String>> {
    val cleaned = SCRIPT.replace(html, " ")
    return TR_SPLIT.split(cleaned).drop(1).mapNotNull { chunk ->
        val body = OPEN_TAG_TAIL.replace(TABLE_END.split(chunk).first(), "")
        CELL_SPLIT.split(body).drop(1).map { htmlText(it) }.filter { it.isNotEmpty() }.takeIf { it.isNotEmpty() }
    }
}

/**
 * Kontoauszug is not on the mobile REST API. The poller may GET page 21411 and
 * pass the HTML here. Rows that are not a date plus a label are ignored.
 */
fun parseKontoauszug(html: String): List<KontoLine> {
    if (html.isBlank()) return emptyList()
    return kontoRows(html).filter { it.size >= 3 && DATE_CELL.containsMatchIn(it[0]) }.map { cells ->
        KontoLine(date = cells[0], label = cells[1], amount = cells[2], balance = cells.getOrElse(3) { "" })
    }
}

/** The statement's closing "Saldo" row (for example "5.40 CHF"), or an empty string. */
fun parseKontoSaldo(html: String): String {
    if (html.isBlank()) return ""
    return kontoRows(html).lastOrNull { it.size >= 2 && SALDO_LABEL.matches(it[0]) }?.last().orEmpty()
}

/** Parses "-12.50 CHF", "1'234.50 CHF" or "12,50" into a number; null when there is none. */
fun parseChfAmount(raw: String): Double? {
    val cleaned = raw.replace("CHF", "", ignoreCase = true).replace("'", "").replace("\u2019", "").replace("\u2212", "-")
        .replace(Regex("""\s+"""), "")
    val match = Regex("""[-+]?\d+(?:[.,]\d+)?""").find(cleaned) ?: return null
    return match.value.replace(',', '.').toDoubleOrNull()
}

enum class KontoFooterKind { Schulnetz, RunningSaldo, Calculated }

/** What the statement footer shows: the amount text and where it came from. */
data class KontoFooter(val kind: KontoFooterKind, val amount: String)

/**
 * Footer choice: Schulnetz's own Saldo wins, then the last row's running Saldo, then the sum of the amounts.
 * Null when there is nothing to show.
 */
fun kontoFooter(lines: List<KontoLine>, kontoSaldo: String): KontoFooter? {
    if (kontoSaldo.isNotBlank()) return KontoFooter(KontoFooterKind.Schulnetz, kontoSaldo.trim())
    if (lines.isEmpty()) return null
    lines.last().balance.takeIf { it.isNotBlank() }?.let { return KontoFooter(KontoFooterKind.RunningSaldo, it.trim()) }
    val amounts = lines.mapNotNull { parseChfAmount(it.amount) }
    if (amounts.isEmpty()) return null
    val sum = Math.round(amounts.sum() * 100) / 100.0
    return KontoFooter(KontoFooterKind.Calculated, String.format(java.util.Locale.ROOT, "%.2f CHF", sum))
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
