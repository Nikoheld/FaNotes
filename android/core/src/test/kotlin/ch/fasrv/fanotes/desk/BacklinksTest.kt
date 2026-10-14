package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class BacklinksTest {
    @Test
    fun anotherNoteThatNamesThisTitleIsABacklink() {
        val found = backlinksFor(
            "Mathe/Algebra.md",
            listOf(
                "Deutsch/Text.md" to "Siehe [[Algebra]] im Heft.",
                "Mathe/Algebra.md" to "Selbst [[Algebra]].",
            ),
        )
        assertEquals(1, found.size)
        assertEquals("Deutsch/Text.md", found[0].path)
        assertEquals("Text", found[0].title)
        assertTrue(found[0].excerpt.contains("[[Algebra]]"))
        assertEquals(listOf("Andere"), wikilinkTargets("Siehe [[Andere#Kapitel|hier]] und [[Andere]]"))
    }

    @Test
    fun wikiTargetPrefersTheSameFolderThenTheShortestPath() {
        val paths = listOf("Mathe/Algebra.md", "Deutsch/Algebra.md", "Note.md", "Fach/Note.md", "Loose.md")
        assertEquals("Mathe/Algebra.md", resolveWikiTarget("Mathe/Algebra.md", paths))
        assertEquals("Mathe/Algebra.md", resolveWikiTarget("Algebra", paths, "Mathe/Aufgaben.md"))
        assertEquals("Deutsch/Algebra.md", resolveWikiTarget("Algebra", paths, "Deutsch/Text.md"))
        assertEquals("Note.md", resolveWikiTarget("Note", paths, "Andere/Text.md"))
        assertEquals("Loose.md", resolveWikiTarget("loose", paths))
        assertNull(resolveWikiTarget("Fehlt", paths))
        assertNull(resolveWikiTarget("  ", paths))
    }
}
