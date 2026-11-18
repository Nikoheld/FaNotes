package ch.fasrv.fanotes

import android.graphics.Canvas
import android.graphics.Color
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import android.text.Layout
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.StaticLayout
import android.text.TextPaint
import android.text.style.BackgroundColorSpan
import android.text.style.ForegroundColorSpan
import android.text.style.RelativeSizeSpan
import android.text.style.StrikethroughSpan
import android.text.style.StyleSpan
import android.text.style.TypefaceSpan
import android.text.style.UnderlineSpan
import ch.fasrv.fanotes.desk.NoteTextBlock
import ch.fasrv.fanotes.desk.NoteTextField
import ch.fasrv.fanotes.desk.NoteTextInline
import ch.fasrv.fanotes.desk.NoteTextInlineStyle
import kotlin.math.ceil
import kotlin.math.max

/**
 * Draws a note text box with its Markdown rendered, the way `NoteTextFieldMarkdown.tsx` and the
 * `.note-text-field-render` styles show it on the desktop: headings 1.5/1.28/1.12 em, lists with 1.35 em indent,
 * tickable task boxes, inline code on a tint, web links in blue, blocks .45 em apart, line height 1.35, padding
 * .22 em / .4 em. Layouts are cached per box until its text, width, size or style changes.
 */
internal class NoteTextBoxPainter {
    /** Box-local hit areas: a task's 1-based source line, or an openable link. */
    data class Hit(val rect: RectF, val taskLine: Int = 0, val href: String? = null)

    class BoxLayout(
        val width: Float,
        val height: Float,
        internal val pieces: List<Piece>,
        val hits: List<Hit>,
    )

    internal sealed class Piece {
        class Text(val layout: StaticLayout, val x: Float, val y: Float) : Piece()
        class Check(val rect: RectF, val done: Boolean) : Piece()
        class Bullet(val x: Float, val y: Float, val radius: Float) : Piece()
        class Bar(val rect: RectF) : Piece()
        class Tint(val rect: RectF) : Piece()
        class Line(val x0: Float, val y0: Float, val x1: Float, val y1: Float) : Piece()
    }

    private data class Key(val text: String, val width: Float, val font: Float, val color: String?, val bold: Boolean, val minHeight: Float, val face: Typeface)

    private val cache = HashMap<String, Pair<Key, BoxLayout>>()
    private val paint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { isLinearText = true; isSubpixelText = true }
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val edge = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val dashed = DashPathEffect(floatArrayOf(6f, 4f), 0f)

    fun clear() = cache.clear()

    /** Drops cached layouts of boxes that are gone. */
    fun retain(ids: Set<String>) {
        cache.keys.retainAll(ids)
    }

    /** [touchPx] is the smallest hit area of a task box (48 dp on the caller's screen). */
    fun layout(field: NoteTextField, widthPx: Float, fontPx: Float, minHeightPx: Float, typeface: Typeface, touchPx: Float): BoxLayout {
        // Compared field by field: this runs every frame for every box, also while the pen writes.
        cache[field.id]?.let { (stamp, layout) ->
            if (stamp.text === field.text || stamp.text == field.text) {
                if (stamp.width == widthPx && stamp.font == fontPx && stamp.color == field.color && stamp.bold == field.bold &&
                    stamp.minHeight == minHeightPx && stamp.face == typeface
                ) {
                    return layout
                }
            }
        }
        val key = Key(field.text, widthPx, fontPx, field.color, field.bold, minHeightPx, typeface)
        val built = build(field, widthPx, fontPx, minHeightPx, typeface, touchPx)
        cache[field.id] = key to built
        return built
    }

    private fun ink(field: NoteTextField): Int = field.color?.let { runCatching { Color.parseColor(it) }.getOrNull() } ?: INK

