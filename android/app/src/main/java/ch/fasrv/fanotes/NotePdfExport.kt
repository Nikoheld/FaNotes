package ch.fasrv.fanotes

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.pdf.PdfDocument
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import ch.fasrv.fanotes.desk.AnchoredBox
import ch.fasrv.fanotes.desk.AnchoredHighlight
import ch.fasrv.fanotes.desk.NoteLinkMark
import ch.fasrv.fanotes.desk.PDF_PAGE_HEIGHT_PT
import ch.fasrv.fanotes.desk.PDF_PAGE_MARGIN_PT
import ch.fasrv.fanotes.desk.PDF_PAGE_WIDTH_PT
import ch.fasrv.fanotes.desk.PageFrame
import ch.fasrv.fanotes.desk.boxOnFrame
import ch.fasrv.fanotes.desk.highlightFrameToSheet
import ch.fasrv.fanotes.desk.highlightToSheet
import ch.fasrv.fanotes.desk.WorksheetPageSpec
import ch.fasrv.fanotes.desk.layoutWorksheetPages
import ch.fasrv.fanotes.desk.noteLinkAppearanceToken
import ch.fasrv.fanotes.desk.noteLinkToSheet
import ch.fasrv.fanotes.desk.pdfPageSlices
import ch.fasrv.fanotes.desk.pdfPaperText
import ch.fasrv.fanotes.ink.InkDocument
import ch.fasrv.fanotes.ink.InkStroke
import ch.fasrv.fanotes.ink.brushOpacity
import ch.fasrv.fanotes.ink.ribbonOutline
import java.io.OutputStream
import kotlin.math.max

private const val TEXT_PAD_X = 72f
private const val TEXT_PAD_Y = 78f

/**
 * Prints the open note the way the desktop does: paper, text, handwriting,
 * a worksheet or PDF backdrop, highlights, and note links. One A4 page per
 * vertical slice of the paper.
 */
