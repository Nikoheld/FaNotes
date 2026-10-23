package ch.fasrv.fanotes

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import androidx.core.graphics.PathParser
import ch.fasrv.fanotes.ink.InkStroke
import ch.fasrv.fanotes.ink.artSymbol
import ch.fasrv.fanotes.ink.figureStampStrokeWidth
import ch.fasrv.fanotes.ink.pressureWidth
import ch.fasrv.fanotes.ink.sprayDots

/**
 * Strokes a math figure stored as 24×24 paths. Line thickness is page units
 * and does not follow the stamp size. Returns false when this stroke is not a figure.
 */
fun drawMathFigure(canvas: Canvas, paint: Paint, stroke: InkStroke, scale: Float, sourceWidth: Double, sourceHeight: Double): Boolean {
    if (stroke.figurePaths.isEmpty()) return false
    val point = stroke.points.firstOrNull() ?: return false
    val previousStyle = paint.style
    val previousAlpha = paint.alpha
    val previousWidth = paint.strokeWidth
    val previousCap = paint.strokeCap
    val previousJoin = paint.strokeJoin
    val symbolScale = (stroke.baseWidth * scale / 24.0).toFloat().coerceAtLeast(0.01f)
    canvas.save()
    canvas.translate((point.x * sourceWidth * scale).toFloat(), (point.y * sourceHeight * scale).toFloat())
    canvas.rotate(stroke.symbolRotation.toFloat())
    canvas.scale(symbolScale, symbolScale)
    canvas.translate(-12f, -12f)
    paint.style = Paint.Style.STROKE
    paint.alpha = ((stroke.opacity ?: 1.0) * 255.0).toInt().coerceIn(0, 255)
    paint.strokeWidth = figureStampStrokeWidth(stroke.baseWidth, stroke.figureLineWidth).toFloat()
    paint.strokeCap = Paint.Cap.ROUND
    paint.strokeJoin = Paint.Join.ROUND
    for (data in stroke.figurePaths) {
        val path = PathParser.createPathFromPathData(data) ?: continue
        canvas.drawPath(path, paint)
    }
    canvas.restore()
    paint.style = previousStyle
    paint.alpha = previousAlpha
    paint.strokeWidth = previousWidth
    paint.strokeCap = previousCap
    paint.strokeJoin = previousJoin
    return true
}

/** Strokes a desktop art symbol in the 24×24 icon space, scaled by the stroke width. */
fun drawArtSymbol(canvas: Canvas, paint: Paint, stroke: InkStroke, scale: Float, sourceWidth: Double, sourceHeight: Double) {
    val symbol = artSymbol(stroke.symbolId) ?: return
    val point = stroke.points.firstOrNull() ?: return
    val previousStyle = paint.style
    val previousAlpha = paint.alpha
    val previousWidth = paint.strokeWidth
    val previousCap = paint.strokeCap
    val previousJoin = paint.strokeJoin
    val symbolScale = (stroke.baseWidth * scale / 24.0).toFloat().coerceAtLeast(0.01f)
    canvas.save()
    canvas.translate((point.x * sourceWidth * scale).toFloat(), (point.y * sourceHeight * scale).toFloat())
    canvas.rotate(stroke.symbolRotation.toFloat())
    canvas.scale(symbolScale, symbolScale)
    canvas.translate(-12f, -12f)
    paint.style = Paint.Style.STROKE
    paint.alpha = ((stroke.opacity ?: 1.0) * 255.0).toInt().coerceIn(0, 255)
    paint.strokeWidth = 1.75f
    paint.strokeCap = Paint.Cap.ROUND
    paint.strokeJoin = Paint.Join.ROUND
    for (data in symbol.paths) {
        val path = PathParser.createPathFromPathData(data) ?: continue
        canvas.drawPath(path, paint)
    }
    canvas.restore()
    paint.style = previousStyle
    paint.alpha = previousAlpha
    paint.strokeWidth = previousWidth
    paint.strokeCap = previousCap
    paint.strokeJoin = previousJoin
}

/** Desktop spray: seeded dots along each segment, not a solid ribbon. */
fun drawSpray(canvas: Canvas, paint: Paint, stroke: InkStroke, scale: Float, sourceWidth: Double, sourceHeight: Double) {
    val points = stroke.points
    if (points.isEmpty()) return
    val previousStyle = paint.style
    paint.style = Paint.Style.FILL
    val opacity = stroke.opacity ?: 0.7
    val pairs = if (points.size == 1) listOf(points[0] to points[0]) else points.zipWithNext()
    pairs.forEachIndexed { index, (previous, point) ->
        val width = pressureWidth(stroke.baseWidth, (previous.pressure + point.pressure) / 2.0, stroke.pressureEnabled) * scale
        val dots = sprayDots(
            previous.x * sourceWidth * scale,
            previous.y * sourceHeight * scale,
            point.x * sourceWidth * scale,
            point.y * sourceHeight * scale,
            width / 2.0,
            stroke.baseWidth,
            seed = 1,
            index = index,
            opacity = opacity,
            scale = scale.toDouble(),
        )
        for (dot in dots) {
            paint.alpha = (dot.alpha * 255.0).toInt().coerceIn(1, 255)
            canvas.drawCircle(dot.x.toFloat(), dot.y.toFloat(), dot.radius.toFloat(), paint)
        }
    }
    paint.style = previousStyle
}