    private fun build(field: NoteTextField, widthPx: Float, fontPx: Float, minHeightPx: Float, typeface: Typeface, touchPx: Float): BoxLayout {
        val padX = 0.4f * fontPx
        val padY = 0.22f * fontPx
        val inner = (widthPx - padX * 2).coerceAtLeast(fontPx * 2)
        val pieces = ArrayList<Piece>()
        val hits = ArrayList<Hit>()
        val color = ink(field)
        paint.color = color
        paint.textSize = fontPx
        paint.typeface = if (field.bold) Typeface.create(typeface, Typeface.BOLD) else typeface
        var y = padY
        val gap = 0.45f * fontPx
        val blocks = ch.fasrv.fanotes.desk.parseNoteTextMarkdown(field.text)
        blocks.forEachIndexed { index, block ->
            val last = index == blocks.lastIndex
            when (block) {
                is NoteTextBlock.Heading -> {
                    val scale = when (block.level) { 1 -> 1.5f; 2 -> 1.28f; 3 -> 1.12f; else -> 1f }
                    if (index > 0) y += 0.2f * fontPx * scale
                    val text = spanned(block.inline, color, fontPx)
                    text.setSpan(RelativeSizeSpan(scale), 0, text.length, Spanned.SPAN_INCLUSIVE_EXCLUSIVE)
                    text.setSpan(StyleSpan(Typeface.BOLD), 0, text.length, Spanned.SPAN_INCLUSIVE_EXCLUSIVE)
                    val layout = staticLayout(text, inner.toInt(), fontPx * scale, 1.2f)
                    pieces += Piece.Text(layout, padX, y)
                    linkHits(layout, block.inline, padX, y, hits)
                    y += layout.height + if (last) 0f else 0.3f * fontPx * scale
                }
                is NoteTextBlock.Paragraph -> {
                    val indent = quoteIndent(block.quoteDepth, fontPx)
                    val layout = staticLayout(spanned(block.inline, color, fontPx), (inner - indent).toInt(), fontPx, LINE)
                    quoteBars(block.quoteDepth, fontPx, padX, y, y + layout.height, pieces)
                    pieces += Piece.Text(layout, padX + indent, y)
                    linkHits(layout, block.inline, padX + indent, y, hits)
                    y += layout.height + if (last) 0f else gap
                }
                is NoteTextBlock.Item -> {
                    val indent = quoteIndent(block.quoteDepth, fontPx) + 1.35f * fontPx * (block.depth + 1)
                    val text = spanned(block.inline, color, fontPx)
                    if (block.task == true) {
                        text.setSpan(StrikethroughSpan(), 0, text.length, Spanned.SPAN_INCLUSIVE_EXCLUSIVE)
                        text.setSpan(ForegroundColorSpan(withAlpha(color, 0.62f)), 0, text.length, Spanned.SPAN_INCLUSIVE_EXCLUSIVE)
                    }
                    // A task item drops its bullet and pulls its box 1.2 em into the indent (desktop CSS).
                    val boxLeft = padX + indent - 1.2f * fontPx
                    val textX = if (block.task != null) boxLeft + 1.25f * fontPx else padX + indent
                    val layout = staticLayout(text, (padX + inner - textX).toInt().coerceAtLeast(fontPx.toInt()), fontPx, LINE)
                    val lineMid = y + (layout.getLineTop(0) + layout.getLineBottom(0)) / 2f
                    quoteBars(block.quoteDepth, fontPx, padX, y, y + layout.height, pieces)
                    when {
                        block.task != null -> {
                            val size = 0.95f * fontPx
                            val box = RectF(boxLeft, lineMid - size / 2, boxLeft + size, lineMid + size / 2)
                            pieces += Piece.Check(box, block.task == true)
                            // A finger needs more than the drawn box.
                            val reach = max(0f, (touchPx - size) / 2)
                            hits += Hit(RectF(box.left - reach, box.top - reach, box.right + reach, box.bottom + reach), taskLine = block.line)
                        }
                        block.number != null -> {
                            val label = StaticLayout.Builder.obtain("${block.number}.", 0, "${block.number}.".length, TextPaint(paint), (1.3f * fontPx).toInt().coerceAtLeast(1))
                                .setAlignment(Layout.Alignment.ALIGN_OPPOSITE).setIncludePad(false).build()
                            pieces += Piece.Text(label, textX - 1.3f * fontPx - 0.25f * fontPx, y)
                        }
                        else -> {
                            val radius = (if (block.depth == 0) 0.17f else 0.14f) * fontPx
                            pieces += Piece.Bullet(textX - 0.6f * fontPx, lineMid, radius)
                        }
                    }
                    pieces += Piece.Text(layout, textX, y)
                    linkHits(layout, block.inline, textX, y, hits)
                    val nextIsItem = blocks.getOrNull(index + 1) is NoteTextBlock.Item
                    y += layout.height + if (last) 0f else if (nextIsItem) 0f else gap
                }
                is NoteTextBlock.Code -> {
                    val indent = quoteIndent(block.quoteDepth, fontPx)
                    val text = SpannableStringBuilder(block.text.ifEmpty { " " })
                    text.setSpan(TypefaceSpan("monospace"), 0, text.length, Spanned.SPAN_INCLUSIVE_EXCLUSIVE)
                    text.setSpan(RelativeSizeSpan(0.9f), 0, text.length, Spanned.SPAN_INCLUSIVE_EXCLUSIVE)
                    val pad = 0.35f * fontPx
                    val layout = staticLayout(text, (inner - indent - pad * 2).toInt().coerceAtLeast(1), fontPx * 0.9f, LINE)
                    pieces += Piece.Tint(RectF(padX + indent, y, padX + inner, y + layout.height + pad * 2))
                    pieces += Piece.Text(layout, padX + indent + pad, y + pad)
                    y += layout.height + pad * 2 + if (last) 0f else gap
                }
                is NoteTextBlock.Rule -> {
                    y += 0.3f * fontPx
                    pieces += Piece.Line(padX, y, padX + inner, y)
                    y += 0.3f * fontPx + if (last) 0f else gap
                }
                is NoteTextBlock.Table -> {
                    val columns = block.header.size.coerceAtLeast(1)
                    val cell = inner / columns
                    val cellPad = 0.4f * fontPx
                    val rows = listOf(block.header) + block.rows
                    rows.forEachIndexed { rowIndex, row ->
                        val layouts = row.map { inline ->
                            val text = spanned(inline, color, fontPx)
                            if (rowIndex == 0) text.setSpan(StyleSpan(Typeface.BOLD), 0, text.length, Spanned.SPAN_INCLUSIVE_EXCLUSIVE)
                            staticLayout(text, (cell - cellPad * 2).toInt().coerceAtLeast(1), fontPx, LINE)
                        }
                        val rowHeight = (layouts.maxOfOrNull { it.height } ?: 0) + 0.2f * fontPx
                        layouts.forEachIndexed { column, layout ->
                            val x = padX + column * cell
                            pieces += Piece.Text(layout, x + cellPad, y + 0.1f * fontPx)
                            linkHits(layout, row[column], x + cellPad, y + 0.1f * fontPx, hits)
                            pieces += Piece.Line(x, y, x + cell, y)
                            pieces += Piece.Line(x, y, x, y + rowHeight)
                        }
                        pieces += Piece.Line(padX + inner, y, padX + inner, y + rowHeight)
                        y += rowHeight
                    }
                    pieces += Piece.Line(padX, y, padX + inner, y)
                    y += if (last) 0f else gap
                }
            }
        }
        if (blocks.isEmpty()) y += LINE * fontPx
        val height = max(minHeightPx, ceil(y + padY))
        return BoxLayout(widthPx, height, pieces, hits)
    }

