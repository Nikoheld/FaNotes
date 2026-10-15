package ch.fasrv.fanotes

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import ch.fasrv.fanotes.ink.ConstantStroke
import ch.fasrv.fanotes.ink.InkStroke
import ch.fasrv.fanotes.ink.StrokeCommand
import ch.fasrv.fanotes.ink.brushPasses
import ch.fasrv.fanotes.ink.constantWidthStroke
import ch.fasrv.fanotes.ink.pencilGrainSegments
import ch.fasrv.fanotes.ink.strokeDotRadius

/**
 * Desktop brush paint for every pass that is not a marker, calligraphy nib, or spray.
 * Pressure draws one stroke per sample. A fixed width is one joined path, and a
 * one-sample stroke is a filled dot.
 */
fun drawBrushPasses(
    canvas: Canvas,
    paint: Paint,
    stroke: InkStroke,
    sourceWidth: Double,
    sourceHeight: Double,
    scale: Float,
    smoothing: Double,
    color: Int,
) {
    if (scale <= 0f || stroke.points.isEmpty()) return
    paint.color = color
    val pageWidth = (sourceWidth * scale).toFloat()
    val pageHeight = (sourceHeight * scale).toFloat()
    val baseAlpha = if (stroke.purpose == "art") (stroke.opacity ?: 1.0) else 1.0
    if (stroke.points.size == 1) {
        val point = stroke.points.first()
        val radius = (strokeDotRadius(stroke.baseWidth, point.pressure, stroke.pressureEnabled, scale.toDouble()) * scale).toFloat()
        val factor = if (stroke.brush == "highlighter") 0.32 else 1.0
        drawStyled(canvas, paint, stroke.colorEffect, pageWidth, pageHeight, stroke.baseWidth.toFloat() * scale, (baseAlpha * factor * 255.0).toInt().coerceIn(0, 255), Paint.Style.FILL, Paint.Cap.ROUND) {
            canvas.drawCircle((point.x * sourceWidth * scale).toFloat(), (point.y * sourceHeight * scale).toFloat(), radius, paint)
        }
        return
    }
    val butt = stroke.brush == "highlighter" && !stroke.pressureEnabled
    for ((passIndex, pass) in brushPasses(stroke.brush).withIndex()) {
        val alpha = (baseAlpha * pass.alpha * 255.0).toInt().coerceIn(0, 255)
        if (stroke.pressureEnabled) {
            drawStyled(canvas, paint, stroke.colorEffect, pageWidth, pageHeight, (stroke.baseWidth * pass.widthFactor * scale).toFloat(), alpha, Paint.Style.STROKE, Paint.Cap.ROUND) {
                drawSegments(canvas, paint, stroke, sourceWidth, sourceHeight, scale, smoothing, passIndex, pass.jitter, pass.widthFactor)
            }
        } else {
            val pathStroke = constantWidthStroke(
                stroke.points,
                sourceWidth,
                sourceHeight,
                smoothing,
                stroke.baseWidth,
                false,
                pass.widthFactor,
                scale.toDouble(),
            ) ?: continue
            drawStyled(canvas, paint, stroke.colorEffect, pageWidth, pageHeight, (pathStroke.width * scale).toFloat(), alpha, Paint.Style.STROKE, if (butt) Paint.Cap.BUTT else Paint.Cap.ROUND) {
                paint.strokeWidth = (pathStroke.width * scale).toFloat()
                canvas.drawPath(pathOf(pathStroke, scale), paint)
            }
        }
    }
}

private fun drawSegments(
    canvas: Canvas,
    paint: Paint,
    stroke: InkStroke,
    sourceWidth: Double,
    sourceHeight: Double,
    scale: Float,
    smoothing: Double,
    passIndex: Int,
    jitter: Double,
    widthFactor: Double,
) {
    val seed = stroke.extras.double("textureSeed")?.takeIf { it.isFinite() }?.toInt() ?: 1
    val segments = pencilGrainSegments(
        stroke.points,
        sourceWidth,
        sourceHeight,
        smoothing,
        stroke.baseWidth,
        stroke.pressureEnabled,
        widthFactor,
        seed,
        passIndex,
        jitter,
        scale.toDouble(),
    )
    val path = Path()
    val pixels = scale.toDouble()
    for (segment in segments) {
        path.rewind()
        path.moveTo((segment.startX * pixels).toFloat(), (segment.startY * pixels).toFloat())
        val controlX = segment.controlX
        val controlY = segment.controlY
        if (controlX != null && controlY != null) {
            path.quadTo(
                (controlX * pixels).toFloat(),
                (controlY * pixels).toFloat(),
                (segment.endX * pixels).toFloat(),
                (segment.endY * pixels).toFloat(),
            )
        } else {
            path.lineTo((segment.endX * pixels).toFloat(), (segment.endY * pixels).toFloat())
        }
        paint.strokeWidth = (segment.width * pixels).toFloat()
        canvas.drawPath(path, paint)
    }
}

private fun pathOf(stroke: ConstantStroke, scale: Float): Path {
    val path = Path()
    val pixels = scale.toDouble()
    for (command in stroke.commands) {
        when (command) {
            is StrokeCommand.Move -> path.moveTo((command.x * pixels).toFloat(), (command.y * pixels).toFloat())
            is StrokeCommand.Line -> path.lineTo((command.x * pixels).toFloat(), (command.y * pixels).toFloat())
            is StrokeCommand.Quad -> path.quadTo(
                (command.cx * pixels).toFloat(),
                (command.cy * pixels).toFloat(),
                (command.x * pixels).toFloat(),
                (command.y * pixels).toFloat(),
            )
        }
    }
    return path
}

private fun drawStyled(
    canvas: Canvas,
    paint: Paint,
    effect: String?,
    pageWidth: Float,
    pageHeight: Float,
    baseWidth: Float,
    alpha: Int,
    style: Paint.Style,
    cap: Paint.Cap,
    draw: () -> Unit,
) {
    val previousStyle = paint.style
    val previousCap = paint.strokeCap
    val previousJoin = paint.strokeJoin
    paint.style = style
    paint.strokeCap = cap
    paint.strokeJoin = Paint.Join.ROUND
    paint.alpha = alpha
    applyInkEffect(paint, effect, pageWidth, pageHeight, baseWidth)
    draw()
    if (effect == "neon") {
        paint.maskFilter = null
        draw()
    }
    paint.shader = null
    paint.maskFilter = null
    paint.style = previousStyle
    paint.strokeCap = previousCap
    paint.strokeJoin = previousJoin
}
