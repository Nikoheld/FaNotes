package ch.fasrv.fanotes.vault

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class WorksheetFileTest {
    @Test
    fun pdfAndImagesUseTheDesktopKindMimeAndMagic() {
        val pdf = worksheetFileFormat("Übung.pdf", "")
        assertEquals("pdf", pdf?.kind)
        assertEquals("application/pdf", pdf?.mime)
        assertEquals(WORKSHEET_PDF_MAX_BYTES, pdf?.maxBytes)
        assertNull(worksheetImportError("Übung.pdf", "", "%PDF-1.7".encodeToByteArray()))

        val jpeg = worksheetFileFormat("scan", "image/jpeg")
        assertEquals(".jpg", jpeg?.extension)
        assertEquals("image", jpeg?.kind)
        assertNull(worksheetImportError("scan", "image/jpeg", byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 0)))

        assertEquals(WORKSHEET_FORMAT_UNSUPPORTED, worksheetImportError("seite.html", "text/html", "x".encodeToByteArray()))
        assertEquals(WORKSHEET_TOO_LARGE, worksheetImportError("leer.pdf", "", byteArrayOf()))
        assertEquals(
            WORKSHEET_BYTES_MISMATCH,
            worksheetImportError("foto.png", "image/png", "%PDF-".encodeToByteArray()),
        )
        assertEquals(
            "image/png",
            worksheetFileFormat("Foto.PNG", "image/jpeg")?.mime,
        )
    }
}
