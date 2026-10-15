package ch.fasrv.fanotes

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import ch.fasrv.fanotes.ink.InkStroke
import ch.fasrv.fanotes.ink.MarkerCommand
import ch.fasrv.fanotes.ink.brushPasses
import ch.fasrv.fanotes.ink.markerCenterline
import ch.fasrv.fanotes.ink.pressureWidth

/** Constant-width marker centerline with the desktop corner fillet. */
fun drawMarkerStroke(
    canvas: Canvas,
    paint: Paint,
    stroke: InkStroke,
    scale: Float,
    sourceWidth: Double,
    sourceHeight: Double,
    smoothing: Double,
    color: Int,
) {
    if (stroke.points.isEmpty()) return
    val first = stroke.points.first()
    val second = stroke.points.getOrNull(1) ?: first
    val pressure = (first.pressure + second.pressure) / 2.0
    val width = pressureWidth(stroke.baseWidth, pressure, stroke.pressureEnabled) * brushPasses("marker").single().widthFactor
    val commands = markerCenterline(
        stroke.points.map { it.x * sourceWidth },
        stroke.points.map { it.y * sourceHeight },
        width,
        smoothing,
    )
    if (commands.isEmpty()) return
    val path = Path()
    for (command in commands) {
        when (command) {
            is MarkerCommand.Move -> path.moveTo((command.x * scale).toFloat(), (command.y * scale).toFloat())
            is MarkerCommand.Line -> path.lineTo((command.x * scale).toFloat(), (command.y * scale).toFloat())
            is MarkerCommand.Quad -> path.quadTo(
                (command.cx * scale).toFloat(),
                (command.cy * scale).toFloat(),
                (command.x * scale).toFloat(),
                (command.y * scale).toFloat(),
            )
        }
    }
    val previousStyle = paint.style
    val previousCap = paint.strokeCap
    val previousJoin = paint.strokeJoin
    val previousWidth = paint.strokeWidth
    val previousAlpha = paint.alpha
    val previousColor = paint.color
    val base = if (stroke.purpose == "art") (stroke.opacity ?: 1.0) else 1.0
    paint.style = Paint.Style.STROKE
    paint.strokeCap = Paint.Cap.ROUND
    paint.strokeJoin = Paint.Join.ROUND
    paint.strokeWidth = (width * scale).toFloat().coerceAtLeast(1f)
    paint.color = color
    paint.alpha = (base * brushPasses("marker").single().alpha * 255.0).toInt().coerceIn(0, 255)
    canvas.drawPath(path, paint)
    paint.style = previousStyle
    paint.strokeCap = previousCap
    paint.strokeJoin = previousJoin
    paint.strokeWidth = previousWidth
    paint.alpha = previousAlpha
    paint.color = previousColor
}
