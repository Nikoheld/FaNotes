package ch.fasrv.fanotes

import android.graphics.Canvas
import android.graphics.Color
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import ch.fasrv.fanotes.desk.ChromeText
import ch.fasrv.fanotes.study.LABEL_PLACEHOLDER
import ch.fasrv.fanotes.study.LABEL_PLACEHOLDER_NUMBERED
import ch.fasrv.fanotes.study.LEGEND_EMPTY
import ch.fasrv.fanotes.study.LEGEND_TITLE
import ch.fasrv.fanotes.study.MEASURE_DISTANCE
import ch.fasrv.fanotes.study.PageBox
import ch.fasrv.fanotes.study.SPoint
import ch.fasrv.fanotes.study.SRect
import ch.fasrv.fanotes.study.StudyAnnotation
import ch.fasrv.fanotes.study.StudyCallout
import ch.fasrv.fanotes.study.StudyImage
import ch.fasrv.fanotes.study.StudyLegend
import ch.fasrv.fanotes.study.StudyMeasure
import ch.fasrv.fanotes.study.StudyMetrics
import ch.fasrv.fanotes.study.StudyStamp
import ch.fasrv.fanotes.study.StudyStroke
import ch.fasrv.fanotes.study.StudyTool
import ch.fasrv.fanotes.study.TextMeasurer
import ch.fasrv.fanotes.study.calloutLabelRect
import ch.fasrv.fanotes.study.calloutShowsText
import ch.fasrv.fanotes.study.formatMeasure
import ch.fasrv.fanotes.study.imageRect
import ch.fasrv.fanotes.study.legendLayout
import ch.fasrv.fanotes.study.measureCentre
import ch.fasrv.fanotes.study.measureLabelRect
import ch.fasrv.fanotes.study.measureScreenPoints
import ch.fasrv.fanotes.study.measureSegments
import ch.fasrv.fanotes.study.measureValue
import ch.fasrv.fanotes.study.pageOrNull
import ch.fasrv.fanotes.study.pageSizeCm
import ch.fasrv.fanotes.study.stampById
import ch.fasrv.fanotes.study.stampFontPx
import ch.fasrv.fanotes.study.strokeWidthPx
import kotlin.math.hypot

/** Points collected so far for a multi-tap measure, in page fractions. */
data class StudyPending(val tool: StudyTool, val page: Int, val pts: List<SPoint>)

/** What the pen is dragging right now (not yet an annotation). */
sealed class StudyLive {
    data class Branch(val page: Int, val pts: List<SPoint>, val color: String, val width: Double) : StudyLive()
    data class Leader(val page: Int, val a: SPoint, val b: SPoint, val color: String) : StudyLive()
    /** The PDF-Ausschnitt rectangle, in page fractions. */
    data class Crop(val page: Int, val rect: SRect) : StudyLive()
}

/**
 * Draws study annotations the way `StudyAnnotationLayer.tsx` + `styles.css` do: images under
 * everything, then leader lines / branch strokes / measures (the SVG layer), then stamps,
 * label boxes and legends (the HTML layer). All sizes come from `StudyMetrics` and scale with the
 * page, so the picture is the same at every zoom.
 */
