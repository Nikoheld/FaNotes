package ch.fasrv.fanotes.sync

import ch.fasrv.fanotes.vault.DirectoryVault
import java.nio.file.Files
import java.time.Instant
import java.time.ZoneId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class LongNameTest {
    // 250 characters, 254 bytes in UTF-8: just under the 255-byte limit of Linux and Android.
    private val longStem = "Leeres Periodensystem für chemische Ressourcen für Lehrer und Schüler " + "x".repeat(250 - 69)
    private fun bytes(text: String) = text.toByteArray(Charsets.UTF_8).size

    @Test
    fun aVaultWritesAFileWhoseNameIsJustUnderTheLimit() {
        assertEquals(254, bytes(longStem))
        val vault = DirectoryVault(Files.createTempDirectory("long-name"))
        vault.write("Chemie/2. Prüfung/$longStem", byteArrayOf(1, 2, 3))
        assertEquals(listOf<Byte>(1, 2, 3), vault.read("Chemie/2. Prüfung/$longStem")!!.toList())
        // No temp file is left beside it.
        assertEquals(listOf(longStem), vault.list("Chemie/2. Prüfung").map { it.path.substringAfterLast('/') })
    }

    @Test
    fun aConflictCopyOfALongNameStaysWithinTheLimit() {
        val at = Instant.parse("2026-11-22T08:05:00Z")
        val copy = conflictCopyPath("Chemie/$longStem.png", "Pixel", at, ZoneId.of("Europe/Zurich"))
        val leaf = copy.substringAfterLast('/')
        assertTrue(bytes(leaf) <= MAX_NAME_BYTES)
        assertTrue(leaf.endsWith(" (Konflikt Pixel 2026-11-22 09-05).png"))
        assertTrue(longStem.startsWith(leaf.substringBefore(" (Konflikt")))
        // Short names are unchanged.
        assertEquals("Chemie/A (Konflikt Pixel 2026-11-22 09-05).md", conflictCopyPath("Chemie/A.md", "Pixel", at, ZoneId.of("Europe/Zurich")))
    }

    @Test
    fun theNameLimitCountsBytesPerName() {
        assertTrue(fitsNameLimit("Chemie/$longStem"))
        assertFalse(fitsNameLimit("Chemie/${longStem}ü"))
        assertTrue(fitsNameLimit("a/".repeat(200) + "b"))
        assertEquals("für", takeUtf8Bytes("für Schüler", 4))
        assertEquals("fü", takeUtf8Bytes("füü", 4))
    }
}
