package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals

class EditorGroupTest {
    @Test
    fun ctrlArrowsMoveByWordPunctuationAndSpace() {
        val line = "hello world"
        assertEquals(5, moveEditorGroup(line, 0, true))
        assertEquals(11, moveEditorGroup(line, 5, true))
        assertEquals(0, moveEditorGroup(line, 6, false))
        assertEquals(6, moveEditorGroup(line, 8, false))
        assertEquals(1, moveEditorGroup("a+b", 0, true))
        assertEquals(2, moveEditorGroup("a+b", 1, true))
        assertEquals(7, moveEditorGroup("foo_bar", 0, true))
        assertEquals(0 to 5, editorGroupSelection(line, 0, 0, true, true))
        assertEquals(5 to 5, editorGroupSelection(line, 0, 5, true, false))
        assertEquals(0 to 0, editorGroupSelection(line, 0, 5, false, false))
        assertEquals(3, moveEditorGroup("x😀y", 1, true))
    }

    @Test
    fun ctrlBackspaceDeletesOneGroupAndASingleLeadingSpace() {
        assertEquals("lo", deleteEditorGroup("hello", 3, 3, false).text)
        assertEquals("", deleteEditorGroup(" hello", 0, 0, true).text)
        assertEquals("hello", deleteEditorGroup("  hello", 0, 0, true).text)
        assertEquals("abcd", deleteEditorGroup("ab\ncd", 2, 2, true).text)
        val selected = deleteEditorGroup("hello world", 0, 6, true)
        assertEquals("world", selected.text)
        assertEquals(0, selected.selectionStart)
        assertEquals("ab", deleteEditorGroup("a+b", 1, 1, true).text)
        assertEquals(1, deleteEditorGroup("a+b", 1, 1, true).selectionStart)
    }

    @Test
    fun homeStopsAtTheIndentAndEndGoesToTheLineEdge() {
        val line = "    hello"
        assertEquals(4 to 4, editorLineBoundarySelection(line, 9, 9, false, false))
        assertEquals(0 to 0, editorLineBoundarySelection(line, 4, 4, false, false))
        assertEquals(4 to 4, editorLineBoundarySelection(line, 6, 6, false, false))
        assertEquals(9 to 9, editorLineBoundarySelection(line, 4, 4, true, false))
        assertEquals(4 to 9, editorLineBoundarySelection(line, 4, 4, true, true))
        val note = "ab\n  cd"
        assertEquals(5 to 5, editorLineBoundarySelection(note, 7, 7, false, false))
        assertEquals(3 to 3, editorLineBoundarySelection(note, 5, 5, false, false))
        assertEquals(7 to 7, editorLineBoundarySelection(note, 5, 5, true, false))
        assertEquals(0 to 0, editorLineBoundarySelection("\thello", 0, 0, false, false))
        assertEquals(1 to 1, editorLineBoundarySelection("\thello", 6, 6, false, false))
    }

    @Test
    fun pageUpAndPageDownKeepTheColumn() {
        val text = (1..8).joinToString("\n") { "row$it" }
        val row2 = text.indexOf("row2")
        assertEquals(text.indexOf("row5") + 2, editorPageSelection(text, row2 + 2, row2 + 2, true, false, 3).first)
        assertEquals(text.indexOf("row1") + 1, editorPageSelection(text, text.indexOf("row4") + 1, text.indexOf("row4") + 1, false, false, 3).first)
        assertEquals(text.length to text.length, editorPageSelection(text, text.length, text.length, true, false, 4))
        assertEquals(0 to 0, editorPageSelection(text, 0, 0, false, false, 4))
        assertEquals(5 to 5, editorPageSelection("hello", 0, 5, true, false, 3))
        assertEquals(0 to text.indexOf("row3"), editorPageSelection(text, 0, 0, true, true, 2))
        assertEquals(10, editorPageLineCount(200, 20))
        assertEquals(1, editorPageLineCount(10, 40))
        assertEquals(1, editorPageLineCount(100, 0))
    }
}