package ch.fasrv.fanotes.ink

import ch.fasrv.fanotes.json.JsonValue
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class FigureStampsTest {
    private val writing = StrokeStyle(color = "#2457d6")
    private val drawing = DEFAULT_DRAWING_STYLE.copy(opacity = 0.5, colorEffect = "gold")

    @Test
    fun figureStampCarriesWhatTheDesktopRebuildsFrom() {
        val stroke = assertNotNull(figureStampStroke(FigureStampSpec("cube", defaultFigureParams("cube"), size = 121.0, rotation = 15.0), 0.3, 0.4, writing))
        assertEquals(122.0, stroke.baseWidth)
        assertEquals("art", stroke.purpose)
        assertEquals("solid", stroke.colorEffect)
        assertEquals(1.0, stroke.opacity)
        assertEquals(15.0, stroke.symbolRotation)
        assertEquals(mathFigurePaths("cube", defaultFigureParams("cube")), stroke.figurePaths)
        val json = stroke.toJson()
        assertEquals("cube", json.string("figureId"))
        assertTrue((json["figureParams"] as JsonValue.Obj).fields.isNotEmpty())
        assertNotNull(json.array("figurePaths"))
        val back = assertNotNull(parseStroke(json))
        assertEquals(stroke.figurePaths, back.figurePaths)
        assertEquals("cube", back.extras.string("figureId"))
    }

    @Test
    fun drawingPenGivesItsOpacityAndInk() {
        val stroke = assertNotNull(figureStampStroke(FigureStampSpec("cube", emptyMap()), 0.5, 0.5, drawing))
        assertEquals(0.5, stroke.opacity)
        assertEquals("gold", stroke.colorEffect)
        assertNull(figureStampStroke(FigureStampSpec("nope", emptyMap()), 0.5, 0.5, drawing))
    }

    @Test
    fun graphStampSavesTheFormulaNotFigurePaths() {
        val paths = functionGraphPaths("x^2", -2.0, 2.0)
        val stroke = assertNotNull(graphStampStroke(GraphStampSpec("x^2", -2.0, 2.0, paths), 0.2, 0.2, writing))
        assertEquals(paths, stroke.figurePaths)
        val json = stroke.toJson()
        assertEquals("x^2", json.string("graphExpression"))
        assertEquals(-2.0, json.double("graphXMin"))
        assertNull(json.array("figurePaths"))
        assertEquals(paths.size, json.array("graphPaths")!!.items.size)
        // Read back (also a desktop graph stroke): drawn from its graph paths.
        val back = assertNotNull(parseStroke(json))
        assertEquals(paths, back.figurePaths)
        assertNull(back.toJson().array("figurePaths"))
    }

    @Test
    fun sizeSnapsToTheDesktopSlider() {
        assertEquals(FIGURE_SIZE_MIN, snapFigureSize(3.0))
        assertEquals(FIGURE_SIZE_MAX, snapFigureSize(999.0))
        assertEquals(FIGURE_SIZE_DEFAULT, snapFigureSize(Double.NaN))
        assertEquals(100.0, snapFigureSize(100.9))
    }
}
