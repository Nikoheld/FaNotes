package ch.fasrv.fanotes

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.Typeface
import android.text.style.LineBackgroundSpan
import android.text.style.ReplacementSpan
import ch.fasrv.fanotes.study.BoxOp
import ch.fasrv.fanotes.study.CurveOp
import ch.fasrv.fanotes.study.ImageOp
import ch.fasrv.fanotes.study.LineOp
import ch.fasrv.fanotes.study.StudyKind
import ch.fasrv.fanotes.study.StudyScene
import ch.fasrv.fanotes.study.TextOp
import ch.fasrv.fanotes.study.Tone
import ch.fasrv.fanotes.study.buildStudyScene

/** Paints a [StudyScene] (read-only table, diagram, cards) on the paper. Units are dp. */
internal class LwBlockPainter(private val accent: Int) {
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeJoin = Paint.Join.ROUND; strokeCap = Paint.Cap.ROUND }
    private val text = Paint(Paint.ANTI_ALIAS_FLAG)
    private val path = Path()
    private val rect = RectF()

    private fun color(tone: Tone): Int = when (tone) {
        Tone.TEXT -> 0xFF1B1D23.toInt()
        Tone.MUTED -> 0xFF4B5565.toInt()
        Tone.LINE -> 0xFF98A2B3.toInt()
        Tone.FILL -> 0xFFFFFFFF.toInt()
        Tone.ACCENT -> accent
        Tone.SOFT -> 0xFFEEF1F8.toInt()
    }

    fun draw(canvas: Canvas, scene: StudyScene, images: Map<String, Bitmap>) {
        for (op in scene.ops) {
            when (op) {
                is BoxOp -> {
                    rect.set(op.x.toFloat(), op.y.toFloat(), (op.x + op.w).toFloat(), (op.y + op.h).toFloat())
                    val radius = op.radius.toFloat()
                    op.fill?.let {
                        fill.color = color(it)
                        canvas.drawRoundRect(rect, radius, radius, fill)
                    }
                    op.stroke?.let {
                        stroke.color = color(it)
                        stroke.strokeWidth = op.strokeWidth.toFloat()
                        canvas.drawRoundRect(rect, radius, radius, stroke)
                    }
                }
                is TextOp -> {
                    text.color = color(op.tone)
                    text.textSize = op.size.toFloat()
                    text.typeface = Typeface.create(Typeface.SANS_SERIF, if (op.bold && op.italic) Typeface.BOLD_ITALIC else if (op.bold) Typeface.BOLD else if (op.italic) Typeface.ITALIC else Typeface.NORMAL)
                    text.textAlign = if (op.center) Paint.Align.CENTER else Paint.Align.LEFT
                    canvas.drawText(op.text, op.x.toFloat(), op.baseline.toFloat(), text)
                }
                is LineOp -> {
                    path.reset()
                    var index = 0
                    while (index + 1 < op.points.size) {
                        if (index == 0) path.moveTo(op.points[0].toFloat(), op.points[1].toFloat())
                        else path.lineTo(op.points[index].toFloat(), op.points[index + 1].toFloat())
                        index += 2
                    }
                    stroke.color = color(op.tone)
                    stroke.strokeWidth = op.width.toFloat()
                    canvas.drawPath(path, stroke)
                }
                is CurveOp -> {
                    path.reset()
                    path.moveTo(op.x1.toFloat(), op.y1.toFloat())
                    path.cubicTo(op.c1x.toFloat(), op.c1y.toFloat(), op.c2x.toFloat(), op.c2y.toFloat(), op.x2.toFloat(), op.y2.toFloat())
                    stroke.color = color(op.tone)
                    stroke.strokeWidth = op.width.toFloat()
                    canvas.drawPath(path, stroke)
                    if (op.arrow) arrowHead(canvas, op)
                }
                is ImageOp -> drawImage(canvas, op, images[op.ref]?.takeIf { !it.isRecycled })
            }
        }
    }

    private fun arrowHead(canvas: Canvas, op: CurveOp) {
        var dx = op.x2 - op.c2x
        var dy = op.y2 - op.c2y
        if (dx * dx + dy * dy < 1e-6) {
            dx = op.x2 - op.x1
            dy = op.y2 - op.y1
        }
        val length = Math.hypot(dx, dy).takeIf { it > 1e-6 } ?: return
        val ux = dx / length
        val uy = dy / length
        val size = 8.0
        path.reset()
        path.moveTo(op.x2.toFloat(), op.y2.toFloat())
        path.lineTo((op.x2 - ux * size - uy * size * 0.45).toFloat(), (op.y2 - uy * size + ux * size * 0.45).toFloat())
        path.lineTo((op.x2 - ux * size + uy * size * 0.45).toFloat(), (op.y2 - uy * size - ux * size * 0.45).toFloat())
        path.close()
        fill.color = color(op.tone)
        canvas.drawPath(path, fill)
    }

    private fun drawImage(canvas: Canvas, op: ImageOp, bitmap: Bitmap?) {
        rect.set(op.x.toFloat(), op.y.toFloat(), (op.x + op.w).toFloat(), (op.y + op.h).toFloat())
        if (bitmap == null) {
            fill.color = color(Tone.SOFT)
            canvas.drawRoundRect(rect, 6f, 6f, fill)
            stroke.color = color(Tone.LINE)
            stroke.strokeWidth = 1f
            canvas.drawRoundRect(rect, 6f, 6f, stroke)
            return
        }
        val frame = RectF(rect)
        val source = Rect(0, 0, bitmap.width, bitmap.height)
        val target = RectF(frame)
        val frameRatio = frame.width() / frame.height()
        val bitmapRatio = bitmap.width.toFloat() / bitmap.height
        if (op.cover) {
            if (bitmapRatio > frameRatio) {
                val keep = (bitmap.height * frameRatio).toInt()
                source.left = (bitmap.width - keep) / 2
                source.right = source.left + keep
            } else {
                val keep = (bitmap.width / frameRatio).toInt()
                source.top = (bitmap.height - keep) / 2
                source.bottom = source.top + keep
            }
        } else if (bitmapRatio > frameRatio) {
            val height = frame.width() / bitmapRatio
            target.top = frame.top + (frame.height() - height) / 2
            target.bottom = target.top + height
        } else {
            val width = frame.height() * bitmapRatio
            target.left = frame.left + (frame.width() - width) / 2
            target.right = target.left + width
        }
        canvas.save()
        path.reset()
        path.addRoundRect(frame, 6f, 6f, Path.Direction.CW)
        canvas.clipPath(path)
        canvas.drawBitmap(bitmap, source, target, Paint(Paint.FILTER_BITMAP_FLAG))
        canvas.restore()
    }
}

