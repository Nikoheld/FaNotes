package ch.fasrv.fanotes.ink

import kotlin.random.Random
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertSame
import kotlin.test.assertTrue

class LiveInkTest {
    private fun wobble(count: Int, seed: Int): List<StrokePoint> {
        val random = Random(seed)
        var x = 0.3
        var y = 0.4
        return List(count) { index ->
            x += (random.nextDouble() - 0.3) * 0.004
            y += (random.nextDouble() - 0.5) * 0.004
            StrokePoint(x, y, index * 4.0, random.nextDouble(), 0.0, 0.0, "pen")
        }
    }

    @Test
    fun aSegmentRangeEqualsTheSameSliceOfTheWholeStroke() {
        for (seed in 1..6) {
            val points = wobble(97, seed)
            for (smoothing in listOf(0.0, 0.35, 0.68, 1.0)) {
                for ((passIndex, jitter) in listOf(0 to 0.0, 1 to 1.4, 2 to 1.8)) {
                    val whole = pencilGrainSegments(points, 1240.0, 1754.0, smoothing, 3.5, true, 0.72, 17, passIndex, jitter, 2.25)
                    assertEquals(points.size - 1, whole.size)
                    for ((first, last) in listOf(1 to 96, 1 to 32, 33 to 64, 2 to 2, 65 to 96, 90 to 200, 40 to 41)) {
                        val slice = pencilGrainSegmentRange(points, 1240.0, 1754.0, smoothing, 3.5, true, 0.72, 17, passIndex, jitter, 2.25, first, last)
                        assertEquals(whole.subList(first - 1, minOf(last, points.lastIndex)), slice, "seed $seed smoothing $smoothing pass $passIndex $first..$last")
                    }
                }
            }
        }
    }

    @Test
    fun anEmptyOrBackwardRangeHasNoSegments() {
        val points = wobble(10, 3)
        assertTrue(pencilGrainSegmentRange(points, 100.0, 100.0, 0.5, 3.0, true, 1.0, 1, 0, 0.0, 1.0, 5, 4).isEmpty())
        assertTrue(pencilGrainSegmentRange(points.take(1), 100.0, 100.0, 0.5, 3.0, true, 1.0, 1, 0, 0.0, 1.0, 1, 1).isEmpty())
        assertTrue(pencilGrainSegmentRange(points, 100.0, 100.0, 0.5, 3.0, true, 1.0, 1, 0, 0.0, 1.0, 12, 20).isEmpty())
    }

    @Test
    fun onlySegmentsWhoseSamplesAreFinalFreezeInWholeChunks() {
        assertEquals(0, liveFrozenSegments(0, 0, 32))
        assertEquals(0, liveFrozenSegments(33, 0, 32))
        // 34 samples: segments 1..33 exist, 1..32 are final (segment 33 still waits for sample 34's successor).
        assertEquals(32, liveFrozenSegments(34, 0, 32))
        assertEquals(32, liveFrozenSegments(65, 32, 32))
        assertEquals(64, liveFrozenSegments(66, 32, 32))
        assertEquals(96, liveFrozenSegments(100, 0, 32))
        assertEquals(32, liveFrozenSegments(20, 32, 32))
    }

    @Test
    fun aJoinedListReadsBothPartsWithoutCopying() {
        val head = listOf(1, 2, 3)
        val tail = listOf(4)
        val joined = joinedPoints(head, tail)
        assertEquals(listOf(1, 2, 3, 4), joined)
        assertEquals(4, joined.size)
        assertEquals(4, joined.last())
        assertSame(head, joinedPoints(head, emptyList()))
        assertSame(tail, joinedPoints(emptyList(), tail))
        assertFailsWith<IndexOutOfBoundsException> { joined[4] }
    }

    @Test
    fun appendingLiveSamplesKeepsEarlierSampleObjects() {
        val session = InkSession(
            InkDocument("t", "lines", PAGE_START_WIDTH, PAGE_START_HEIGHT, emptyList(), "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"),
        )
        session.beginStroke()
        for (point in wobble(40, 9)) session.addSample(point)
        val first = session.livePoints[0]
        val list = session.livePoints
        session.addSample(StrokePoint(list.last().x + 0.001, list.last().y, 999.0, 0.5, 0.0, 0.0, "pen"))
        assertSame(first, session.livePoints[0])
        assertEquals(41, session.livePoints.size)
        val stroke = session.endStroke(StrokeStyle(), "2026-01-01T00:00:01Z")
        assertEquals(41, stroke?.points?.size)
        assertTrue(session.livePoints.isEmpty())
        session.beginStroke()
        session.addSample(StrokePoint(0.5, 0.5, 1.0, 0.5, 0.0, 0.0, "pen"))
        assertEquals(41, stroke?.points?.size, "a new stroke must not grow the committed one")
    }
}
