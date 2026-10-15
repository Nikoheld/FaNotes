package ch.fasrv.fanotes

import android.graphics.Canvas
import android.graphics.ColorFilter
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.drawable.Drawable
import android.os.Build
import android.widget.TextView
import ch.fasrv.fanotes.desk.paperCaretWidthPx

/** A 2px accent caret, matching `.cm-cursor` on the desktop paper. */
internal fun applyPaperCaret(view: TextView, accent: Int, textSizePx: Float) {
    if (Build.VERSION.SDK_INT < 29) return
    view.textCursorDrawable = PaperCaretDrawable(accent, paperCaretWidthPx(textSizePx))
}

private class PaperCaretDrawable(color: Int, private val widthPx: Int) : Drawable() {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { this.color = color }

    override fun draw(canvas: Canvas) {
        canvas.drawRect(bounds, paint)
    }

    override fun getIntrinsicWidth(): Int = widthPx

    override fun setAlpha(alpha: Int) {
        paint.alpha = alpha
    }

    override fun setColorFilter(colorFilter: ColorFilter?) {
        paint.colorFilter = colorFilter
    }

    @Suppress("OVERRIDE_DEPRECATION")
    override fun getOpacity(): Int = PixelFormat.OPAQUE
}
