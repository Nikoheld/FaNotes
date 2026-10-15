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
        val again = insertSection(inserted, (section.top + section.bodyTop) / 2)
        assertEquals(SECTION_PLACE_BLOCKED, sectionInsertNotice(inserted, again))
        assertEquals(1, sectionsOf(again).size)
        val second = insertSection(inserted, 0.8)
        assertEquals(SECTION_PLACE_DONE, sectionInsertNotice(inserted, second))
        assertEquals(2, sectionsOf(second).size)
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
        val half = InkStroke(
            listOf(
                StrokePoint(0.5, 0.5, 0.0, 0.4, 0.0, 0.0, "pen"),
                StrokePoint(0.0, 0.0, 0.0, 0.4, 0.0, 0.0, "pen"),
                StrokePoint(0.0, 1.0, 0.0, 0.4, 0.0, 0.0, "pen"),
            ),
            2.0,
            false,
            "#000000",
        )
        assertEquals(emptySet(), lassoHits(listOf(half), loop))
        val moved = applyLasso(listOf(stroke), setOf(0), "move")
        assertEquals(0.54, moved.single().points.single().x, 1e-9)
        val copied = applyLasso(listOf(stroke), setOf(0), "copy")
        assertEquals(2, copied.size)
        assertEquals("#2457d6", applyLasso(listOf(stroke), setOf(0), "recolor", color = "#2457d6").single().color)
        assertEquals(emptyList(), applyLasso(listOf(stroke), setOf(0), "delete"))
        assertEquals("Auswahl verschoben.", lassoActionNotice("move"))
        assertEquals(SELECT_DRAG_NOTICE, SELECT_DRAG_NOTICE)
    }
}
