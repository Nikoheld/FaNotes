package ch.fasrv.fanotes.ink

import kotlin.math.cos
import kotlin.math.sin
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ShapeSnapTest {
    @Test
    fun aStraightStrokeBecomesALineAndArtDoesNotSnap() {
        val points = (0 until 18).map { index ->
            val t = index / 17.0
            StrokePoint(0.12 + t * 0.62, 0.42, index.toDouble(), 0.5, 0.0, 0.0, "pen")
        }
        val snapped = snapStrokeToShape(points, 1000.0, 800.0, 50)
        assertEquals("line", snapped?.kind)
        val ys = snapped!!.points.map { it.y }.distinct()
        assertEquals(1, ys.size)
        assertTrue(inkStrokeAllowsShapeSnap("handwriting", null))
        assertTrue(!inkStrokeAllowsShapeSnap("art", null))
        assertTrue(!shapeSnapAllowsLiveSample(true))
    }

    @Test
    fun aClosedLoopBecomesACircleAndAScribbleStaysFreehand() {
        val points = (0 until 40).map { index ->
            val angle = index / 39.0 * Math.PI * 2
            StrokePoint(
                (500 + cos(angle) * 90) / 1000.0,
                (400 + sin(angle) * 90) / 800.0,
                index.toDouble(),
                0.5,
                0.0,
                0.0,
                "pen",
            )
        }
        val circle = snapStrokeToShape(points, 1000.0, 800.0, 50)
        assertEquals("circle", circle?.kind)
        val scribble = (0 until 24).map { index ->
            StrokePoint(0.2 + (index % 5) * 0.04, 0.2 + (index % 3) * 0.07, index.toDouble(), 0.4, 0.0, 0.0, "pen")
        }
        assertNull(snapStrokeToShape(scribble, 1000.0, 800.0, 50))
    }
}