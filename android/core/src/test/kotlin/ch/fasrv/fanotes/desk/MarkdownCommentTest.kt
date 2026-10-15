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
}
