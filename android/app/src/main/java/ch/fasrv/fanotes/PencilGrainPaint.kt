package ch.fasrv.fanotes

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import ch.fasrv.fanotes.ink.ConstantStroke
import ch.fasrv.fanotes.ink.GrainSegment
import ch.fasrv.fanotes.ink.InkStroke
import ch.fasrv.fanotes.ink.StrokeCommand
import ch.fasrv.fanotes.ink.brushPasses
import ch.fasrv.fanotes.ink.constantWidthStroke
import ch.fasrv.fanotes.ink.pencilGrainSegmentRange
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
    val segments = pencilGrainSegments(
        stroke.points,
        sourceWidth,
        sourceHeight,
        smoothing,
        stroke.baseWidth,
        stroke.pressureEnabled,
        widthFactor,
        textureSeedOf(stroke),
        passIndex,
        jitter,
        scale.toDouble(),
    )
    paintSegments(canvas, paint, segments, scale)
}

private fun textureSeedOf(stroke: InkStroke): Int =
    stroke.extras.double("textureSeed")?.takeIf { it.isFinite() }?.toInt() ?: 1

private fun paintSegments(canvas: Canvas, paint: Paint, segments: List<GrainSegment>, scale: Float) {
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

/** True when [drawBrushPasses] paints [stroke] one segment at a time, so a slice of it can be painted alone. */
fun paintsPerSegment(stroke: InkStroke): Boolean =
    stroke.pressureEnabled && stroke.points.size >= 2 && stroke.symbolId == null && stroke.figurePaths.isEmpty() &&
        stroke.brush != "spray" && stroke.brush != "marker" && stroke.brush != "calligraphy"

/**
 * Grain segments [first]..[last] of every pass, as [drawBrushPasses] computes them for a per-segment stroke
 * (see [paintsPerSegment]). One list per pass, widest pass first.
 */
fun passSegmentRange(
    stroke: InkStroke,
    sourceWidth: Double,
    sourceHeight: Double,
    scale: Float,
    smoothing: Double,
    first: Int,
    last: Int,
): List<List<GrainSegment>> = brushPasses(stroke.brush).mapIndexed { passIndex, pass ->
    pencilGrainSegmentRange(
        stroke.points,
        sourceWidth,
        sourceHeight,
        smoothing,
        stroke.baseWidth,
        stroke.pressureEnabled,
        pass.widthFactor,
        textureSeedOf(stroke),
        passIndex,
        pass.jitter,
        scale.toDouble(),
        first,
        last,
    )
}

/**
 * Paints [passes] (from [passSegmentRange]) with the paint state [drawBrushPasses] gives each pass, so a slice of
 * a per-segment stroke looks the same as that part of the whole stroke.
 */
fun drawPassSegments(
    canvas: Canvas,
    paint: Paint,
    stroke: InkStroke,
    sourceWidth: Double,
    sourceHeight: Double,
    scale: Float,
    color: Int,
    passes: List<List<GrainSegment>>,
) {
    if (scale <= 0f) return
    paint.color = color
    val pageWidth = (sourceWidth * scale).toFloat()
    val pageHeight = (sourceHeight * scale).toFloat()
    val baseAlpha = if (stroke.purpose == "art") (stroke.opacity ?: 1.0) else 1.0
    for ((passIndex, pass) in brushPasses(stroke.brush).withIndex()) {
        val segments = passes.getOrNull(passIndex) ?: continue
        if (segments.isEmpty()) continue
        val alpha = (baseAlpha * pass.alpha * 255.0).toInt().coerceIn(0, 255)
        drawStyled(canvas, paint, stroke.colorEffect, pageWidth, pageHeight, (stroke.baseWidth * pass.widthFactor * scale).toFloat(), alpha, Paint.Style.STROKE, Paint.Cap.ROUND) {
            paintSegments(canvas, paint, segments, scale)
        }
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
