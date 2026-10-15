package ch.fasrv.fanotes

import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import android.text.Editable
import android.text.Layout
import android.text.Spanned
import android.text.style.BackgroundColorSpan
import android.text.style.CharacterStyle
import android.text.style.LeadingMarginSpan
import android.text.style.LineBackgroundSpan
import android.text.style.LineHeightSpan
import android.text.style.MetricAffectingSpan
import android.text.style.ReplacementSpan
import android.text.style.StrikethroughSpan
import android.text.style.StyleSpan
import android.text.style.TypefaceSpan
import ch.fasrv.fanotes.desk.LiveKind
import ch.fasrv.fanotes.desk.LiveMark
import ch.fasrv.fanotes.desk.PAPER_CODE_BACKGROUND
import ch.fasrv.fanotes.desk.PAPER_QUOTE_INK
import ch.fasrv.fanotes.desk.PAPER_RULE_ARGB
import ch.fasrv.fanotes.desk.PAPER_RULE_STRONG_ARGB
import ch.fasrv.fanotes.desk.layoutDisplayMath
import ch.fasrv.fanotes.desk.paperMathBorderArgb
import ch.fasrv.fanotes.desk.paperMathBox
import ch.fasrv.fanotes.desk.paperMathFillArgb
import ch.fasrv.fanotes.desk.paperMathInlinePad
import ch.fasrv.fanotes.desk.paperTableFillArgb
import ch.fasrv.fanotes.desk.tablePadPx
import ch.fasrv.fanotes.desk.tableRulePx
import ch.fasrv.fanotes.desk.paperCodeBox
import ch.fasrv.fanotes.desk.paperCodeInkArgb
import ch.fasrv.fanotes.desk.livePreviewMarks
import ch.fasrv.fanotes.desk.paperAccentReadableArgb
import ch.fasrv.fanotes.desk.quoteMargins
import ch.fasrv.fanotes.desk.quoteWashArgb
import ch.fasrv.fanotes.desk.selectionMatchRanges

/** A span the live preview owns, so the next pass can remove only its own marks. */
interface LivePreviewSpan

/**
 * Paints desktop live-preview marks onto the editor text without changing
 * the characters. The cursor line still shows its Markdown markers.
 */
