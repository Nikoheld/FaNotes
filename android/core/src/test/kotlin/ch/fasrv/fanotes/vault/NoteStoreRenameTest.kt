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
        assertEquals("Schule/Mathe.md", movedVaultPath("Schule/Mathe.md", "Schule") { false })
        assertEquals("Archiv/Mathe.md", movedVaultPath("Schule/Mathe.md", "Archiv") { false })
        assertEquals(
            "Archiv/Mathe 2.md",
            movedVaultPath("Schule/Mathe.md", "Archiv") { it == "Archiv/Mathe.md" || it == "Archiv/Mathe.famd" },
        )
        assertEquals("Archiv/Schule", movedVaultPath("Schule", "Archiv") { false })
        val intoSelf = assertFailsWith<IllegalArgumentException> { movedVaultPath("Schule", "Schule/Unter") { false } }
        assertEquals("Ein Ordner kann nicht in sich selbst verschoben werden.", intoSelf.message)
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
            store.createFolder("", "Archiv")
            val moved = store.moveEntry("Physik/Algebra.md", "Archiv")
            assertEquals("Archiv/Algebra.md", moved)
            assertTrue(vault.exists(companionPath("Archiv/Algebra.md", ".famd")))
            assertFalse(vault.exists("Physik/Algebra.md"))
            store.createMarkdown("Archiv", "Andere")
            val bumped = store.moveEntry("Physik/Andere.md", "Archiv")
            assertEquals("Archiv/Andere 2.md", bumped)
            assertTrue(vault.exists(companionPath("Archiv/Andere 2.md", ".famd")))
            val folderMove = store.moveEntry("Physik", "Archiv")
            assertEquals("Archiv/Physik", folderMove)
            assertTrue(vault.exists("Archiv/Physik/.keep"))
            val missing = assertFailsWith<IllegalArgumentException> { store.moveEntry("Archiv/Algebra.md", "Fehlt") }
            assertEquals("Der Zielordner wurde nicht gefunden.", missing.message)
        } finally {
            root.toFile().deleteRecursively()
        }
    }
}