/**
 * A study block (`fanotes-key` ... `fanotes-term`) on the paper: the opening fence line is
 * replaced by the drawn block and the JSON lines collapse, like display math.
 */
internal class StudyBlockSpan(
    val kindId: String,
    private val body: String,
    private val images: Map<String, Bitmap>,
    columnPx: Float,
    accent: Int,
) : ReplacementSpan(), LineBackgroundSpan, LivePreviewSpan {
    private val density = android.content.res.Resources.getSystem().displayMetrics.density
    private val widthDp = (if (columnPx > 0f) columnPx else 640f * density) / density
    private val painter = LwBlockPainter(accent)
    private val scene: StudyScene? by lazy { cachedStudyScene(kindId, body, widthDp.toDouble()) }
    private val margin get() = 6f * density

    override fun getSize(paint: Paint, text: CharSequence, start: Int, end: Int, fm: Paint.FontMetricsInt?): Int {
        val total = (scene?.height ?: 24.0).toFloat() * density + margin * 2
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
        canvas: Canvas, paint: Paint, left: Int, right: Int, top: Int, baseline: Int, bottom: Int,
        text: CharSequence, start: Int, end: Int, lineNumber: Int,
    ) {
        val drawn = scene ?: return
        if (right <= left) return
        val fit = minOf(1f, (right - left) / density / drawn.width.toFloat())
        canvas.save()
        canvas.translate(left.toFloat(), top + margin)
        canvas.scale(density * fit, density * fit)
        painter.draw(canvas, drawn, images)
        canvas.restore()
    }
}

private val sceneCache = object : LinkedHashMap<String, StudyScene?>(16, 0.75f, true) {
    override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, StudyScene?>) = size > 24
}

/** Spans are rebuilt on every caret move; the layout of a block only changes with its JSON or the column width. */
internal fun cachedStudyScene(kindId: String, body: String, widthDp: Double): StudyScene? {
    val key = "$kindId|${widthDp.toInt()}|${body.hashCode()}|${body.length}"
    synchronized(sceneCache) {
        if (sceneCache.containsKey(key)) return sceneCache[key]
    }
    val scene = StudyKind.of(kindId)?.let { buildStudyScene(it, body, widthDp) }
    synchronized(sceneCache) { sceneCache[key] = scene }
    return scene
}
