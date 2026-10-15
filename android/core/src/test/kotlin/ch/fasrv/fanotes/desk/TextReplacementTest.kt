package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals

class TextReplacementTest {
    @Test
    fun theSmallestSpanLeavesTheSharedEndsAlone() {
        assertEquals(TextReplacement(10, 11, ""), minimalReplacement("Hallo Welt\n", "Hallo Welt"))
        assertEquals(TextReplacement(2, 2, "X"), minimalReplacement("abc", "abXc"))
        assertEquals(TextReplacement(4, 4, ""), minimalReplacement("same", "same"))
        assertEquals(TextReplacement(0, 0, "new"), minimalReplacement("", "new"))
        assertEquals(TextReplacement(2, 3, ""), minimalReplacement("aaa", "aa"))
        val emoji = minimalReplacement("x😀y", "x😁y")
        assertEquals("x😁y", "x😀y".substring(0, emoji.from) + emoji.insert + "x😀y".substring(emoji.to))
    }

    @Test
    fun aCursorAfterTheEditStaysOnTheSameCharacter() {
        val current = "Hello world"
        val next = "Hi world"
        val change = minimalReplacement(current, next)
        assertEquals(TextReplacement(1, 5, "i"), change)
        assertEquals(2, mapThroughReplacement(change, 5))
        assertEquals(3, mapThroughReplacement(change, 6))
        assertEquals(8, mapThroughReplacement(change, current.length))
        assertEquals(0, mapThroughReplacement(change, 0))
        assertEquals(2 to 8, mapSelectionThroughReplacement(current, next, 4, current.length))
    }
}