fun writeNotePdf(
    output: OutputStream,
    markdown: String,
    document: InkDocument,
    backdrops: List<BackdropSlice>,
    boxes: List<AnchoredBox>,
    highlights: List<AnchoredHighlight>,
    links: List<NoteLinkMark>,
    fontSizePx: Float = 16f,
    lineHeight: Float = 1.72f,
    contentWidthPx: Float = 820f,
    smoothing: Float = 0.68f,
    editorTypeface: Typeface = Typeface.create("sans-serif", Typeface.NORMAL),
    showLineNumbers: Boolean = false,
) {
    val sourceWidth = document.sourceWidth.coerceAtLeast(1.0)
    val sourceHeight = document.sourceHeight.coerceAtLeast(1.0)
    val worksheetPages = backdrops.mapNotNull { slice ->
        val bitmap = slice.bitmap ?: return@mapNotNull null
        if (slice.worksheetId.isEmpty() || bitmap.isRecycled || bitmap.width <= 0 || bitmap.height <= 0) return@mapNotNull null
        WorksheetPageSpec(slice.worksheetId, slice.page, bitmap.height.toDouble() / bitmap.width.toDouble())
    }
    val placements = if (worksheetPages.isEmpty()) {
        emptyList()
    } else {
        layoutWorksheetPages(sourceWidth, pdfTextBottom(markdown, fontSizePx, lineHeight, contentWidthPx, document.originY), worksheetPages)
    }
    val virtualHeight = max(sourceHeight, placements.maxOfOrNull { it.top + it.height + 36.0 } ?: 0.0)
    val slices = pdfPageSlices(sourceWidth, virtualHeight)
    val contentWidth = (PDF_PAGE_WIDTH_PT - PDF_PAGE_MARGIN_PT * 2).toFloat()
    val scale = (contentWidth / sourceWidth).toFloat()
    val pageWidth = (sourceWidth * scale).toFloat()
    val pageHeight = (virtualHeight * scale).toFloat()
    val frames = if (placements.isNotEmpty()) {
        emptyList()
    } else {
        backdrops.mapIndexed { index, slice ->
            PageFrame(index + 1, slice.topPagePx.toDouble(), slice.heightPagePx.toDouble(), slice.widthPagePx.toDouble())
        }
    }
    val paper = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; style = Paint.Style.FILL }
    val ruling = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    val ink = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    val text = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#252630")
        typeface = editorTypeface
    }
    val highlightPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    val linkPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.parseColor("#2A6F97"); style = Paint.Style.FILL }
    val pdf = PdfDocument()
    try {
        for (slice in slices) {
            val info = PdfDocument.PageInfo.Builder(
                PDF_PAGE_WIDTH_PT.toInt(),
                PDF_PAGE_HEIGHT_PT.toInt(),
                slice.index + 1,
            ).create()
            val page = pdf.startPage(info)
            val canvas = page.canvas
            canvas.drawColor(Color.WHITE)
            canvas.save()
            canvas.translate(
                PDF_PAGE_MARGIN_PT.toFloat(),
                PDF_PAGE_MARGIN_PT.toFloat() - (slice.sourceTop * scale).toFloat(),
            )
            canvas.clipRect(
                0f,
                (slice.sourceTop * scale).toFloat(),
                contentWidth,
                ((slice.sourceTop + slice.sourceHeight) * scale).toFloat(),
            )
            canvas.drawRect(0f, 0f, pageWidth, pageHeight, paper)
            if (placements.isEmpty()) backdrops.forEach { backdrop -> drawBackdrop(canvas, backdrop, scale) }
            else drawWorksheetColumn(canvas, backdrops, placements, scale)
            if (backdrops.none { it.bitmap != null }) {
                drawRuling(canvas, document.paperStyle, pageWidth, (sourceHeight * scale).toFloat(), scale, ruling)
            }
            drawMarkdown(canvas, markdown, scale, text, document.originX, document.originY, fontSizePx, lineHeight, contentWidthPx, showLineNumbers)
            highlights.forEach { anchored ->
                val rect = if (placements.isEmpty()) {
                    highlightToSheet(anchored.mark, frames, sourceWidth, sourceHeight)
                } else {
                    val frame = placements.firstOrNull { it.id == anchored.worksheetId && it.page == anchored.mark.page.coerceAtLeast(1) } ?: return@forEach
                    highlightFrameToSheet(anchored.mark, frame, sourceWidth, sourceHeight)
                }
                highlightPaint.color = parsePdfColor(anchored.mark.color)
                highlightPaint.alpha = 96
                canvas.drawRect(
                    (rect.x * sourceWidth * scale).toFloat(),
                    (rect.y * sourceHeight * scale).toFloat(),
                    ((rect.x + rect.width) * sourceWidth * scale).toFloat(),
                    ((rect.y + rect.height) * sourceHeight * scale).toFloat(),
                    highlightPaint,
                )
            }
            document.strokes.forEach { stroke -> drawStroke(canvas, stroke, sourceWidth, sourceHeight, scale, ink, smoothing) }
            boxes.forEach { anchored ->
                val (x, y) = if (placements.isEmpty()) {
                    anchored.box.x to anchored.box.y
                } else {
                    val frame = placements.firstOrNull { it.id == anchored.worksheetId && it.page == anchored.box.page.coerceAtLeast(1) } ?: return@forEach
                    boxOnFrame(anchored.box, frame, sourceWidth, sourceHeight)
                }
                text.color = Color.parseColor("#202333")
                text.textSize = (anchored.box.fontSize * scale).toFloat().coerceAtLeast(8f)
                canvas.drawText(anchored.box.text, (x * sourceWidth * scale).toFloat(), (y * sourceHeight * scale).toFloat(), text)
            }
            links.forEach { link ->
                val sheet = noteLinkToSheet(link, frames, sourceWidth, sourceHeight)
                val x = (sheet.first * sourceWidth * scale).toFloat()
                val y = (sheet.second * sourceHeight * scale).toFloat()
                val appearance = noteLinkAppearanceToken(link.style)
                if (appearance != "text") canvas.drawCircle(x, y, 6f, linkPaint)
                if (appearance != "symbol") {
                    text.color = Color.parseColor("#2A6F97")
                    text.textSize = 11f
                    canvas.drawText(link.label.ifBlank { "Notiz" }, x + if (appearance == "text") 0f else 8f, y + 4f, text)
                }
            }
            canvas.restore()
            pdf.finishPage(page)
        }
        pdf.writeTo(output)
    } finally {
        pdf.close()
    }
}

private fun pdfTextBottom(
    markdown: String,
    fontSizePx: Float,
    lineHeight: Float,
    contentWidthPx: Float,
    originY: Double,
): Double {
    val body = pdfPaperText(markdown)
    if (body.isEmpty()) return max(0.0, originY)
    val paint = TextPaint(Paint.ANTI_ALIAS_FLAG)
    paint.textSize = fontSizePx
    val layout = StaticLayout.Builder.obtain(body, 0, body.length, paint, contentWidthPx.toInt().coerceAtLeast(1))
        .setAlignment(Layout.Alignment.ALIGN_NORMAL)
        .setIncludePad(false)
        .setLineSpacing(0f, lineHeight)
        .build()
    return TEXT_PAD_Y.toDouble() + originY + layout.height.toDouble()
}

