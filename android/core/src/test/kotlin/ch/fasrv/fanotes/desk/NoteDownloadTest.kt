package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class NoteDownloadTest {
    @Test
    fun onlyMarkdownAndPdfNotesCanBeDownloaded() {
        assertEquals("Algebra.md", noteDownloadFileName("Schule/Algebra.md"))
        assertEquals("Skript.pdf", noteDownloadFileName("Skript.pdf"))
        assertTrue(noteCanDownload("Schule/Algebra.md"))
        assertTrue(noteCanDownload("Seite.markdown"))
        assertTrue(noteCanDownload("Buch.PDF"))
        assertFalse(noteCanDownload("Schule"))
        assertFalse(noteCanDownload("Schule/Algebra.famd"))
        assertEquals(
            "Nur Markdown-Notizen und PDF-Notizen können direkt heruntergeladen werden.",
            NOTE_DOWNLOAD_REFUSED,
        )
    }
}