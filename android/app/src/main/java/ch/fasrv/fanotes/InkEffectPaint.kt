package ch.fasrv.fanotes

import android.graphics.BlurMaskFilter
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Shader
import ch.fasrv.fanotes.ink.inkEffectGradient

/**
 * Desktop `strokePaint`: a special ink is a linear gradient across the page,
 * from 8% down the left edge toward 28% down the right edge. Neon also glows.
 */
fun applyInkEffect(paint: Paint, effect: String?, pageWidth: Float, pageHeight: Float, baseWidth: Float) {
    val gradient = inkEffectGradient(effect)
    if (gradient == null) {
        paint.shader = null
        paint.maskFilter = null
        return
    }
    paint.shader = LinearGradient(
        0f,
        pageHeight * 0.08f,
        pageWidth,
        pageHeight * 0.28f,
        gradient.second,
        gradient.first,
        Shader.TileMode.CLAMP,
    )
    paint.maskFilter = if (effect == "neon") {
        BlurMaskFilter((4f).coerceAtLeast(baseWidth * 0.85f), BlurMaskFilter.Blur.NORMAL)
    } else {
        null
    }
}

fun drawInkPath(canvas: Canvas, path: Path, paint: Paint, effect: String?, pageWidth: Float, pageHeight: Float, baseWidth: Float) {
    applyInkEffect(paint, effect, pageWidth, pageHeight, baseWidth)
    if (effect == "neon") {
        canvas.drawPath(path, paint)
        paint.maskFilter = null
    }
    canvas.drawPath(path, paint)
    paint.shader = null
    paint.maskFilter = null
}
