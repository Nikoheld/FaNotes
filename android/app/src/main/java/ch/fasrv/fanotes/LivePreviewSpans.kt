package ch.fasrv.fanotes

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Typeface
import android.text.Editable
import android.text.Spanned
import android.text.style.CharacterStyle
import android.text.style.LineHeightSpan
import android.text.style.MetricAffectingSpan
import android.text.style.ReplacementSpan
import android.text.style.StrikethroughSpan
import android.text.style.StyleSpan
import android.text.style.TypefaceSpan
import ch.fasrv.fanotes.desk.LiveKind
import ch.fasrv.fanotes.desk.LiveMark
import ch.fasrv.fanotes.desk.livePreviewMarks

/** A span the live preview owns, so the next pass can remove only its own marks. */
interface LivePreviewSpan

/**
 * Paints desktop live-preview marks onto the editor text without changing
 * the characters. The cursor line still shows its Markdown markers.
 */
fun applyLivePreview(editable: Editable, selectionStart: Int, selectionEnd: Int, accent: Int) {
    if (hasComposingSpan(editable)) return
    for (span in editable.getSpans(0, editable.length, LivePreviewSpan::class.java)) editable.removeSpan(span)
    val length = editable.length
    for (mark in livePreviewMarks(editable.toString(), selectionStart, selectionEnd)) {
        val start = mark.start.coerceIn(0, length)
        val end = mark.end.coerceIn(start, length)
        if (start == end) continue
        editable.setSpan(spanFor(mark, accent), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    }
}

private fun hasComposingSpan(editable: Editable): Boolean {
    for (span in editable.getSpans(0, editable.length, Any::class.java)) {
        if (editable.getSpanFlags(span) and Spanned.SPAN_COMPOSING != 0) return true
    }
    return false
}

private fun spanFor(mark: LiveMark, accent: Int): Any = when (mark.kind) {
    LiveKind.HIDE -> HideSpan()
    LiveKind.COLLAPSE -> CollapseSpan()
    LiveKind.BULLET -> SwapSpan("• ")
    LiveKind.TASK_OPEN -> TaskSpan("☐ ")
    LiveKind.TASK_DONE -> TaskSpan("☑ ")
    LiveKind.H1 -> HeadingSpan(2f)
    LiveKind.H2 -> HeadingSpan(1.55f)
    LiveKind.H3 -> HeadingSpan(1.28f)
    LiveKind.H4 -> HeadingSpan(1.1f)
    LiveKind.H5, LiveKind.H6 -> HeadingSpan(1f)
    LiveKind.QUOTE -> QuoteSpan()
    LiveKind.STRONG -> StrongSpan()
    LiveKind.EMPHASIS -> EmphasisSpan()
    LiveKind.STRIKE -> StrikeSpan()
    LiveKind.CODE -> CodeSpan()
    LiveKind.MATH -> MathSpan()
    LiveKind.LINK -> LinkSpan(accent)
    LiveKind.DETAILS_SUMMARY -> DetailsSummarySpan(mark.label, mark.body)
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

private class CollapseSpan : LineHeightSpan, LivePreviewSpan {
    override fun chooseHeight(text: CharSequence, start: Int, end: Int, spanstartv: Int, lineHeight: Int, fm: Paint.FontMetricsInt) {
        fm.ascent = 0
        fm.descent = 0
        fm.top = 0
        fm.bottom = 0
    }
}

private class HeadingSpan(private val proportion: Float) : MetricAffectingSpan(), LivePreviewSpan {
    override fun updateDrawState(paint: android.text.TextPaint) = apply(paint)
    override fun updateMeasureState(paint: android.text.TextPaint) = apply(paint)

    private fun apply(paint: android.text.TextPaint) {
        paint.textSize *= proportion
        paint.typeface = Typeface.create(paint.typeface, Typeface.BOLD)
    }
}

private class QuoteSpan : CharacterStyle(), LivePreviewSpan {
    override fun updateDrawState(paint: android.text.TextPaint) {
        paint.color = 0xFF5C6158.toInt()
    }
}

private class StrongSpan : StyleSpan(Typeface.BOLD), LivePreviewSpan
private class EmphasisSpan : StyleSpan(Typeface.ITALIC), LivePreviewSpan
private class StrikeSpan : StrikethroughSpan(), LivePreviewSpan
private class CodeSpan : TypefaceSpan("monospace"), LivePreviewSpan
private class MathSpan : TypefaceSpan("monospace"), LivePreviewSpan

private class LinkSpan(private val color: Int) : CharacterStyle(), LivePreviewSpan {
    override fun updateDrawState(paint: android.text.TextPaint) {
        paint.color = color
        paint.isUnderlineText = true
    }
}
