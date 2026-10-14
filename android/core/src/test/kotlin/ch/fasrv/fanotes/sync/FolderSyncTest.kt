package ch.fasrv.fanotes.sync

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class FolderSyncTest {
    @Test
    fun localFoldersAreParsedToggledAndMatchedAsPrefixes() {
        assertEquals(listOf("Physik/Buch"), syncPrefixesFromSetting("Physik/Buch, ../x\nPhysik/Buch"))
        assertEquals(emptyList(), syncPrefixesFromSetting(" \n ../secret "))
        assertEquals("Physik/Buch", toggleSyncPrefix("", "/Physik/Buch/"))
        assertEquals("", toggleSyncPrefix("Physik/Buch", "Physik/Buch"))
        assertEquals("Physik/Buch\nChemie", toggleSyncPrefix("Physik/Buch", "Chemie"))
        assertTrue(pathIsSyncExcluded("Physik/Buch/a.md", listOf("Physik/Buch")))
        assertTrue(pathIsSyncExcluded("Physik/Buch", listOf("Physik/Buch")))
        assertFalse(pathIsSyncExcluded("Physik/Buchstaben.md", listOf("Physik/Buch")))
        assertFalse(isSyncablePath("Physik/Buch/a.md", SyncPathOptions(excludedPrefixes = listOf("Physik/Buch"))))
        assertTrue(isSyncablePath("Chemie/a.md", SyncPathOptions(excludedPrefixes = listOf("Physik/Buch"))))
    }
}
