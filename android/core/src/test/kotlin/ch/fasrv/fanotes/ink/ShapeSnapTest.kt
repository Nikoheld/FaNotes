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
        assertTrue(strokeLooksLikeShape(points, 1000.0, 800.0, 50))
        assertEquals("Kreis erkannt · Stift heben übernimmt die saubere Form.", shapeRecognizedNotice("circle"))
    }

    @Test
    fun aHoldHintsBeforeItSnapsAndAMoveRestartsTheClock() {
        val profile = shapeSnapProfile(50)
        assertEquals(700, profile.dwellMs)
        assertEquals(260, profile.hintMs)
        val watch = ShapeSnapWatch()
        watch.begin(0)
        assertEquals(260L, watch.onSample(0, 12.0, canArm = true, profile))
        val hint = watch.onDue(260, profile, looksLikeShape = true)
        assertTrue(hint.showHint)
        assertTrue(!hint.trySnap)
        assertEquals(440L, hint.waitMs)
        val early = watch.onDue(400, profile, looksLikeShape = true)
        assertTrue(!early.trySnap)
        assertEquals(300L, early.waitMs)
        val snap = watch.onDue(700, profile, looksLikeShape = true)
        assertTrue(snap.trySnap)
        assertEquals(null, watch.noteSnap(success = true, 700))
        watch.begin(1_000)
        assertEquals(260L, watch.onSample(1_000, 8.0, canArm = true, profile))
        assertEquals(260L, watch.onSample(1_100, 4.0, canArm = true, profile))
        val restarted = watch.onDue(1_360, profile, looksLikeShape = false)
        assertTrue(!restarted.showHint)
        assertEquals(440L, restarted.waitMs)
    }
}