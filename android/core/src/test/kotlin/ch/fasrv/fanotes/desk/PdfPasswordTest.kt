package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class PdfPasswordTest {
    @Test
    fun aLockedPdfAsksForThePasswordFromAndroid15() {
        assertTrue(pdfNeedsPassword("SecurityException", "Cannot open"))
        assertTrue(pdfNeedsPassword("PasswordException", ""))
        assertTrue(pdfNeedsPassword("IOException", "Password required or incorrect password."))
        assertFalse(pdfNeedsPassword("IOException", "Die PDF-Datei ist leer."))
        assertFalse(pdfPasswordSupported(34))
        assertTrue(pdfPasswordSupported(35))
        assertEquals("Dieses PDF ist geschützt", PDF_PASSWORD_TITLE)
        assertEquals("Öffnen", PDF_PASSWORD_ACTION)
    }
}