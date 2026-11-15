package ch.fasrv.fanotes.study

/**
 * A read-only drawing of a study block as plain shapes, laid out for a given column width.
 * The Android views paint these shapes; keeping the layout here keeps it testable on the JVM.
 * Units are density independent (dp); colours are named tones the painter maps to the paper theme.
 */
enum class Tone { TEXT, MUTED, LINE, FILL, ACCENT, SOFT }

sealed interface SceneOp
data class BoxOp(
    val x: Double, val y: Double, val w: Double, val h: Double, val radius: Double,
    val fill: Tone?, val stroke: Tone?, val strokeWidth: Double = 1.2,
) : SceneOp
data class TextOp(
    val text: String, val x: Double, val baseline: Double, val size: Double, val tone: Tone,
    val bold: Boolean = false, val italic: Boolean = false, val center: Boolean = false,
) : SceneOp
/** Polyline through x0,y0,x1,y1,... */
data class LineOp(val points: List<Double>, val tone: Tone, val width: Double = 1.4) : SceneOp
data class CurveOp(
    val x1: Double, val y1: Double, val c1x: Double, val c1y: Double, val c2x: Double, val c2y: Double,
    val x2: Double, val y2: Double, val tone: Tone, val width: Double = 1.6, val arrow: Boolean = true,
) : SceneOp
/** A picture from the vault (or a placeholder while it loads), drawn to cover or fit its frame. */
data class ImageOp(val ref: String, val x: Double, val y: Double, val w: Double, val h: Double, val cover: Boolean) : SceneOp

data class StudyScene(val width: Double, val height: Double, val ops: List<SceneOp>)

private const val TEXT_SIZE = 12.5
private const val CHAR_W = 6.7

private class Sheet(val width: Double) {
    val ops = ArrayList<SceneOp>()
    var y = 0.0

    fun heading(title: String) {
        if (title.isBlank()) return
        wrapText(title.trim(), maxOf(8, (width / 8.0).toInt())).forEach { line ->
            ops += TextOp(line, 4.0, y + 15, 14.0, Tone.TEXT, bold = true)
            y += 19
        }
        y += 6
    }

    fun finish() = StudyScene(width, maxOf(y, 8.0), ops)
}

private fun charsFor(width: Double, size: Double = TEXT_SIZE) = maxOf(3, ((width) / (CHAR_W * size / TEXT_SIZE)).toInt())

/** The scene for a study block, or null when the JSON cannot be read (the caller shows the raw block). */
fun buildStudyScene(kind: StudyKind, body: String, width: Double): StudyScene? {
    val w = maxOf(width, 160.0)
    return when (kind) {
        StudyKind.KEY -> keyScene(parseKeyData(body) ?: return null, w)
        StudyKind.SORT -> sortScene(parseSortData(body) ?: return null, w)
        StudyKind.MAP -> mapScene(parseMapData(body) ?: return null, w)
        StudyKind.PLATE -> plateScene(parsePlateData(body) ?: return null, w)
        StudyKind.TERM -> termScene(parseTermData(body) ?: return null, w)
    }
}

