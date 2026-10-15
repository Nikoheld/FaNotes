package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class EditorEscapeTest {
    @Test
    fun escapeCollapsesARangeToTheCaretAndLeavesACaretAlone() {
        assertEquals(8, simplifyEditorSelection(3, 8, 20))
        assertEquals(3, simplifyEditorSelection(8, 3, 20))
        assertEquals(0, simplifyEditorSelection(4, 0, 20))
        assertNull(simplifyEditorSelection(4, 4, 20))
        assertNull(simplifyEditorSelection(4, -1, 20))
        assertNull(simplifyEditorSelection(-1, -1, 20))
        assertEquals(20, simplifyEditorSelection(0, 40, 20))
    }
}
