package ch.fasrv.fanotes.ink

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

class InkBrushesTest {
    @Test
    fun brushesUseTheDesktopDefaultsAndPaintPasses() {
        assertEquals(8, ART_BRUSHES.size)
        assertEquals(22.0, artBrush("highlighter").defaultWidth)
        assertFalse(artBrush("highlighter").pressure)
        assertEquals(26.0, artBrush("spray").defaultWidth)
        assertTrue(artBrush("pencil").pressure)
        assertEquals("Fineliner", artBrush(null).label)
        val pencil = brushPasses("pencil")
        assertEquals(3, pencil.size)
        assertEquals(0.72, pencil[0].widthFactor)
        assertEquals(0.58, pencil[0].alpha)
        assertEquals(1.4, pencil[1].jitter)
        val water = brushPasses("watercolor")
        assertEquals(1.48, water[0].widthFactor)
        assertEquals(0.11, water[0].alpha)
        assertEquals(0.9, brushPasses("marker").single().alpha)
        assertEquals(0.34, brushPasses("highlighter").single().alpha)
        assertEquals(1.0, brushPasses("fineliner").single().widthFactor)
    }

    @Test
    fun aMarkerCornerFilletsInsideTheNib() {
        val straight = markerCenterline(listOf(0.0, 10.0), listOf(0.0, 0.0), 8.0, 1.0)
        assertEquals(2, straight.size)
        val aligned = markerCenterline(listOf(0.0, 50.0, 100.0), listOf(0.0, 0.0, 0.0), 20.0, 1.0)
        assertTrue(aligned.none { it is MarkerCommand.Quad })
        val corner = markerCenterline(listOf(0.0, 100.0, 100.0), listOf(0.0, 0.0, 100.0), 20.0, 1.0)
        val quad = corner.filterIsInstance<MarkerCommand.Quad>().single()
        assertEquals(100.0, quad.cx, 0.001)
        assertEquals(0.0, quad.cy, 0.001)
        assertEquals(100.0, quad.x, 0.001)
        assertEquals(24.042, quad.y, 0.01)
        assertTrue(corner.last() is MarkerCommand.Line)
    }

    @Test
    fun theCalligraphyNibSlantsLikeTheDesktopBroadPen() {
        val offset = calligraphyNibOffset(10.0)
        assertEquals(kotlin.math.cos(CALLIGRAPHY_ANGLE) * 5.0, offset.x, 1e-9)
        assertEquals(kotlin.math.sin(CALLIGRAPHY_ANGLE) * 5.0, offset.y, 1e-9)
        assertTrue(offset.y < 0.0)
        assertEquals(5.0, calligraphyDotRadii(10.0).first, 1e-9)
        assertEquals(1.6, calligraphyDotRadii(10.0).second, 1e-9)
        assertEquals(0.5, calligraphyDotRadii(1.0).second, 1e-9)
    }

    @Test
    fun pencilGrainShiftsEachSegmentOnItsOwn() {
        assertEquals(0.0, pencilJitterOffset(1, 1, 1, 0.0).first, 0.0)
        assertNotEquals(pencilJitterOffset(1, 1, 1, 1.4), pencilJitterOffset(1, 2, 1, 1.4))
        assertNotEquals(pencilJitterOffset(1, 1, 1, 1.4), pencilJitterOffset(1, 1, 2, 1.4))
        val straight = listOf(
            StrokePoint(0.0, 0.0, 0.0, 0.5, 0.0, 0.0, "pen"),
            StrokePoint(1.0, 0.0, 1.0, 0.5, 0.0, 0.0, "pen"),
        )
        val segment = pencilGrainSegments(straight, 100.0, 100.0, 0.0, 3.0, true, 0.22, 1, 1, 0.0, 1.0).single()
        assertEquals(0.0, segment.startX, 1e-9)
        assertEquals(100.0, segment.endX, 1e-9)
        assertEquals(null, segment.controlX)
        val width = maxOf(1.0, pressureWidth(3.0, 0.5, true)) * 0.22
        assertEquals(width, segment.width, 1e-9)
        val turn = straight + StrokePoint(0.0, 1.0, 2.0, 0.5, 0.0, 0.0, "pen")
        val curved = pencilGrainSegments(turn, 100.0, 100.0, 1.0, 3.0, true, 0.22, 1, 1, 0.0, 1.0)
        assertEquals(2, curved.size)
        assertEquals(100.0, curved[0].controlX)
        assertTrue(curved[0].endX < 100.0)
        val shifted = pencilGrainSegments(straight, 100.0, 100.0, 0.0, 3.0, true, 0.22, 1, 1, 1.4, 1.0).single()
        assertEquals(pencilJitterOffset(1, 1, 1, 1.4).first, shifted.startX, 1e-9)
    }

    @Test
    fun constantWidthDropsATinyPenUpStub() {
        val points = listOf(
            StrokePoint(0.0, 0.0, 0.0, 0.5, 0.0, 0.0, "pen"),
            StrokePoint(1.0, 0.0, 1.0, 0.5, 0.0, 0.0, "pen"),
            StrokePoint(1.001, 0.0, 2.0, 0.5, 0.0, 0.0, "pen"),
        )
        val stroke = constantWidthStroke(points, 100.0, 100.0, 0.0, 10.0, false, 1.0, 1.0)
        assertEquals(listOf(0.0, 100.0), stroke?.commands?.map {
            when (it) {
                is StrokeCommand.Move -> it.x
                is StrokeCommand.Line -> it.x
                is StrokeCommand.Quad -> it.x
            }
        })
        val kept = constantWidthStroke(
            points.dropLast(1) + StrokePoint(2.0, 0.0, 2.0, 0.5, 0.0, 0.0, "pen"),
            100.0, 100.0, 0.0, 10.0, false, 1.0, 1.0,
        )
        assertEquals(3, kept?.commands?.size)
        val light = StrokePoint(0.0, 0.0, 0.0, 0.1, 0.0, 0.0, "pen")
        val heavy = StrokePoint(1.0, 0.0, 1.0, 1.0, 0.0, 0.0, "pen")
        val soft = pencilGrainSegments(listOf(light, light.copy(x = 1.0)), 100.0, 100.0, 0.0, 4.0, true, 1.0, 1, 0, 0.0, 1.0).single().width
        val firm = pencilGrainSegments(listOf(heavy, heavy.copy(x = 1.0)), 100.0, 100.0, 0.0, 4.0, true, 1.0, 1, 0, 0.0, 1.0).single().width
        assertTrue(firm > soft)
        assertEquals(5.0, strokeDotRadius(10.0, 0.5, false, 1.0), 1e-9)
    }
}