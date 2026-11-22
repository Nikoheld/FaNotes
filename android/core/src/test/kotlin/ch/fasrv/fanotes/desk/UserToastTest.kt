package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class UserToastTest {
    @Test
    fun fileErrorsLoseTheirPathsAndGetShortMessages() {
        val denied = java.nio.file.AccessDeniedException("/data/user/0/app/files/vault/Inbox/CRLF.famd.1234.tmp")
        assertEquals(FILE_ERROR_DENIED, friendlyFileError(denied, "x"))
        val perm = java.io.FileNotFoundException("/data/x/Inbox/a.tmp (Permission denied)")
        assertEquals(FILE_ERROR_DENIED, friendlyFileError(perm, "x"))
        assertEquals(FILE_ERROR_READ_ONLY, friendlyFileError(java.io.IOException("open failed: EROFS (Read-only file system)"), "x"))
        assertEquals(FILE_ERROR_FULL, friendlyFileError(java.io.IOException("write failed: ENOSPC (No space left on device)"), "x"))
        assertEquals(FILE_ERROR_MISSING, friendlyFileError(java.nio.file.NoSuchFileException("/a/b/c.md"), "x"))
        assertEquals(FILE_ERROR_DENIED, friendlyFileError(RuntimeException("save", java.io.IOException("EACCES")), "x"))
        assertEquals("Fallback.", friendlyFileError(IllegalStateException("rename /data/user/0/f/a.tmp failed"), "Fallback."))
        assertEquals("Klartext.", friendlyFileError(IllegalStateException("Klartext."), "Fallback."))
    }

    @Test
    fun userVisibleFailureNeverShowsARawPath() {
        val text = userVisibleFailure(java.io.IOException("/data/user/0/ch.fasrv.fanotes/files/vault/Inbox/N.famd.u.tmp: open failed: EACCES"), "Speichern fehlgeschlagen.")
        assertEquals(FILE_ERROR_DENIED, text)
        assertFalse(text!!.contains("/data"))
    }

    @Test
    fun saveRetriesBackOffAndCap() {
        val delays = (0..8).map { saveRetryDelayMs(it) }
        assertEquals(delays.sorted(), delays)
        assertEquals(2_000L, delays.first())
        assertEquals(30_000L, delays.last())
    }

    @Test
    fun toastLifetimeScalesWithLengthAndIsCapped() {
        assertTrue(toastLifetimeMs("Kurz.") in 4_000L..5_000L)
        assertEquals(12_000L, toastLifetimeMs("x".repeat(1_000)))
        assertEquals(8_000L, toastLifetimeMs("Gelöscht", hasAction = true))
        assertTrue(toastSurvivesNavigation(200L))
        assertFalse(toastSurvivesNavigation(5_000L))
        assertNull(userVisibleToast("  "))
    }
}

class SwissSpellingTest {
    @Test
    fun germanShowsSwissSpellingAndEnglishFindsKeysEitherWay() {
        val catalog = loadEnglishCatalogResource()
        assertEquals("Schliessen", translateChrome("Schließen", "de", catalog))
        assertEquals("Grösse des Vaults", translateChrome("Größe des Vaults", "de", catalog))
        assertEquals("Close", translateChrome("Schließen", "en", catalog))
        assertEquals("Close", translateChrome("Schliessen", "en", catalog))
        assertEquals("Unbekannt", translateChrome("Unbekannt", "de", emptyMap()))
        assertFalse(translateChrome("Fußball", "en", catalog).contains('ß'))
    }

    @Test
    fun newlyAddedMessagesAreInTheEnglishCatalog() {
        val catalog = loadEnglishCatalogResource()
        for (key in listOf("Profil eingerichtet.", "Vault-Ordner öffnen", "Papierkorb", "Speichern fehlgeschlagen.", FILE_ERROR_DENIED, FILE_ERROR_READ_ONLY, FILE_ERROR_FULL)) {
            assertTrue(catalog.containsKey(key), "missing English text for $key")
        }
    }
}
