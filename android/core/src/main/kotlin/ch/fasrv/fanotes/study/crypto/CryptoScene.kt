package ch.fasrv.fanotes.study.crypto

import ch.fasrv.fanotes.study.BoxOp
import ch.fasrv.fanotes.study.Sheet
import ch.fasrv.fanotes.study.StudyScene
import ch.fasrv.fanotes.study.TextOp
import ch.fasrv.fanotes.study.Tone
import ch.fasrv.fanotes.study.charsFor
import ch.fasrv.fanotes.study.wrapText

/**
 * Read-only drawing of a crypto block in the note (port of `crypto/html.ts`). It shows only what the student
 * entered; an answer the student did not give never appears here.
 */

private const val CELL_W = 17.0
private const val ROW_H = 20.0

private fun Sheet.line(label: String, value: String) {
    if (value.isBlank()) return
    val lines = wrapText("$label  $value", charsFor(width - 12))
    lines.forEach { part ->
        ops += TextOp(part, 4.0, y + 13, 12.5, Tone.TEXT)
        y += 16
    }
    y += 2
}

private fun Sheet.plainLine(text: String, bold: Boolean = false) {
    wrapText(text, charsFor(width - 12)).forEach { part ->
        ops += TextOp(part, 4.0, y + 13, 12.5, Tone.TEXT, bold = bold)
        y += 16
    }
}

/** Rows of aligned cells, wrapped into blocks that fit the width. [highlight] marks rows drawn in the accent tone. */
private fun Sheet.alignedRows(rows: List<Pair<String, List<String>>>, labelWidth: Double, cellWidth: Double = CELL_W, accentRows: Set<Int> = emptySet()) {
    val count = rows.maxOfOrNull { it.second.size } ?: return
    if (count == 0) return
    val perBlock = maxOf(1, ((width - labelWidth) / cellWidth).toInt())
    for (start in 0 until count step perBlock) {
        rows.forEachIndexed { rowIndex, (label, values) ->
            if (start == 0 && label.isNotEmpty()) ops += TextOp(label, 4.0, y + 14, 11.0, Tone.MUTED)
            for (offset in 0 until perBlock) {
                val value = values.getOrNull(start + offset) ?: continue
                val x = labelWidth + offset * cellWidth
                ops += BoxOp(x, y, cellWidth, ROW_H, 0.0, if (rowIndex in accentRows) Tone.SOFT else null, Tone.LINE, 0.8)
                ops += TextOp(value, x + cellWidth / 2, y + 14, 12.0, Tone.TEXT, center = true, bold = rowIndex in accentRows)
            }
            y += ROW_H
        }
        y += 8
    }
}

private fun bitsOf(list: List<String>, count: Int): List<String> = List(count) { index ->
    list.getOrNull(index).orEmpty().map { cellText(it).ifEmpty { "·" } }.joinToString("")
}

