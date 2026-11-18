package ch.fasrv.fanotes.desk

import ch.fasrv.fanotes.famd.isoNow
import ch.fasrv.fanotes.ink.InkSession
import ch.fasrv.fanotes.ink.StrokePoint
import ch.fasrv.fanotes.ink.StrokeStyle
import ch.fasrv.fanotes.ink.newInkDocument
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class PdfMarkHistoryTest {
    private val a = PdfTextMark("a", 1, "Photosynthese", "highlight")
    private val b = PdfTextMark("b", 1, "Chlorophyll", "underline")
    private val c = PdfTextMark("c", 2, "Zellwand", "highlight")

    private fun stroke(session: InkSession, y: Double) {
        session.commitShape(listOf(StrokePoint(0.2, y, 0.0, 0.6, 0.0, 0.0, "pen"), StrokePoint(0.4, y, 10.0, 0.6, 0.0, 0.0, "pen")), StrokeStyle(), isoNow())
    }

    @Test
    fun undoBringsAnErasedMarkBackAndRedoTakesItOffAgain() {
        val history = PdfMarkHistory()
        history.record(listOf(a, b), listOf(b), inkStamp = 0, now = 0)
        assertTrue(history.canUndo(0))
        val undone = history.undo(listOf(b), inkChanges = 0)!!
        assertEquals(setOf(a, b), undone.toSet())
        assertTrue(history.canRedo(0, 0))
        assertEquals(listOf(b), history.redo(undone))
        assertFalse(history.canRedo(0, 0))
        assertNull(history.redo(listOf(b)))
    }

    @Test
    fun undoKeepsMarksChangedInBetween() {
        val history = PdfMarkHistory()
        history.record(listOf(a, b), listOf(b), inkStamp = 0, now = 0)
        // Sync added c meanwhile; undo restores a and keeps c.
        assertEquals(setOf(a, b, c), history.undo(listOf(b, c), inkChanges = 0)!!.toSet())
    }

    @Test
    fun oneEraserGestureIsOneStep() {
        val history = PdfMarkHistory(mergeMs = 1_000)
        // The eraser splits a into a remnant, then erases the remnant and b.
        val remnant = a.copy(id = "a2", quote = "Photo")
        history.record(listOf(a, b), listOf(remnant, b), inkStamp = 0, now = 0, merge = true)
        history.record(listOf(remnant, b), emptyList(), inkStamp = 0, now = 300, merge = true)
        assertEquals(setOf(a, b), history.undo(emptyList(), 0)!!.toSet())
        assertFalse(history.canUndo(0))
        // A later gesture is its own step.
        history.record(listOf(a, b), listOf(b), inkStamp = 0, now = 5_000, merge = true)
        history.record(listOf(b), emptyList(), inkStamp = 0, now = 9_000, merge = true)
        assertEquals(listOf(b), history.undo(emptyList(), 0))
        assertTrue(history.canUndo(0))
    }

    @Test
    fun interleavesWithTheInkHistoryInOrder() {
        val session = InkSession(newInkDocument("PDF", "plain", isoNow()))
        val history = PdfMarkHistory()
        var marks = listOf(a, b)
        stroke(session, 0.2) // ink 1
        history.record(marks, listOf(b), session.undoStamp, now = 0) // marks after ink 1
        marks = listOf(b)
        stroke(session, 0.3) // ink 2
        assertEquals(2, session.document.strokes.size)

        // Undo: ink 2, then the marks, then ink 1.
        assertFalse(history.canUndo(session.undoStamp))
        assertTrue(session.undo())
        assertTrue(history.canUndo(session.undoStamp))
        marks = history.undo(marks, session.changeCount)!!
        assertEquals(setOf(a, b), marks.toSet())
        assertFalse(history.canUndo(session.undoStamp))
        assertTrue(session.undo())
        assertEquals(0, session.document.strokes.size)

        // Redo in the same order: ink 1, the marks, ink 2.
        assertFalse(history.canRedo(session.undoStamp, session.changeCount))
        assertTrue(session.redo())
        assertTrue(history.canRedo(session.undoStamp, session.changeCount))
        marks = history.redo(marks)!!
        assertEquals(listOf(b), marks)
        assertTrue(session.redo())
        assertEquals(2, session.document.strokes.size)
    }

    @Test
    fun newInkAfterAnUndoDropsTheMarkRedo() {
        val session = InkSession(newInkDocument("PDF", "plain", isoNow()))
        val history = PdfMarkHistory()
        history.record(listOf(a), emptyList(), session.undoStamp, now = 0)
        history.undo(emptyList(), session.changeCount)
        assertTrue(history.canRedo(session.undoStamp, session.changeCount))
        stroke(session, 0.5)
        session.undo()
        // Back at the same ink stamp, but the redo would now skip the new stroke's redo: not offered.
        assertFalse(history.canRedo(session.undoStamp, session.changeCount))
    }

    @Test
    fun replacingTheSessionStartsANewGeneration() {
        val session = InkSession(newInkDocument("PDF", "plain", isoNow()))
        val before = session.generation
        session.replace(newInkDocument("PDF", "plain", isoNow()))
        assertNotEquals(before, session.generation)
        val history = PdfMarkHistory()
        history.reset("Schule/Bio.pdf#1")
        history.record(listOf(a), emptyList(), 0, 0)
        history.reset("Schule/Bio.pdf#2")
        assertFalse(history.canUndo(0))
        assertEquals("Schule/Bio.pdf#2", history.key)
    }
}