    fun draw(canvas: Canvas, layout: BoxLayout, field: NoteTextField, left: Float, top: Float, density: Float, placeholder: String, fontPx: Float) {
        val color = ink(field)
        val radius = 6f * density
        val empty = field.text.isEmpty()
        fill.color = Color.argb(if (empty) 150 else 224, 255, 255, 255)
        canvas.drawRoundRect(left, top, left + layout.width, top + layout.height, radius, radius, fill)
        edge.strokeWidth = max(1f, density)
        edge.color = Color.argb(if (empty) 140 else 64, 32, 34, 43)
        edge.pathEffect = if (empty) dashed else null
        canvas.drawRoundRect(left, top, left + layout.width, top + layout.height, radius, radius, edge)
        edge.pathEffect = null
        if (empty) {
            paint.color = PLACEHOLDER
            paint.textSize = fontPx
            paint.typeface = Typeface.DEFAULT
            canvas.drawText(placeholder, left + 0.4f * fontPx, top + 0.22f * fontPx + fontPx, paint)
            return
        }
        for (piece in layout.pieces) {
            when (piece) {
                is Piece.Text -> {
                    canvas.save()
                    canvas.translate(left + piece.x, top + piece.y)
                    piece.layout.draw(canvas)
                    canvas.restore()
                }
                is Piece.Check -> {
                    val box = RectF(piece.rect).apply { offset(left, top) }
                    val corner = box.width() * 0.22f
                    if (piece.done) {
                        fill.color = color
                        canvas.drawRoundRect(box, corner, corner, fill)
                        edge.color = Color.WHITE
                        edge.strokeWidth = box.width() * 0.14f
                        val path = Path().apply {
                            moveTo(box.left + box.width() * 0.24f, box.top + box.height() * 0.52f)
                            lineTo(box.left + box.width() * 0.43f, box.top + box.height() * 0.72f)
                            lineTo(box.left + box.width() * 0.78f, box.top + box.height() * 0.3f)
                        }
                        edge.strokeCap = Paint.Cap.ROUND
                        canvas.drawPath(path, edge)
                    } else {
                        fill.color = Color.WHITE
                        canvas.drawRoundRect(box, corner, corner, fill)
                        edge.color = withAlpha(color, 0.7f)
                        edge.strokeWidth = max(1f, box.width() * 0.09f)
                        canvas.drawRoundRect(box, corner, corner, edge)
                    }
                }
                is Piece.Bullet -> {
                    fill.color = color
                    canvas.drawCircle(left + piece.x, top + piece.y, piece.radius, fill)
                }
                is Piece.Bar -> {
                    fill.color = withAlpha(color, 0.3f)
                    canvas.drawRect(piece.rect.left + left, piece.rect.top + top, piece.rect.right + left, piece.rect.bottom + top, fill)
                }
                is Piece.Tint -> {
                    fill.color = withAlpha(color, 0.07f)
                    canvas.drawRoundRect(piece.rect.left + left, piece.rect.top + top, piece.rect.right + left, piece.rect.bottom + top, radius, radius, fill)
                }
                is Piece.Line -> {
                    edge.color = withAlpha(color, 0.3f)
                    edge.strokeWidth = max(1f, density * 0.8f)
                    canvas.drawLine(piece.x0 + left, piece.y0 + top, piece.x1 + left, piece.y1 + top, edge)
                }
            }
        }
    }

