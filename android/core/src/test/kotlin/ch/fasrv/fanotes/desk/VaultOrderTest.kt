package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class VaultOrderTest {
    @Test
    fun foldersLeadAndNumbersSortByValue() {
        assertTrue(compareVaultEntries(true, "Notiz", false, "Archiv") < 0)
        assertTrue(compareVaultNames("Note 2", "Note 10") < 0)
        assertTrue(compareVaultNames("10", "2") > 0)
        assertTrue(compareVaultNames("Kapitel 9", "Kapitel 10") < 0)
        assertTrue(compareVaultNames("a10b", "a2b") > 0)
        assertEquals(0, compareVaultNames("a02", "a2"))
        assertEquals(0, compareVaultNames("äpfel", "Apfel"))
        assertEquals(0, compareVaultNames("ß", "ss"))
        assertEquals(0, compareVaultNames("Datei 1", "datei 1"))
        assertTrue(compareVaultNames("2", "a") < 0)
        val names = listOf("Note 10", "Ordner", "note 2", "Äpfel", "10", "2")
        val sorted = names.sortedWith(::compareVaultNames)
        assertEquals(listOf("2", "10", "Äpfel", "note 2", "Note 10", "Ordner"), sorted)
    }
}
