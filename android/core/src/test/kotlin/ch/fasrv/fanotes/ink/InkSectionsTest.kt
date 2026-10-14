package ch.fasrv.fanotes.ink

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class InkSectionsTest {
    @Test
    fun collapsingHidesTheBodyAndExpandingRestoresIt() {
        val stroke = InkStroke(
            points = listOf(StrokePoint(0.2, 0.6, 0.0, 0.5, 0.0, 0.0, "pen")),
            baseWidth = 3.0,
            pressureEnabled = false,
            color = "#202333",
        )
        val document = newInkDocument("Seite", "dots", "2026-01-01T00:00:00.000Z").copy(strokes = listOf(stroke))
        val inserted = insertSection(document, 0.2)
        val section = sectionsOf(inserted).single()
        val collapsed = toggleSection(inserted, section.id)
        assertTrue(collapsed.strokes.isEmpty())
        assertTrue(sectionsOf(collapsed).single().collapsed)
        val expanded = toggleSection(collapsed, section.id)
        assertEquals(1, expanded.strokes.size)
        assertTrue(!sectionsOf(expanded).single().collapsed)
    }

    @Test
    fun lassoSelectsTheStrokeInsideTheLoop() {
        val stroke = InkStroke(listOf(StrokePoint(0.5, 0.5, 0.0, 0.4, 0.0, 0.0, "pen")), 2.0, false, "#000000")
        val loop = listOf(
            StrokePoint(0.2, 0.2, 0.0, 0.0, 0.0, 0.0, "pen"),
            StrokePoint(0.8, 0.2, 0.0, 0.0, 0.0, 0.0, "pen"),
            StrokePoint(0.8, 0.8, 0.0, 0.0, 0.0, 0.0, "pen"),
            StrokePoint(0.2, 0.8, 0.0, 0.0, 0.0, 0.0, "pen"),
        )
        assertEquals(setOf(0), lassoHits(listOf(stroke), loop))
    }
}
