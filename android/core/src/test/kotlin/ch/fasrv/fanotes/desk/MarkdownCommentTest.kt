package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals

class MarkdownCommentTest {
    @Test
    fun ctrlSlashWrapsTheLineAndASecondPressRemovesIt() {
        assertEquals(MarkdownEdit("<!-- Hallo -->", 7, 7), toggleMarkdownComment("Hallo", 2, 2))
        assertEquals(MarkdownEdit("<!-- Hallo -->", 0, 0), toggleMarkdownComment("Hallo", 0, 0))
        assertEquals(MarkdownEdit("<!-- Hallo -->", 5, 10), toggleMarkdownComment("Hallo", 0, 5))
        assertEquals(MarkdownEdit("Hallo", 2, 2), toggleMarkdownComment("<!-- Hallo -->", 7, 7))
        assertEquals(MarkdownEdit("  <!-- Hallo -->", 9, 9), toggleMarkdownComment("  Hallo", 4, 4))
        assertEquals(MarkdownEdit("  Hallo", 4, 4), toggleMarkdownComment("  <!-- Hallo -->", 9, 9))
        assertEquals(MarkdownEdit("<!--  -->", 0, 0), toggleMarkdownComment("", 0, 0))
        assertEquals(MarkdownEdit("", 0, 0), toggleMarkdownComment("<!--  -->", 0, 0))
    }

    @Test
    fun aSelectionThatEndsAtTheNextLineDoesNotCommentThatLine() {
        assertEquals(
            MarkdownEdit("<!-- Hallo\nWelt -->", 5, 15),
            toggleMarkdownComment("Hallo\nWelt", 0, 10),
        )
        assertEquals(
            MarkdownEdit("<!-- Hallo -->\nWelt", 5, 15),
            toggleMarkdownComment("Hallo\nWelt", 0, 6),
        )
        assertEquals(MarkdownEdit("Hallo\nWelt", 0, 10), toggleMarkdownComment("<!-- Hallo\nWelt -->", 5, 15))
    }

    @Test
    fun altShiftAWrapsOnlyTheSelection() {
        assertEquals(MarkdownEdit("Ha<!--  -->llo", 7, 7), toggleMarkdownBlockComment("Hallo", 2, 2))
        assertEquals(MarkdownEdit("Hallo", 2, 2), toggleMarkdownBlockComment("Ha<!--  -->llo", 7, 7))
        assertEquals(MarkdownEdit("<!-- Hal -->lo", 5, 8), toggleMarkdownBlockComment("Hallo", 0, 3))
        val wrapped = "<!-- one\ntwo --> three"
        assertEquals(MarkdownEdit("one\ntwo three", 0, 7), toggleMarkdownBlockComment(wrapped, 0, wrapped.indexOf(" three")))
        val note = "\n line 1\n line 2\n line 3\n line 4\n line 5\n"
        val start = note.indexOf("e 1")
        val end = note.indexOf("4")
        val commented = toggleMarkdownBlockComment(note, start, end)
        assertEquals("\n lin<!-- e 1\n line 2\n line 3\n line  -->4\n line 5\n", commented.text)
        assertEquals(start + "<!-- ".length, commented.selectionStart)
        assertEquals(end + "<!-- ".length, commented.selectionEnd)
    }
}
