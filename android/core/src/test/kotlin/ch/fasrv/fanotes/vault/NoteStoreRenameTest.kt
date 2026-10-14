package ch.fasrv.fanotes.vault

import ch.fasrv.fanotes.famd.companionPath
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class NoteStoreRenameTest {
    @Test
    fun aTypedExtensionStaysOffTheFileAndABlankNameIsRefused() {
        assertEquals("Physik/Algebra.md", renamedVaultPath("Physik/Mathe.md", "Algebra.md", folder = false))
        assertEquals("Bericht.pdf", renamedVaultPath("Dokument.pdf", "Bericht", folder = false))
        assertEquals("Physik", renamedVaultPath("Schule", "Physik", folder = true))
        val error = assertFailsWith<IllegalArgumentException> { renamedVaultPath("A.md", "   ", folder = false) }
        assertEquals("Der Name darf nicht leer sein.", error.message)
    }

    @Test
    fun renamingAFolderMovesTheNotesInsideIt() {
        val root = Files.createTempDirectory("fanotes-rename")
        try {
            val vault = DirectoryVault(root)
            val store = NoteStore(vault)
            store.createFolder("", "Schule")
            val note = store.createMarkdown("Schule", "Mathe")
            assertTrue(vault.exists(companionPath(note, ".famd")))
            val folder = store.rename("Schule", "Physik")
            assertEquals("Physik", folder)
            assertTrue(vault.exists("Physik/Mathe.md"))
            assertTrue(vault.exists(companionPath("Physik/Mathe.md", ".famd")))
            assertFalse(vault.exists("Schule/Mathe.md"))
            val renamed = store.rename("Physik/Mathe.md", "Algebra.md")
            assertEquals("Physik/Algebra.md", renamed)
            assertTrue(vault.exists("Physik/Algebra.md"))
            assertTrue(vault.exists(companionPath("Physik/Algebra.md", ".famd")))
            assertFalse(vault.exists("Physik/Mathe.md"))
            store.createMarkdown("Physik", "Andere")
            val taken = assertFailsWith<IllegalArgumentException> { store.rename("Physik/Algebra.md", "Andere") }
            assertEquals("An diesem Ort existiert bereits ein Eintrag mit diesem Namen.", taken.message)
            assertEquals("Physik/Algebra.md", store.rename("Physik/Algebra.md", "Algebra"))
        } finally {
            root.toFile().deleteRecursively()
        }
    }
}