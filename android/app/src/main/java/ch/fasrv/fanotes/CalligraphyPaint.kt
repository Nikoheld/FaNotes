package ch.fasrv.fanotes

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import ch.fasrv.fanotes.ink.CALLIGRAPHY_ANGLE
import ch.fasrv.fanotes.ink.InkStroke
import ch.fasrv.fanotes.ink.calligraphyDotRadii
import ch.fasrv.fanotes.ink.calligraphyNibOffset
import ch.fasrv.fanotes.ink.pressureWidth

/** Slanted broad-nib segments, matching `calligraphyNib` in the desktop paint. */
fun drawCalligraphyStroke(
    canvas: Canvas,
    paint: Paint,
    stroke: InkStroke,
    scale: Float,
    sourceWidth: Double,
    sourceHeight: Double,
    color: Int,
) {
    if (stroke.points.isEmpty()) return
    val previousStyle = paint.style
    val previousAlpha = paint.alpha
    val previousColor = paint.color
    val base = if (stroke.purpose == "art") (stroke.opacity ?: 1.0) else 1.0
    paint.style = Paint.Style.FILL
    paint.color = color
    paint.alpha = (base * 255.0).toInt().coerceIn(0, 255)
    val points = stroke.points
    if (points.size == 1) {
        val point = points[0]
        val nib = pressureWidth(stroke.baseWidth, point.pressure, stroke.pressureEnabled)
        val (rx, ry) = calligraphyDotRadii(nib)
        val cx = (point.x * sourceWidth * scale).toFloat()
        val cy = (point.y * sourceHeight * scale).toFloat()
        canvas.save()
        canvas.translate(cx, cy)
        canvas.rotate(Math.toDegrees(CALLIGRAPHY_ANGLE).toFloat())
        canvas.drawOval(RectF((-rx * scale).toFloat(), (-ry * scale).toFloat(), (rx * scale).toFloat(), (ry * scale).toFloat()), paint)
        canvas.restore()
    } else {
        val path = Path()
        for (index in 1 until points.size) {
            val previous = points[index - 1]
            val point = points[index]
            val nib = pressureWidth(
                stroke.baseWidth,
                (previous.pressure + point.pressure) / 2.0,
                stroke.pressureEnabled,
            )
            val offset = calligraphyNibOffset(nib)
            val ox = offset.x * scale
            val oy = offset.y * scale
            val x0 = previous.x * sourceWidth * scale
            val y0 = previous.y * sourceHeight * scale
            val x1 = point.x * sourceWidth * scale
            val y1 = point.y * sourceHeight * scale
            path.moveTo((x0 + ox).toFloat(), (y0 + oy).toFloat())
            path.lineTo((x1 + ox).toFloat(), (y1 + oy).toFloat())
            path.lineTo((x1 - ox).toFloat(), (y1 - oy).toFloat())
            path.lineTo((x0 - ox).toFloat(), (y0 - oy).toFloat())
            path.close()
        }
        canvas.drawPath(path, paint)
    }
    paint.style = previousStyle
    paint.alpha = previousAlpha
    paint.color = previousColor
}
