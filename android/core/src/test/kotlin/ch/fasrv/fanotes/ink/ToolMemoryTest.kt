package ch.fasrv.fanotes.ink

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class ToolMemoryTest {
    @Test
    fun missingOrForeignTextIsTheDefaults() {
        assertEquals(InkToolMemory(), decodeToolMemory(null))
        assertEquals(InkToolMemory(), decodeToolMemory("{\"tool\":\"pen\"}"))
        assertEquals(DEFAULT_DRAWING_STYLE, decodeToolMemory("v1|drawing").drawing)
    }

    @Test
    fun modesKeepTheirOwnPen() {
        val writingPen = StrokeStyle(color = "#202333", baseWidth = 2.4)
        val (drawing, art) = InkToolMemory().switchMode(INK_MODE_DRAWING, writingPen)
        assertEquals(INK_MODE_DRAWING, drawing.inkMode)
        assertEquals(DEFAULT_DRAWING_STYLE, art)
        val painted = styleWithBrush(art, "watercolor").copy(color = "#d83b52", colorEffect = "aurora", opacity = 0.5)
        val (writing, pen) = drawing.switchMode(INK_MODE_WRITING, painted)
        assertEquals(writingPen.copy(purpose = "handwriting"), pen)
        assertEquals("watercolor", writing.drawing.brush)
        assertEquals(20.0, writing.drawing.baseWidth)
        assertEquals("aurora", writing.drawing.colorEffect)
        assertEquals("art", writing.drawing.purpose)
        val (_, back) = writing.switchMode(INK_MODE_DRAWING, pen)
        assertEquals(writing.drawing, back)
    }

    @Test
    fun writingPenIsSolidHandwriting() {
        val style = sanitizeModeStyle(StrokeStyle(color = "#ABC", baseWidth = 40.0, colorEffect = "gold", opacity = 0.4, purpose = "art"), INK_MODE_WRITING)
        assertEquals("#aabbcc", style.color)
        assertEquals(WRITING_WIDTH_MAX, style.baseWidth)
        assertEquals("solid", style.colorEffect)
        assertNull(style.opacity)
        assertEquals("handwriting", style.purpose)
    }

    @Test
    fun encodingRoundTrips() {
        val memory = InkToolMemory(
            inkMode = INK_MODE_DRAWING,
            writing = StrokeStyle(color = "#2457d6", baseWidth = 3.5, pressureEnabled = true, brush = "pencil"),
            drawing = DEFAULT_DRAWING_STYLE.copy(brush = "spray", baseWidth = 26.0, opacity = 0.7, colorEffect = "neon"),
            recentColors = listOf("#112233", "#445566"),
        )
        val text = encodeToolMemory(memory)
        assertEquals("v1|drawing|w=#2457d6,3.5,1,pencil,,solid|d=#3478df,26,0,spray,0.7,neon|r=#112233;#445566", text)
        assertEquals(memory, decodeToolMemory(text))
    }

    @Test
    fun decodingClampsBadValues() {
        val memory = decodeToolMemory("v1|drawing|d=#zzzzzz,900,0,laser,0.01,plasma|r=#12;nope;#ABCDEF")
        assertEquals(DEFAULT_DRAWING_STYLE.color, memory.drawing.color)
        assertEquals(DRAWING_WIDTH_MAX, memory.drawing.baseWidth)
        assertEquals("fineliner", memory.drawing.brush)
        assertEquals(DRAWING_OPACITY_MIN, memory.drawing.opacity)
        assertEquals("solid", memory.drawing.colorEffect)
        assertEquals(listOf("#abcdef"), memory.recentColors)
    }

    @Test
    fun recentColoursAreNewestFirstWithoutDuplicates() {
        var recent = emptyList<String>()
        for (color in listOf("#111111", "#222222", "#111111", "nope")) recent = pushRecentColor(recent, color)
        assertEquals(listOf("#111111", "#222222"), recent)
        repeat(12) { recent = pushRecentColor(recent, "#0000%02x".format(it)) }
        assertEquals(TOOL_MEMORY_RECENT_MAX, recent.size)
        assertEquals("#00000b", recent.first())
    }

    @Test
    fun brushChoiceUsesTheDesktopDefaults() {
        val style = styleWithBrush(StrokeStyle(color = "#ff0000"), "highlighter")
        assertEquals("highlighter", style.brush)
        assertEquals(22.0, style.baseWidth)
        assertEquals(false, style.pressureEnabled)
        assertEquals("#ff0000", style.color)
    }
}
