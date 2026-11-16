package ch.fasrv.fanotes

import android.graphics.Canvas
import android.graphics.Color
import android.graphics.DashPathEffect
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.Typeface
import android.util.SparseArray
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
import ch.fasrv.fanotes.study.StudyPending
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
    private val clip = Rect()
    private val matrix = Matrix()

    // ---- memoised work: a frame must not parse colours, measure text or rebuild paths it already has ----------

    private val colors = HashMap<String, Int>()

    /** [Color.parseColor] once per distinct value. A bad value is grey, and stays grey without throwing every frame. */
    private fun parse(value: String): Int {
        colors[value]?.let { return it }
        val parsed = try { Color.parseColor(value) } catch (_: IllegalArgumentException) { Color.GRAY }
        if (colors.size >= COLOR_CACHE_MAX) colors.clear()
        colors[value] = parsed
        return parsed
    }

    // Direct-mapped width cache: a label or legend row measures the same text at the same size every frame.
    private val widthText = arrayOfNulls<String>(WIDTH_SLOTS)
    private val widthFont = DoubleArray(WIDTH_SLOTS)
    private val widthBold = BooleanArray(WIDTH_SLOTS)
    private val widthValue = DoubleArray(WIDTH_SLOTS)

    val measurer = TextMeasurer { value, fontPx, bold ->
        val slot = ((value.hashCode() * 31 + fontPx.hashCode()) * 31 + (if (bold) 1 else 0)) and (WIDTH_SLOTS - 1)
        if (widthText[slot] == value && widthFont[slot] == fontPx && widthBold[slot] == bold) {
            widthValue[slot]
        } else {
            text.typeface = if (bold) BOLD else Typeface.DEFAULT
            text.textSize = fontPx.toFloat()
            val measured = text.measureText(value).toDouble()
            widthText[slot] = value
            widthFont[slot] = fontPx
            widthBold[slot] = bold
            widthValue[slot] = measured
            measured
        }
    }

    // Dash patterns that do not depend on the zoom are shared. A dashed line follows its width, and all lines of
    // one frame on one page share it, so the last effect is reused.
    private var dashWidth = -1f
    private var dashEffect: DashPathEffect? = null

    private fun dashFor(width: Float): DashPathEffect {
        val kept = dashEffect
        if (kept != null && dashWidth == width) return kept
        return DashPathEffect(floatArrayOf(width * 2, width * 2), 0f).also {
            dashEffect = it
            dashWidth = width
        }
    }

    /** Page boxes of the current frame: each page is resolved once, not once per item and pass. */
    private val boxes = SparseArray<PageBox>()
    private var boxSource: (Int) -> PageBox? = { null }

    private fun boxOf(page: Int): PageBox? {
        val known = boxes.get(page)
        if (known != null) return if (known === NO_BOX) null else known
        val box = boxSource(page)
        boxes.put(page, box ?: NO_BOX)
        return box
    }

    /** A stroke's path in page fractions: the points are walked once, then it is transformed per frame. */
    private class CachedStroke(val source: StudyStroke, val path: Path, val bounds: RectF, var frame: Int)

    private val strokePaths = HashMap<String, CachedStroke>()
    private var frame = 0

    private fun strokePathOf(s: StudyStroke): CachedStroke {
        val hit = strokePaths[s.id]
        if (hit != null && hit.source === s) {
            hit.frame = frame
            return hit
        }
        val fractions = Path()
        s.pts.forEachIndexed { i, p ->
            if (i == 0) fractions.moveTo(p.x.toFloat(), p.y.toFloat()) else fractions.lineTo(p.x.toFloat(), p.y.toFloat())
        }
        val bounds = RectF()
        fractions.computeBounds(bounds, true)
        return CachedStroke(s, fractions, bounds, frame).also { strokePaths[s.id] = it }
    }

    /** The live branch stroke is appended to, not rebuilt: [liveCount] points of [liveSource] are already in [livePath]. */
    private val livePath = Path()
    private var liveSource: List<SPoint>? = null
    private var liveCount = 0

    /** Whether a rectangle in the drawing's own coordinates reaches the visible area of this frame. */
    private fun visible(left: Double, top: Double, right: Double, bottom: Double): Boolean =
        right >= clip.left && left <= clip.right && bottom >= clip.top && top <= clip.bottom

    /** Items of a page that is more than [PAGE_CULL_MARGIN] away from the view are not even laid out. */
    private fun pageVisible(box: PageBox): Boolean {
        val margin = PAGE_CULL_MARGIN * box.k
        return visible(box.left - margin, box.top - margin, box.left + box.width + margin, box.top + box.height + margin)
    }

    fun draw(
        canvas: Canvas,
        items: List<StudyAnnotation>,
        boxFor: (Int) -> PageBox?,
        selectedId: String?,
        pending: StudyPending?,
        live: StudyLive?,
    ) {
        if (items.isEmpty() && pending == null && live == null) {
            if (liveSource != null) liveSource = null
            return
        }
        // An empty clip means nothing of this canvas is visible.
        if (!canvas.getClipBounds(clip)) return
        boxSource = boxFor
        boxes.clear()
        frame++
        var strokes = 0
        // An image can hang far past its own page (a tall one covers the pages below), so it is culled by its
        // own rectangle in drawImage, not by its page.
        for (item in items) {
            if (item !is StudyImage) continue
            val box = boxOf(item.page) ?: continue
            drawImage(canvas, item, box, item.id == selectedId)
        }
        for (item in items) {
            if (item is StudyStroke) {
                strokes++
                strokePaths[item.id]?.frame = frame
            }
            val box = boxOf(item.pageOrNull() ?: continue) ?: continue
            if (!pageVisible(box)) continue
            when (item) {
                is StudyCallout -> drawLeader(canvas, item, box, item.id == selectedId)
                is StudyStroke -> drawStroke(canvas, item, box, item.id == selectedId)
                is StudyMeasure -> drawMeasure(canvas, item, box, item.id == selectedId)
                else -> Unit
            }
        }
        // Paths of strokes that are gone (deleted, undone, another note) are dropped; off-screen ones stay.
        if (strokePaths.size > strokes) {
            val stale = strokePaths.values.iterator()
            while (stale.hasNext()) if (stale.next().frame != frame) stale.remove()
        }
        for (item in items) {
            val box = boxOf(item.pageOrNull() ?: continue) ?: continue
            if (!pageVisible(box)) continue
            when (item) {
                is StudyStamp -> drawStamp(canvas, item, box, item.id == selectedId)
                is StudyCallout -> drawLabel(canvas, item, box, item.id == selectedId)
                is StudyLegend -> drawLegend(canvas, item, items, box, item.id == selectedId)
                else -> Unit
            }
        }
        drawLive(canvas, live, pending)
    }

    private fun line(canvas: Canvas, a: SPoint, b: SPoint, color: Int, width: Float, dashed: Boolean = false) {
        paint.reset()
        paint.isAntiAlias = true
        paint.style = Paint.Style.STROKE
        paint.strokeCap = Paint.Cap.ROUND
        paint.color = color
        paint.strokeWidth = width
        if (dashed) paint.pathEffect = dashFor(width)
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
        // The resize handle sits on the corner and reaches past the rectangle.
        val reach = 12.0 * box.k.coerceAtLeast(1.0)
        // An off-screen image must not start a decode either.
        if (!visible(r.l - reach, r.t - reach, r.r + reach, r.b + reach)) return
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
            paint.pathEffect = SELECT_DASH
            canvas.drawRect(rect, paint)
            if (!item.locked) dot(canvas, r.r, r.b, 7f * box.k.toFloat().coerceAtLeast(1f), Color.WHITE, accent(), 2f)
        }
    }

    private fun drawLeader(canvas: Canvas, c: StudyCallout, box: PageBox, selected: Boolean) {
        val k = box.k.toFloat()
        val a = SPoint(box.px(c.ax), box.py(c.ay))
        val l = SPoint(box.px(c.lx), box.py(c.ly))
        val reach = 12.0 * k
        if (!visible(minOf(a.x, l.x) - reach, minOf(a.y, l.y) - reach, maxOf(a.x, l.x) + reach, maxOf(a.y, l.y) + reach)) return
        val color = parse(c.color)
        if (hypot(a.x - l.x, a.y - l.y) > StudyMetrics.LEADER_MIN * k) line(canvas, a, l, color, StudyMetrics.LEADER_WIDTH.toFloat() * k)
        dot(canvas, a.x, a.y, (if (selected) StudyMetrics.ANCHOR_R_SELECTED else StudyMetrics.ANCHOR_R).toFloat() * k, color, Color.WHITE, 1.5f * k)
    }

    private fun drawStroke(canvas: Canvas, s: StudyStroke, box: PageBox, selected: Boolean) {
        if (s.pts.size < 2) return
        val cached = strokePathOf(s)
        val widthPx = strokeWidthPx(s, box).toFloat()
        val b = cached.bounds
        val reach = widthPx / 2.0 + 8.0 * box.k.coerceAtLeast(1.0)
        if (!visible(box.px(b.left.toDouble()) - reach, box.py(b.top.toDouble()) - reach, box.px(b.right.toDouble()) + reach, box.py(b.bottom.toDouble()) + reach)) return
        // The page-fraction path becomes screen pixels in one native call instead of one call per point.
        matrix.setScale(box.width.toFloat(), box.height.toFloat())
        matrix.postTranslate(box.left.toFloat(), box.top.toFloat())
        path.rewind()
        cached.path.transform(matrix, path)
        paint.reset()
        paint.isAntiAlias = true
        paint.style = Paint.Style.STROKE
        paint.strokeCap = Paint.Cap.ROUND
        paint.strokeJoin = Paint.Join.ROUND
        paint.color = parse(s.color)
        paint.alpha = (s.opacity * 255).toInt().coerceIn(0, 255)
        paint.strokeWidth = widthPx
        canvas.drawPath(path, paint)
        if (selected) {
            paint.reset()
            paint.isAntiAlias = true
            paint.style = Paint.Style.STROKE
            paint.strokeWidth = 1.5f * box.k.toFloat().coerceAtLeast(1f)
            paint.color = STROKE_SELECT
            paint.pathEffect = SELECT_DASH
            canvas.drawPath(path, paint)
        }
    }

    private fun drawMeasure(canvas: Canvas, m: StudyMeasure, box: PageBox, selected: Boolean) {
        val k = box.k.toFloat()
        val real = measureScreenPoints(m, box)
        val label = measureLabelOf(m, box)
        val r = measureLabelRect(m, box, label)
        val reach = 12.0 * k
        var left = r.l
        var top = r.t
        var right = r.r
        var bottom = r.b
        for (p in real) {
            left = minOf(left, p.x)
            top = minOf(top, p.y)
            right = maxOf(right, p.x)
            bottom = maxOf(bottom, p.y)
        }
        if (!visible(left - reach, top - reach, right + reach, bottom + reach)) return
        val color = parse(m.color)
        for ((a, b) in measureSegments(m)) line(canvas, real[a], real[b], color, 2f * k)
        for (p in real) dot(canvas, p.x, p.y, StudyMetrics.MEASURE_POINT_R.toFloat() * k, Color.WHITE, color, 2f * k)
        box(canvas, r, 4f * k, Color.WHITE, color, (if (selected) 2.5f else 1f) * k)
        text.typeface = BOLD
        text.textSize = StudyMetrics.MEASURE_FONT.toFloat() * k
        text.color = color
        val c = measureCentre(m, real)
        canvas.drawText(label, (c.x + 10 * k).toFloat(), (c.y - 12 * k).toFloat(), text)
    }

    private class CachedLabel(val source: StudyMeasure, val width: Double, val height: Double, val text: String)

    private val measureLabels = HashMap<String, CachedLabel>()

    /** The measure's value text. It only follows the page's proportions, so panning and the same zoom reuse it. */
    private fun measureLabelOf(m: StudyMeasure, box: PageBox): String {
        val hit = measureLabels[m.id]
        if (hit != null && hit.source === m && hit.width == box.width && hit.height == box.height) return hit.text
        val label = formatMeasure(m, measureValue(m, pageSizeCm(box.width, box.height)))
        if (measureLabels.size >= LABEL_CACHE_MAX) measureLabels.clear()
        measureLabels[m.id] = CachedLabel(m, box.width, box.height, label)
        return label
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
        if (!visible(cx - size.toDouble(), cy - size.toDouble(), cx + size.toDouble(), cy + size.toDouble())) return
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
            paint.pathEffect = STAMP_DASH
            canvas.drawCircle(cx, cy, size * 0.8f, paint)
        }
    }

    private fun drawLabel(canvas: Canvas, c: StudyCallout, box: PageBox, selected: Boolean) {
        val k = box.k.toFloat()
        val r = calloutLabelRect(c, box, selected, measurer)
        val halo = 8.0 * k
        if (!visible(r.l - halo, r.t - halo, r.r + halo, r.b + halo)) return
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
        val halo = 8.0 * k
        if (!visible(r.l - halo, r.t - halo, r.r + halo, r.b + halo)) return
        box(canvas, r, 8f * k, LEGEND_FILL, LEGEND_EDGE, 1f * k)
        if (selected) {
            rect.set(r.l.toFloat(), r.t.toFloat(), r.r.toFloat(), r.b.toFloat())
            paint.reset()
            paint.isAntiAlias = true
            paint.style = Paint.Style.STROKE
            paint.strokeWidth = 2f * k.coerceAtLeast(1f)
            paint.color = accent()
            canvas.drawRoundRect(rect, 8f * k, 8f * k, paint)
        }
        val inkColor = LEGEND_INK
        val left = (r.l + StudyMetrics.LEGEND_PAD_X * k).toFloat()
        text.typeface = BOLD
        text.textSize = StudyMetrics.LEGEND_FONT.toFloat() * k
        text.color = inkColor
        canvas.drawText(ChromeText.ui(LEGEND_TITLE), left, (r.t + (StudyMetrics.LEGEND_PAD_Y + 13) * k).toFloat(), text)
        if (layout.empty) {
            text.typeface = Typeface.DEFAULT
            text.textSize = 11.5f * k
            text.color = LEGEND_MUTED
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

    private fun drawLive(canvas: Canvas, live: StudyLive?, pending: StudyPending?) {
        if (live !is StudyLive.Branch && liveSource != null) {
            liveSource = null
            liveCount = 0
        }
        when (live) {
            is StudyLive.Branch -> boxOf(live.page)?.let { box ->
                if (live.pts.size < 2) return@let
                // Only the points added since the last frame go into the path; the new stroke starts a fresh one.
                if (live.pts !== liveSource || live.pts.size < liveCount) {
                    livePath.rewind()
                    liveSource = live.pts
                    liveCount = 0
                }
                for (i in liveCount until live.pts.size) {
                    val p = live.pts[i]
                    if (i == 0) livePath.moveTo(p.x.toFloat(), p.y.toFloat()) else livePath.lineTo(p.x.toFloat(), p.y.toFloat())
                }
                liveCount = live.pts.size
                matrix.setScale(box.width.toFloat(), box.height.toFloat())
                matrix.postTranslate(box.left.toFloat(), box.top.toFloat())
                path.rewind()
                livePath.transform(matrix, path)
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
            is StudyLive.Leader -> boxOf(live.page)?.let { box ->
                line(canvas, SPoint(box.px(live.a.x), box.py(live.a.y)), SPoint(box.px(live.b.x), box.py(live.b.y)), parse(live.color), 2f * box.k.toFloat(), dashed = true)
            }
            is StudyLive.Crop -> boxOf(live.page)?.let { box -> drawCrop(canvas, live.rect, box) }
            null -> Unit
        }
        if (pending != null) {
            val box = boxOf(pending.page) ?: return
            val k = box.k.toFloat()
            val red = PENDING_RED
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
        dot(canvas, l.toDouble(), t.toDouble(), 6f * k, Color.WHITE, accent(), 2f * k)
        dot(canvas, rr.toDouble(), t.toDouble(), 6f * k, Color.WHITE, accent(), 2f * k)
        dot(canvas, l.toDouble(), b.toDouble(), 6f * k, Color.WHITE, accent(), 2f * k)
        dot(canvas, rr.toDouble(), b.toDouble(), 6f * k, Color.WHITE, accent(), 2f * k)
    }

    private companion object {
        val BOLD: Typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)

        /** Shared, immutable effects and colours that used to be built or parsed on every frame. */
        val SELECT_DASH = DashPathEffect(floatArrayOf(10f, 8f), 0f)
        val STAMP_DASH = DashPathEffect(floatArrayOf(8f, 6f), 0f)
        val STROKE_SELECT = Color.parseColor("#2563eb")
        val PENDING_RED = Color.parseColor("#dc2626")
        val LEGEND_FILL = Color.argb(242, 255, 255, 255)
        val LEGEND_EDGE = Color.parseColor("#9ca3af")
        val LEGEND_INK = Color.parseColor("#20222b")
        val LEGEND_MUTED = Color.parseColor("#6b7280")

        /** Marks a page that has no box, so a missing page is asked for once per frame too. */
        val NO_BOX = PageBox(0.0, 0.0, 0.0, 0.0)

        /**
         * Pages farther than this from the view (in 800 px reference units, scaled with the page) skip layout and
         * drawing. It covers the widest label (120 characters) and a legend hanging over the page edge.
         */
        const val PAGE_CULL_MARGIN = 1600.0
        const val COLOR_CACHE_MAX = 512
        const val LABEL_CACHE_MAX = 256
        const val WIDTH_SLOTS = 256
    }
}
