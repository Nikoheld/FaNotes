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
        assertEquals(136, revealScrollTop(200, 16))
        assertEquals(0, revealScrollTop(40, 0))
        assertEquals(1, revealScrollTop(49, 0))
        assertEquals(REVEAL_LINE_MARGIN_PX, 48)
        assertEquals(2, headingLineForSection(markdown, 0))
        assertEquals(6, headingLineForSection(markdown, 1))
        assertNull(headingLineForSection(markdown, 5))
        assertNull(headingLineForSection(markdown, -1))
        assertEquals(1, sectionIndexForHeading(markdown, 6))
        assertEquals(-1, sectionIndexForHeading(markdown, 4))
    }

    @Test
    fun aHeadingAnchorUsesTheDesktopSlug() {
        assertEquals("uber-die-menge", headingSlug("Über die Menge"))
        assertEquals("aufgabe-1", headingSlug("Aufgabe 1"))
        assertEquals("abschnitt", headingSlug("..."))
        val note = "# Beweis\n\nText\n\n# Beweis\n"
        assertEquals(1, headingAnchorLine(note, "Beweis"))
        assertEquals(1, headingAnchorLine(note, "beweis"))
        assertEquals(5, headingAnchorLine(note, "beweis-2"))
        assertEquals(1, headingAnchorLine(note, "#user-content-Beweis"))
        assertEquals(5, headingAnchorLine(note, "user-content-beweis-2"))
        assertEquals(null, headingAnchorLine(note, "user-content-"))
        assertEquals(null, headingAnchorLine(note, "fehlt"))
        val prefixed = "# user-content-Beweis\n\n# Beweis\n"
        assertEquals(1, headingAnchorLine(prefixed, "#user-content-user-content-Beweis"))
        assertEquals(3, headingAnchorLine(prefixed, "#user-content-beweis"))
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
        assertEquals(1, foldedHeadingHidingLine(note, setOf(1), 3))
        assertEquals(1, foldedHeadingHidingLine(note, setOf(1), 7))
        assertEquals(null, foldedHeadingHidingLine(note, setOf(1), 1))
        assertEquals(null, foldedHeadingHidingLine(note, setOf(1), 9))
        assertEquals(null, foldedHeadingHidingLine(note, emptySet(), 3))
        assertEquals(1, foldedHeadingHidingLine(note, setOf(1, 5), 7))
        assertEquals(listOf("▾", "", "", "", "▾", "", "", "", "", ""), foldMarkerGlyphs(note, emptySet()))
        assertEquals(listOf("▸", "", "", ""), foldMarkerGlyphs(note, setOf(1)))
        assertEquals(1, headingLineForFoldMarker(note, emptySet(), 1))
        assertEquals(5, headingLineForFoldMarker(note, emptySet(), 5))
        assertEquals(1, headingLineForFoldMarker(note, setOf(1), 1))
        assertNull(headingLineForFoldMarker(note, setOf(1), 3))
        assertNull(headingLineForFoldMarker(note, emptySet(), 2))
        assertNull(headingLineForFoldMarker("# Nur\n", emptySet(), 1))
    }

    @Test
    fun keyboardFoldsMatchTheDesktopHeadingCommands() {
        val note = "# A\nbody\n# B\nbody\n## C\nmore\n"
        assertEquals(setOf(1), foldHeadingAtCursor(note, emptySet(), 0))
        assertNull(foldHeadingAtCursor(note, emptySet(), note.indexOf("body")))
        assertNull(foldHeadingAtCursor(note, setOf(1), 0))
        val all = foldAllHeadings(note, emptySet())
        assertEquals(setOf(1, 3), all)
        assertNull(foldAllHeadings(note, setOf(1, 3)))
        assertEquals(setOf(3), unfoldHeadingAtCursor(note, setOf(1, 3), 0))
        assertEquals(emptySet(), unfoldAllHeadings(setOf(1)))
        assertNull(unfoldAllHeadings(emptySet()))
        val inBody = note.indexOf("# B\nbody") + "# B\n".length
        val cursor = visibleCursorAfterFold(note, emptySet(), all!!, inBody)
        val visible = markdownWithFolds(note, all)
        assertEquals(visible.indexOf("# B") + "# B".length, cursor)
        assertEquals("fold", foldShortcut(true, true, false, false, '['))
        assertEquals("unfold", foldShortcut(true, true, false, false, ']'))
        assertEquals("all", foldShortcut(true, false, true, false, '['))
        assertEquals("none", foldShortcut(true, false, true, false, ']'))
        assertNull(foldShortcut(true, true, true, false, '['))
        assertNull(foldShortcut(false, true, false, false, '['))
    }
}