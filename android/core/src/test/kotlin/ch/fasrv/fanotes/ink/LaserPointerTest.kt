package ch.fasrv.fanotes.ink

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class LaserPointerTest {
    @Test
    fun barelyMovingHeadOnlyRefreshesItsTime() {
        val trail = LaserTrail()
        trail.push(10f, 10f, 0)
        trail.push(11f, 10.5f, 16)
        assertEquals(1, trail.size)
        assertEquals(16L, trail.t(0))
        trail.push(14f, 10f, 32)
        assertEquals(2, trail.size)
    }

    @Test
    fun trailIsCappedAtTheDesktopSampleCount() {
        val trail = LaserTrail()
        for (i in 0 until 100) trail.push(i * 5f, 0f, i.toLong())
        assertEquals(LASER_MAX_SAMPLES, trail.size)
        assertEquals((100 - LASER_MAX_SAMPLES) * 5f, trail.x(0))
        assertEquals(99 * 5f, trail.x(trail.size - 1))
    }

    @Test
    fun oldSamplesFadeOutOfTheTrail() {
        val trail = LaserTrail()
        trail.push(0f, 0f, 0)
        trail.push(10f, 0f, 200)
        trail.push(20f, 0f, 390)
        assertEquals(2, trail.size)
        assertEquals(10f, trail.x(0))
        assertTrue(trail.trim(500))
        assertFalse(trail.trim(390 + LASER_TRAIL_MS + 1))
        assertEquals(0, trail.size)
        trail.live = true
        assertTrue(trail.trim(10_000))
    }

    @Test
    fun segmentAlphaFadesFromTheDesktopMaximum() {
        assertEquals(0.85f, laserSegmentAlpha(0))
        assertEquals(0f, laserSegmentAlpha(LASER_TRAIL_MS))
        assertEquals(0f, laserSegmentAlpha(LASER_TRAIL_MS * 2))
        assertEquals(0.425f, laserSegmentAlpha(LASER_TRAIL_MS / 2), 0.001f)
    }
}
