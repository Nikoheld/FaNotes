package ch.fasrv.fanotes.ink

import ch.fasrv.fanotes.famd.isoNow
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

/** Sweep continuity between eraser frames, and the per-stroke reject that keeps heavy pages cheap. */
class EraserSweepTest {
    private val w = 900.0
    private val h = PAGE_START_HEIGHT

    private fun sp(x: Double, y: Double) = StrokePoint(x, y, 0.0, 0.6, 0.0, 0.0, "pen")

    /** Horizontal stroke at normalised [y], one vertex every [step] (normalised) from [fromX] to [toX]. */
    private fun horizontal(y: Double, fromX: Double, toX: Double, step: Double = 0.01, width: Double = 3.5, brush: String? = null): InkStroke {
        val points = ArrayList<StrokePoint>()
        var x = fromX
        while (x <= toX + 1e-9) {
            points += sp(x, y)
            x += step
        }
        return InkStroke(points = points, baseWidth = width, pressureEnabled = true, color = "#202333", brush = brush)
    }

    private fun vertical(x: Double, fromY: Double, toY: Double, step: Double = 0.01, width: Double = 3.5, brush: String? = null): InkStroke {
        val points = ArrayList<StrokePoint>()
        var y = fromY
        while (y <= toY + 1e-9) {
            points += sp(x, y)
            y += step
        }
        return InkStroke(points = points, baseWidth = width, pressureEnabled = true, color = "#202333", brush = brush)
    }

    private fun sessionOf(vararg strokes: InkStroke) =
        InkSession(newInkDocument("Page", "dots", isoNow(0)).copy(strokes = strokes.toList()))

    private fun keptPx(session: InkSession) = session.document.strokes.flatMap { it.points }.map { it.x * w }

    // -- sweep continuity -----------------------------------------------------------------

    @Test
    fun aFastSweepErasesTheSpanBetweenTwoFrames() {
        // Two frames with one sample each, 360 px apart (a finger at 1500 px/s on a 60 Hz panel).
        val session = sessionOf(horizontal(0.5, 0.05, 0.95))
        session.beginErase()
        assertTrue(session.eraseSamples(listOf(sp(0.2, 0.5)), 20.0, isoNow(1)))
        assertTrue(session.eraseSamples(listOf(sp(0.6, 0.5)), 20.0, isoNow(2)))
        session.endErase()
        val kept = keptPx(session)
        // Reach is 20 + 3.5 / 2: everything from 158.25 to 561.75 is under the sweep, a probe step outside it may survive.
        assertTrue(kept.none { it in 160.0..560.0 }, "ink between the frames survived: ${kept.filter { it in 160.0..560.0 }}")
        assertTrue(kept.any { it < 160.0 }, "ink left of the sweep stays")
        assertTrue(kept.any { it > 560.0 }, "ink right of the sweep stays")
        assertEquals(2, session.document.strokes.size)
    }

    @Test
    fun theSweepIsOneUndoStep() {
        val session = sessionOf(horizontal(0.5, 0.05, 0.95))
        session.beginErase()
        session.eraseSamples(listOf(sp(0.2, 0.5)), 20.0, isoNow(1))
        session.eraseSamples(listOf(sp(0.6, 0.5)), 20.0, isoNow(2))
        session.endErase()
        assertTrue(session.undo())
        assertEquals(1, session.document.strokes.size)
        assertFalse(session.canUndo)
    }

    @Test
    fun aFrameWithOneSampleIsACapsuleFromWhereTheNibWas() {
        val session = sessionOf(horizontal(0.5, 0.05, 0.95))
        session.beginErase()
        session.eraseSamples(listOf(sp(0.2, 0.5)), 20.0, isoNow(1))
        // A single sample 100 px on is not a disk any more: the nib moved there from 180 px.
        session.eraseSamples(listOf(sp(0.311, 0.5)), 20.0, isoNow(2))
        val kept = keptPx(session)
        assertTrue(kept.none { it in 160.0..300.0 }, "the 100 px between the frames is erased: ${kept.filter { it in 160.0..300.0 }}")
    }

