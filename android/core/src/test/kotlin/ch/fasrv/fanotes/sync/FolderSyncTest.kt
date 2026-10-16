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
        assertEquals("Nur auf diesem Gerät", localFolderAction(false))
        assertEquals("Wieder synchronisieren", localFolderAction(true))
        assertEquals("Physik/Buch", toggleSyncPrefix("", "/Physik/Buch/"))
        assertEquals("", toggleSyncPrefix("Physik/Buch", "Physik/Buch"))
        assertEquals("Physik/Buch\nChemie", toggleSyncPrefix("Physik/Buch", "Chemie"))
        assertTrue(pathIsSyncExcluded("Physik/Buch/a.md", listOf("Physik/Buch")))
        assertTrue(pathIsSyncExcluded("Physik/Buch", listOf("Physik/Buch")))
        assertFalse(pathIsSyncExcluded("Physik/Buchstaben.md", listOf("Physik/Buch")))
        assertFalse(isSyncablePath("Physik/Buch/a.md", SyncPathOptions(excludedPrefixes = listOf("Physik/Buch"))))
        assertTrue(isSyncablePath("Chemie/a.md", SyncPathOptions(excludedPrefixes = listOf("Physik/Buch"))))
        assertFalse(isSyncablePath(".fanotes/trash/index.json"))
        assertFalse(isSyncablePath(".fanotes/trash/abc/Math/Algebra.md"))
        assertFalse(isSyncablePath(".fanotes/history/abc/index.json"))
        assertTrue(isSyncablePath(".fanotes/history/abc/index.json", SyncPathOptions(includeHistory = true)))
        assertFalse(isSyncablePath(".fanotes/onboarding.json", SyncPathOptions(includeHistory = true)))
    }
}
