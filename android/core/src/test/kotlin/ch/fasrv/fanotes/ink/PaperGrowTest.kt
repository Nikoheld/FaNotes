package ch.fasrv.fanotes.ink

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class PaperGrowTest {
    @Test
    fun theFarEdgeGrowsInMarginStepsAndTheNearEdgeInsertsAPad() {
        assertEquals(PAGE_START_HEIGHT, growWriteExtent(0.4, PAGE_START_HEIGHT, WRITE_MARGIN_Y, GROW_STEP_Y))
        assertEquals(PAGE_START_HEIGHT, growWriteExtent(0.55, PAGE_START_HEIGHT, WRITE_MARGIN_Y, GROW_STEP_Y))
        val bottom = growWriteExtent(0.94, PAGE_START_HEIGHT, WRITE_MARGIN_Y, GROW_STEP_Y)
        assertEquals(1440.0, bottom)
        assertEquals(1584.0, growWriteExtent(0.94, bottom, WRITE_MARGIN_Y, GROW_STEP_Y))
        assertEquals(PAGE_START_WIDTH, growWriteExtent(0.5, PAGE_START_WIDTH, WRITE_MARGIN_X, GROW_STEP_X))
        assertTrue(growWriteExtent(0.94, PAGE_START_WIDTH, WRITE_MARGIN_X, GROW_STEP_X) > PAGE_START_WIDTH)
        assertEquals(PAGE_START_HEIGHT, growWriteExtent(null, PAGE_START_HEIGHT, WRITE_MARGIN_Y, GROW_STEP_Y))
        assertEquals(PAGE_START_HEIGHT, growWriteExtent(Double.NaN, PAGE_START_HEIGHT, WRITE_MARGIN_Y, GROW_STEP_Y))
        assertEquals(0.0, growWriteOrigin(0.5, PAGE_START_WIDTH, WRITE_MARGIN_X, GROW_STEP_X))
        assertEquals(108.0, growWriteOrigin(0.1, PAGE_START_WIDTH, WRITE_MARGIN_X, GROW_STEP_X))

        val grown = growPageFromMark(PAGE_START_WIDTH, PAGE_START_HEIGHT, 0.0, 0.0, 0.1, 0.5)
        assertEquals(108.0, grown.padX)
        assertEquals(0.0, grown.padY)
        assertEquals(PAGE_START_WIDTH + 108.0, grown.width)
        assertEquals(PAGE_START_HEIGHT, grown.height)
        val again = growPageFromMark(grown.width, grown.height, grown.padX, 0.0, keepMarkOnPage(0.1, PAGE_START_WIDTH, grown.width, grown.padX), 0.5)
        assertEquals(0.0, again.padX)
    }

    @Test
    fun anExistingMarkKeepsItsPagePixelWhenTheLeftMarginAppears() {
        val document = newInkDocument("Seite", "dots", "2026-01-01T00:00:00.000Z").copy(
            strokes = listOf(
                InkStroke(
                    points = listOf(StrokePoint(0.5, 0.4, 0.0, 0.5, 0.0, 0.0, "pen")),
                    baseWidth = 3.5,
                    pressureEnabled = true,
                    color = "#202333",
                ),
            ),
        )
        val beforeX = 0.5 * document.sourceWidth
        val grown = growDocument(document, 0.1 * document.sourceWidth, 0.5 * document.sourceHeight)
        val point = grown.document.strokes.single().points.single()
        assertEquals(beforeX + 108.0, point.x * grown.document.sourceWidth, 0.01)
        assertEquals(108.0, grown.document.originX)
        assertEquals(0.0, grown.document.originY)
        val json = grown.document.toJson()
        assertEquals(108.0, json.double("sourceOriginX"))
        val restored = parseInkDocument(json, "Seite", "dots", "2026-01-01T00:00:00.000Z")
        assertEquals(108.0, restored.originX)
        assertEquals(PAGE_START_WIDTH + 108.0, restored.sourceWidth)
    }
}
