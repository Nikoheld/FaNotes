package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals

class EditorWashTest {
    @Test
    fun theActiveLineAndSelectionUseTheDesktopAccentMix() {
        assertEquals(0x0D2A6F97, activeLineArgb(0xFF2A6F97.toInt()))
        assertEquals(0x0D2A6F97, activeLineArgb(0x802A6F97.toInt()))
        assertEquals(0x472A6F97, selectionWashArgb(0xFF2A6F97.toInt()))
        assertEquals(0x47D9730D, selectionWashArgb(0xFFD9730D.toInt()))
        assertEquals(0x122A6F97, quoteWashArgb(0xFF2A6F97.toInt()))
        assertEquals(3 to 16, quoteMargins(16f))
        assertEquals(6 to 32, quoteMargins(32f))
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
