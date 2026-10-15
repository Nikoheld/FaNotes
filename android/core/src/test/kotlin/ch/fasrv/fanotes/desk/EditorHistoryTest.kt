package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class EditorHistoryTest {
    @Test
    fun typingAndBackspaceShareOneUndoStepUntilThePause() {
        val history = EditorHistory()
        history.record("", "a", 0, 1, 0)
        history.record("a", "ab", 1, 2, 200)
        val both = history.undo("ab")
        assertEquals("", both?.text)
        assertEquals(0, both?.selectionStart)
        assertNull(history.undo(""))
        history.record("", "a", 0, 1, 0)
        history.record("a", "ab", 1, 2, 600)
        assertEquals("a", history.undo("ab")?.text)
        assertEquals("", history.undo("a")?.text)
        val redone = history.redo("")
        assertEquals("a", redone?.text)
        assertEquals(1, redone?.selectionStart)
        assertEquals("ab", history.redo("a")?.text)
        history.record("ab", "abc", 2, 3, 2_000)
        assertNull(history.redo("abc"))
        val erased = EditorHistory()
        erased.record("abc", "ab", 3, 2, 0)
        erased.record("ab", "a", 2, 1, 100)
        val restored = erased.undo("a")
        assertEquals("abc", restored?.text)
        assertEquals(3, restored?.selectionStart)
        val forward = EditorHistory()
        forward.record("abc", "ac", 1, 1, 0)
        forward.record("ac", "a", 1, 1, 40)
        val brought = forward.undo("a")
        assertEquals("abc", brought?.text)
        assertEquals(1, brought?.selectionStart)
        assertEquals("undo", editorHistoryCommand(true, false, false, false, "z"))
        assertEquals("redo", editorHistoryCommand(true, false, false, false, "y"))
        assertEquals("redo", editorHistoryCommand(true, true, false, false, "z"))
        assertNull(editorHistoryCommand(true, false, true, false, "z"))
        assertNull(editorHistoryCommand(false, false, false, false, "z"))
    }
}