private fun drawWorksheetColumn(
    canvas: Canvas,
    backdrops: List<BackdropSlice>,
    placements: List<ch.fasrv.fanotes.desk.WorksheetPlacement>,
    scale: Float,
) {
    val edge = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        color = Color.parseColor("#2E3848")
        alpha = 46
        strokeWidth = max(0.6f, scale)
    }
    val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; style = Paint.Style.FILL }
    val label = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#282A34")
        textSize = 11f
    }
    for (place in placements) {
        val slice = backdrops.firstOrNull { it.worksheetId == place.id && it.page == place.page } ?: continue
        val bitmap = slice.bitmap ?: continue
        if (bitmap.isRecycled) continue
        val dest = RectF(
            (place.left * scale).toFloat(),
            (place.top * scale).toFloat(),
            ((place.left + place.width) * scale).toFloat(),
            ((place.top + place.height) * scale).toFloat(),
        )
        canvas.drawRect(dest, fill)
        canvas.drawBitmap(bitmap, null, dest, null)
        canvas.drawRect(dest, edge)
        if (place.captionTop >= 0.0 && slice.label.isNotEmpty()) {
            canvas.drawText(slice.label, dest.left, (place.captionTop * scale).toFloat() + 12f, label)
        }
    }
}

private fun drawBackdrop(canvas: Canvas, slice: BackdropSlice, scale: Float) {
    val bitmap: Bitmap = slice.bitmap ?: return
    if (bitmap.isRecycled) return
    val dest = RectF(
        0f,
        slice.topPagePx * scale,
        slice.widthPagePx * scale,
        (slice.topPagePx + slice.heightPagePx) * scale,
    )
    canvas.drawBitmap(bitmap, null, dest, null)
}

private fun drawRuling(canvas: Canvas, style: String, pageWidth: Float, pageHeight: Float, scale: Float, ruling: Paint) {
    if (style == "blank") return
    ruling.strokeWidth = max(0.6f, scale * 0.7f)
    fun stepFor(millimeters: Double) = max(1.5f, (pageWidth * millimeters / 210.0).toFloat())
    when (style) {
        "dots" -> {
            val step = stepFor(7.5)
            ruling.color = Color.parseColor("#5C6B8E")
            ruling.alpha = 70
            val radius = max(0.6f, scale * 1.05f)
            var y = step
            while (y < pageHeight) {
                var x = step
                while (x < pageWidth) {
                    canvas.drawCircle(x, y, radius, ruling)
                    x += step
                }
                y += step
            }
        }
        "squares", "grid" -> {
            val step = stepFor(if (style == "squares") 5.0 else 7.5)
            ruling.color = Color.parseColor(if (style == "squares") "#5C76A8" else "#677493")
            ruling.alpha = if (style == "squares") 56 else 37
            val start = if (style == "squares") 0f else step
            var x = start
            while (x <= pageWidth) {
                canvas.drawLine(x, 0f, x, pageHeight, ruling)
                x += step
            }
            var y = start
            while (y <= pageHeight) {
                canvas.drawLine(0f, y, pageWidth, y, ruling)
                y += step
            }
        }
        "lines" -> {
            val step = stepFor(7.5)
            ruling.color = Color.parseColor("#677493")
            ruling.alpha = 37
            var y = step
            while (y < pageHeight) {
                canvas.drawLine(0f, y, pageWidth, y, ruling)
                y += step
            }
            ruling.color = Color.parseColor("#D25269")
            ruling.alpha = 40
            val margin = step * 1.65f
            canvas.drawLine(margin, 0f, margin, pageHeight, ruling)
        }
        "millimeter" -> {
            val minor = stepFor(1.0)
            val major = stepFor(5.0)
            ruling.color = Color.parseColor("#5C76A8")
            ruling.alpha = 26
            var x = minor
            while (x < pageWidth) {
                canvas.drawLine(x, 0f, x, pageHeight, ruling)
                x += minor
            }
            var y = minor
            while (y < pageHeight) {
                canvas.drawLine(0f, y, pageWidth, y, ruling)
                y += minor
            }
            ruling.alpha = 56
            x = major
            while (x < pageWidth) {
                canvas.drawLine(x, 0f, x, pageHeight, ruling)
                x += major
            }
            y = major
            while (y < pageHeight) {
                canvas.drawLine(0f, y, pageWidth, y, ruling)
                y += major
            }
        }
    }
}

