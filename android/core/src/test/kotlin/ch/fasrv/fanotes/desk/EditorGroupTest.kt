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
}