package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class LargeNoteTest {
    private fun big(): String = buildString {
        repeat(6000) { append("line number ").append(it).append(" with some words in it\n") }
    }

    @Test
    fun largeThresholdIsHundredThousandChars() {
        assertTrue(isLargeNote(100_001))
        assertTrue(!isLargeNote(100_000))
    }

    @Test
    fun htmlAutoCloseInLargeNoteMatchesSmallNoteBehaviour() {
        val head = big()
        assertTrue(head.length > LARGE_NOTE_CHARS)
        val typedBefore = "$head\n<div"
        val after = "$typedBefore>"
        val edit = assertNotNull(htmlAutoClose(typedBefore, typedBefore.length, 0, after))
        assertEquals("$after</div>", edit.text)
        assertEquals(after.length, edit.selectionStart)
        val small = htmlAutoClose("<div", 4, 0, "<div>")
        assertEquals("<div></div>", small?.text)
    }

    @Test
    fun htmlAutoCloseInLargeNoteInTheMiddleKeepsBothSides() {
        val head = big()
        val tail = "\ntail text\n"
        val before = "$head<span$tail"
        val start = head.length + 5
        val after = before.substring(0, start) + ">" + before.substring(start)
        val edit = assertNotNull(htmlAutoClose(before, start, 0, after))
        assertEquals(head + "<span></span>" + tail, edit.text)
        assertEquals(start + 1, edit.selectionStart)
    }

    @Test
    fun htmlAutoCloseIgnoresOtherCharacters() {
        val before = big()
        assertNull(htmlAutoClose(before, 3, 0, before.substring(0, 3) + "x" + before.substring(3)))
    }
}
