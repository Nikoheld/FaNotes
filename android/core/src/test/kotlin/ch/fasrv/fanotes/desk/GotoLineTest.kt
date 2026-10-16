package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class GotoLineTest {
    private val note = "eins\nzwei\ndrei\n"

    @Test
    fun absoluteRelativePercentAndColumn() {
        assertEquals(GotoLineCursor(2, 0, note.indexOf("zwei")), gotoLineCursor(note, "2", 1))
        assertEquals(GotoLineCursor(2, 2, note.indexOf("zwei") + 2), gotoLineCursor(note, "2:2", 1))
        assertEquals(GotoLineCursor(2, 4, note.indexOf("zwei") + 4), gotoLineCursor(note, "2:99", 1))
        assertEquals(GotoLineCursor(4, 0, note.length), gotoLineCursor(note, "+2", 2))
        assertEquals(GotoLineCursor(1, 0, 0), gotoLineCursor(note, "-9", 2))
        assertEquals(GotoLineCursor(2, 0, note.indexOf("zwei")), gotoLineCursor(note, "50%", 1))
        assertEquals(GotoLineCursor(1, 0, 0), gotoLineCursor("nur", "0", 1))
        assertEquals(GotoLineCursor(1, 0, 0), gotoLineCursor("nur", "999", 1))
        assertEquals(GotoLineCursor(3, 1, "ab\ncd\nef".indexOf("ef") + 1), gotoLineCursor("ab\ncd\nef", ":1", 3))
        assertNull(gotoLineCursor(note, "12.5", 1))
        assertNull(gotoLineCursor(note, "Zeile", 1))
        assertEquals(3, lineNumberAt(note, note.indexOf("drei")))
        assertEquals(4, markdownLineCount(note))
        assertEquals(1, markdownLineCount(""))
    }

    @Test
    fun percentOffsetsUseJavascriptRounding() {
        val lines = "\n".repeat(99)
        assertEquals(30, gotoLineCursor(lines, "+10%", 20)?.line)
        assertEquals(10, gotoLineCursor(lines, "-10%", 20)?.line)
        assertEquals(2, gotoLineCursor("a\nb\nc", "50%", 1)?.line)
        assertEquals(440, promptWidthDp(800))
        assertEquals(368, promptWidthDp(400))
        assertEquals(12, PROMPT_RADIUS_DP)
        assertEquals("12, +3, 50%, 8:4", GOTO_PLACEHOLDER)
        assertEquals("Vault-Wurzel", PROMPT_ROOT)
    }
}