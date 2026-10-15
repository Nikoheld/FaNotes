package ch.fasrv.fanotes.ink

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
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
}