    @Test
    fun aNewGestureStartsFreshInsteadOfJoiningTheLastOne() {
        val session = sessionOf(horizontal(0.5, 0.05, 0.95))
        session.beginErase()
        session.eraseSamples(listOf(sp(0.2, 0.5)), 20.0, isoNow(1))
        session.endErase()
        session.beginErase()
        session.eraseSamples(listOf(sp(0.6, 0.5)), 20.0, isoNow(2))
        session.endErase()
        val kept = keptPx(session)
        assertTrue(kept.any { it in 300.0..400.0 }, "lifting the pen between gestures must not erase the stretch between them")
        assertTrue(kept.none { it in 520.0..560.0 })
    }

    @Test
    fun undoMidGestureDropsTheSweepOrigin() {
        val session = sessionOf(horizontal(0.5, 0.05, 0.95))
        session.beginErase()
        session.eraseSamples(listOf(sp(0.2, 0.5)), 20.0, isoNow(1))
        assertTrue(session.undo())
        session.eraseSamples(listOf(sp(0.6, 0.5)), 20.0, isoNow(2))
        val kept = keptPx(session)
        assertTrue(kept.any { it in 150.0..210.0 }, "undo brought the first cut back and the next frame does not reach for it")
        assertTrue(kept.any { it in 300.0..400.0 })
    }

    @Test
    fun replacingTheDocumentDropsTheSweepOrigin() {
        val session = sessionOf(horizontal(0.5, 0.05, 0.95))
        session.beginErase()
        session.eraseSamples(listOf(sp(0.2, 0.5)), 20.0, isoNow(1))
        session.replace(newInkDocument("Other", "dots", isoNow(0)).copy(strokes = listOf(horizontal(0.5, 0.05, 0.95))))
        session.eraseSamples(listOf(sp(0.6, 0.5)), 20.0, isoNow(2))
        assertTrue(keptPx(session).any { it in 300.0..400.0 })
    }

    @Test
    fun theCarryOnlyContinuesOnTheSamePageSize() {
        val from = EraserCarry(sp(0.2, 0.5), w, h)
        val samples = listOf(sp(0.6, 0.5))
        val same = eraserSweep(from, samples, w, h)
        assertEquals(listOf(from.point, samples.single()), same)
        // The page grew: 0.5 now means another spot, so the carry is not trusted.
        assertEquals(samples, eraserSweep(from, samples, w, h * 1.5))
        assertEquals(samples, eraserSweep(from, samples, w * 0.8, h))
        assertEquals(samples, eraserSweep(null, samples, w, h))
    }

    @Test
    fun theSweepPathDropsNearDuplicatesAndNonFiniteSamples() {
        val samples = listOf(
            sp(0.2, 0.5),
            sp(0.2 + 0.1 / w, 0.5),
            sp(Double.NaN, 0.5),
            sp(0.3, Double.POSITIVE_INFINITY),
            sp(0.2 + 5.0 / w, 0.5),
        )
        val path = eraserSweep(null, samples, w, h)
        assertEquals(listOf(samples[0], samples[4]), path, "0.1 px apart adds nothing, NaN and infinity are skipped")
        assertTrue(eraserSweep(null, listOf(sp(Double.NaN, 0.1)), w, h).isEmpty())
        // The carry is the last finite sample, never a NaN.
        assertEquals(samples[4], eraserCarryOf(samples, w, h)?.point)
        assertNull(eraserCarryOf(listOf(sp(Double.NaN, 0.1)), w, h))
    }

    @Test
    fun aNonFiniteFrameLeavesTheCarryAlone() {
        val session = sessionOf(horizontal(0.5, 0.05, 0.95))
        session.beginErase()
        session.eraseSamples(listOf(sp(0.2, 0.5)), 20.0, isoNow(1))
        assertFalse(session.eraseSamples(listOf(sp(Double.NaN, 0.5)), 20.0, isoNow(2)))
        session.eraseSamples(listOf(sp(0.6, 0.5)), 20.0, isoNow(3))
        assertTrue(keptPx(session).none { it in 160.0..560.0 }, "the frame after the bad one still sweeps from 0.2")
    }

    // -- the per-stroke reject --------------------------------------------------------------

    @Test
    fun strokesFarFromTheSweepAreNeitherCopiedNorSplit() {
        val near = horizontal(0.5, 0.05, 0.95)
        val far = (0 until 300).map { i -> horizontal(0.8 + (i % 10) * 0.01, 0.05, 0.95, step = 0.05) }
        val session = sessionOf(near, *far.toTypedArray())
        assertTrue(session.erase(listOf(sp(0.5, 0.5)), 20.0, isoNow(1)))
        val after = session.document.strokes
        assertEquals(far.size, after.count { stroke -> far.any { it === stroke } }, "every far stroke is the same instance")
        assertTrue(after.none { it === near })
        assertEquals(far, after.takeLast(far.size), "order is kept")
    }