class StudyPainter(private val images: StudyImageCache, private val accent: () -> Int) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val text = Paint(Paint.ANTI_ALIAS_FLAG)
    private val path = Path()
    private val rect = RectF()

    val measurer = TextMeasurer { value, fontPx, bold ->
        text.typeface = if (bold) BOLD else Typeface.DEFAULT
        text.textSize = fontPx.toFloat()
        text.measureText(value).toDouble()
    }

    private fun parse(value: String) = try { Color.parseColor(value) } catch (_: IllegalArgumentException) { Color.GRAY }

    fun draw(
        canvas: Canvas,
        items: List<StudyAnnotation>,
        boxFor: (Int) -> PageBox?,
        selectedId: String?,
        pending: StudyPending?,
        live: StudyLive?,
    ) {
        if (items.isEmpty() && pending == null && live == null) return
        for (item in items) if (item is StudyImage) boxFor(item.page)?.let { drawImage(canvas, item, it, item.id == selectedId) }
        for (item in items) {
            val box = boxFor(item.pageOrNull() ?: continue) ?: continue
            when (item) {
                is StudyCallout -> drawLeader(canvas, item, box, item.id == selectedId)
                is StudyStroke -> drawStroke(canvas, item, box, item.id == selectedId)
                is StudyMeasure -> drawMeasure(canvas, item, box, item.id == selectedId)
                else -> Unit
            }
        }
        for (item in items) {
            val box = boxFor(item.pageOrNull() ?: continue) ?: continue
            when (item) {
                is StudyStamp -> drawStamp(canvas, item, box, item.id == selectedId)
                is StudyCallout -> drawLabel(canvas, item, box, item.id == selectedId)
                is StudyLegend -> drawLegend(canvas, item, items, box, item.id == selectedId)
                else -> Unit
            }
        }
        drawLive(canvas, live, pending, boxFor)
    }

    private fun line(canvas: Canvas, a: SPoint, b: SPoint, color: Int, width: Float, dashed: Boolean = false) {
        paint.reset()
        paint.isAntiAlias = true
        paint.style = Paint.Style.STROKE
        paint.strokeCap = Paint.Cap.ROUND
        paint.color = color
        paint.strokeWidth = width
        if (dashed) paint.pathEffect = DashPathEffect(floatArrayOf(width * 2, width * 2), 0f)
        canvas.drawLine(a.x.toFloat(), a.y.toFloat(), b.x.toFloat(), b.y.toFloat(), paint)
    }

    private fun dot(canvas: Canvas, x: Double, y: Double, r: Float, fill: Int, stroke: Int, strokeWidth: Float) {
        paint.reset()
        paint.isAntiAlias = true
        paint.style = Paint.Style.FILL
        paint.color = fill
        canvas.drawCircle(x.toFloat(), y.toFloat(), r, paint)
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = strokeWidth
        paint.color = stroke
        canvas.drawCircle(x.toFloat(), y.toFloat(), r, paint)
    }

    private fun drawImage(canvas: Canvas, item: StudyImage, box: PageBox, selected: Boolean) {
        val r = imageRect(item, box)
        rect.set(r.l.toFloat(), r.t.toFloat(), r.r.toFloat(), r.b.toFloat())
        val bitmap = images.get(item, r.w.toInt())
        paint.reset()
        paint.isAntiAlias = true
        paint.isFilterBitmap = true
        paint.alpha = (item.opacity * 255).toInt().coerceIn(0, 255)
        if (bitmap != null) canvas.drawBitmap(bitmap, null, rect, paint)
        else {
            paint.color = Color.argb((item.opacity * 60).toInt(), 120, 120, 120)
            canvas.drawRect(rect, paint)
        }
        if (selected) {
            paint.reset()
            paint.isAntiAlias = true
            paint.style = Paint.Style.STROKE
            paint.strokeWidth = 1.5f * box.k.toFloat().coerceAtLeast(1f)
            paint.color = accent()
            paint.pathEffect = DashPathEffect(floatArrayOf(10f, 8f), 0f)
            canvas.drawRect(rect, paint)
            if (!item.locked) dot(canvas, r.r, r.b, 7f * box.k.toFloat().coerceAtLeast(1f), Color.WHITE, accent(), 2f)
        }
    }

    private fun drawLeader(canvas: Canvas, c: StudyCallout, box: PageBox, selected: Boolean) {
        val k = box.k.toFloat()
        val a = SPoint(box.px(c.ax), box.py(c.ay))
        val l = SPoint(box.px(c.lx), box.py(c.ly))
        val color = parse(c.color)
        if (hypot(a.x - l.x, a.y - l.y) > StudyMetrics.LEADER_MIN * k) line(canvas, a, l, color, StudyMetrics.LEADER_WIDTH.toFloat() * k)
        dot(canvas, a.x, a.y, (if (selected) StudyMetrics.ANCHOR_R_SELECTED else StudyMetrics.ANCHOR_R).toFloat() * k, color, Color.WHITE, 1.5f * k)
    }

    private fun drawStroke(canvas: Canvas, s: StudyStroke, box: PageBox, selected: Boolean) {
        if (s.pts.size < 2) return
        path.reset()
        s.pts.forEachIndexed { i, p ->
            val x = box.px(p.x).toFloat()
            val y = box.py(p.y).toFloat()
            if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
        }
        paint.reset()
        paint.isAntiAlias = true
        paint.style = Paint.Style.STROKE
        paint.strokeCap = Paint.Cap.ROUND
        paint.strokeJoin = Paint.Join.ROUND
        paint.color = parse(s.color)
        paint.alpha = (s.opacity * 255).toInt().coerceIn(0, 255)
        paint.strokeWidth = strokeWidthPx(s, box).toFloat()
        canvas.drawPath(path, paint)
        if (selected) {
            paint.reset()
            paint.isAntiAlias = true
            paint.style = Paint.Style.STROKE
            paint.strokeWidth = 1.5f * box.k.toFloat().coerceAtLeast(1f)
            paint.color = Color.parseColor("#2563eb")
            paint.pathEffect = DashPathEffect(floatArrayOf(10f, 8f), 0f)
            canvas.drawPath(path, paint)
        }
    }

    private fun drawMeasure(canvas: Canvas, m: StudyMeasure, box: PageBox, selected: Boolean) {
        val k = box.k.toFloat()
        val real = measureScreenPoints(m, box)
        val color = parse(m.color)
        for ((a, b) in measureSegments(m)) line(canvas, real[a], real[b], color, 2f * k)
        for (p in real) dot(canvas, p.x, p.y, StudyMetrics.MEASURE_POINT_R.toFloat() * k, Color.WHITE, color, 2f * k)
        val label = formatMeasure(m, measureValue(m, pageSizeCm(box.width, box.height)))
        val r = measureLabelRect(m, box, label)
        box(canvas, r, 4f * k, Color.WHITE, color, (if (selected) 2.5f else 1f) * k)
        text.typeface = BOLD
        text.textSize = StudyMetrics.MEASURE_FONT.toFloat() * k
        text.color = color
        val c = measureCentre(m, real)
        canvas.drawText(label, (c.x + 10 * k).toFloat(), (c.y - 12 * k).toFloat(), text)
    }

    private fun box(canvas: Canvas, r: SRect, radius: Float, fill: Int, stroke: Int, strokeWidth: Float) {
        rect.set(r.l.toFloat(), r.t.toFloat(), r.r.toFloat(), r.b.toFloat())
        paint.reset()
        paint.isAntiAlias = true
        paint.style = Paint.Style.FILL
        paint.color = fill
        canvas.drawRoundRect(rect, radius, radius, paint)
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = strokeWidth
        paint.color = stroke
        canvas.drawRoundRect(rect, radius, radius, paint)
    }

    private fun drawStamp(canvas: Canvas, s: StudyStamp, box: PageBox, selected: Boolean) {
        val def = stampById(s.stamp) ?: return
        val size = stampFontPx(s, box).toFloat()
        val cx = box.px(s.x).toFloat()
        val cy = box.py(s.y).toFloat()
        text.typeface = BOLD
        text.textSize = size
        text.textAlign = Paint.Align.CENTER
        val baseline = cy - (text.ascent() + text.descent()) / 2f
        text.style = Paint.Style.STROKE
        text.strokeWidth = 3f * box.k.toFloat().coerceAtLeast(0.6f)
        text.color = Color.WHITE
        canvas.drawText(def.glyph, cx, baseline, text)
        text.style = Paint.Style.FILL
        text.color = parse(def.color)
        canvas.drawText(def.glyph, cx, baseline, text)
        text.textAlign = Paint.Align.LEFT
        if (selected) {
            paint.reset()
            paint.isAntiAlias = true
            paint.style = Paint.Style.STROKE
            paint.strokeWidth = 1.5f * box.k.toFloat().coerceAtLeast(1f)
            paint.color = accent()
            paint.pathEffect = DashPathEffect(floatArrayOf(8f, 6f), 0f)
            canvas.drawCircle(cx, cy, size * 0.8f, paint)
        }
    }

    private fun drawLabel(canvas: Canvas, c: StudyCallout, box: PageBox, selected: Boolean) {
        val k = box.k.toFloat()
        val r = calloutLabelRect(c, box, selected, measurer)
        val color = parse(c.color)
        if (selected) {
            rect.set((r.l - 3 * k).toFloat(), (r.t - 3 * k).toFloat(), (r.r + 3 * k).toFloat(), (r.b + 3 * k).toFloat())
            paint.reset()
            paint.isAntiAlias = true
            paint.color = (accent() and 0x00FFFFFF) or (0x4D shl 24)
            canvas.drawRoundRect(rect, (StudyMetrics.LABEL_RADIUS + 3).toFloat() * k, (StudyMetrics.LABEL_RADIUS + 3).toFloat() * k, paint)
        }
        box(canvas, r, StudyMetrics.LABEL_RADIUS.toFloat() * k, Color.argb(240, 255, 255, 255), color, StudyMetrics.LABEL_BORDER.toFloat() * k)
        var x = (r.l + (StudyMetrics.LABEL_BORDER + StudyMetrics.LABEL_PAD_X) * k).toFloat()
        if (c.num != null) {
            val rad = (StudyMetrics.BADGE / 2).toFloat() * k
            paint.reset()
            paint.isAntiAlias = true
            paint.color = color
            canvas.drawCircle(x + rad, r.cy.toFloat(), rad, paint)
            text.typeface = BOLD
            text.textSize = 12f * k
            text.color = Color.WHITE
            text.textAlign = Paint.Align.CENTER
            canvas.drawText(c.num.toString(), x + rad, r.cy.toFloat() - (text.ascent() + text.descent()) / 2f, text)
            text.textAlign = Paint.Align.LEFT
            x += 2 * rad + StudyMetrics.BADGE_GAP.toFloat() * k
        }
        if (calloutShowsText(c, selected)) {
            val empty = c.text.isEmpty()
            text.typeface = BOLD
            text.textSize = StudyMetrics.LABEL_FONT.toFloat() * k
            text.color = if (empty) Color.argb(150, Color.red(color), Color.green(color), Color.blue(color)) else color
            val shown = if (empty) ChromeText.ui(if (c.num != null) LABEL_PLACEHOLDER_NUMBERED else LABEL_PLACEHOLDER) else c.text
            canvas.drawText(shown, x, r.cy.toFloat() - (text.ascent() + text.descent()) / 2f, text)
        }
    }

    private fun drawLegend(canvas: Canvas, legend: StudyLegend, all: List<StudyAnnotation>, box: PageBox, selected: Boolean) {
        val k = box.k.toFloat()
        val layout = legendLayout(legend, all, box, measurer)
        val r = layout.rect
        box(canvas, r, 8f * k, Color.argb(242, 255, 255, 255), Color.parseColor("#9ca3af"), 1f * k)
        if (selected) {
            rect.set(r.l.toFloat(), r.t.toFloat(), r.r.toFloat(), r.b.toFloat())
            paint.reset()
            paint.isAntiAlias = true
            paint.style = Paint.Style.STROKE
            paint.strokeWidth = 2f * k.coerceAtLeast(1f)
            paint.color = accent()
            canvas.drawRoundRect(rect, 8f * k, 8f * k, paint)
        }
        val inkColor = Color.parseColor("#20222b")
        val left = (r.l + StudyMetrics.LEGEND_PAD_X * k).toFloat()
        text.typeface = BOLD
        text.textSize = StudyMetrics.LEGEND_FONT.toFloat() * k
        text.color = inkColor
        canvas.drawText(ChromeText.ui(LEGEND_TITLE), left, (r.t + (StudyMetrics.LEGEND_PAD_Y + 13) * k).toFloat(), text)
        if (layout.empty) {
            text.typeface = Typeface.DEFAULT
            text.textSize = 11.5f * k
            text.color = Color.parseColor("#6b7280")
            canvas.drawText(ChromeText.ui(LEGEND_EMPTY), left, (r.t + (StudyMetrics.LEGEND_PAD_Y + StudyMetrics.LEGEND_TITLE_H + 14) * k).toFloat(), text)
            return
        }
        layout.rows.forEachIndexed { i, row ->
            val rr = layout.rowRects[i]
            val baseline = rr.cy.toFloat()
            text.typeface = BOLD
            text.textSize = StudyMetrics.LEGEND_FONT.toFloat() * k
            text.color = parse(row.color)
            canvas.drawText(row.glyph, left, baseline - (text.ascent() + text.descent()) / 2f, text)
            text.typeface = if (row.stamp) Typeface.DEFAULT else Typeface.create(Typeface.DEFAULT, Typeface.ITALIC)
            text.color = inkColor
            canvas.drawText(row.label.ifEmpty { "..." }, left + (StudyMetrics.LEGEND_GLYPH_W + StudyMetrics.LEGEND_ROW_GAP).toFloat() * k, baseline - (text.ascent() + text.descent()) / 2f, text)
        }
    }

    private fun drawLive(canvas: Canvas, live: StudyLive?, pending: StudyPending?, boxFor: (Int) -> PageBox?) {
        when (live) {
            is StudyLive.Branch -> boxFor(live.page)?.let { box ->
                if (live.pts.size < 2) return@let
                path.reset()
                live.pts.forEachIndexed { i, p ->
                    val x = box.px(p.x).toFloat()
                    val y = box.py(p.y).toFloat()
                    if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
                }
                paint.reset()
                paint.isAntiAlias = true
                paint.style = Paint.Style.STROKE
                paint.strokeCap = Paint.Cap.ROUND
                paint.strokeJoin = Paint.Join.ROUND
                paint.color = parse(live.color)
                paint.alpha = (0.4 * 255).toInt()
                paint.strokeWidth = (live.width * box.width / StudyMetrics.STROKE_REF).coerceAtLeast(2.0).toFloat()
                canvas.drawPath(path, paint)
            }
            is StudyLive.Leader -> boxFor(live.page)?.let { box ->
                line(canvas, SPoint(box.px(live.a.x), box.py(live.a.y)), SPoint(box.px(live.b.x), box.py(live.b.y)), parse(live.color), 2f * box.k.toFloat(), dashed = true)
            }
            is StudyLive.Crop -> boxFor(live.page)?.let { box -> drawCrop(canvas, live.rect, box) }
            null -> Unit
        }
        if (pending != null) {
            val box = boxFor(pending.page) ?: return
            val k = box.k.toFloat()
            val red = Color.parseColor("#dc2626")
            val dots = pending.pts.map { SPoint(box.px(it.x), box.py(it.y)) }
            // Same preview as desktop: first leg dashed once the vertex of a 3-point angle is down.
            val segments = when {
                pending.tool == StudyTool.ANGLE && dots.size == 3 -> listOf(1 to 0, 1 to 2)
                pending.tool == StudyTool.ANGLE && dots.size == 2 -> listOf(0 to 1)
                pending.tool == StudyTool.ANGLE_LINES && dots.size >= 2 -> listOf(0 to 1) + if (dots.size == 4) listOf(2 to 3) else emptyList()
                pending.tool == StudyTool.ANGLE_LINES && dots.size == 3 -> listOf(0 to 1)
                else -> if (dots.size == 2) listOf(0 to 1) else emptyList()
            }
            for ((a, b) in segments) line(canvas, dots[a], dots[b], red, 1.5f * k, dashed = true)
            for (d in dots) dot(canvas, d.x, d.y, 5f * k, red, red, 1f)
        }
    }

    /** Dims the page outside the rectangle, outlines it dashed in the accent colour and puts a handle on each corner. */
    private fun drawCrop(canvas: Canvas, r: SRect, box: PageBox) {
        val l = box.px(r.l).toFloat(); val t = box.py(r.t).toFloat()
        val rr = box.px(r.r).toFloat(); val b = box.py(r.b).toFloat()
        val bl = box.left.toFloat(); val bt = box.top.toFloat()
        val br = (box.left + box.width).toFloat(); val bb = (box.top + box.height).toFloat()
        paint.reset()
        paint.style = Paint.Style.FILL
        paint.color = Color.argb(90, 0, 0, 0)
        canvas.drawRect(bl, bt, br, t, paint)
        canvas.drawRect(bl, b, br, bb, paint)
        canvas.drawRect(bl, t, l, b, paint)
        canvas.drawRect(rr, t, br, b, paint)
        val k = box.k.toFloat().coerceAtLeast(0.5f)
        line(canvas, SPoint(l.toDouble(), t.toDouble()), SPoint(rr.toDouble(), t.toDouble()), accent(), 2f * k, dashed = true)
        line(canvas, SPoint(rr.toDouble(), t.toDouble()), SPoint(rr.toDouble(), b.toDouble()), accent(), 2f * k, dashed = true)
        line(canvas, SPoint(rr.toDouble(), b.toDouble()), SPoint(l.toDouble(), b.toDouble()), accent(), 2f * k, dashed = true)
        line(canvas, SPoint(l.toDouble(), b.toDouble()), SPoint(l.toDouble(), t.toDouble()), accent(), 2f * k, dashed = true)
        for ((x, y) in listOf(l to t, rr to t, l to b, rr to b)) dot(canvas, x.toDouble(), y.toDouble(), 6f * k, Color.WHITE, accent(), 2f * k)
    }

    private companion object {
        val BOLD: Typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
    }
}
