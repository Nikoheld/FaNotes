package ch.fasrv.fanotes

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
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
import android.text.style.ForegroundColorSpan
import android.text.style.ReplacementSpan
import android.text.style.StyleSpan
import android.text.style.UnderlineSpan
import android.text.style.TypefaceSpan
import ch.fasrv.fanotes.desk.LiveKind
import ch.fasrv.fanotes.desk.LiveMark
import ch.fasrv.fanotes.desk.PAPER_CODE_BACKGROUND
import ch.fasrv.fanotes.desk.PAPER_QUOTE_INK
import ch.fasrv.fanotes.desk.PAPER_RULE_ARGB
import ch.fasrv.fanotes.desk.PAPER_RULE_STRONG_ARGB
import ch.fasrv.fanotes.desk.layoutDisplayMath
import ch.fasrv.fanotes.desk.paperDetailsBox
import ch.fasrv.fanotes.desk.paperDetailsFillArgb
import ch.fasrv.fanotes.desk.paperDetailsOpenFillArgb
import ch.fasrv.fanotes.desk.paperMathBorderArgb
import ch.fasrv.fanotes.desk.paperMathBox
import ch.fasrv.fanotes.desk.paperMathFillArgb
import ch.fasrv.fanotes.desk.paperMathInlinePad
import ch.fasrv.fanotes.desk.paperTableFillArgb
import ch.fasrv.fanotes.desk.tablePadPx
import ch.fasrv.fanotes.desk.tableRulePx
import ch.fasrv.fanotes.desk.PAPER_STRONG_WEIGHT
import ch.fasrv.fanotes.desk.PAPER_BULLET_WEIGHT
import ch.fasrv.fanotes.desk.paperCodeBox
import ch.fasrv.fanotes.desk.paperTaskBox
import ch.fasrv.fanotes.desk.paperLinkUnderlineArgb
import ch.fasrv.fanotes.desk.paperLinkUnderlineOffset
import ch.fasrv.fanotes.desk.paperHeading
import ch.fasrv.fanotes.desk.paperCodeInkArgb
import ch.fasrv.fanotes.desk.MATCHING_BRACKET_ARGB
import ch.fasrv.fanotes.desk.NONMATCHING_BRACKET_ARGB
import ch.fasrv.fanotes.desk.SPECIAL_CHAR_ARGB
import ch.fasrv.fanotes.desk.bracketHighlight
import ch.fasrv.fanotes.desk.SYNTAX_ATOM_ARGB
import ch.fasrv.fanotes.desk.SYNTAX_COMMENT_ARGB
import ch.fasrv.fanotes.desk.SYNTAX_ESCAPE_ARGB
import ch.fasrv.fanotes.desk.SourceSyntax
import ch.fasrv.fanotes.desk.DetailsInline
import ch.fasrv.fanotes.text.tableAlignAt
import ch.fasrv.fanotes.text.tableCellOrigin
import ch.fasrv.fanotes.desk.detailsImageFrame
import ch.fasrv.fanotes.desk.followedTarget
import ch.fasrv.fanotes.desk.detailsImageMargin
import ch.fasrv.fanotes.desk.detailsImageRadius
import ch.fasrv.fanotes.desk.livePreviewMarks
import ch.fasrv.fanotes.desk.sourceSyntaxMarks
import ch.fasrv.fanotes.desk.specialCharMarks
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
    focused: Boolean = true,
    images: Map<String, Bitmap> = emptyMap(),
    imageColumnPx: Float = 0f,
) {
    if (hasComposingSpan(editable)) return
    for (span in editable.getSpans(0, editable.length, LivePreviewSpan::class.java)) editable.removeSpan(span)
    val length = editable.length
    val readable = paperAccentReadableArgb(accent)
    for (mark in livePreviewMarks(editable.toString(), selectionStart, selectionEnd)) {
        val start = mark.start.coerceIn(0, length)
        val end = mark.end.coerceIn(start, length)
        if (start == end) continue
        editable.setSpan(
            spanFor(mark, readable, accent, textSizePx, images, imageColumnPx),
            start,
            end,
            Spanned.SPAN_EXCLUSIVE_EXCLUSIVE,
        )
    }
    for (mark in sourceSyntaxMarks(editable.toString(), selectionStart, selectionEnd)) {
        val start = mark.start.coerceIn(0, length)
        val end = mark.end.coerceIn(start, length)
        if (start == end) continue
        editable.setSpan(syntaxSpan(mark.style), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    }
    if (focused && selectionStart == selectionEnd) {
        val highlight = bracketHighlight(editable.toString(), selectionStart)
        if (highlight != null) {
            val color = if (highlight.matched) MATCHING_BRACKET_ARGB else NONMATCHING_BRACKET_ARGB
            paintBracket(editable, highlight.start, color, length)
            val partner = highlight.partner
            if (partner != null) paintBracket(editable, partner, color, length)
        }
    }
    for (mark in specialCharMarks(editable.toString())) {
        val from = mark.index
        val to = from + 1
        if (to > length) continue
        if (editable.getSpans(from, to, HideSpan::class.java).isNotEmpty()) continue
        editable.setSpan(SpecialCharSpan(mark.placeholder), from, to, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    }
    val matches = selectionMatchRanges(editable.toString(), selectionStart, selectionEnd) ?: return
    for ((start, end) in matches) {
        val from = start.coerceIn(0, length)
        val to = end.coerceIn(from, length)
        if (from == to) continue
        editable.setSpan(SelectionMatchSpan(), from, to, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    }
}

private fun syntaxSpan(style: SourceSyntax): Any = when (style) {
    SourceSyntax.HEADING -> SyntaxUnderlineSpan()
    SourceSyntax.STRONG -> SyntaxBoldSpan()
    SourceSyntax.EMPHASIS -> SyntaxItalicSpan()
    SourceSyntax.ATOM -> SyntaxColorSpan(SYNTAX_ATOM_ARGB)
    SourceSyntax.COMMENT -> SyntaxColorSpan(SYNTAX_COMMENT_ARGB)
    SourceSyntax.ESCAPE -> SyntaxColorSpan(SYNTAX_ESCAPE_ARGB)
}

private class SyntaxUnderlineSpan : UnderlineSpan(), LivePreviewSpan

private class SyntaxBoldSpan : StyleSpan(Typeface.BOLD), LivePreviewSpan

private class SyntaxItalicSpan : StyleSpan(Typeface.ITALIC), LivePreviewSpan

private class SyntaxColorSpan(color: Int) : ForegroundColorSpan(color), LivePreviewSpan

private fun paintBracket(editable: Editable, index: Int, color: Int, length: Int) {
    val from = index.coerceIn(0, length)
    val to = (from + 1).coerceAtMost(length)
    if (from == to) return
    editable.setSpan(BracketMatchSpan(color), from, to, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
}

private fun hasComposingSpan(editable: Editable): Boolean {
    for (span in editable.getSpans(0, editable.length, Any::class.java)) {
        if (editable.getSpanFlags(span) and Spanned.SPAN_COMPOSING != 0) return true
    }
    return false
}

private fun spanFor(
    mark: LiveMark,
    readable: Int,
    accent: Int,
    textSizePx: Float,
    images: Map<String, Bitmap>,
    imageColumnPx: Float,
): Any = when (mark.kind) {
    LiveKind.HIDE -> HideSpan()
    LiveKind.COLLAPSE -> CollapseSpan()
    LiveKind.BULLET -> AccentSwapSpan("• ", readable)
    LiveKind.TASK_OPEN -> TaskSpan(false, readable, textSizePx)
    LiveKind.TASK_DONE -> TaskSpan(true, readable, textSizePx)
    LiveKind.H1 -> HeadingSpan(1, textSizePx)
    LiveKind.H2 -> HeadingSpan(2, textSizePx)
    LiveKind.H3 -> HeadingSpan(3, textSizePx)
    LiveKind.H4 -> HeadingSpan(4, textSizePx)
    LiveKind.H5 -> HeadingSpan(5, textSizePx)
    LiveKind.H6 -> HeadingSpan(6, textSizePx)
    LiveKind.QUOTE -> PaperQuoteSpan(readable, quoteWashArgb(accent), textSizePx)
    LiveKind.STRONG -> StrongSpan()
    LiveKind.EMPHASIS -> EmphasisSpan()
    LiveKind.STRIKE -> StrikeSpan()
    LiveKind.CODE -> PaperCodeSpan(paperCodeInkArgb(accent), textSizePx)
    LiveKind.CODE_FENCE -> CodeFenceSpan()
    LiveKind.MATH -> PaperInlineMathSpan(textSizePx)
    LiveKind.MATH_BLOCK -> PaperMathBlockSpan(mark.label, paperMathFillArgb(accent), paperMathBorderArgb(accent), textSizePx)
    LiveKind.LINK -> LinkSpan(readable, textSizePx)
    LiveKind.DETAILS_SUMMARY -> DetailsSummarySpan(
        mark.label,
        mark.body,
        mark.open,
        mark.continues,
        paperDetailsFillArgb(),
        paperDetailsOpenFillArgb(accent),
        readable,
        textSizePx,
        mark.readingScales,
        mark.readingHeadings,
        mark.readingKinds,
        mark.readingSources,
        mark.readingInlines,
        images,
        imageColumnPx,
    )
    LiveKind.DETAILS_BODY -> DetailsBodySpan(paperDetailsFillArgb(), textSizePx, false)
    LiveKind.DETAILS_END -> DetailsBodySpan(paperDetailsFillArgb(), textSizePx, true)
    LiveKind.TABLE_ROW -> TableRowSpan(paperTableFillArgb(accent), textSizePx)
    LiveKind.TABLE_RULE -> TableRuleSpan(textSizePx)
    LiveKind.RULE -> PaperThematicRuleSpan(textSizePx)
}

/**
 * Desktop paper details card: a rounded panel, a chevron, and „Bearbeiten“.
 * An open block keeps the summary band washed and lets the body continue below.
 */
internal class DetailsSummarySpan(
    private val summary: String,
    private val body: String,
    private val open: Boolean,
    private val continues: Boolean,
    private val fill: Int,
    private val openFill: Int,
    private val accent: Int,
    private val textSizePx: Float,
    private val readingScales: List<Float> = emptyList(),
    private val readingHeadings: List<Boolean> = emptyList(),
    private val readingKinds: List<String> = emptyList(),
    private val readingSources: List<String> = emptyList(),
    private val readingInlines: List<List<DetailsInline>> = emptyList(),
    private val images: Map<String, Bitmap> = emptyMap(),
    private val imageColumnPx: Float = 0f,
) : ReplacementSpan(), LineBackgroundSpan, LivePreviewSpan {
    private val linkHits = ArrayList<Pair<RectF, String>>()

    fun linkAt(x: Float, y: Float): ch.fasrv.fanotes.desk.FollowedLink? {
        val target = linkHits.firstOrNull { (rect, _) ->
            x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
        }?.second ?: return null
        return followedTarget(target)
    }

    override fun getSize(paint: Paint, text: CharSequence, start: Int, end: Int, fm: Paint.FontMetricsInt?): Int {
        val box = paperDetailsBox(textSizePx)
        val metrics = paint.fontMetrics
        val textHeight = -metrics.ascent + metrics.descent
        val bodyLines = if (body.isEmpty()) emptyList() else body.split('\n')
        val bodyExtra = bodyBlockHeight(paint, bodyLines, box.padY)
        val total = box.marginY * 2f + box.padY * 2f + textHeight + bodyExtra
        if (fm != null) {
            val half = (total / 2f).toInt().coerceAtLeast(1)
            fm.ascent = -half
            fm.descent = half
            fm.top = fm.ascent
            fm.bottom = fm.descent
        }
        return (paint.measureText(summary) + box.padX + textSizePx * 7f).toInt().coerceAtLeast(1)
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
        val box = paperDetailsBox(textSizePx)
        val contentTop = top + box.marginY
        val contentBottom = bottom - box.marginY
        if (contentBottom <= contentTop) return
        val rect = RectF(left + box.border, contentTop, right - box.border, contentBottom)
        val previousColor = paint.color
        val previousStyle = paint.style
        val previousStroke = paint.strokeWidth
        val previousFace = paint.typeface
        val previousSize = paint.textSize
        paint.style = Paint.Style.FILL
        paint.color = fill
        canvas.drawRoundRect(rect, box.radius, box.radius, paint)
        if (continues) {
            canvas.drawRect(rect.left, rect.bottom - box.radius, rect.right, rect.bottom, paint)
        }
        val metrics = paint.fontMetrics
        val textHeight = -metrics.ascent + metrics.descent
        val summaryBottom = contentTop + box.padY * 2f + textHeight
        if (open) {
            val washBottom = if (body.isEmpty()) contentBottom.coerceAtMost(summaryBottom) else summaryBottom.coerceAtMost(contentBottom)
            paint.color = openFill
            canvas.drawRect(rect.left, rect.top, rect.right, washBottom, paint)
            paint.color = PAPER_RULE_ARGB
            canvas.drawRect(rect.left, washBottom - box.border, rect.right, washBottom, paint)
        }
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = box.border
        paint.color = PAPER_RULE_STRONG_ARGB
        canvas.drawRoundRect(rect, box.radius, box.radius, paint)
        paint.style = Paint.Style.FILL
        paint.color = PAPER_MATH_INK
        paint.typeface = Typeface.create(previousFace, Typeface.BOLD)
        val summaryBaseline = contentTop + box.padY - metrics.ascent
        canvas.drawText(summary, rect.left + box.padX, summaryBaseline, paint)
        if (body.isNotEmpty()) {
            linkHits.clear()
            var cursor = summaryBottom + box.padY * 0.35f
            body.split('\n').forEachIndexed { index, line ->
                val picture = imageSlot(index)
                if (picture != null) {
                    val margin = detailsImageMargin(previousSize)
                    val (frameW, frameH) = detailsImageFrame(picture.width, picture.height, imageColumnPx)
                    val available = (rect.right - box.padX) - (rect.left + box.padX)
                    val drawnW = frameW.coerceAtMost(available.coerceAtLeast(1f))
                    val drawnH = if (frameW > 0f) frameH * (drawnW / frameW) else frameH
                    val left = rect.left + box.padX + ((available - drawnW) / 2f).coerceAtLeast(0f)
                    cursor += margin
                    drawDetailsImage(canvas, paint, picture, left, cursor, drawnW, drawnH, box.border)
                    cursor += frameH + margin
                    return@forEachIndexed
                }
                val lineInlines = readingInlines.getOrElse(index) { emptyList() }
                val scale = readingScales.getOrElse(index) { 1f }
                val heading = readingHeadings.getOrElse(index) { false }
                val kind = readingKinds.getOrElse(index) { "paragraph" }
                paint.textSize = previousSize * scale
                paint.typeface = when (kind) {
                    "code", "math" -> Typeface.MONOSPACE
                    else -> Typeface.create(previousFace, if (heading) Typeface.BOLD else Typeface.NORMAL)
                }
                val lineMetrics = paint.fontMetrics
                cursor += -lineMetrics.ascent
                val textX = rect.left + box.padX
                when (kind) {
                    "rule" -> {
                        paint.color = PAPER_RULE_ARGB
                        val ruleY = cursor - lineMetrics.descent
                        canvas.drawRect(textX, ruleY, rect.right - box.padX, ruleY + box.border, paint)
                        paint.color = PAPER_MATH_INK
                    }
                    "quote" -> {
                        paint.color = accent
                        canvas.drawRect(textX, cursor + lineMetrics.ascent, textX + box.border * 2f, cursor + lineMetrics.descent, paint)
                        paint.color = PAPER_MATH_INK
                        drawRichText(canvas, paint, line, textX + previousSize * 0.7f, cursor, lineInlines, paint.typeface)
                    }
                    "bullet" -> {
                        val indent = ch.fasrv.fanotes.desk.detailsListIndent(line)
                        val mark = "• "
                        val indentWidth = if (indent.isEmpty()) 0f else paint.measureText(indent)
                        paint.color = accent
                        canvas.drawText(mark, textX + indentWidth, cursor, paint)
                        paint.color = PAPER_MATH_INK
                        val rest = line.removePrefix(indent).removePrefix(mark)
                        drawRichText(
                            canvas,
                            paint,
                            rest,
                            textX + indentWidth + paint.measureText(mark),
                            cursor,
                            shiftInlines(lineInlines, indent.length + mark.length),
                            paint.typeface,
                        )
                    }
                    "number" -> {
                        val indent = ch.fasrv.fanotes.desk.detailsListIndent(line)
                        val marker = ch.fasrv.fanotes.desk.detailsNumberMarker(line)
                        val indentWidth = if (indent.isEmpty()) 0f else paint.measureText(indent)
                        paint.color = accent
                        if (marker.isNotEmpty()) canvas.drawText(marker, textX + indentWidth, cursor, paint)
                        paint.color = PAPER_MATH_INK
                        val prefix = indent + marker
                        val rest = if (prefix.isEmpty()) line else line.removePrefix(prefix)
                        val markerWidth = if (marker.isEmpty()) 0f else paint.measureText(marker)
                        drawRichText(
                            canvas,
                            paint,
                            rest,
                            textX + indentWidth + markerWidth,
                            cursor,
                            shiftInlines(lineInlines, prefix.length),
                            paint.typeface,
                        )
                    }
                    "task" -> {
                        val indent = ch.fasrv.fanotes.desk.detailsListIndent(line)
                        val marker = ch.fasrv.fanotes.desk.detailsTaskMarker(line)
                        val checked = ch.fasrv.fanotes.desk.detailsTaskChecked(line) == true
                        val indentWidth = if (indent.isEmpty()) 0f else paint.measureText(indent)
                        val task = paperTaskBox(previousSize)
                        val mid = cursor + (lineMetrics.ascent + lineMetrics.descent) / 2f
                        val taskRect = RectF(
                            textX + indentWidth,
                            mid - task.size / 2f,
                            textX + indentWidth + task.size,
                            mid + task.size / 2f,
                        )
                        drawPaperTaskBox(canvas, paint, taskRect, checked, accent, task.border)
                        paint.color = PAPER_MATH_INK
                        paint.style = Paint.Style.FILL
                        val prefix = indent + marker
                        val rest = if (prefix.isEmpty()) line else line.removePrefix(prefix)
                        drawRichText(
                            canvas,
                            paint,
                            rest,
                            textX + indentWidth + task.size + task.gap,
                            cursor,
                            shiftInlines(lineInlines, prefix.length),
                            paint.typeface,
                        )
                    }
                    "table" -> {
                        val cells = line.split('\u001f')
                        val count = cells.size.coerceAtLeast(1)
                        val span = ((rect.right - box.padX) - textX) / count
                        val top = cursor + lineMetrics.ascent
                        val bottom = cursor + lineMetrics.descent
                        val alignLine = readingSources.getOrElse(index) { "" }
                        val pad = previousSize * 0.25f
                        cells.forEachIndexed { cellIndex, cell ->
                            val left = textX + cellIndex * span
                            if (heading) {
                                paint.style = Paint.Style.FILL
                                paint.color = PAPER_DETAILS_BUTTON
                                canvas.drawRect(left, top, left + span, bottom, paint)
                            }
                            paint.style = Paint.Style.STROKE
                            paint.strokeWidth = box.border
                            paint.color = PAPER_RULE_ARGB
                            canvas.drawRect(left, top, left + span, bottom, paint)
                            paint.style = Paint.Style.FILL
                            paint.color = PAPER_MATH_INK
                            val marks = cellInlines(lineInlines, cells, cellIndex)
                            val face = paint.typeface
                            val width = drawRichText(canvas, paint, cell, 0f, cursor, marks, face, measureOnly = true)
                            val origin = tableCellOrigin(tableAlignAt(alignLine, cellIndex), left, span, width, pad)
                            drawRichText(canvas, paint, cell, origin, cursor, marks, face)
                        }
                    }
                    else -> drawRichText(canvas, paint, line, textX, cursor, lineInlines, paint.typeface)
                }
                cursor += lineMetrics.descent
            }
        }
        drawEditButton(canvas, paint, rect, contentTop, box.border)
        drawChevron(canvas, paint, rect, summaryBaseline, open)
        paint.color = previousColor
        paint.style = previousStyle
        paint.strokeWidth = previousStroke
        paint.typeface = previousFace
        paint.textSize = previousSize
    }

    private fun bodyBlockHeight(paint: Paint, lines: List<String>, padY: Float): Float {
        if (lines.isEmpty()) return 0f
        val saved = paint.textSize
        var height = padY * 0.35f
        lines.forEachIndexed { index, _ ->
            val picture = imageSlot(index)
            if (picture != null) {
                val margin = detailsImageMargin(saved)
                val frame = detailsImageFrame(picture.width, picture.height, imageColumnPx)
                height += margin + frame.second + margin
            } else {
                paint.textSize = saved * readingScales.getOrElse(index) { 1f }
                val metrics = paint.fontMetrics
                height += -metrics.ascent + metrics.descent
            }
        }
        paint.textSize = saved
        return height
    }

    private fun rememberLink(active: List<DetailsInline>, left: Float, width: Float, baseline: Float, paint: Paint) {
        val target = active.firstOrNull { it.kind == "link" && it.target.isNotEmpty() }?.target ?: return
        if (width <= 0f) return
        val metrics = paint.fontMetrics
        linkHits += RectF(left, baseline + metrics.ascent, left + width, baseline + metrics.descent) to target
    }

    private fun shiftInlines(marks: List<DetailsInline>, by: Int): List<DetailsInline> {
        if (by == 0) return marks
        return marks.mapNotNull { mark ->
            val end = mark.end - by
            if (end <= 0) return@mapNotNull null
            mark.copy(start = (mark.start - by).coerceAtLeast(0), end = end)
        }
    }

    private fun cellInlines(marks: List<DetailsInline>, cells: List<String>, index: Int): List<DetailsInline> {
        var origin = 0
        for (cell in 0 until index) origin += cells[cell].length + 1
        val end = origin + cells.getOrElse(index) { "" }.length
        return marks.mapNotNull { mark ->
            if (mark.end <= origin || mark.start >= end) return@mapNotNull null
            mark.copy(
                start = (mark.start - origin).coerceAtLeast(0),
                end = (mark.end - origin).coerceAtMost(end - origin),
            )
        }.filter { it.end > it.start }
    }

    private fun drawRichText(
        canvas: Canvas,
        paint: Paint,
        text: String,
        x: Float,
        y: Float,
        marks: List<DetailsInline>,
        baseFace: Typeface?,
        measureOnly: Boolean = false,
    ): Float {
        if (text.isEmpty()) return x
        if (marks.isEmpty()) {
            if (!measureOnly) canvas.drawText(text, x, y, paint)
            return x + paint.measureText(text)
        }
        val cuts = sortedSetOf(0, text.length)
        for (mark in marks) {
            if (mark.start in 0..text.length) cuts += mark.start
            if (mark.end in 0..text.length) cuts += mark.end
        }
        val points = cuts.toList()
        val baseColor = paint.color
        val baseSize = paint.textSize
        val baseStrike = paint.isStrikeThruText
        var cursor = x
        for (index in 0 until points.size - 1) {
            val from = points[index]
            val to = points[index + 1]
            if (to <= from) continue
            val segment = text.substring(from, to)
            val active = marks.filter { it.start < to && it.end > from }
            val strong = active.any { it.kind == "strong" }
            val emphasis = active.any { it.kind == "emphasis" }
            val code = active.any { it.kind == "code" }
            val math = active.any { it.kind == "math" }
            val strike = active.any { it.kind == "strike" }
            val link = active.any { it.kind == "link" }
            val bold = strong || ((baseFace?.style ?: 0) and Typeface.BOLD) != 0
            paint.isStrikeThruText = strike
            paint.typeface = when {
                code -> Typeface.MONOSPACE
                bold && emphasis -> Typeface.create(baseFace, Typeface.BOLD_ITALIC)
                bold -> Typeface.create(baseFace, Typeface.BOLD)
                emphasis -> Typeface.create(baseFace, Typeface.ITALIC)
                else -> baseFace
            }
            if (math && !code) {
                paint.textSize = baseSize
                paint.style = Paint.Style.FILL
                paint.color = PAPER_MATH_INK
                val formula = layoutDisplayMath(segment)
                val pad = paperMathInlinePad(baseSize)
                if (!measureOnly) drawMath(canvas, paint, formula, cursor + pad, y + baseSize * 0.08f, baseSize)
                val width = measureMath(paint, formula, baseSize).width + pad * 2f
                if (!measureOnly) rememberLink(active, cursor, width, y, paint)
                cursor += width
            } else if (code) {
                val box = paperCodeBox(baseSize)
                paint.textSize = box.textPx
                val width = paint.measureText(segment)
                val metrics = paint.fontMetrics
                val rect = RectF(cursor, y + metrics.ascent - box.padY, cursor + width + box.padX * 2f, y + metrics.descent + box.padY)
                if (!measureOnly) {
                    paint.style = Paint.Style.FILL
                    paint.color = PAPER_CODE_BACKGROUND
                    canvas.drawRoundRect(rect, box.radius, box.radius, paint)
                    paint.style = Paint.Style.STROKE
                    paint.strokeWidth = box.border
                    paint.color = PAPER_RULE_ARGB
                    canvas.drawRoundRect(rect, box.radius, box.radius, paint)
                    paint.style = Paint.Style.FILL
                    paint.color = paperCodeInkArgb(accent)
                    canvas.drawText(segment, cursor + box.padX, y, paint)
                    rememberLink(active, cursor, width + box.padX * 2f, y, paint)
                }
                cursor += width + box.padX * 2f
            } else {
                paint.textSize = baseSize
                paint.style = Paint.Style.FILL
                paint.color = if (link) accent else baseColor
                val width = paint.measureText(segment)
                if (!measureOnly) {
                    canvas.drawText(segment, cursor, y, paint)
                    if (link) {
                        val offset = paperLinkUnderlineOffset(textSizePx)
                        val thickness = (textSizePx / 16f).coerceAtLeast(1f)
                        paint.color = paperLinkUnderlineArgb(accent)
                        canvas.drawRect(cursor, y + offset, cursor + width, y + offset + thickness, paint)
                        rememberLink(active, cursor, width, y, paint)
                    }
                }
                cursor += width
            }
        }
        paint.textSize = baseSize
        paint.color = baseColor
        paint.typeface = baseFace
        paint.isStrikeThruText = baseStrike
        paint.style = Paint.Style.FILL
        return cursor
    }

    private fun imageSlot(index: Int): Bitmap? {
        if (imageColumnPx <= 0f || readingKinds.getOrElse(index) { "" } != "image") return null
        val source = readingSources.getOrElse(index) { "" }
        if (source.isEmpty()) return null
        return images[source]?.takeIf { !it.isRecycled }
    }

    private fun drawDetailsImage(
        canvas: Canvas,
        paint: Paint,
        bitmap: Bitmap,
        left: Float,
        top: Float,
        frameW: Float,
        frameH: Float,
        border: Float,
    ) {
        val dest = RectF(left, top, left + frameW, top + frameH)
        val radius = detailsImageRadius(textSizePx)
        val previousFlags = paint.flags
        paint.style = Paint.Style.FILL
        paint.color = Color.WHITE
        canvas.drawRoundRect(dest, radius, radius, paint)
        canvas.save()
        canvas.clipPath(Path().apply { addRoundRect(dest, radius, radius, Path.Direction.CW) })
        paint.flags = previousFlags or Paint.FILTER_BITMAP_FLAG
        canvas.drawBitmap(bitmap, null, dest, paint)
        canvas.restore()
        paint.flags = previousFlags
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = border
        paint.color = PAPER_RULE_ARGB
        canvas.drawRoundRect(dest, radius, radius, paint)
        paint.style = Paint.Style.FILL
        paint.color = PAPER_MATH_INK
    }

    private fun drawEditButton(canvas: Canvas, paint: Paint, rect: RectF, contentTop: Float, border: Float) {
        paint.textSize = textSizePx * 0.75f
        val label = "Bearbeiten"
        val width = paint.measureText(label) + textSizePx * 0.7f
        val height = textSizePx * 1.35f
        val right = rect.right - textSizePx * 2.6f
        val button = RectF(right - width, contentTop + textSizePx * 0.28f, right, contentTop + textSizePx * 0.28f + height)
        paint.style = Paint.Style.FILL
        paint.color = PAPER_DETAILS_BUTTON
        canvas.drawRoundRect(button, textSizePx * 0.4f, textSizePx * 0.4f, paint)
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = border
        paint.color = PAPER_RULE_ARGB
        canvas.drawRoundRect(button, textSizePx * 0.4f, textSizePx * 0.4f, paint)
        paint.style = Paint.Style.FILL
        paint.color = PAPER_QUOTE_INK
        paint.typeface = Typeface.create(paint.typeface, Typeface.NORMAL)
        val baseline = button.centerY() - (paint.fontMetrics.ascent + paint.fontMetrics.descent) / 2f
        canvas.drawText(label, button.left + textSizePx * 0.35f, baseline, paint)
    }

    private fun drawChevron(canvas: Canvas, paint: Paint, rect: RectF, baseline: Float, opened: Boolean) {
        paint.style = Paint.Style.FILL
        paint.color = accent
        paint.textSize = textSizePx * 1.25f
        paint.typeface = Typeface.create(paint.typeface, Typeface.NORMAL)
        val label = "›"
        val width = paint.measureText(label)
        val cx = rect.right - textSizePx * 0.9f - width / 2f
        val cy = baseline + (paint.fontMetrics.ascent + paint.fontMetrics.descent) / 2f
        canvas.save()
        canvas.rotate(if (opened) -90f else 90f, cx, cy)
        canvas.drawText(label, cx - width / 2f, baseline, paint)
        canvas.restore()
    }
}

internal class DetailsBodySpan(
    private val fill: Int,
    private val textSizePx: Float,
    private val close: Boolean,
) : LineBackgroundSpan, LeadingMarginSpan, LivePreviewSpan {
    override fun getLeadingMargin(first: Boolean) = paperDetailsBox(textSizePx).padX.toInt()

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
        val box = paperDetailsBox(textSizePx)
        val rect = RectF(left + box.border, top.toFloat(), right - box.border, bottom.toFloat())
        val previousColor = paint.color
        val previousStyle = paint.style
        val previousStroke = paint.strokeWidth
        paint.style = Paint.Style.FILL
        paint.color = fill
        if (close) {
            canvas.drawRoundRect(rect, box.radius, box.radius, paint)
            canvas.drawRect(rect.left, rect.top, rect.right, (rect.top + box.radius).coerceAtMost(rect.bottom), paint)
        } else {
            canvas.drawRect(rect, paint)
        }
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = box.border
        paint.color = PAPER_RULE_STRONG_ARGB
        canvas.drawLine(rect.left, rect.top, rect.left, rect.bottom, paint)
        canvas.drawLine(rect.right, rect.top, rect.right, rect.bottom, paint)
        if (close) canvas.drawLine(rect.left, rect.bottom, rect.right, rect.bottom, paint)
        paint.color = previousColor
        paint.style = previousStyle
        paint.strokeWidth = previousStroke
    }
}

private const val PAPER_DETAILS_BUTTON = 0xFFFAFAFD.toInt()

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

/**
 * Desktop paper task box: a 15px control, 7px before the words, filled with
 * the readable accent when the task is done.
 */
internal class TaskSpan(
    private val checked: Boolean,
    private val accent: Int,
    private val textSizePx: Float,
) : ReplacementSpan(), LivePreviewSpan {
    override fun getSize(paint: Paint, text: CharSequence, start: Int, end: Int, fm: Paint.FontMetricsInt?): Int {
        val box = paperTaskBox(textSizePx)
        return (box.size + box.gap).toInt().coerceAtLeast(1)
    }

    override fun draw(canvas: Canvas, text: CharSequence, start: Int, end: Int, x: Float, top: Int, y: Int, bottom: Int, paint: Paint) {
        val box = paperTaskBox(textSizePx)
        val mid = (top + bottom) / 2f
        val rect = RectF(x, mid - box.size / 2f, x + box.size, mid + box.size / 2f)
        drawPaperTaskBox(canvas, paint, rect, checked, accent, box.border)
    }
}

internal fun drawPaperTaskBox(canvas: Canvas, paint: Paint, rect: RectF, checked: Boolean, accent: Int, border: Float) {
    val radius = rect.width() * 0.22f
    val previousColor = paint.color
    val previousStyle = paint.style
    val previousStroke = paint.strokeWidth
    val previousCap = paint.strokeCap
    if (checked) {
        paint.style = Paint.Style.FILL
        paint.color = accent
        canvas.drawRoundRect(rect, radius, radius, paint)
        paint.color = 0xFFFFFFFF.toInt()
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = (border * 1.6f).coerceAtLeast(1.5f)
        paint.strokeCap = Paint.Cap.ROUND
        val left = rect.left + rect.width() * 0.22f
        val right = rect.right - rect.width() * 0.22f
        val midY = rect.centerY() + rect.height() * 0.08f
        canvas.drawLine(left, midY, left + rect.width() * 0.22f, midY + rect.height() * 0.18f, paint)
        canvas.drawLine(left + rect.width() * 0.22f, midY + rect.height() * 0.18f, right, midY - rect.height() * 0.22f, paint)
    } else {
        paint.style = Paint.Style.FILL
        paint.color = 0xFFFFFFFF.toInt()
        canvas.drawRoundRect(rect, radius, radius, paint)
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = border
        paint.color = 0xFF6D7180.toInt()
        canvas.drawRoundRect(rect, radius, radius, paint)
    }
    paint.color = previousColor
    paint.style = previousStyle
    paint.strokeWidth = previousStroke
    paint.strokeCap = previousCap
}

internal class AccentSwapSpan(drawn: String, private val color: Int) : SwapSpan(drawn) {
    override fun draw(canvas: Canvas, text: CharSequence, start: Int, end: Int, x: Float, top: Int, y: Int, bottom: Int, paint: Paint) {
        val previousColor = paint.color
        val previousFace = paint.typeface
        paint.color = color
        paint.typeface = Typeface.create(previousFace, PAPER_BULLET_WEIGHT, false)
        super.draw(canvas, text, start, end, x, top, y, bottom, paint)
        paint.color = previousColor
        paint.typeface = previousFace
    }
}

private class SpecialCharSpan(placeholder: String) : SwapSpan(placeholder) {
    override fun draw(canvas: Canvas, text: CharSequence, start: Int, end: Int, x: Float, top: Int, y: Int, bottom: Int, paint: Paint) {
        val previous = paint.color
        paint.color = SPECIAL_CHAR_ARGB
        super.draw(canvas, text, start, end, x, top, y, bottom, paint)
        paint.color = previous
    }
}

private class BracketMatchSpan(color: Int) : BackgroundColorSpan(color), LivePreviewSpan

private class SelectionMatchSpan : BackgroundColorSpan(0x8099FF77.toInt()), LivePreviewSpan

private class CollapseSpan : LineHeightSpan, LivePreviewSpan {
    override fun chooseHeight(text: CharSequence, start: Int, end: Int, spanstartv: Int, lineHeight: Int, fm: Paint.FontMetricsInt) {
        fm.ascent = 0
        fm.descent = 0
        fm.top = 0
        fm.bottom = 0
    }
}

internal class HeadingSpan(private val level: Int, private val baseTextPx: Float) :
    MetricAffectingSpan(), LineHeightSpan, LineBackgroundSpan, LivePreviewSpan {
    override fun updateDrawState(paint: android.text.TextPaint) = apply(paint)
    override fun updateMeasureState(paint: android.text.TextPaint) = apply(paint)

    private fun apply(paint: android.text.TextPaint) {
        val heading = paperHeading(level, baseTextPx)
        paint.textSize *= heading.scale
        paint.letterSpacing = heading.letterSpacing
        paint.typeface = Typeface.create(paint.typeface, 720, false)
    }

    override fun chooseHeight(text: CharSequence, start: Int, end: Int, spanstartv: Int, lineHeight: Int, fm: Paint.FontMetricsInt) {
        val heading = paperHeading(level, baseTextPx)
        val top = kotlin.math.round(heading.padTop).toInt()
        val bottom = kotlin.math.round(heading.padBottom).toInt()
        if (top == 0 && bottom == 0) return
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
        if (level != 1 || right <= left) return
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

internal class StrongSpan : MetricAffectingSpan(), LivePreviewSpan {
    override fun updateDrawState(paint: android.text.TextPaint) = apply(paint)
    override fun updateMeasureState(paint: android.text.TextPaint) = apply(paint)

    private fun apply(paint: android.text.TextPaint) {
        paint.typeface = Typeface.create(paint.typeface, PAPER_STRONG_WEIGHT, false)
    }
}

private class EmphasisSpan : StyleSpan(Typeface.ITALIC), LivePreviewSpan

/** Struck text uses the paper's soft ink, not the body colour. */
internal class StrikeSpan : CharacterStyle(), LivePreviewSpan {
    override fun updateDrawState(paint: android.text.TextPaint) {
        paint.color = PAPER_QUOTE_INK
        paint.isStrikeThruText = true
    }
}
/**
 * Desktop paper inline code: a rounded chip, a hairline rule, monospace
 * at 0.9em, and ink mixed from the readable accent.
 */
/**
 * A fenced code block off the caret: monospace at 0.9em on the paper code fill.
 * The fence characters stay so the block can still be recognised.
 */
internal class CodeFenceSpan : MetricAffectingSpan(), LineBackgroundSpan, LivePreviewSpan {
    override fun updateDrawState(paint: android.text.TextPaint) = apply(paint)
    override fun updateMeasureState(paint: android.text.TextPaint) = apply(paint)

    private fun apply(paint: android.text.TextPaint) {
        paint.textSize *= 0.9f
        paint.typeface = Typeface.MONOSPACE
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
        paint.color = PAPER_CODE_BACKGROUND
        canvas.drawRect(left.toFloat(), top.toFloat(), right.toFloat(), bottom.toFloat(), paint)
        paint.color = previous
    }
}

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

/**
 * Desktop paper link: readable accent, with the underline at 38% of that
 * colour and 3px below the baseline.
 */
internal class LinkSpan(private val color: Int, private val textSizePx: Float) : ReplacementSpan(), LivePreviewSpan {
    override fun getSize(paint: Paint, text: CharSequence, start: Int, end: Int, fm: Paint.FontMetricsInt?): Int {
        val extra = (paperLinkUnderlineOffset(textSizePx) + (textSizePx / 16f).coerceAtLeast(1f)).toInt()
        if (fm != null) {
            fm.descent += extra
            fm.bottom += extra
        }
        return paint.measureText(text, start, end).toInt().coerceAtLeast(1)
    }

    override fun draw(canvas: Canvas, text: CharSequence, start: Int, end: Int, x: Float, top: Int, y: Int, bottom: Int, paint: Paint) {
        val previousColor = paint.color
        val previousStyle = paint.style
        paint.style = Paint.Style.FILL
        paint.color = color
        canvas.drawText(text, start, end, x, y.toFloat(), paint)
        val width = paint.measureText(text, start, end)
        val offset = paperLinkUnderlineOffset(textSizePx)
        val thickness = (textSizePx / 16f).coerceAtLeast(1f)
        paint.color = paperLinkUnderlineArgb(color)
        canvas.drawRect(x, y + offset, x + width, y + offset + thickness, paint)
        paint.color = previousColor
        paint.style = previousStyle
    }
}