fun applyLivePreview(
    editable: Editable,
    selectionStart: Int,
    selectionEnd: Int,
    accent: Int,
    textSizePx: Float = 16f,
) {
    if (hasComposingSpan(editable)) return
    for (span in editable.getSpans(0, editable.length, LivePreviewSpan::class.java)) editable.removeSpan(span)
    val length = editable.length
    val readable = paperAccentReadableArgb(accent)
    for (mark in livePreviewMarks(editable.toString(), selectionStart, selectionEnd)) {
        val start = mark.start.coerceIn(0, length)
        val end = mark.end.coerceIn(start, length)
        if (start == end) continue
        editable.setSpan(spanFor(mark, readable, accent, textSizePx), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    }
    val matches = selectionMatchRanges(editable.toString(), selectionStart, selectionEnd) ?: return
    for ((start, end) in matches) {
        val from = start.coerceIn(0, length)
        val to = end.coerceIn(from, length)
        if (from == to) continue
        editable.setSpan(SelectionMatchSpan(), from, to, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    }
}

private fun hasComposingSpan(editable: Editable): Boolean {
    for (span in editable.getSpans(0, editable.length, Any::class.java)) {
        if (editable.getSpanFlags(span) and Spanned.SPAN_COMPOSING != 0) return true
    }
    return false
}

private fun spanFor(mark: LiveMark, readable: Int, accent: Int, textSizePx: Float): Any = when (mark.kind) {
    LiveKind.HIDE -> HideSpan()
    LiveKind.COLLAPSE -> CollapseSpan()
    LiveKind.BULLET -> AccentSwapSpan("• ", readable)
    LiveKind.TASK_OPEN -> TaskSpan("☐ ")
    LiveKind.TASK_DONE -> TaskSpan("☑ ")
    LiveKind.H1 -> HeadingSpan(2f, textSizePx)
    LiveKind.H2 -> HeadingSpan(1.55f, textSizePx)
    LiveKind.H3 -> HeadingSpan(1.28f, textSizePx)
    LiveKind.H4 -> HeadingSpan(1.1f, textSizePx)
    LiveKind.H5, LiveKind.H6 -> HeadingSpan(1f, textSizePx)
    LiveKind.QUOTE -> PaperQuoteSpan(readable, quoteWashArgb(accent), textSizePx)
    LiveKind.STRONG -> StrongSpan()
    LiveKind.EMPHASIS -> EmphasisSpan()
    LiveKind.STRIKE -> StrikeSpan()
    LiveKind.CODE -> PaperCodeSpan(paperCodeInkArgb(accent), textSizePx)
    LiveKind.MATH -> PaperInlineMathSpan(textSizePx)
    LiveKind.MATH_BLOCK -> PaperMathBlockSpan(mark.label, paperMathFillArgb(accent), paperMathBorderArgb(accent), textSizePx)
    LiveKind.LINK -> LinkSpan(readable)
    LiveKind.DETAILS_SUMMARY -> DetailsSummarySpan(mark.label, mark.body)
    LiveKind.TABLE_ROW -> TableRowSpan(paperTableFillArgb(accent), textSizePx)
    LiveKind.TABLE_RULE -> TableRuleSpan(textSizePx)
    LiveKind.RULE -> PaperThematicRuleSpan(textSizePx)
}

internal class DetailsSummarySpan(private val summary: String, private val body: String) : ReplacementSpan(), LivePreviewSpan {
    override fun getSize(paint: Paint, text: CharSequence, start: Int, end: Int, fm: Paint.FontMetricsInt?): Int {
        val summaryWidth = paint.measureText(summary).toInt().coerceAtLeast(1)
        if (body.isEmpty()) return summaryWidth
        if (fm != null) {
            val extra = paint.fontMetricsInt.descent - paint.fontMetricsInt.ascent
            fm.descent += extra
            fm.bottom += extra
        }
        return maxOf(summaryWidth, paint.measureText(body).toInt())
    }

    override fun draw(canvas: Canvas, text: CharSequence, start: Int, end: Int, x: Float, top: Int, y: Int, bottom: Int, paint: Paint) {
        val previous = paint.typeface
        paint.typeface = Typeface.create(previous, Typeface.BOLD)
        canvas.drawText(summary, x, y.toFloat(), paint)
        if (body.isNotEmpty()) {
            paint.typeface = Typeface.create(previous, Typeface.NORMAL)
            val step = paint.fontMetrics.descent - paint.fontMetrics.ascent
            canvas.drawText(body, x, y + step, paint)
        }
        paint.typeface = previous
    }
}

private class HideSpan : ReplacementSpan(), LivePreviewSpan {
    override fun getSize(paint: Paint, text: CharSequence, start: Int, end: Int, fm: Paint.FontMetricsInt?) = 0
    override fun draw(canvas: Canvas, text: CharSequence, start: Int, end: Int, x: Float, top: Int, y: Int, bottom: Int, paint: Paint) = Unit
}

internal open class SwapSpan(private val drawn: String) : ReplacementSpan(), LivePreviewSpan {
    override fun getSize(paint: Paint, text: CharSequence, start: Int, end: Int, fm: Paint.FontMetricsInt?): Int =
        paint.measureText(drawn).toInt().coerceAtLeast(1)

    override fun draw(canvas: Canvas, text: CharSequence, start: Int, end: Int, x: Float, top: Int, y: Int, bottom: Int, paint: Paint) {
        canvas.drawText(drawn, x, y.toFloat(), paint)
    }
}

internal class TaskSpan(drawn: String) : SwapSpan(drawn)

internal class AccentSwapSpan(drawn: String, private val color: Int) : SwapSpan(drawn) {
    override fun draw(canvas: Canvas, text: CharSequence, start: Int, end: Int, x: Float, top: Int, y: Int, bottom: Int, paint: Paint) {
        val previousColor = paint.color
        val previousFace = paint.typeface
        paint.color = color
        paint.typeface = Typeface.create(previousFace, Typeface.BOLD)
        super.draw(canvas, text, start, end, x, top, y, bottom, paint)
        paint.color = previousColor
        paint.typeface = previousFace
    }
}

private class SelectionMatchSpan : BackgroundColorSpan(0x8099FF77.toInt()), LivePreviewSpan

private class CollapseSpan : LineHeightSpan, LivePreviewSpan {
    override fun chooseHeight(text: CharSequence, start: Int, end: Int, spanstartv: Int, lineHeight: Int, fm: Paint.FontMetricsInt) {
        fm.ascent = 0
        fm.descent = 0
        fm.top = 0
        fm.bottom = 0
    }
}

private class HeadingSpan(private val proportion: Float, private val baseTextPx: Float) :
    MetricAffectingSpan(), LineHeightSpan, LineBackgroundSpan, LivePreviewSpan {
    override fun updateDrawState(paint: android.text.TextPaint) = apply(paint)
    override fun updateMeasureState(paint: android.text.TextPaint) = apply(paint)

    private fun apply(paint: android.text.TextPaint) {
        paint.textSize *= proportion
        paint.typeface = Typeface.create(paint.typeface, Typeface.BOLD)
    }

    override fun chooseHeight(text: CharSequence, start: Int, end: Int, spanstartv: Int, lineHeight: Int, fm: Paint.FontMetricsInt) {
        if (proportion != 2f) return
        val top = (baseTextPx * 1f).toInt()
        val bottom = (baseTextPx * 0.56f).toInt()
        fm.ascent -= top
        fm.top -= top
        fm.descent += bottom
        fm.bottom += bottom
    }

    override fun drawBackground(
        canvas: Canvas,
        paint: Paint,
        left: Int,
        right: Int,
        top: Int,
        baseline: Int,
        bottom: Int,
        text: CharSequence,
        start: Int,
        end: Int,
        lineNumber: Int,
    ) {
        if (proportion != 2f || right <= left) return
        val thickness = (baseTextPx / 16f).coerceAtLeast(1f)
        val previous = paint.color
        paint.color = PAPER_RULE_ARGB
        canvas.drawRect(left.toFloat(), bottom - thickness, right.toFloat(), bottom.toFloat(), paint)
        paint.color = previous
    }
}

/**
 * Desktop paper quote: a 3px accent bar, 13px of space, a 7% accent wash,
 * and the paper's soft text colour.
 */
internal class TableRowSpan(private val fill: Int, private val textSizePx: Float) :
    LeadingMarginSpan, LineBackgroundSpan, LivePreviewSpan {
    private val pad = tablePadPx(textSizePx)
    private val hairline = (textSizePx / 16f).coerceAtLeast(1f)

    override fun getLeadingMargin(first: Boolean) = pad

    override fun drawLeadingMargin(
        canvas: Canvas,
        paint: Paint,
        x: Int,
        dir: Int,
        top: Int,
        baseline: Int,
        bottom: Int,
        text: CharSequence,
        start: Int,
        end: Int,
        first: Boolean,
        layout: Layout,
    ) = Unit

    override fun drawBackground(
        canvas: Canvas,
        paint: Paint,
        left: Int,
        right: Int,
        top: Int,
        baseline: Int,
        bottom: Int,
        text: CharSequence,
        start: Int,
        end: Int,
        lineNumber: Int,
    ) {
        if (right <= left) return
        val previous = paint.color
        paint.color = fill
        canvas.drawRect(left.toFloat(), top.toFloat(), right.toFloat(), bottom.toFloat(), paint)
        paint.color = PAPER_RULE_ARGB
        canvas.drawRect(left.toFloat(), top.toFloat(), left + hairline, bottom.toFloat(), paint)
        canvas.drawRect(right - hairline, top.toFloat(), right.toFloat(), bottom.toFloat(), paint)
        paint.color = previous
    }
}

internal class TableRuleSpan(private val textSizePx: Float) : LineHeightSpan, LineBackgroundSpan, LivePreviewSpan {
    private val bar = tableRulePx(textSizePx)
    private val hairline = (textSizePx / 16f).coerceAtLeast(1f)

    override fun chooseHeight(text: CharSequence, start: Int, end: Int, spanstartv: Int, lineHeight: Int, fm: Paint.FontMetricsInt) {
        fm.ascent = 0
        fm.top = 0
        fm.descent = bar
        fm.bottom = bar
    }

    override fun drawBackground(
        canvas: Canvas,
        paint: Paint,
        left: Int,
        right: Int,
        top: Int,
        baseline: Int,
        bottom: Int,
        text: CharSequence,
        start: Int,
        end: Int,
        lineNumber: Int,
    ) {
        if (right <= left) return
        val previous = paint.color
        paint.color = PAPER_RULE_ARGB
        canvas.drawRect(left.toFloat(), top.toFloat(), left + hairline, bottom.toFloat(), paint)
        canvas.drawRect(right - hairline, top.toFloat(), right.toFloat(), bottom.toFloat(), paint)
        paint.color = PAPER_RULE_STRONG_ARGB
        canvas.drawRect(left.toFloat(), bottom - hairline, right.toFloat(), bottom.toFloat(), paint)
        paint.color = previous
    }
}

/** Desktop paper thematic break: a strong rule across the middle of the line. */
internal class PaperThematicRuleSpan(private val textSizePx: Float) : LineBackgroundSpan, LivePreviewSpan {
    override fun drawBackground(
        canvas: Canvas,
        paint: Paint,
        left: Int,
        right: Int,
        top: Int,
        baseline: Int,
        bottom: Int,
        text: CharSequence,
        start: Int,
        end: Int,
        lineNumber: Int,
    ) {
        if (right <= left) return
        val thickness = (textSizePx / 16f).coerceAtLeast(1f)
        val y = top + (bottom - top) * 0.5f
        val previous = paint.color
        paint.color = PAPER_RULE_STRONG_ARGB
        canvas.drawRect(left.toFloat(), y, right.toFloat(), y + thickness, paint)
        paint.color = previous
    }
}

internal class PaperRuleSpan(private val baseTextPx: Float) : LineBackgroundSpan, LivePreviewSpan {
    override fun drawBackground(
        canvas: Canvas,
        paint: Paint,
        left: Int,
        right: Int,
        top: Int,
        baseline: Int,
        bottom: Int,
        text: CharSequence,
        start: Int,
        end: Int,
        lineNumber: Int,
    ) {
        if (right <= left) return
        val thickness = (baseTextPx / 16f).coerceAtLeast(1f)
        val previous = paint.color
        paint.color = PAPER_RULE_ARGB
        canvas.drawRect(left.toFloat(), bottom - thickness, right.toFloat(), bottom.toFloat(), paint)
        paint.color = previous
    }
}

internal class PaperQuoteSpan(
    private val barColor: Int,
    private val washColor: Int,
    private val textSizePx: Float,
) : CharacterStyle(), LeadingMarginSpan, LineBackgroundSpan, LivePreviewSpan {
    private val barPx = quoteMargins(textSizePx).first
    private val marginPx = quoteMargins(textSizePx).second

    override fun updateDrawState(paint: android.text.TextPaint) {
        paint.color = PAPER_QUOTE_INK
    }

    override fun getLeadingMargin(first: Boolean) = marginPx

    override fun drawLeadingMargin(
        canvas: Canvas,
        paint: Paint,
        x: Int,
        dir: Int,
        top: Int,
        baseline: Int,
        bottom: Int,
        text: CharSequence,
        start: Int,
        end: Int,
        first: Boolean,
        layout: Layout,
    ) {
        val previous = paint.color
        paint.color = barColor
        val left = if (dir > 0) x else x - barPx
        canvas.drawRect(left.toFloat(), top.toFloat(), (left + barPx).toFloat(), bottom.toFloat(), paint)
        paint.color = previous
    }

    override fun drawBackground(
        canvas: Canvas,
        paint: Paint,
        left: Int,
        right: Int,
        top: Int,
        baseline: Int,
        bottom: Int,
        text: CharSequence,
        start: Int,
        end: Int,
        lineNumber: Int,
    ) {
        if (right <= left) return
        val previousShader = paint.shader
        val previousColor = paint.color
        paint.shader = LinearGradient(
            left.toFloat(),
            0f,
            right.toFloat(),
            0f,
            washColor,
            0x00000000,
            Shader.TileMode.CLAMP,
        )
        canvas.drawRect(left.toFloat(), top.toFloat(), right.toFloat(), bottom.toFloat(), paint)
        paint.shader = previousShader
        paint.color = previousColor
    }
}

private class StrongSpan : StyleSpan(Typeface.BOLD), LivePreviewSpan
private class EmphasisSpan : StyleSpan(Typeface.ITALIC), LivePreviewSpan
private class StrikeSpan : StrikethroughSpan(), LivePreviewSpan
/**
 * Desktop paper inline code: a rounded chip, a hairline rule, monospace
 * at 0.9em, and ink mixed from the readable accent.
 */
internal class PaperCodeSpan(private val ink: Int, private val textSizePx: Float) : ReplacementSpan(), LivePreviewSpan {
    private val box = paperCodeBox(textSizePx)

    override fun getSize(paint: Paint, text: CharSequence, start: Int, end: Int, fm: Paint.FontMetricsInt?): Int {
        val previous = paint.textSize
        paint.textSize = box.textPx
        val width = paint.measureText(text, start, end) + box.padX * 2f
        if (fm != null) {
            val metrics = paint.fontMetricsInt
            val pad = box.padY.toInt()
            fm.ascent = metrics.ascent - pad
            fm.descent = metrics.descent + pad
            fm.top = metrics.top - pad
            fm.bottom = metrics.bottom + pad
        }
        paint.textSize = previous
        return width.toInt().coerceAtLeast(1)
    }

    override fun draw(canvas: Canvas, text: CharSequence, start: Int, end: Int, x: Float, top: Int, y: Int, bottom: Int, paint: Paint) {
        val previousSize = paint.textSize
        val previousColor = paint.color
        val previousFace = paint.typeface
        val previousStyle = paint.style
        val previousStroke = paint.strokeWidth
        paint.textSize = box.textPx
        val width = paint.measureText(text, start, end) + box.padX * 2f
        val rect = RectF(x, top.toFloat(), x + width, bottom.toFloat())
        paint.style = Paint.Style.FILL
        paint.color = PAPER_CODE_BACKGROUND
        canvas.drawRoundRect(rect, box.radius, box.radius, paint)
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = box.border
        paint.color = PAPER_RULE_ARGB
        canvas.drawRoundRect(rect, box.radius, box.radius, paint)
        paint.style = Paint.Style.FILL
        paint.color = ink
        paint.typeface = Typeface.MONOSPACE
        canvas.drawText(text, start, end, x + box.padX, y.toFloat(), paint)
        paint.textSize = previousSize
        paint.color = previousColor
        paint.typeface = previousFace
        paint.style = previousStyle
        paint.strokeWidth = previousStroke
    }
}
internal class PaperInlineMathSpan(private val textSizePx: Float) : ReplacementSpan(), LivePreviewSpan {
    override fun getSize(paint: Paint, text: CharSequence, start: Int, end: Int, fm: Paint.FontMetricsInt?): Int {
        val extent = measureMath(paint, layoutDisplayMath(text.subSequence(start, end).toString()), textSizePx)
        val pad = paperMathInlinePad(textSizePx)
        val drop = textSizePx * 0.08f
        if (fm != null) {
            fm.ascent = -(extent.ascent + drop).toInt()
            fm.descent = (extent.descent + drop).toInt()
            fm.top = fm.ascent
            fm.bottom = fm.descent
        }
        return (extent.width + pad * 2f).toInt().coerceAtLeast(1)
    }

    override fun draw(canvas: Canvas, text: CharSequence, start: Int, end: Int, x: Float, top: Int, y: Int, bottom: Int, paint: Paint) {
        val previous = paint.color
        paint.color = PAPER_MATH_INK
        drawMath(canvas, paint, layoutDisplayMath(text.subSequence(start, end).toString()), x + paperMathInlinePad(textSizePx), y + textSizePx * 0.08f, textSizePx)
        paint.color = previous
    }
}

/**
 * Desktop paper display math: a rounded card in a light accent wash, with the
 * formula centred. The opening fence is replaced; the source lines collapse.
 */
internal class PaperMathBlockSpan(
    private val source: String?,
    private val fill: Int,
    private val border: Int,
    private val textSizePx: Float,
) : ReplacementSpan(), LineBackgroundSpan, LivePreviewSpan {
    override fun getSize(paint: Paint, text: CharSequence, start: Int, end: Int, fm: Paint.FontMetricsInt?): Int {
        val extent = measureMath(paint, layoutDisplayMath(formula(text, start, end)), textSizePx)
        val box = paperMathBox(textSizePx)
        val total = maxOf(extent.height, textSizePx) + box.padY * 2f + box.marginY * 2f
        if (fm != null) {
            val half = (total / 2f).toInt().coerceAtLeast(1)
            fm.ascent = -half
            fm.descent = half
            fm.top = fm.ascent
            fm.bottom = fm.descent
        }
        return 1
    }

    override fun draw(canvas: Canvas, text: CharSequence, start: Int, end: Int, x: Float, top: Int, y: Int, bottom: Int, paint: Paint) = Unit

    override fun drawBackground(
        canvas: Canvas,
        paint: Paint,
        left: Int,
        right: Int,
        top: Int,
        baseline: Int,
        bottom: Int,
        text: CharSequence,
        start: Int,
        end: Int,
        lineNumber: Int,
    ) {
        if (right <= left) return
        val box = paperMathBox(textSizePx)
        val contentTop = top + box.marginY
        val contentBottom = bottom - box.marginY
        if (contentBottom <= contentTop) return
        val rect = RectF(left + box.border, contentTop, right - box.border, contentBottom)
        val previousColor = paint.color
        val previousStyle = paint.style
        val previousStroke = paint.strokeWidth
        paint.style = Paint.Style.FILL
        paint.color = fill
        canvas.drawRoundRect(rect, box.radius, box.radius, paint)
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = box.border
        paint.color = border
        canvas.drawRoundRect(rect, box.radius, box.radius, paint)
        val node = layoutDisplayMath(formula(text, start, end))
        val extent = measureMath(paint, node, textSizePx)
        val formulaX = left + (right - left - extent.width) / 2f
        val formulaBaseline = (contentTop + contentBottom) / 2f + (extent.ascent - extent.descent) / 2f
        paint.style = Paint.Style.FILL
        paint.color = PAPER_MATH_INK
        drawMath(canvas, paint, node, formulaX, formulaBaseline, textSizePx)
        paint.color = previousColor
        paint.style = previousStyle
        paint.strokeWidth = previousStroke
    }

    private fun formula(text: CharSequence, start: Int, end: Int): String =
        source ?: text.subSequence(start, end).toString()
}

private const val PAPER_MATH_INK = 0xFF252630.toInt()

private class LinkSpan(private val color: Int) : CharacterStyle(), LivePreviewSpan {
    override fun updateDrawState(paint: android.text.TextPaint) {
        paint.color = color
        paint.isUnderlineText = true
    }
}
