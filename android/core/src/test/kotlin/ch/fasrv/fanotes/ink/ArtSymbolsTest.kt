package ch.fasrv.fanotes.ink

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ArtSymbolsTest {
    @Test
    fun symbolsMatchTheDesktopCatalogAndRoundTrip() {
        assertEquals(25, ART_SYMBOLS.size)
        assertEquals("Stern", artSymbol("star")?.label)
        assertEquals(2, artSymbol("book")?.paths?.size)
        assertNull(artSymbol("missing"))
        assertEquals("book", nextArtSymbol(null))
        assertNull(nextArtSymbol(ART_SYMBOLS.last().id))
        val stroke = InkStroke(
            points = listOf(StrokePoint(0.4, 0.6, 1.0, 0.5, 0.0, 0.0, "pen")),
            baseWidth = ART_SYMBOL_SIZE,
            pressureEnabled = false,
            color = "#3478df",
            purpose = "art",
            symbolId = "heart",
            symbolRotation = 15.0,
        )
        val document = newInkDocument("Symbole", "blank", "2026-01-01T00:00:00.000Z").copy(strokes = listOf(stroke))
        val restored = parseInkDocument(document.toJson(), "Symbole", "blank", "2026-01-01T00:00:00.000Z")
        assertEquals("heart", restored.strokes.single().symbolId)
        assertEquals(15.0, restored.strokes.single().symbolRotation)
        assertEquals("art", restored.strokes.single().purpose)
    }

    @Test
    fun sprayUsesTheDesktopParticleCount() {
        val dots = sprayDots(0.0, 0.0, 10.0, 0.0, 5.0, 10.0, 1, 0, 1.0)
        assertEquals(7, dots.size)
        assertTrue(dots.all { it.alpha in 0.2..0.7 })
        assertTrue(dots.all { it.radius >= 0.35 })
    }
}
