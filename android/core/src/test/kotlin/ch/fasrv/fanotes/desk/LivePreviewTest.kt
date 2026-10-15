package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class LivePreviewTest {
    @Test
    fun inactiveLinesHideMarkersAndTheCursorLineKeepsThem() {
        val note = "# Titel\n**fett** und *kursiv*\n- Punkt\n- [x] Tun\n> Zitat\n---\n[[Ziel|Name]]\n[Text](https://fanotes.example)\n`code` und \$x\$"
        val onTitle = livePreviewMarks(note, 0, 0)
        assertTrue(onTitle.any { it.kind == LiveKind.H1 && it.start == 0 })
        assertFalse(onTitle.any { it.kind == LiveKind.HIDE && it.start == 0 })
        assertEquals(LiveKind.STRONG, onTitle.first { it.start == note.indexOf("fett") }.kind)
        assertTrue(onTitle.any { it.kind == LiveKind.HIDE && it.start == note.indexOf("**") })

        val onBold = livePreviewMarks(note, note.indexOf("**"), note.indexOf("**"))
        assertFalse(onBold.any { it.kind == LiveKind.STRONG })
        assertTrue(onBold.any { it.kind == LiveKind.HIDE && it.start == 0 && it.end == 2 })
        assertEquals(LiveKind.BULLET, onBold.first { it.start == note.indexOf("- Punkt") }.kind)
        assertEquals(LiveKind.TASK_DONE, onBold.first { it.start == note.indexOf("- [x]") }.kind)
        assertEquals(LiveKind.QUOTE, onBold.first { it.start == note.indexOf("> Zitat") }.kind)
        assertTrue(onBold.any { it.kind == LiveKind.HIDE && it.start == note.indexOf("---") && it.end == note.indexOf("---") + 3 })
        assertTrue(onBold.any { it.kind == LiveKind.RULE && it.start == note.indexOf("---") })
        val onRule = livePreviewMarks("---", 1, 1)
        assertTrue(onRule.any { it.kind == LiveKind.RULE })
        assertFalse(onRule.any { it.kind == LiveKind.HIDE })
        assertEquals(LiveKind.LINK, onBold.first { it.start == note.indexOf("Name") }.kind)
        assertEquals(LiveKind.LINK, onBold.first { it.start == note.indexOf("Text") }.kind)
        assertEquals(LiveKind.CODE, onBold.first { it.start == note.indexOf("code") }.kind)
        assertEquals(LiveKind.MATH, onBold.first { it.start == note.indexOf("x\$") }.kind)
        assertEquals(LiveKind.EMPHASIS, onTitle.first { it.start == note.indexOf("kursiv") }.kind)
    }

    @Test
    fun metadataStaysHiddenOnTheCursorLineAndCodeOwnsItsRange() {
        val hidden = "<!-- fanotes-ink:abc -->"
        val marks = livePreviewMarks(hidden, 0, 0)
        assertEquals(listOf(LiveKind.HIDE, LiveKind.COLLAPSE), marks.map { it.kind })
        assertEquals(0 to hidden.length, marks[0].start to marks[0].end)
        val fenced = "`**a**`\n."
        val code = livePreviewMarks(fenced, fenced.indexOf('.'), fenced.indexOf('.'))
        assertEquals(listOf(LiveKind.HIDE, LiveKind.HIDE, LiveKind.CODE), code.map { it.kind })
        assertFalse(code.any { it.kind == LiveKind.STRONG })
        val rule = livePreviewMarks("| --- | --- |", 0, 0)
        assertTrue(rule.any { it.kind == LiveKind.TABLE_RULE })
        assertTrue(rule.any { it.kind == LiveKind.HIDE })
        assertTrue(livePreviewMarks("| A | B |", 0, 0).any { it.kind == LiveKind.TABLE_ROW })
        assertEquals(emptyList(), livePreviewMarks("", 0, 0))
    }

    @Test
    fun detailsSummaryHidesTheBodyUntilTheBlockIsOpen() {
        val closed = "<details>\n<summary>**Titel**</summary>\n\nGeheim\n</details>\nNachher"
        val folded = livePreviewMarks(closed, closed.length, closed.length)
        assertEquals("Titel", folded.first { it.kind == LiveKind.DETAILS_SUMMARY }.label)
        assertTrue(folded.any { it.kind == LiveKind.HIDE && it.start == closed.indexOf("Geheim") })
        assertTrue(folded.any { it.kind == LiveKind.HIDE && it.start == closed.indexOf("</details>") })
        val inside = livePreviewMarks(closed, closed.indexOf("Geheim"), closed.indexOf("Geheim"))
        assertFalse(inside.any { it.kind == LiveKind.DETAILS_SUMMARY })

        val inline = "<details><summary>Was</summary>4</details>"
        assertEquals("", livePreviewMarks(inline, 0, 0).first { it.kind == LiveKind.DETAILS_SUMMARY }.body)
        val opened = toggleDetailsOpen(inline, 0)
        assertEquals("<details open><summary>Was</summary>4</details>", opened)
        assertEquals("4", livePreviewMarks(opened!!, 0, 0).first { it.kind == LiveKind.DETAILS_SUMMARY }.body)
        assertEquals(inline, toggleDetailsOpen(opened, 0))

        val multi = "<details open>\n<summary>Titel</summary>\nGeheim\n</details>"
        val openMarks = livePreviewMarks(multi, multi.length, multi.length)
        assertEquals("Titel", openMarks.first { it.kind == LiveKind.DETAILS_SUMMARY }.label)
        assertFalse(openMarks.any { it.kind == LiveKind.HIDE && it.start == multi.indexOf("Geheim") })
        assertTrue(openMarks.any { it.kind == LiveKind.HIDE && it.start == multi.indexOf("<summary>") })
        assertTrue(openMarks.any { it.kind == LiveKind.HIDE && it.start == multi.indexOf("</details>") })
    }

    @Test
    fun tappingTheTaskBoxFlipsOnlyThatBox() {
        assertEquals("- [x] Offen", toggleTaskMarker("- [ ] Offen", 0))
        assertEquals("- [ ] Fertig", toggleTaskMarker("- [x] Fertig", 3))
        assertEquals("- [ ] Fertig", toggleTaskMarker("- [X] Fertig", 0))
        assertEquals(null, toggleTaskMarker("- [ ] Offen", 6))
        val indented = "  - [ ] A"
        assertEquals("  - [x] A", toggleTaskMarker(indented, 4))
        assertEquals(null, toggleTaskMarker(indented, 0))
        val second = "- [x] Oben\n- [ ] Unten"
        assertEquals("- [x] Oben\n- [x] Unten", toggleTaskMarker(second, second.indexOf("Unten") - 2))
        assertEquals("- [ ] Oben\n- [ ] Unten", toggleTaskMarker(second, 0))
    }

    @Test
    fun otherCopiesOfTheSelectionAreMarkedUntilThereAreTooMany() {
        val text = "beta Beta beta"
        assertEquals(listOf(10 to 14), selectionMatchRanges(text, 0, 4))
        assertEquals(emptyList(), selectionMatchRanges(text, 5, 5))
        assertEquals(emptyList(), selectionMatchRanges("aaaa", 1, 3))
        val many = "a".repeat(102)
        assertEquals(null, selectionMatchRanges(many, 0, 1))
        assertEquals(100, selectionMatchRanges("a".repeat(101), 0, 1)?.size)
    }

    @Test
    fun nextOccurrenceSelectsTheWordThenTheNextWholeCopy() {
        assertEquals(0 to 5, nextEditorOccurrence("Hallo Welt", 2, 2))
        assertEquals(0 to 5, nextEditorOccurrence("Hallo Welt", 5, 5))
        assertEquals(null, nextEditorOccurrence("Hallo Welt", 5, 6))
        assertEquals(0 to 7, editorWordRange("foo_bar baz", 1))
        val repeated = "beta und beta"
        assertEquals(9 to 13, nextEditorOccurrence(repeated, 0, 4))
        assertEquals(0 to 4, nextEditorOccurrence(repeated, 9, 13))
        assertEquals(4 to 8, nextEditorOccurrence("betabeta", 0, 4))
        assertEquals(null, nextEditorOccurrence("Beta beta", 0, 4))
        assertEquals(null, nextEditorOccurrence("nur", 0, 3))
        assertTrue(nextOccurrenceShortcut(true, false, false, false, 'd'))
        assertTrue(nextOccurrenceShortcut(true, false, false, false, 'D'))
        assertFalse(nextOccurrenceShortcut(true, true, false, false, 'd'))
        assertFalse(nextOccurrenceShortcut(false, false, false, false, 'd'))
        assertFalse(nextOccurrenceShortcut(true, false, true, false, 'd'))
        assertFalse(nextOccurrenceShortcut(true, false, false, true, 'd'))
        assertFalse(nextOccurrenceShortcut(true, false, false, false, 'b'))
    }
}
