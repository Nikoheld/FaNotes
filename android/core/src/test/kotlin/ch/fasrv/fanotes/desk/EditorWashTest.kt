package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class EditorWashTest {
    @Test
    fun theActiveLineAndSelectionUseTheDesktopAccentMix() {
        assertEquals(0x09252630, activeLineArgb())
        assertEquals(0x472A6F97, selectionWashArgb(0xFF2A6F97.toInt()))
        assertEquals(0x47D9730D, selectionWashArgb(0xFFD9730D.toInt()))
        assertEquals(0x122A6F97, quoteWashArgb(0xFF2A6F97.toInt()))
        assertEquals(10, tablePadPx(16f))
        assertEquals(3, tableRulePx(16f))
        assertEquals(20, tablePadPx(32f))
        val task = paperTaskBox(16f)
        assertEquals(15f, task.size, 0.01f)
        assertEquals(7f, task.gap, 0.01f)
        assertEquals(30f, paperTaskBox(32f).size, 0.01f)
        assertEquals(14f, paperTaskBox(32f).gap, 0.01f)
        assertEquals(800, PAPER_BULLET_WEIGHT)
        assertEquals(2, paperCaretWidthPx(16f))
        assertEquals(4, paperCaretWidthPx(32f))
        assertEquals(1, paperCaretWidthPx(4f))
        assertEquals(3 to 16, quoteMargins(16f))
        assertEquals(6 to 32, quoteMargins(32f))
        val code = paperCodeBox(16f)
        assertEquals(14.4f, code.textPx, 0.01f)
        assertEquals(5.184f, code.padX, 0.01f)
        assertEquals(1.44f, code.padY, 0.01f)
        assertEquals(5f, code.radius, 0.01f)
        assertEquals(1f, code.border, 0.01f)
        assertTrue(paperCodeBox(32f).textPx > code.textPx)
        val h1 = paperHeading(1, 16f)
        assertEquals(2f, h1.scale)
        assertEquals(16f, h1.padTop, 0.01f)
        assertEquals(8.96f, h1.padBottom, 0.01f)
        assertEquals(-0.025f, h1.letterSpacing)
        val h2 = paperHeading(2, 16f)
        assertEquals(1.55f, h2.scale)
        assertEquals(16f * 1.55f * 0.62f, h2.padTop, 0.01f)
        assertEquals(0f, h2.padBottom)
        assertEquals(1.28f, paperHeading(3, 16f).scale)
        assertEquals(1.1f, paperHeading(4, 16f).scale)
        assertEquals(1f, paperHeading(5, 16f).scale)
        assertEquals(16f * 0.25f, paperHeading(6, 16f).padTop, 0.01f)
    }

    @Test
    fun theActiveLineFollowsTheSelectionHead() {
        assertEquals(4, activeLineHead(4, 10))
        assertEquals(2, activeLineHead(2, 10))
        assertEquals(10, activeLineHead(10, 10))
        assertEquals(0, activeLineHead(-3, 10))
        assertEquals(10, activeLineHead(40, 10))
        assertEquals(0, activeLineHead(2, 0))
    }
}
