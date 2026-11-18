package ch.fasrv.fanotes.desk

import ch.fasrv.fanotes.ink.InkStroke
import ch.fasrv.fanotes.ink.StrokePoint
import kotlin.random.Random
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class InkRasterBoundsTest {
    private fun point(x: Double, y: Double) = StrokePoint(x, y, 0.0, 0.5, 0.0, 0.0, "pen")

    /** The per-sample test the tile cache used before the bounds cache. */
    private fun anySampleNear(points: List<StrokePoint>, width: Double, height: Double, pad: Double, x: Int, y: Int, tile: Int) =
        points.any { p ->
            val px = p.x * width
            val py = p.y * height
            px >= x - pad && px <= x + tile + pad && py >= y - pad && py <= y + tile + pad
        }

    @Test
    fun boundsSpanEverySample() {
        assertNull(strokeSampleBounds(emptyList()))
        val bounds = strokeSampleBounds(listOf(point(0.4, 0.2), point(0.1, 0.9), point(0.7, 0.5)))!!
        assertEquals(listOf(0.1, 0.2, 0.7, 0.9), bounds.toList())
    }

    @Test
    fun theBoundsTestNeverDropsATileTheSampleTestKept() {
        val random = Random(42)
        repeat(300) {
            val points = List(1 + random.nextInt(30)) { point(random.nextDouble(), random.nextDouble()) }
            val bounds = strokeSampleBounds(points)!!
            for (tileY in 0 until 1800 step 192) for (tileX in 0 until 1300 step 192) {
                if (anySampleNear(points, 1240.0, 1754.0, 40.0, tileX, tileY, 192)) {
                    assertTrue(boundsNearTile(bounds, 1240.0, 1754.0, 40.0, tileX, tileY, 192))
                }
            }
        }
    }

    @Test
    fun aLongStraightSegmentReachesTheTilesBetweenItsEnds() {
        val line = listOf(point(0.0, 0.1), point(1.0, 0.1))
        val bounds = strokeSampleBounds(line)!!
        // A tile in the middle of the line holds no sample but the ink crosses it.
        assertFalse(anySampleNear(line, 1240.0, 1754.0, 40.0, 576, 128, 192))
        assertTrue(boundsNearTile(bounds, 1240.0, 1754.0, 40.0, 576, 128, 192))
        assertFalse(boundsNearTile(bounds, 1240.0, 1754.0, 40.0, 576, 960, 192))
    }

    @Test
    fun symbolsAndFiguresPadByTheirSize() {
        val ink = InkStroke(listOf(point(0.5, 0.5)), 3.0, true, "#000000")
        assertEquals(40.0, tileStrokePad(ink))
        assertEquals(64.0, tileStrokePad(ink.copy(baseWidth = 64.0, symbolId = "star")))
        assertEquals(30.0, tileStrokePad(ink.copy(baseWidth = 28.0, figurePaths = listOf("M0 0L1 1"), figureLineWidth = 2.0)))
    }

    @Test
    fun theBoundsCacheReusesBoxesOfStrokesItAlreadySaw() {
        val a = InkStroke(listOf(point(0.1, 0.1), point(0.2, 0.3)), 3.0, true, "#000000")
        val b = InkStroke(listOf(point(0.5, 0.5)), 3.0, true, "#000000")
        val c = InkStroke(listOf(point(0.9, 0.8), point(0.6, 0.95)), 3.0, true, "#000000")
        val cache = StrokeBoundsCache()
        val first = cache.table(listOf(a, b))
        assertEquals(listOf(0.1, 0.1, 0.2, 0.3), first[0]!!.toList())
        val appended = cache.table(listOf(a, b, c))
        assertTrue(first[0] === appended[0] && first[1] === appended[1])
        assertEquals(listOf(0.6, 0.8, 0.9, 0.95), appended[2]!!.toList())
        // Erasing the first stroke shifts the rest; their boxes are still reused, not recomputed.
        val erased = cache.table(listOf(b, c))
        assertTrue(erased[0] === appended[1] && erased[1] === appended[2])
        val empty = InkStroke(emptyList(), 3.0, true, "#000000")
        assertNull(cache.table(listOf(empty))[0])
    }
}
