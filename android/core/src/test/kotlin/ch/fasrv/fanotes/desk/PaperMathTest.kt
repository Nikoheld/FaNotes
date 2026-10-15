package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class PaperMathTest {
    @Test
    fun aDisplayBlockFoldsUntilTheCaretStepsInside() {
        val note = "Vorher\n$$\nx^2\n$$\nNachher"
        val outside = livePreviewMarks(note, 0, 0)
        val card = outside.first { it.kind == LiveKind.MATH_BLOCK }
        assertEquals("x^2", card.label)
        assertEquals(note.indexOf("$$"), card.start)
        assertEquals(note.indexOf("$$") + 2, card.end)
        assertTrue(outside.any { it.kind == LiveKind.HIDE && it.start == note.indexOf("x^2") })
        assertTrue(outside.any { it.kind == LiveKind.COLLAPSE && it.start == note.lastIndexOf("$$") })
        assertFalse(outside.any { it.kind == LiveKind.HIDE && it.start == note.indexOf("Nachher") })

        val inside = livePreviewMarks(note, note.indexOf("x^2"), note.indexOf("x^2"))
        assertFalse(inside.any { it.kind == LiveKind.MATH_BLOCK })
        assertFalse(inside.any { it.kind == LiveKind.HIDE && it.start == note.indexOf("x^2") })

        val onFence = livePreviewMarks(note, note.lastIndexOf("$$"), note.lastIndexOf("$$"))
        assertFalse(onFence.any { it.kind == LiveKind.MATH_BLOCK })
        assertFalse(livePreviewMarks("$$\nx", 0, 0).any { it.kind == LiveKind.MATH_BLOCK })
        assertEquals(emptyList(), displayMathBlocks("\$x\$"))
    }

    @Test
    fun twoBlocksAndAnIndentedFenceStayIndependent() {
        val note = "$$\na\n$$\n\n  $$\nb\n  $$\n"
        val blocks = displayMathBlocks(note)
        assertEquals(listOf("a", "b"), blocks.map { it.source })
        assertTrue(displayMathIntersects(blocks[0], blocks[0].from, blocks[0].from))
        assertFalse(displayMathIntersects(blocks[0], blocks[1].from, blocks[1].from))
        val marks = livePreviewMarks(note, note.length, note.length)
        assertEquals(listOf("a", "b"), marks.filter { it.kind == LiveKind.MATH_BLOCK }.map { it.label })
    }

    @Test
    fun schoolFormulasBecomeFractionsRootsAndScripts() {
        assertEquals("x[^2]", mathNodeShape(layoutDisplayMath("x^2")))
        assertEquals("x[^2_1]", mathNodeShape(layoutDisplayMath("x^2_1")))
        assertEquals("(1)/(2)", mathNodeShape(layoutDisplayMath("\\frac{1}{2}")))
        assertEquals("(a+b)/(c)", mathNodeShape(layoutDisplayMath("\\frac{a+b}{c}")))
        assertEquals("√(x+1)", mathNodeShape(layoutDisplayMath("\\sqrt{x+1}")))
        assertEquals("α+π", mathNodeShape(layoutDisplayMath("\\alpha + \\pi")))
        assertEquals("E=mc[^2]", mathNodeShape(layoutDisplayMath("E = mc^2")))
        assertEquals("sin", mathNodeShape(layoutDisplayMath("\\sin")))
        assertEquals("", mathNodeShape(layoutDisplayMath("   ")))
        assertEquals(mixColors(paperAccentReadable(DEFAULT_ACCENT), "#ffffff", 0.04), paperMathFill(DEFAULT_ACCENT))
        assertEquals(mixColors(paperAccentReadable(DEFAULT_ACCENT), "#232633", 0.14), paperMathBorder(DEFAULT_ACCENT))
        val box = paperMathBox(16f)
        assertEquals(10f, box.radius)
        assertEquals(20f, box.padX)
        assertEquals(16f, box.padY)
        assertEquals(12f, box.marginY)
        assertEquals(16f * 0.14f, paperMathInlinePad(16f))
    }
}