private fun keyScene(data: KeyData, width: Double): StudyScene {
    val sheet = Sheet(width)
    sheet.heading(data.title)
    val features = data.table.features
    if (features.isNotEmpty() || data.table.items.isNotEmpty()) {
        val columns = features.size + 1
        val colW = width / columns
        val chars = charsFor(colW - 10)
        val rows = ArrayList<List<String>>()
        rows += listOf("Art") + features.mapIndexed { index, feature -> feature.ifEmpty { "Merkmal ${index + 1}" } }
        data.table.items.forEach { rows += listOf(it.name) + it.values }
        rows.forEachIndexed { rowIndex, row ->
            val wrapped = row.map { wrapText(it, chars) }
            val height = wrapped.maxOf { it.size } * 15.0 + 10
            for (column in 0 until columns) {
                val x = column * colW
                sheet.ops += BoxOp(x, sheet.y, colW, height, 0.0, if (rowIndex == 0) Tone.SOFT else if (column == 0) Tone.SOFT else null, Tone.LINE, 0.8)
                wrapped[column].forEachIndexed { line, text ->
                    sheet.ops += TextOp(text, x + 5, sheet.y + 5 + 11 + line * 15.0, 12.0, Tone.TEXT, bold = rowIndex == 0 || column == 0)
                }
            }
            sheet.y += height
        }
        sheet.y += 14
    }
    if (data.tree.nodes.isNotEmpty()) {
        val layout = layoutKeyTree(data.tree)
        val k = minOf(1.0, width / layout.width)
        val top = sheet.y
        val offsetX = maxOf(0.0, (width - layout.width * k) / 2)
        val size = maxOf(8.0, TEXT_SIZE * k)
        for (edge in layout.edges) {
            val x1 = offsetX + edge.x1 * k
            val x2 = offsetX + edge.x2 * k
            val y1 = top + edge.y1 * k
            val y2 = top + edge.y2 * k
            val mid = (y1 + y2) / 2
            sheet.ops += LineOp(listOf(x1, y1, x1, mid, x2, mid, x2, y2), Tone.LINE, 1.4)
            if (edge.label.isNotEmpty()) {
                val labelW = edge.label.length * 6.0 * k + 8
                val cx = (x1 + x2) / 2
                sheet.ops += BoxOp(cx - labelW / 2, mid - 9, labelW, 16.0, 4.0, Tone.FILL, null)
                sheet.ops += TextOp(edge.label, cx, mid + 3, maxOf(8.0, 11 * k), Tone.MUTED, center = true)
            }
        }
        for (node in layout.nodes) {
            val x = offsetX + node.x * k
            val y = top + node.y * k
            val h = node.h * k
            sheet.ops += BoxOp(x, y, node.w * k, h, if (node.leaf) minOf(h / 2, 10.0) else 8.0, if (node.leaf) Tone.SOFT else Tone.FILL, if (node.leaf) Tone.LINE else Tone.ACCENT, if (node.leaf) 1.2 else 1.6)
            node.lines.forEachIndexed { line, text ->
                sheet.ops += TextOp(text, x + node.w * k / 2, y + (3 + 13 + line * 16.0) * k, size, Tone.TEXT, bold = node.leaf, center = true)
            }
        }
        sheet.y = top + layout.height * k + 6
    }
    if (data.compareImage.isNotEmpty()) {
        val height = minOf(width * 0.6, 240.0)
        sheet.ops += ImageOp(data.compareImage, 0.0, sheet.y, width, height, cover = false)
        sheet.y += height + 4
        sheet.ops += TextOp(data.compareLabel.ifEmpty { "Vergleich" }, width / 2, sheet.y + 11, 11.0, Tone.MUTED, center = true)
        sheet.y += 18
    }
    return sheet.finish()
}

private fun sortScene(data: SortData, width: Double): StudyScene {
    val sheet = Sheet(width)
    sheet.heading(data.title)
    val text = data.cards.associate { it.id to it.text }
    val gap = 10.0
    val perRow = if (data.sequence) 1 else maxOf(1, minOf(data.groups.size, ((width + gap) / (140 + gap)).toInt()))
    val colW = (width - gap * (perRow - 1)) / perRow
    val chars = charsFor(colW - 22)
    data.groups.chunked(perRow).forEach { row ->
        val heights = row.map { group ->
            var h = 30.0
            group.cards.forEach { id -> h += wrapText(text[id].orEmpty(), chars).size * 15.0 + 12 }
            maxOf(h + 6, 60.0)
        }
        val rowHeight = heights.max()
        row.forEachIndexed { column, group ->
            val x = column * (colW + gap)
            sheet.ops += BoxOp(x, sheet.y, colW, rowHeight, 8.0, Tone.SOFT, Tone.LINE, 1.0)
            sheet.ops += TextOp(group.title.ifEmpty { "Gruppe" }, x + 8, sheet.y + 19, 12.5, Tone.TEXT, bold = true)
            var cardY = sheet.y + 28
            group.cards.forEachIndexed { index, id ->
                val label = (if (data.sequence) "${index + 1}. " else "") + text[id].orEmpty()
                val lines = wrapText(label, chars)
                val h = lines.size * 15.0 + 10
                sheet.ops += BoxOp(x + 6, cardY, colW - 12, h, 6.0, Tone.FILL, Tone.LINE, 1.0)
                lines.forEachIndexed { line, part -> sheet.ops += TextOp(part, x + 12, cardY + 5 + 11 + line * 15.0, 12.5, Tone.TEXT) }
                cardY += h + 6
            }
        }
        sheet.y += rowHeight + gap
    }
    val open = unsortedCards(data)
    if (open.isNotEmpty()) {
        var x = 0.0
        var rowTop = sheet.y
        var rowH = 0.0
        for (card in open) {
            val lines = wrapText(card.text, maxOf(8, charsFor(width - 24)))
            val cardW = minOf(width, lines.maxOf { it.length } * CHAR_W + 20)
            if (x > 0 && x + cardW > width) {
                x = 0.0
                rowTop += rowH + 6
                rowH = 0.0
            }
            val h = lines.size * 15.0 + 10
            sheet.ops += BoxOp(x, rowTop, cardW, h, 6.0, Tone.FILL, Tone.MUTED, 1.0)
            lines.forEachIndexed { line, part -> sheet.ops += TextOp(part, x + 10, rowTop + 5 + 11 + line * 15.0, 12.5, Tone.MUTED) }
            x += cardW + 6
            rowH = maxOf(rowH, h)
        }
        sheet.y = rowTop + rowH + 6
    }
    return sheet.finish()
}

