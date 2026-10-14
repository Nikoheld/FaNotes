package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class NoteOutlineTest {
    private val markdown = """
        <!-- fanotes-tags: klausur, physik -->
        # Einleitung

        Absatz.

        ## Aufgabe 1

        Text #übung und mehr.
    """.trimIndent() + "\n"

    @Test
    fun headingsKeepTheDesktopLineNumbers() {
        val headings = parseNoteOutline(markdown)
        assertEquals(
            listOf(
                NoteOutlineHeading(1, "Einleitung", 2),
                NoteOutlineHeading(2, "Aufgabe 1", 6),
            ),
            headings,
        )
        assertEquals(markdown.indexOf("# Einleitung"), revealLineStart(markdown, 2))
        assertEquals(markdown.indexOf("## Aufgabe 1"), revealLineStart(markdown, 6))
        assertEquals(0, revealLineStart(markdown, 0))
        assertEquals(markdown.length, revealLineStart(markdown, 99))
        assertEquals(2, headingLineForSection(markdown, 0))
        assertEquals(6, headingLineForSection(markdown, 1))
        assertNull(headingLineForSection(markdown, 5))
        assertNull(headingLineForSection(markdown, -1))
        assertEquals(1, sectionIndexForHeading(markdown, 6))
        assertEquals(-1, sectionIndexForHeading(markdown, 4))
    }

    @Test
    fun closingHashesAreNotPartOfTheTitle() {
        assertEquals("Aufgabe 1", parseNoteOutline("## Aufgabe 1 ##").single().title)
        assertEquals(6, parseNoteOutline("###### Tief").single().level)
        assertTrue(parseNoteOutline("#nope").isEmpty())
        assertTrue(parseNoteOutline(" # eingerückt").isEmpty())
    }

    @Test
    fun foldingAHeadingHidesItsBodyAndKeepsTheNextHeading() {
        val note = "# Einleitung\n\nAbsatz.\n\n## Aufgabe 1\n\nText\n\n# Nächstes\n"
        val fold = headingFoldRange(note, 1)
        assertEquals(note.indexOf("\n\nAbsatz") + 1, fold?.from)
        assertEquals(note.indexOf("# Nächstes") - 1, fold?.to)
        val visible = markdownWithFolds(note, setOf(1))
        assertEquals("# Einleitung\n\n# Nächstes\n", visible)
        val edited = applyFoldedEdit(note, setOf(1), visible, visible.replace("# Einleitung", "# Einleitung!"))
        assertEquals("# Einleitung!\n\nAbsatz.\n\n## Aufgabe 1\n\nText\n\n# Nächstes\n", edited)
        assertEquals(setOf(1), shiftFoldedLines(note, edited, setOf(1)))
        assertNull(headingFoldRange("# Nur\n", 1))
    }
}