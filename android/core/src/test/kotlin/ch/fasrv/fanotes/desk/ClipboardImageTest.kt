package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ClipboardImageTest {
    @Test
    fun aClipboardImageLandsOnTheSheetUnlessTheEditorHasFocus() {
        assertEquals("image/png", clipboardImageMime("image/png"))
        assertEquals("image/jpeg", clipboardImageMime("image/jpeg; charset=binary"))
        assertEquals("image/jpeg", clipboardImageMime("IMAGE/JPG"))
        assertEquals("image/webp", clipboardImageMime("image/webp"))
        assertEquals("image/gif", clipboardImageMime("image/gif"))
        assertNull(clipboardImageMime("text/plain"))
        assertNull(clipboardImageMime("image/bmp"))
        assertNull(clipboardImageMime(null))
        assertEquals("Bild.png", clipboardImageFileName("image/png"))
        assertEquals("Bild.jpg", clipboardImageFileName("image/jpeg"))
        assertEquals("Bild.webp", clipboardImageFileName("image/webp"))
        assertEquals("Bild.gif", clipboardImageFileName("image/gif"))
        assertEquals("Bild.png", clipboardImageFileName("text/plain"))
        assertTrue(pasteImageOntoSheet(editorFocused = false))
        assertFalse(pasteImageOntoSheet(editorFocused = true))
        assertEquals("Bild.png", droppedImageFile("image/png"))
        assertEquals("Bild.jpg", droppedImageFile("image/jpeg; charset=binary"))
        assertEquals("Bild.webp", droppedImageFile("image/webp"))
        assertNull(droppedImageFile("text/plain"))
        assertNull(droppedImageFile("application/pdf"))
        assertNull(droppedImageFile(null))
    }
}