private fun mapScene(data: MapData, width: Double): StudyScene {
    val sheet = Sheet(width)
    sheet.heading(data.title)
    if (data.nodes.isEmpty()) return sheet.finish()
    val layout = layoutMap(data)
    val k = minOf(1.0, width / layout.width)
    val top = sheet.y
    val offsetX = maxOf(0.0, (width - layout.width * k) / 2)
    val size = maxOf(8.0, TEXT_SIZE * k)
    for (edge in layout.edges) {
        sheet.ops += CurveOp(
            offsetX + edge.x1 * k, top + edge.y1 * k, offsetX + edge.c1x * k, top + edge.c1y * k,
            offsetX + edge.c2x * k, top + edge.c2y * k, offsetX + edge.x2 * k, top + edge.y2 * k, Tone.ACCENT,
        )
        if (edge.label.isNotEmpty()) {
            val labelW = edge.label.length * 6.0 * k + 10
            val lx = offsetX + edge.lx * k
            val ly = top + edge.ly * k
            sheet.ops += BoxOp(lx - labelW / 2, ly - 9, labelW, 17.0, 5.0, Tone.FILL, null)
            sheet.ops += TextOp(edge.label, lx, ly + 4, maxOf(8.0, 11 * k), Tone.MUTED, italic = true, center = true)
        }
    }
    for (node in layout.nodes) {
        val x = offsetX + node.x * k
        val y = top + node.y * k
        sheet.ops += BoxOp(x, y, node.w * k, node.h * k, 9.0, Tone.FILL, Tone.LINE, 1.4)
        node.lines.forEachIndexed { line, text ->
            sheet.ops += TextOp(text, x + node.w * k / 2, y + (3 + 13 + line * 16.0) * k, size, Tone.TEXT, center = true)
        }
    }
    sheet.y = top + layout.height * k + 6
    return sheet.finish()
}

private fun plateScene(data: PlateData, width: Double): StudyScene {
    val sheet = Sheet(width)
    sheet.heading(data.title)
    val gap = 8.0
    val cols = data.cols.coerceIn(1, 8)
    val cell = (width - gap * (cols - 1)) / cols
    data.items.chunked(cols).forEach { row ->
        val imageH = cell * 0.75
        var captionH = 0.0
        row.forEachIndexed { column, item ->
            val x = column * (cell + gap)
            if (item.img.isNotEmpty()) sheet.ops += ImageOp(item.img, x, sheet.y, cell, imageH, cover = true)
            else sheet.ops += BoxOp(x, sheet.y, cell, imageH, 6.0, Tone.SOFT, Tone.LINE, 1.0)
            if (data.showLabels) {
                val lines = wrapText(item.label, charsFor(cell)).take(3)
                lines.forEachIndexed { line, text -> sheet.ops += TextOp(text, x + cell / 2, sheet.y + imageH + 14 + line * 15.0, 12.0, Tone.TEXT, center = true) }
                captionH = maxOf(captionH, lines.size * 15.0 + 4)
            }
        }
        sheet.y += imageH + captionH + 10
    }
    return sheet.finish()
}

private fun termScene(data: TermData, width: Double): StudyScene {
    val sheet = Sheet(width)
    val chars = charsFor(width - 24)
    for (entry in data.terms) {
        val parts = ArrayList<Triple<String, Tone, Boolean>>()
        val definition = wrapText(entry.definition, chars).takeIf { entry.definition.isNotBlank() }.orEmpty()
        val example = wrapText("Beispiel: ${entry.example}", chars).takeIf { entry.example.isNotBlank() }.orEmpty()
        val source = wrapText("Quelle: ${entry.source}", chars).takeIf { entry.source.isNotBlank() }.orEmpty()
        definition.forEach { parts += Triple(it, Tone.TEXT, false) }
        example.forEach { parts += Triple(it, Tone.TEXT, false) }
        source.forEach { parts += Triple(it, Tone.MUTED, false) }
        val name = wrapText(entry.term.ifEmpty { "Begriff" }, charsFor(width - 24, 14.0))
        val height = 12.0 + name.size * 19.0 + parts.size * 16.0 + 10
        sheet.ops += BoxOp(0.0, sheet.y, width, height, 8.0, Tone.FILL, Tone.LINE, 1.0)
        var y = sheet.y + 12
        name.forEach {
            sheet.ops += TextOp(it, 12.0, y + 14, 14.0, Tone.TEXT, bold = true)
            y += 19
        }
        parts.forEach { (text, tone, _) ->
            sheet.ops += TextOp(text, 12.0, y + 12, 12.5, tone)
            y += 16
        }
        sheet.y += height + 8
    }
    return sheet.finish()
}

/** True when the block's JSON parses; otherwise the editor keeps showing the raw block. */
fun studyBlockReadable(block: StudyBlockRef): Boolean = parseJsonObjectOrNull(block.body) != null
