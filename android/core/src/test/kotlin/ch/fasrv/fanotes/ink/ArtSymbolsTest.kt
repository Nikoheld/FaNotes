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
        assertEquals("Stern eingefügt · tippe erneut für weitere.", symbolPlacedNotice("Stern"))
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
    fun symbolSizeAndRotationFollowTheDesktopSliders() {
        assertEquals(72.0, artSymbolSizeSetting(null))
        assertEquals(20.0, snapArtSymbolSize(10.0))
        assertEquals(180.0, snapArtSymbolSize(200.0))
        assertEquals(74.0, snapArtSymbolSize(73.0))
        assertEquals(20.0, stepArtSymbolSize(180.0, 1))
        assertEquals(180.0, stepArtSymbolSize(20.0, -1))
        assertEquals(0.0, artSymbolRotationSetting("nope"))
        assertEquals(5.0, snapArtSymbolRotation(3.0))
        assertEquals(-180.0, stepArtSymbolRotation(180.0, 1))
        assertEquals(180.0, stepArtSymbolRotation(-180.0, -1))
        val session = InkSession(newInkDocument("Symbole", "blank", "2026-01-01T00:00:00.000Z"))
        val stamped = session.placeSymbol(0.2, 0.3, StrokeStyle(), "star", "2026-01-01T00:00:00.000Z", 41.0, 12.0)
        assertEquals(42.0, stamped?.baseWidth)
        assertEquals(10.0, stamped?.symbolRotation)
        assertEquals("star", nextArtSymbol("book", "symbols"))
        assertEquals("laptop", nextArtSymbol("pencil", "school"))
        assertNull(nextArtSymbol("laptop", "school"))
        assertEquals("symbols", nextArtSymbolCategory("school"))
        assertEquals(0.12, snapArtSymbolOpacity(0.0))
        assertEquals(1.0, snapArtSymbolOpacity(2.0))
        assertEquals(0.12, stepArtSymbolOpacity(1.0, 1))
        val faded = session.placeSymbol(0.2, 0.4, StrokeStyle(), "heart", "2026-01-01T00:00:00.000Z", opacity = 0.55)
        assertEquals(0.55, faded?.opacity)
    }

    @Test
    fun sprayUsesTheDesktopParticleCount() {
        val dots = sprayDots(0.0, 0.0, 10.0, 0.0, 5.0, 10.0, 1, 0, 1.0)
        assertEquals(7, dots.size)
        assertTrue(dots.all { it.alpha in 0.2..0.7 })
        assertTrue(dots.all { it.radius >= 0.35 })
    }
}