private fun drawMarkdown(
    canvas: Canvas,
    markdown: String,
    scale: Float,
    paint: TextPaint,
    originX: Double,
    originY: Double,
    fontSizePx: Float,
    lineHeight: Float,
    contentWidthPx: Float,
    showLineNumbers: Boolean,
) {
    val text = pdfPaperText(markdown)
    if (text.isEmpty()) return
    paint.color = Color.parseColor("#252630")
    paint.textSize = fontSizePx * scale
    val width = (contentWidthPx * scale).toInt().coerceAtLeast(1)
    val layout = StaticLayout.Builder.obtain(text, 0, text.length, paint, width)
        .setAlignment(Layout.Alignment.ALIGN_NORMAL)
        .setIncludePad(false)
        .setLineSpacing(0f, lineHeight)
        .setBreakStrategy(Layout.BREAK_STRATEGY_HIGH_QUALITY)
        .setHyphenationFrequency(Layout.HYPHENATION_FREQUENCY_NONE)
        .build()
    canvas.save()
    canvas.translate((TEXT_PAD_X + originX.toFloat()) * scale, (TEXT_PAD_Y + originY.toFloat()) * scale)
    if (showLineNumbers) {
        val numbers = TextPaint(paint)
        numbers.color = Color.parseColor("#8A8D98")
        numbers.textAlign = Paint.Align.RIGHT
        numbers.textSize = fontSizePx * scale * 0.82f
        val labels = ch.fasrv.fanotes.desk.editorLineNumberLabels(text)
        val starts = ch.fasrv.fanotes.desk.lineStartOffsets(text)
        labels.forEachIndexed { index, label ->
            val offset = starts[index].coerceIn(0, text.length)
            val visual = layout.getLineForOffset(offset)
            canvas.drawText(label, -8f * scale, layout.getLineBaseline(visual).toFloat(), numbers)
        }
    }
    layout.draw(canvas)
    canvas.restore()
}

private fun drawStroke(canvas: Canvas, stroke: InkStroke, sourceWidth: Double, sourceHeight: Double, scale: Float, paint: Paint, smoothing: Float) {
    if (stroke.points.isEmpty()) return
    paint.color = parsePdfColor(stroke.color)
    paint.alpha = 255
    if (stroke.symbolId != null) {
        drawArtSymbol(canvas, paint, stroke, scale, sourceWidth, sourceHeight)
        return
    }
    if (stroke.brush == "spray") {
        drawSpray(canvas, paint, stroke, scale, sourceWidth, sourceHeight)
        return
    }
    if (stroke.brush == "marker") {
        drawMarkerStroke(canvas, paint, stroke, scale, sourceWidth, sourceHeight, smoothing.toDouble(), parsePdfColor(stroke.color))
        return
    }
    if (stroke.brush == "calligraphy") {
        drawCalligraphyStroke(canvas, paint, stroke, scale, sourceWidth, sourceHeight, parsePdfColor(stroke.color))
        return
    }
    val passes = ch.fasrv.fanotes.ink.brushPasses(stroke.brush)
    val baseAlpha = if (stroke.purpose == "art") (stroke.opacity ?: 1.0) else 1.0
    for ((passIndex, pass) in passes.withIndex()) {
        if (pass.jitter > 0.0) {
            paint.color = parsePdfColor(stroke.color)
            drawPencilGrain(
                canvas,
                paint,
                stroke,
                sourceWidth,
                sourceHeight,
                scale,
                smoothing.toDouble(),
                passIndex,
                pass.jitter,
                pass.widthFactor,
                (baseAlpha * pass.alpha * 255.0).toInt().coerceIn(0, 255),
            )
            continue
        }
        canvas.save()
        val outline = ribbonOutline(stroke, sourceWidth, sourceHeight, smoothing.toDouble(), widthFactor = pass.widthFactor)
        val path = Path()
        smoothOutline(path, outline, scale)
        if (!path.isEmpty) {
            paint.color = parsePdfColor(stroke.color)
            paint.alpha = (baseAlpha * pass.alpha * 255.0).toInt().coerceIn(0, 255)
            drawInkPath(canvas, path, paint, stroke.colorEffect, (sourceWidth * scale).toFloat(), (sourceHeight * scale).toFloat(), (stroke.baseWidth * pass.widthFactor * scale).toFloat())
        }
        canvas.restore()
    }
}

private fun smoothOutline(path: Path, outline: FloatArray, scale: Float) {
    val count = outline.size / 2
    if (count < 2) return
    fun coord(index: Int, axis: Int) = outline[(index % count) * 2 + axis] * scale
    path.moveTo(coord(0, 0), coord(0, 1))
    if (count == 2) {
        path.lineTo(coord(1, 0), coord(1, 1))
        path.close()
        return
    }
    for (index in 0 until count) {
        val next = index + 1
        val midX = (coord(index, 0) + coord(next, 0)) / 2f
        val midY = (coord(index, 1) + coord(next, 1)) / 2f
        path.quadTo(coord(index, 0), coord(index, 1), midX, midY)
    }
    path.close()
}

private fun parsePdfColor(value: String): Int = try {
    Color.parseColor(value)
} catch (_: IllegalArgumentException) {
    Color.BLACK
}
