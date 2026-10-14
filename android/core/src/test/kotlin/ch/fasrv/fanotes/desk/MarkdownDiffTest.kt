package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class MarkdownDiffTest {
    @Test
    fun changedLinesAreRemovedThenAdded() {
        val changed = diffNoteLines("alt\n", "neu\n")
        assertTrue(changed.any { it.kind == DiffKind.REMOVED && it.text == "alt" })
        assertTrue(changed.any { it.kind == DiffKind.ADDED && it.text == "neu" })
        assertEquals("- alt\n+ neu", formatNoteDiff("alt\n", "neu\n"))
        assertEquals("Kein Textunterschied.", formatNoteDiff("gleich\n", "gleich\n"))
        assertTrue(timelineHasInk("<!-- fanotes-ink:abc -->"))
        assertTrue(timelineHasInk("searchTranscript"))
        assertTrue(timelineHasInk(""""strokes""""))
        assertFalse(timelineHasInk("nur Text"))
    }

    @Test
    fun repeatedLinesMatchOnceAndTheListStopsAtEighty() {
        val changed = diffNoteLines("a\na\n", "a\n")
        assertEquals(listOf(TimelineRow(DiffKind.REMOVED, "a")), changed.filter { it.text == "a" })
        val before = (1..100).joinToString("\n") { "alt-$it" }
        assertEquals(80, diffNoteLines(before, "").size)
    }
}
