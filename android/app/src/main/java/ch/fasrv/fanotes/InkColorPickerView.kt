package ch.fasrv.fanotes

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ComposeShader
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.RectF
import android.graphics.Shader
import android.view.MotionEvent
import android.view.View

/**
 * Custom colour ("Eigene Farbe"): a saturation/brightness square over a hue strip. Pen and finger
 * drag either part; [onColor] reports `#rrggbb` while dragging and once more with `done` on lift.
 */
internal class InkColorPickerView(context: Context) : View(context) {
    var onColor: (hex: String, done: Boolean) -> Unit = { _, _ -> }
    private val density = resources.displayMetrics.density
    private val hsv = floatArrayOf(210f, 0.75f, 0.85f)
    private val square = RectF()
    private val strip = RectF()
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val knob = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private var dragging = 0
    private var squareHue = Float.NaN

    fun setColor(hex: String) {
        val color = runCatching { Color.parseColor(hex) }.getOrNull() ?: return
        Color.colorToHSV(color, hsv)
        invalidate()
    }

    fun hex(): String = "#%06x".format(Color.HSVToColor(hsv) and 0xFFFFFF)

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val width = MeasureSpec.getSize(widthMeasureSpec)
        setMeasuredDimension(width, (200 * density).toInt())
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        val pad = 4 * density
        square.set(pad, pad, w - pad, h - 48 * density)
        strip.set(pad, h - 36 * density, w - pad, h - 8 * density)
        squareHue = Float.NaN
    }

    override fun onDraw(canvas: Canvas) {
        if (squareHue != hsv[0]) {
            squareHue = hsv[0]
            val pure = Color.HSVToColor(floatArrayOf(hsv[0], 1f, 1f))
            val horizontal = LinearGradient(square.left, 0f, square.right, 0f, Color.WHITE, pure, Shader.TileMode.CLAMP)
            val vertical = LinearGradient(0f, square.top, 0f, square.bottom, Color.TRANSPARENT, Color.BLACK, Shader.TileMode.CLAMP)
            squareShader = ComposeShader(horizontal, vertical, PorterDuff.Mode.SRC_OVER)
        }
        paint.shader = squareShader
        canvas.drawRoundRect(square, 10 * density, 10 * density, paint)
        if (hueShader == null) {
            val stops = IntArray(7) { Color.HSVToColor(floatArrayOf(it * 60f % 360f, 1f, 1f)) }
            hueShader = LinearGradient(strip.left, 0f, strip.right, 0f, stops, null, Shader.TileMode.CLAMP)
        }
        paint.shader = hueShader
        canvas.drawRoundRect(strip, strip.height() / 2, strip.height() / 2, paint)
        paint.shader = null
        val sx = square.left + hsv[1] * square.width()
        val sy = square.top + (1f - hsv[2]) * square.height()
        drawKnob(canvas, sx, sy, Color.HSVToColor(hsv))
        val hx = strip.left + hsv[0] / 360f * strip.width()
        drawKnob(canvas, hx, strip.centerY(), Color.HSVToColor(floatArrayOf(hsv[0], 1f, 1f)))
    }

    private var squareShader: Shader? = null
    private var hueShader: Shader? = null

    private fun drawKnob(canvas: Canvas, x: Float, y: Float, color: Int) {
        paint.color = color
        canvas.drawCircle(x, y, 10 * density, paint)
        knob.strokeWidth = 3 * density
        knob.color = Color.WHITE
        canvas.drawCircle(x, y, 11 * density, knob)
        knob.strokeWidth = density
        knob.color = 0x66000000
        canvas.drawCircle(x, y, 12.5f * density, knob)
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        parent?.requestDisallowInterceptTouchEvent(true)
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> dragging = if (event.y >= strip.top - 8 * density) 2 else 1
            MotionEvent.ACTION_CANCEL -> {
                dragging = 0
                return true
            }
        }
        if (dragging == 1) {
            hsv[1] = ((event.x - square.left) / square.width()).coerceIn(0f, 1f)
            hsv[2] = (1f - (event.y - square.top) / square.height()).coerceIn(0f, 1f)
        } else if (dragging == 2) {
            hsv[0] = ((event.x - strip.left) / strip.width() * 360f).coerceIn(0f, 359.9f)
        }
        invalidate()
        val done = event.actionMasked == MotionEvent.ACTION_UP
        onColor(hex(), done)
        if (done) dragging = 0
        return true
    }
}
