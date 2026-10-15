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