    @Test
    fun aFrameThatTouchesNothingChangesNothingAndAllocatesNoList() {
        val session = sessionOf(horizontal(0.5, 0.05, 0.95))
        val before = session.document.strokes
        assertFalse(session.eraseSamples(listOf(sp(0.5, 0.9)), 20.0, isoNow(1)))
        assertSame(before, session.document.strokes)
        assertFalse(session.canUndo, "no undo step for a frame that erased nothing")
        assertNull(session.erasedBounds)
    }

    @Test
    fun aStrokeAtTheEdgeOfTheReachIsStillCutAndOneBeyondItIsNot() {
        // Reach is 20 + 3.5 / 2 = 21.75 px.
        val inside = vertical(0.2 + 21.0 / w, 0.4, 0.6)
        val outside = vertical(0.2 + 23.0 / w, 0.4, 0.6)
        val session = sessionOf(inside, outside)
        assertTrue(session.erase(listOf(sp(0.2, 0.5)), 20.0, isoNow(1)))
        assertTrue(session.document.strokes.none { it === inside })
        assertTrue(session.document.strokes.any { it === outside }, "23 px away is out of reach and stays the same stroke")
    }

    @Test
    fun theRejectNeverSkipsAStrokeThatSplitStrokeWouldCut() {
        val radius = 20.0
        val sample = sp(0.2, 0.5)
        val sweep = assertNotNull(sweepBounds(listOf(sample), w, h))
        for (brush in listOf(null, "fineliner", "pencil", "marker", "highlighter", "calligraphy", "paintbrush", "watercolor", "spray")) {
            for (width in listOf(1.0, 3.5, 12.0, 30.0)) {
                for (offset in 0..160) {
                    val side = horizontal(0.5, 0.2 + offset / w, 0.2 + (offset + 40) / w, step = 0.01, width = width, brush = brush)
                    val below = vertical(0.2, 0.5 + offset / h, 0.5 + (offset + 40) / h, step = 0.01, width = width, brush = brush)
                    for (stroke in listOf(side, below)) {
                        val cut = splitStroke(stroke, listOf(sample), radius, w, h) != null
                        val may = strokeMayBeTouched(stroke, sweep, radius, w, h)
                        assertTrue(!cut || may, "brush=$brush width=$width offset=$offset: cut but rejected")
                    }
                }
            }
        }
    }

    @Test
    fun theRejectStillSkipsStrokesThatAreClearlyOutOfReach() {
        val sample = sp(0.2, 0.5)
        val sweep = assertNotNull(sweepBounds(listOf(sample), w, h))
        val stroke = horizontal(0.5, 0.2 + 120.0 / w, 0.2 + 400.0 / w, width = 3.5)
        assertFalse(strokeMayBeTouched(stroke, sweep, 20.0, w, h))
        val empty = InkStroke(points = emptyList(), baseWidth = 3.5, pressureEnabled = true, color = "#202333")
        assertFalse(strokeMayBeTouched(empty, sweep, 20.0, w, h))
        // The box of a long sweep reaches strokes anywhere along it.
        val long = assertNotNull(sweepBounds(listOf(sample, sp(0.9, 0.5)), w, h))
        assertTrue(strokeMayBeTouched(stroke, long, 20.0, w, h))
    }

    @Test
    fun theErasedBoxCoversTheWholeSweepPlusTheReach() {
        val session = sessionOf(horizontal(0.5, 0.05, 0.95))
        session.beginErase()
        session.eraseSamples(listOf(sp(0.2, 0.5)), 20.0, isoNow(1))
        session.eraseSamples(listOf(sp(0.6, 0.5)), 20.0, isoNow(2))
        val box = assertNotNull(session.erasedBounds)
        // The frame sweeps 180 px to 540 px, so the tiles of the whole stretch are stale, not only those at the event point.
        assertTrue(box[0] <= 180.0 - 21.75, "left ${box[0]}")
        assertTrue(box[2] >= 540.0 + 21.75, "right ${box[2]}")
        assertTrue(box[1] <= 0.5 * h - 21.75 && box[3] >= 0.5 * h + 21.75)
    }
}