    private fun quoteIndent(depth: Int, fontPx: Float) = depth * (0.6f * fontPx + 3f)

    private fun quoteBars(depth: Int, fontPx: Float, padX: Float, top: Float, bottom: Float, pieces: MutableList<Piece>) {
        for (level in 0 until depth) {
            val x = padX + level * (0.6f * fontPx + 3f)
            pieces += Piece.Bar(RectF(x, top, x + 3f, bottom))
        }
    }

    private fun staticLayout(text: CharSequence, width: Int, fontPx: Float, lineHeight: Float): StaticLayout {
        val local = TextPaint(paint)
        local.textSize = fontPx
        val metrics = local.fontMetrics
        val natural = metrics.descent - metrics.ascent
        val extra = (lineHeight * fontPx - natural).coerceAtLeast(0f)
        return StaticLayout.Builder.obtain(text, 0, text.length, TextPaint(paint), width.coerceAtLeast(1))
            .setLineSpacing(extra, 1f)
            .setIncludePad(false)
            .setBreakStrategy(Layout.BREAK_STRATEGY_HIGH_QUALITY)
            .build()
    }

    private fun spanned(inline: NoteTextInline, color: Int, fontPx: Float): SpannableStringBuilder {
        val text = SpannableStringBuilder(inline.text.ifEmpty { " " })
        for (span in inline.spans) {
            val start = span.start.coerceIn(0, text.length)
            val end = span.end.coerceIn(start, text.length)
            if (start == end) continue
            when (span.style) {
                NoteTextInlineStyle.BOLD -> text.setSpan(StyleSpan(Typeface.BOLD), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                NoteTextInlineStyle.ITALIC -> text.setSpan(StyleSpan(Typeface.ITALIC), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                NoteTextInlineStyle.STRIKE -> text.setSpan(StrikethroughSpan(), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                NoteTextInlineStyle.CODE -> {
                    text.setSpan(TypefaceSpan("monospace"), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                    text.setSpan(RelativeSizeSpan(0.9f), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                    text.setSpan(BackgroundColorSpan(withAlpha(color, 0.09f)), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
                NoteTextInlineStyle.LINK -> if (span.href != null) {
                    text.setSpan(ForegroundColorSpan(LINK), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                    text.setSpan(UnderlineSpan(), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
            }
        }
        return text
    }

    private fun linkHits(layout: StaticLayout, inline: NoteTextInline, x: Float, y: Float, hits: MutableList<Hit>) {
        for (span in inline.spans) {
            val href = span.href ?: continue
            if (span.style != NoteTextInlineStyle.LINK) continue
            val path = Path()
            layout.getSelectionPath(span.start.coerceAtMost(layout.text.length), span.end.coerceAtMost(layout.text.length), path)
            val bounds = RectF()
            path.computeBounds(bounds, true)
            if (bounds.isEmpty) continue
            bounds.offset(x, y)
            hits += Hit(bounds, href = href)
        }
    }

    private fun withAlpha(color: Int, alpha: Float) = Color.argb((alpha * 255).toInt(), Color.red(color), Color.green(color), Color.blue(color))

    companion object {
        const val INK = 0xFF20222B.toInt()
        const val PLACEHOLDER = 0xFF747887.toInt()
        const val LINK = 0xFF2563C9.toInt()
        const val LINE = 1.35f
    }
}
