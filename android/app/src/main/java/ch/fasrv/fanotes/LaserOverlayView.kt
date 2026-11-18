package ch.fasrv.fanotes

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.os.SystemClock
import android.view.View
import ch.fasrv.fanotes.ink.LASER_CORE_ARGB
import ch.fasrv.fanotes.ink.LASER_DOT_ARGB
import ch.fasrv.fanotes.ink.LASER_HALO_ARGB
import ch.fasrv.fanotes.ink.LASER_TRAIL_RGB
import ch.fasrv.fanotes.ink.LaserTrail
import ch.fasrv.fanotes.ink.laserSegmentAlpha

/**
 * The laser pointer (desktop `paintLaserPointer`): a fading red trail and a bright head while the pen
 * is down. A transparent layer over the page, so a laser sample redraws only this view, not the page
 * and its ink tiles. It never takes touches.
 */
internal class LaserOverlayView(context: Context) : View(context) {
    private val trail = LaserTrail()
    private val line = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
    }
    private val dot = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val density = resources.displayMetrics.density

    init {
        isClickable = false
        isFocusable = false
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
        setWillNotDraw(false)
    }

    /** Phase 0 down, 1 move, 2 up (x/y ignored). Times are uptime milliseconds. */
    fun sample(x: Float, y: Float, t: Long, phase: Int) {
        when (phase) {
            0 -> {
                trail.live = true
                trail.push(x, y, t)
            }
            1 -> trail.push(x, y, t)
            else -> trail.live = false
        }
        postInvalidateOnAnimation()
    }

    fun clear() {
        trail.clear()
        invalidate()
    }

    override fun onTouchEvent(event: android.view.MotionEvent?): Boolean = false

    override fun onDraw(canvas: Canvas) {
        val now = SystemClock.uptimeMillis()
        val more = trail.trim(now)
        line.strokeWidth = 2.4f * density
        for (index in 1 until trail.size) {
            val alpha = laserSegmentAlpha(now - trail.t(index))
            if (alpha <= 0f) continue
            line.color = ((alpha * 255f).toInt().coerceIn(0, 255) shl 24) or LASER_TRAIL_RGB
            canvas.drawLine(trail.x(index - 1), trail.y(index - 1), trail.x(index), trail.y(index), line)
        }
        if (trail.live && trail.size > 0) {
            val x = trail.x(trail.size - 1)
            val y = trail.y(trail.size - 1)
            dot.color = LASER_HALO_ARGB
            canvas.drawCircle(x, y, 10f * density, dot)
            dot.color = LASER_DOT_ARGB
            canvas.drawCircle(x, y, 5f * density, dot)
            dot.color = LASER_CORE_ARGB
            canvas.drawCircle(x, y, 2f * density, dot)
        }
        // Keep fading after the lift; stop asking for frames once the trail is gone.
        if (more && (trail.size > 1 || !trail.live)) postInvalidateOnAnimation()
    }
}
