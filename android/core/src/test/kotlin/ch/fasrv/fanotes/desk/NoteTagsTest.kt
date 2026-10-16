package ch.fasrv.fanotes.desk

import ch.fasrv.fanotes.vault.NoteKind
import ch.fasrv.fanotes.vault.VaultNode
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertSame
import kotlin.test.assertTrue

class NoteTagsTest {
    @Test
    fun markerAndHashtagsStayUniqueInSwissLowercase() {
        val content = "<!-- fanotes-tags: Schule, Mathe -->\nSiehe #Mathe und #Übung.\nfoo#bar"
        assertEquals(listOf("schule", "mathe", "übung"), parseNoteTags(content))
        assertEquals(listOf("schule", "mathe"), parseDeclaredTags(content))
        assertEquals(listOf("mathe", "übung"), parseHashtags(content))
        assertEquals("zwei-worte", normalizeTag("  #Zwei Worte "))
        assertEquals("a".repeat(40), normalizeTag("A".repeat(45)))
        assertEquals(emptyList(), parseHashtags("<!-- fanotes-tags: #geheim -->"))
        assertEquals(listOf("übung"), parseHashtags("#Übung und `#geheim`\n```\n#code\n```\n"))
    }

    @Test
    fun applyWritesTheMarkerAndStripsALeadingNewlineOrBom() {
        assertEquals(
            "<!-- fanotes-tags: algebra -->\n# Titel",
            applyNoteTags("\uFEFF# Titel", listOf("Algebra")),
        )
        val replaced = applyNoteTags("<!-- FANOTES-TAGS: alt -->\n\n# Titel", listOf("Neu", "neu"))
        assertEquals("<!-- fanotes-tags: neu -->\n\n# Titel", replaced)
        assertEquals("# Titel", applyNoteTags("<!-- fanotes-tags: alt -->\n\n# Titel", emptyList()))
        assertEquals("# Titel", applyNoteTags("# Titel", emptyList()))
        assertEquals(listOf("mathe", "bio"), collectVaultTags(listOf("#Mathe", "#Bio #mathe")))
    }

    @Test
    fun filterKeepsTheFolderAroundAMatchingNote() {
        val algebra = VaultNode("Algebra", "Math/Algebra.md", NoteKind.MARKDOWN, 0)
        val skip = VaultNode("Skip", "Math/Skip.md", NoteKind.MARKDOWN, 0)
        val loose = VaultNode("Loose", "Loose.md", NoteKind.MARKDOWN, 0)
        val tree = listOf(
            VaultNode("Math", "Math", NoteKind.FOLDER, 0, listOf(algebra, skip)),
            loose,
        )
        val index = mapOf("Math/Algebra.md" to listOf("algebra"))
        assertSame(tree, filterVaultByTag(tree, null, index))
        val filtered = filterVaultByTag(tree, "Algebra", index)
        assertEquals(listOf("Math"), filtered.map { it.path })
        assertEquals(listOf("Math/Algebra.md"), filtered.first().children.map { it.path })
        assertTrue(filterVaultByTag(tree, "fehlt", index).isEmpty())
    }
}
