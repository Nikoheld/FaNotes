package ch.fasrv.fanotes.ink

import kotlin.math.hypot

/**
 * Screen-space laser pointer trail, ported from `fanotes/src/lib/laserPointer.ts`.
 * Samples are view pixels and milliseconds. Nothing here is ink and nothing is stored in the note.
 */
const val LASER_TRAIL_MS = 380L
const val LASER_MAX_SAMPLES = 48
/** Head moves shorter than this (px) only refresh its time, like the desktop's 2 CSS px. */
const val LASER_MIN_STEP_PX = 2f

/**
 * Fixed-size ring of the newest samples. [push] keeps the head, refreshes it when the pointer barely
 * moved, caps the trail at [LASER_MAX_SAMPLES] and drops samples older than [LASER_TRAIL_MS]. No
 * allocation per sample, since a stylus reports up to 240 of them a second.
 */
class LaserTrail(private val capacity: Int = LASER_MAX_SAMPLES, private val minStep: Float = LASER_MIN_STEP_PX) {
    private val xs = FloatArray(capacity)
    private val ys = FloatArray(capacity)
    private val ts = LongArray(capacity)
    private var head = 0
    var size = 0
        private set

    /** True while the pointer is down: the bright head dot is drawn. */
    var live = false

    fun x(index: Int) = xs[slot(index)]
    fun y(index: Int) = ys[slot(index)]
    fun t(index: Int) = ts[slot(index)]

    private fun slot(index: Int) = (head + index) % capacity

    fun push(x: Float, y: Float, t: Long) {
        if (size > 0) {
            val last = slot(size - 1)
            if (hypot((x - xs[last]).toDouble(), (y - ys[last]).toDouble()) < minStep) {
                ts[last] = t
                trim(t)
                return
            }
        }
        if (size == capacity) {
            head = (head + 1) % capacity
            size -= 1
        }
        val at = slot(size)
        xs[at] = x
        ys[at] = y
        ts[at] = t
        size += 1
        trim(t)
    }

    /** Drops samples older than the trail. Returns true while something is left to draw. */
    fun trim(now: Long, trailMs: Long = LASER_TRAIL_MS): Boolean {
        val cutoff = now - trailMs
        while (size > 0 && ts[head] < cutoff) {
            head = (head + 1) % capacity
            size -= 1
        }
        return size > 0 || live
    }

    fun clear() {
        head = 0
        size = 0
        live = false
    }
}

/** Opacity of the trail segment ending at a sample of age [ageMs]: 0.85 fading to 0 (desktop). */
fun laserSegmentAlpha(ageMs: Long, trailMs: Long = LASER_TRAIL_MS): Float {
    val alpha = 1f - ageMs.toFloat() / trailMs.toFloat()
    return (alpha.coerceIn(0f, 1f) * 0.85f)
}

/** Desktop colours: red trail, translucent halo, red dot with a white core. */
const val LASER_TRAIL_RGB = 0xFF2A30
const val LASER_HALO_ARGB = 0x59FF2A2A
const val LASER_DOT_ARGB = 0xFFFF2A2A.toInt()
const val LASER_CORE_ARGB = 0xFFFFFFFF.toInt()
