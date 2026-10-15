package ch.fasrv.fanotes

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import ch.fasrv.fanotes.ink.InkStroke
import ch.fasrv.fanotes.ink.pencilGrainSegments

/** Pencil grain passes: one round stroke per sample, shifted like the desktop. */
fun drawPencilGrain(
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
    alpha: Int,
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
    if (segments.isEmpty()) return
    val style = paint.style
    val cap = paint.strokeCap
    val join = paint.strokeJoin
    paint.style = Paint.Style.STROKE
    paint.strokeCap = Paint.Cap.ROUND
    paint.strokeJoin = Paint.Join.ROUND
    paint.alpha = alpha
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
    paint.style = style
    paint.strokeCap = cap
    paint.strokeJoin = join
}
