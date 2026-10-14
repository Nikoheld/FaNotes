package ch.fasrv.fanotes.ink

import kotlin.math.abs
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class DraftingToolsTest {
    @Test
    fun a4ColumnIs210Millimetres() {
        assertEquals(1.0, mmToNorm(210.0, 900.0), 1e-12)
    }

    @Test
    fun penAboveTheRulerLandsOnTheTopEdge() {
        val pose = DraftingPose(0.5, 0.5, 0.0)
        val edge = rulerDrawingEdges(pose, 900.0, 1273.0).first()
        val above = mmToNormPoint(0.0, -rulerWidth(pose) / 2 - 2.0, pose, 900.0, 1273.0)
        val snap = snapToDraftingTools(above.x, above.y, listOf(DraftingToolState(DraftingKind.RULER, pose)), 900.0, 1273.0)
        assertNotNull(snap)
        assertEquals(edge.ay, snap.y, 1e-9)
        assertEquals(0.5, snap.x, 1e-6)
        assertEquals(DraftingKind.RULER, snap.kind)
    }

    @Test
    fun penUnderTheRulerStillDrawsOnAnEdge() {
        val pose = DraftingPose(0.5, 0.5, 0.0)
        val edge = rulerDrawingEdges(pose, 900.0, 1273.0).first()
        val inside = mmToNormPoint(10.0, -6.0, pose, 900.0, 1273.0)
        assertTrue(pointInsideRuler(inside.x, inside.y, pose, 900.0, 1273.0))
        val snap = snapToDraftingTools(inside.x, inside.y, listOf(DraftingToolState(DraftingKind.RULER, pose)), 900.0, 1273.0)
        assertNotNull(snap)
        assertEquals(edge.ay, snap.y, 1e-9)
    }

    @Test
    fun compassCircleStaysRoundAndCloses() {
        val pose = DraftingPose(0.5, 0.5, 0.0, radiusMm = 35.0)
        val pencil = compassPencilPoint(pose, 900.0, 1273.0)
        assertEquals(0.5 + mmToNorm(35.0, 900.0), pencil.x, 1e-9)
        assertEquals(0.5, pencil.y, 1e-9)
        val circle = sampleCompassCircle(pose, 900.0, 1273.0)
        assertTrue(circle.size > 8)
        assertEquals(circle.first().x, circle.last().x, 1e-9)
        assertEquals(circle.first().y, circle.last().y, 1e-9)
        val mid = circle[circle.size / 2]
        assertEquals(35.0, radiusMmBetween(0.5, 0.5, mid.x, mid.y, 900.0, 1273.0), 0.05)
    }

    @Test
    fun setSquareLiesDownOnANearbyRuler() {
        val ruler = DraftingPose(0.5, 0.5, 0.0)
        val top = rulerDrawingEdges(ruler, 900.0, 1273.0).first()
        val square = DraftingPose(0.5, top.ay - mmToNorm(2.0, 1273.0), 0.0)
        val attached = attachSetSquareToRuler(square, ruler, 900.0, 1273.0)
        assertNotNull(attached)
        assertEquals(top.ay, attached.y, 1e-6)
        assertTrue(abs(attached.rotation) < 1e-6)
    }

    @Test
    fun aToolThatStartsOffTheSheetIsPulledBack() {
        val kept = keepPoseOnSheet(DraftingKind.RULER, defaultRulerPose().copy(x = -1.0), 900.0, 1273.0)
        assertTrue(kept.x > 0.0)
        assertTrue(kept.x < 1.0)
    }
}