fun cryptoScene(data: CryptoData, width: Double): StudyScene {
    val sheet = Sheet(width)
    sheet.heading(data.title.trim().ifEmpty { data.tool.label } + "  ·  " + data.tool.label)
    when (data) {
        is CaesarData -> {
            val cipher = when (data.mode) {
                CaesarMode.SHIFT -> shiftAlphabet(data.shift)
                CaesarMode.ALPHABET -> checkAlphabet(data.alphabet).let { if (it.ok) it.letters else "" }
                CaesarMode.KEYWORD -> data.built.padEnd(26, '_').take(26).map { cellText(it).uppercase().ifEmpty { "·" } }.joinToString("")
            }
            sheet.plainLine(
                when (data.mode) {
                    CaesarMode.SHIFT -> "Verschiebung um ${data.shift}"
                    CaesarMode.ALPHABET -> "Vorgegebenes Alphabet"
                    CaesarMode.KEYWORD -> "Schlüsselwort"
                },
                bold = true,
            )
            if (data.mode == CaesarMode.KEYWORD && data.keyword.isNotEmpty()) {
                sheet.line("Schlüsselwort", keywordParts(data.keyword).filter { it.kind != KeywordPartKind.REPEAT }.joinToString("") { it.ch.toString() })
            }
            if (cipher.length == 26) {
                sheet.alignedRows(listOf("" to PLAIN_ROW.map { it.toString() }, "" to cipher.map { it.toString() }), 0.0, accentRows = setOf(1))
            }
            sheet.line("Text", data.task)
            sheet.line("Antwort", data.answer)
        }
        is FreqData -> {
            val rows = frequencyRows(data.text).filter { it.count > 0 }.take(12)
            rows.forEach { row ->
                val bar = minOf(100.0, Math.round(row.percent * 4).toDouble())
                val room = maxOf(20.0, width - 150.0)
                sheet.ops += TextOp(row.letter.toString(), 4.0, sheet.y + 12, 12.0, Tone.TEXT, bold = true)
                sheet.ops += BoxOp(24.0, sheet.y + 2, maxOf(2.0, room * bar / 100), 10.0, 2.0, Tone.ACCENT, null)
                sheet.ops += TextOp("${"%.1f".format(java.util.Locale.ROOT, row.percent)} % (${row.count})", 24.0 + maxOf(2.0, room * bar / 100) + 6, sheet.y + 12, 11.0, Tone.MUTED)
                sheet.y += 15
            }
            if (rows.isNotEmpty()) sheet.y += 6
            if (data.text.isNotBlank()) {
                val mapped = applyMap(data.text, data.map).joinToString("") { (it.plain ?: it.ch).toString() }
                sheet.plainLine(mapped)
            }
        }
        is VigenereData -> {
            val rows = vigenereRows(data.key, data.plain)
            if (rows.plain.isNotEmpty()) {
                val answer = rows.plain.indices.map { cellText(data.answer.getOrNull(it)).uppercase() }
                sheet.alignedRows(
                    listOf("Klartext" to rows.plain.map { it.toString() }, "Schlüssel" to rows.key.map { it.toString() }, "Geheimtext" to answer),
                    72.0, accentRows = setOf(2),
                )
            }
        }
        is XorData -> {
            val letters = xorLetters(data.plain, data.key)
            if (letters.plain.isNotEmpty()) {
                val n = letters.plain.length
                // One column per letter; the 7 bit codes are drawn as vertical strings so a wide text still fits.
                sheet.alignedRows(
                    listOf(
                        "Klartext" to letters.plain.map { it.toString() }, "Schlüssel" to letters.key.map { it.toString() },
                    ),
                    72.0,
                )
                listOf("Klartext (ASCII)" to data.p, "Schlüssel (ASCII)" to data.k, "Geheimtext" to data.c).forEach { (label, list) ->
                    sheet.plainLine(label, bold = true)
                    sheet.plainLine(bitsOf(list, n).joinToString(" "))
                }
            }
        }
        is ModData -> {
            if (data.a.isNotEmpty() && data.b.isNotEmpty() && data.m.isNotEmpty()) {
                val op = when (data.op) { ModOp.TIMES -> "·"; ModOp.PLUS -> "+"; ModOp.POWER -> "hoch" }
                sheet.plainLine("(${data.a} $op ${data.b}) mod ${data.m}", bold = true)
            }
            val steps = listOf("a mod m" to data.s1) + (if (data.op == ModOp.POWER) emptyList() else listOf("b mod m" to data.s2)) + listOf(
                (when (data.op) { ModOp.TIMES -> "Produkt"; ModOp.PLUS -> "Summe"; ModOp.POWER -> "(a mod m) hoch b" }) to data.s3,
                "Resultat mod m" to data.s4,
            )
            steps.filter { it.second.isNotEmpty() }.forEach { (label, value) -> sheet.plainLine("$label = $value") }
        }
        is DhData -> {
            val given = listOf("Y" to data.y, "P" to data.p, "A" to data.a, "B" to data.b).filter { it.second.isNotEmpty() }
            val own = listOf("α" to data.alpha, "β" to data.beta, "s (Alice)" to data.sa, "s (Bob)" to data.sb).filter { it.second.isNotEmpty() }
            if (given.isNotEmpty()) sheet.plainLine(given.joinToString(" · ") { "${it.first} = ${it.second}" })
            if (own.isNotEmpty()) sheet.plainLine(own.joinToString(" · ") { "${it.first} = ${it.second}" })
        }
    }
    return sheet.finish()
}
