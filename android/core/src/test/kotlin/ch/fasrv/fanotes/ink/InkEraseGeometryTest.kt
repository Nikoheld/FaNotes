package ch.fasrv.fanotes.ink

import ch.fasrv.fanotes.famd.isoNow
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.random.Random
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Geometry of the eraser cut (`splitStroke`): the same cases as
 * `fanotes/scripts/check-tool-erase.mjs` on the desktop. Width 3 and radius 6
 * reach the ink 7.5 px to either side of the eraser; a remainder shorter than
 * max(0.5, width / 4) px is a crumb and is dropped.
 */
class InkEraseGeometryTest {
    private val pageW = 1000.0
    private val pageH = 1400.0

    private fun fieldsAt(x: Double, y: Double) = doubleArrayOf(0.5 * x + 0.25 * y, 0.2 + 0.0004 * x + 0.0003 * y)

    /** A stroke through [coords] given in page px; time and pressure are linear in the position. */
    private fun ink(
        vararg coords: Pair<Double, Double>,
        width: Double = 3.0,
        page: Double = pageH,
    ): InkStroke = InkStroke(
        points = coords.map { (x, y) ->
            val fields = fieldsAt(x, y)
            StrokePoint(x / pageW, y / page, fields[0], fields[1], 0.0, 0.0, "pen")
        },
        baseWidth = width,
        pressureEnabled = true,
        color = "#202333",
    )

    private fun sample(x: Double, y: Double, page: Double = pageH) = StrokePoint(x / pageW, y / page, 0.0, 0.6, 0.0, 0.0, "pen")

    private fun coords(stroke: InkStroke, page: Double = pageH) = stroke.points.map { it.x * pageW to it.y * page }

    private fun assertShape(
        pieces: List<InkStroke>?,
        expected: List<List<Pair<Double, Double>>>,
        label: String,
        page: Double = pageH,
    ) {
        assertNotNull(pieces, "$label: the stroke is cut")
        val got = pieces.map { coords(it, page) }
        assertEquals(expected.size, got.size, "$label: expected ${expected.size} pieces, got $got")
        got.forEachIndexed { index, piece ->
            assertEquals(expected[index].size, piece.size, "$label: piece $index is $piece")
            piece.forEachIndexed { at, (x, y) ->
                assertEquals(expected[index][at].first, x, 1e-6, "$label: piece $index point $at x")
                assertEquals(expected[index][at].second, y, 1e-6, "$label: piece $index point $at y")
            }
        }
    }

    private fun cut(stroke: InkStroke, radius: Double, page: Double = pageH, vararg samples: Pair<Double, Double>) =
        splitStroke(stroke, samples.map { (x, y) -> sample(x, y, page) }, radius, pageW, page)

    @Test
    fun aSwipeAcrossASparseSegmentCutsItBetweenItsVertices() {
        // The vertices are 200 px apart: no vertex and no probe needs to be near the swipe.
        for (x in listOf(130.0, 200.0, 270.0)) {
            assertShape(
                cut(ink(100.0 to 500.0, 300.0 to 500.0), 6.0, pageH, x to 480.0, x to 520.0),
                listOf(listOf(100.0 to 500.0, (x - 7.5) to 500.0), listOf((x + 7.5) to 500.0, 300.0 to 500.0)),
                "swipe at x=$x",
            )
        }
        val slope = 20.0 / 300.0
        assertShape(
            cut(ink(100.0 to 500.0, 400.0 to 520.0), 6.0, pageH, 250.0 to 400.0, 250.0 to 600.0),
            listOf(
                listOf(100.0 to 500.0, 242.5 to 500.0 + 142.5 * slope),
                listOf(257.5 to 500.0 + 157.5 * slope, 400.0 to 520.0),
            ),
            "a long swipe across a slanted stroke",
        )
        assertShape(
            cut(ink(100.0 to 500.0, 300.0 to 500.0), 6.0, pageH, 130.0 to 480.0, 130.0 to 520.0, 270.0 to 520.0, 270.0 to 480.0),
            listOf(
                listOf(100.0 to 500.0, 122.5 to 500.0),
                listOf(137.5 to 500.0, 262.5 to 500.0),
                listOf(277.5 to 500.0, 300.0 to 500.0),
            ),
            "a U-shaped sweep that crosses the stroke twice",
        )
    }

    @Test
    fun aSweepAcrossAVeryLongSegmentWithATinyRadiusStillCuts() {
        // 4000 px at a radius of 1 px: 512 probes along the segment would be 7.8 px apart,
        // wider than the 5.5 px the eraser covers, so a probe walk can step over the sweep.
        val tall = 9000.0
        assertShape(
            cut(ink(100.0 to 100.0, 100.0 to 4100.0, page = tall), 1.0, tall, 90.0 to 2000.0, 110.0 to 2000.0),
            listOf(listOf(100.0 to 100.0, 100.0 to 1997.5), listOf(100.0 to 2002.5, 100.0 to 4100.0)),
            "a 1 px sweep across a 4000 px segment",
            tall,
        )
    }

    @Test
    fun anEraserSittingOnALongSegmentCutsOutItsOwnWidthOnly() {
        for (x in listOf(110.0, 130.0, 160.0, 200.0, 270.0, 290.0)) {
            assertShape(
                cut(ink(100.0 to 500.0, 300.0 to 500.0), 6.0, pageH, x to 500.0),
                listOf(listOf(100.0 to 500.0, (x - 7.5) to 500.0), listOf((x + 7.5) to 500.0, 300.0 to 500.0)),
                "stationary eraser at x=$x",
            )
        }
        assertShape(
            cut(ink(100.0 to 500.0, 160.0 to 500.0, 220.0 to 500.0), 3.0, pageH, 118.0 to 500.0),
            listOf(listOf(100.0 to 500.0, 113.5 to 500.0), listOf(122.5 to 500.0, 160.0 to 500.0, 220.0 to 500.0)),
            "a small eraser on the first segment of a polyline",
        )
        assertShape(
            cut(ink(100.0 to 500.0, 160.0 to 500.0, 220.0 to 500.0), 6.0, pageH, 160.0 to 500.0),
            listOf(listOf(100.0 to 500.0, 152.5 to 500.0), listOf(167.5 to 500.0, 220.0 to 500.0)),
            "an eraser on a vertex takes the vertex",
        )
        assertShape(
            cut(ink(100.0 to 500.0, 152.5 to 500.0, 220.0 to 500.0), 6.0, pageH, 160.0 to 500.0),
            listOf(listOf(100.0 to 500.0, 152.5 to 500.0), listOf(167.5 to 500.0, 220.0 to 500.0)),
            "a cut that lands on a vertex does not repeat it",
        )
    }

    @Test
    fun noCrumbsAreLeftNextToACut() {
        // A remainder under 0.75 px (a quarter of the width) is dropped, a longer one stays.
        assertShape(
            cut(ink(100.0 to 500.0, 300.0 to 500.0), 6.0, pageH, 292.0 to 500.0),
            listOf(listOf(100.0 to 500.0, 284.5 to 500.0)),
            "a 0.5 px remainder at the far end",
        )
        assertShape(
            cut(ink(100.0 to 500.0, 300.0 to 500.0), 6.0, pageH, 108.0 to 500.0),
            listOf(listOf(115.5 to 500.0, 300.0 to 500.0)),
            "a 0.5 px remainder at the near end",
        )
        assertShape(
            cut(ink(100.0 to 500.0, 300.0 to 500.0), 6.0, pageH, 291.5 to 500.0),
            listOf(listOf(100.0 to 500.0, 284.0 to 500.0), listOf(299.0 to 500.0, 300.0 to 500.0)),
            "a 1 px remainder",
        )
        // The limit grows with the width: a quarter of 12 px is 3 px.
        val wide = ink(100.0 to 500.0, 300.0 to 500.0, width = 12.0)
        assertShape(cut(wide, 6.0, pageH, 286.0 to 500.0), listOf(listOf(100.0 to 500.0, 274.0 to 500.0)), "a 2 px stub of a wide stroke")
        assertShape(
            cut(wide, 6.0, pageH, 284.0 to 500.0),
            listOf(listOf(100.0 to 500.0, 272.0 to 500.0), listOf(296.0 to 500.0, 300.0 to 500.0)),
            "a 4 px stub of a wide stroke",
        )
    }

    @Test
    fun dotsAndMissesAreAllOrNothing() {
        val dot = ink(100.0 to 500.0, width = 8.0)
        assertEquals(emptyList<InkStroke>(), cut(dot, 2.0, pageH, 105.0 to 500.0), "a dot is erased when the disk reaches its edge")
        assertNull(cut(dot, 2.0, pageH, 107.0 to 500.0), "and kept when the disk stops short of it")
        assertEquals(emptyList<InkStroke>(), cut(ink(100.0 to 500.0, 101.0 to 500.0), 2.0, pageH, 100.0 to 500.0), "a tiny two-point stroke")
        assertEquals(emptyList<InkStroke>(), cut(ink(100.0 to 500.0, 100.0 to 500.0, 100.0 to 500.0), 2.0, pageH, 103.0 to 500.0), "repeated samples are a dot")
        val line = ink(100.0 to 500.0, 300.0 to 500.0)
        assertNull(cut(line, 6.0, pageH, 200.0 to 500.0 - 7.51), "0.01 px short of the ink")
        val chord = sqrt(7.5 * 7.5 - 7.49 * 7.49)
        assertShape(
            cut(line, 6.0, pageH, 200.0 to 500.0 - 7.49),
            listOf(listOf(100.0 to 500.0, (200.0 - chord) to 500.0), listOf((200.0 + chord) to 500.0, 300.0 to 500.0)),
            "a graze cuts the chord and no more",
        )
    }

    @Test
    fun aCutPieceGetsTheTimeAndPressureTheLineHasThere() {
        val pieces = cut(ink(100.0 to 500.0, 300.0 to 500.0), 6.0, pageH, 200.0 to 500.0)
        assertNotNull(pieces)
        for (piece in pieces) {
            for (point in piece.points) {
                val fields = fieldsAt(point.x * pageW, point.y * pageH)
                assertEquals(fields[0], point.t, 1e-9)
                assertEquals(fields[1], point.pressure, 1e-9)
            }
        }
    }

    @Test
    fun theSessionCutsASparseStrokeInOneUndoStep() {
        val session = InkSession(
            newInkDocument("Page", "dots", isoNow(0)).let { document ->
                val width = document.sourceWidth
                val height = document.sourceHeight
                val points = listOf(100.0 to 500.0, 300.0 to 500.0).map { (x, y) -> StrokePoint(x / width, y / height, 0.0, 0.6, 0.0, 0.0, "pen") }
                document.copy(strokes = listOf(InkStroke(points, 3.0, true, "#202333")))
            },
        )
        val width = session.document.sourceWidth
        val height = session.document.sourceHeight
        val swipe = listOf(StrokePoint(200.0 / width, 480.0 / height, 0.0, 0.6, 0.0, 0.0, "pen"), StrokePoint(200.0 / width, 520.0 / height, 0.0, 0.6, 0.0, 0.0, "pen"))
        assertTrue(session.erase(swipe, radiusPagePx = 6.0, now = isoNow(1)))
        val pieces = session.document.strokes
        assertEquals(2, pieces.size)
        assertEquals(192.5, pieces[0].points.last().x * width, 1e-6)
        assertEquals(207.5, pieces[1].points.first().x * width, 1e-6)
        assertTrue(session.undo())
        assertEquals(1, session.document.strokes.size)
        assertEquals(2, session.document.strokes.single().points.size)
    }

    // ---- Random strokes and sweeps against a sampling oracle ----

    private fun between(random: Random, low: Double, high: Double) = low + (high - low) * random.nextDouble()

    private fun distanceToSegment(px: Double, py: Double, ax: Double, ay: Double, bx: Double, by: Double): Double {
        val dx = bx - ax
        val dy = by - ay
        val squared = dx * dx + dy * dy
        val t = if (squared > 0.0) (((px - ax) * dx + (py - ay) * dy) / squared).coerceIn(0.0, 1.0) else 0.0
        return hypot(px - (ax + dx * t), py - (ay + dy * t))
    }

    private fun distanceToLine(x: Double, y: Double, line: List<Pair<Double, Double>>): Double {
        if (line.size == 1) return hypot(x - line[0].first, y - line[0].second)
        var best = Double.POSITIVE_INFINITY
        for (index in 1 until line.size) {
            best = min(best, distanceToSegment(x, y, line[index - 1].first, line[index - 1].second, line[index].first, line[index].second))
        }
        return best
    }

    /** Points along a polyline no farther than [step] apart, vertices included. */
    private fun sampleLine(line: List<Pair<Double, Double>>, step: Double): List<Pair<Double, Double>> {
        val found = arrayListOf(line[0])
        for (index in 1 until line.size) {
            val (ax, ay) = line[index - 1]
            val (bx, by) = line[index]
            val parts = max(1, ceil(hypot(bx - ax, by - ay) / step).toInt())
            for (part in 1..parts) found += (ax + (bx - ax) * part / parts) to (ay + (by - ay) * part / parts)
        }
        return found
    }

    private fun lengthOf(line: List<Pair<Double, Double>>): Double {
        var sum = 0.0
        for (index in 1 until line.size) sum += hypot(line[index].first - line[index - 1].first, line[index].second - line[index - 1].second)
        return sum
    }

    private fun randomStroke(random: Random, w: Double, h: Double): InkStroke {
        val sparse = random.nextDouble() < 0.5
        val count = if (sparse) 2 + random.nextInt(7) else 20 + random.nextInt(100)
        var x = between(random, 30.0, w - 30.0)
        var y = between(random, 30.0, h - 30.0)
        var heading = between(random, 0.0, 2 * PI)
        val points = ArrayList<StrokePoint>()
        repeat(count) {
            val fields = fieldsAt(x, y)
            points += StrokePoint(x / w, y / h, fields[0], fields[1], 0.0, 0.0, "pen")
            heading += if (sparse) between(random, -1.5, 1.5) else between(random, -0.4, 0.4)
            val step = when {
                random.nextDouble() < 0.05 -> 0.0
                sparse -> between(random, 15.0, 260.0)
                else -> between(random, 0.4, 3.5)
            }
            x = (x + cos(heading) * step).coerceIn(2.0, w - 2.0)
            y = (y + sin(heading) * step).coerceIn(2.0, h - 2.0)
        }
        return InkStroke(points, between(random, 0.5, 14.0), true, "#202333")
    }

    @Test
    fun randomStrokesAndSweepsMatchASamplingOracle() {
        val random = Random(20261116)
        var cutStrokes = 0
        var untouched = 0
        var multiPiece = 0
        repeat(300) { trial ->
            val w = (500 + random.nextInt(800)).toDouble()
            val h = (700 + random.nextInt(1500)).toDouble()
            val strokes = List(1 + random.nextInt(3)) { randomStroke(random, w, h) }
            val target = strokes[random.nextInt(strokes.size)]
            val hook = target.points[random.nextInt(target.points.size)]
            var x = (hook.x * w + between(random, -30.0, 30.0)).coerceIn(1.0, w - 1.0)
            var y = (hook.y * h + between(random, -30.0, 30.0)).coerceIn(1.0, h - 1.0)
            val path = arrayListOf(x to y)
            val wanted = 1 + random.nextInt(6)
            val fast = random.nextDouble() < 0.6
            var heading = between(random, 0.0, 2 * PI)
            var attempt = 0
            while (attempt < 60 && path.size < wanted) {
                attempt += 1
                heading += between(random, -1.2, 1.2)
                val step = if (fast) between(random, 10.0, 320.0) else between(random, 0.5, 6.0)
                val nextX = (x + cos(heading) * step).coerceIn(1.0, w - 1.0)
                val nextY = (y + sin(heading) * step).coerceIn(1.0, h - 1.0)
                if (hypot(nextX - x, nextY - y) < 0.6) continue
                path += nextX to nextY
                x = nextX
                y = nextY
            }
            val radius = if (random.nextDouble() < 0.15) between(random, 0.5, 3.0) else between(random, 1.0, 40.0)
            val samples = path.map { (px, py) -> StrokePoint(px / w, py / h, 0.0, 0.6, 0.0, 0.0, "pen") }

            for ((index, stroke) in strokes.withIndex()) {
                val label = "trial $trial stroke $index (radius $radius, width ${stroke.baseWidth}, ${stroke.points.size} points)"
                val original = stroke.points.map { it.x * w to it.y * h }
                val reach = radius + stroke.baseWidth / 2
                val crumb = max(0.5, stroke.baseWidth / 4)
                val inkSamples = sampleLine(original, 0.25)
                val gaps = inkSamples.map { (sx, sy) -> distanceToLine(sx, sy, path) }
                val nearest = gaps.minOrNull()!!
                val pieces = splitStroke(stroke, samples, radius, w, h)

                // 0.125 px is the most a point between two samples can be closer than the closest sample.
                if (nearest > reach + 0.126) {
                    assertNull(pieces, "$label: ink the path never reaches stays")
                    untouched += 1
                    continue
                }
                if (nearest < reach - 0.01) {
                    assertNotNull(pieces, "$label: ink the path reaches is cut")
                    cutStrokes += 1
                }
                if (pieces == null) continue
                if (pieces.size > 1) multiPiece += 1

                val lines = pieces.map { piece -> piece.points.map { it.x * w to it.y * h } }
                lines.forEachIndexed { at, line ->
                    assertTrue(line.size >= 2, "$label: piece $at has one point")
                    assertTrue(lengthOf(line) >= crumb - 1e-9, "$label: piece $at is a crumb of ${lengthOf(line)} px")
                    // Every piece is a stretch of the original line...
                    for ((sx, sy) in sampleLine(line, 0.5)) {
                        assertTrue(distanceToLine(sx, sy, original) <= 1e-6, "$label: piece $at leaves the drawn line at $sx,$sy")
                    }
                    // ...that lies wholly outside the reach of the eraser.
                    for ((sx, sy) in sampleLine(line, 0.25)) {
                        val gap = distanceToLine(sx, sy, path)
                        assertTrue(gap >= reach - 1e-6, "$label: ink left at $sx,$sy, $gap px from the path (reach $reach)")
                    }
                    for (point in pieces[at].points) {
                        val fields = fieldsAt(point.x * w, point.y * h)
                        assertEquals(fields[0], point.t, 1e-9, "$label: a cut point lost its time")
                        assertEquals(fields[1], point.pressure, 1e-9, "$label: a cut point lost its pressure")
                    }
                    // Erasing the same place again changes nothing.
                    assertNull(splitStroke(pieces[at], samples, radius, w, h), "$label: piece $at is cut again")
                }

                // Only ink within reach goes, plus a crumb next to a cut.
                inkSamples.forEachIndexed { at, (sx, sy) ->
                    if (gaps[at] > reach + crumb + 1e-6) {
                        val covered = lines.any { line ->
                            (1 until line.size).any { i -> distanceToSegment(sx, sy, line[i - 1].first, line[i - 1].second, line[i].first, line[i].second) <= 1e-6 }
                        }
                        assertTrue(covered, "$label: ink at $sx,$sy is ${gaps[at]} px from the path (reach $reach, crumb $crumb) and was removed")
                    }
                }
            }
        }
        assertTrue(cutStrokes > 150, "the random trials cut ink ($cutStrokes cut strokes)")
        assertTrue(untouched > 50, "the random trials also miss ($untouched untouched strokes)")
        assertTrue(multiPiece > 20, "some random cuts leave more than one piece ($multiPiece)")
    }

    @Test
    fun theRemainderNextToTheEndOfALongSegmentIsACrumbOnlyBelowItsLimit() {
        val random = Random(77)
        var dropped = 0
        var kept = 0
        repeat(120) { trial ->
            val radius = between(random, 1.0, 30.0)
            val width = between(random, 0.5, 14.0)
            val reach = radius + width / 2
            val crumb = max(0.5, width / 4)
            val stub = between(random, 0.05, crumb * 1.8)
            if (abs(stub - crumb) < 1e-4) return@repeat
            val length = 4 * (radius + 7) + 40
            val stroke = ink(100.0 to 500.0, (100.0 + length) to 500.0, width = width)
            val pieces = cut(stroke, radius, pageH, (100.0 + length - reach - stub) to 500.0)
            assertNotNull(pieces, "trial $trial")
            val tail = pieces.map { coords(it) }.filter { abs(it.last().first - (100.0 + length)) < 1e-6 }
            if (stub < crumb) {
                assertEquals(0, tail.size, "trial $trial: a stub of $stub px (crumb $crumb) is dropped")
                dropped += 1
            } else {
                assertEquals(1, tail.size, "trial $trial: a stub of $stub px (crumb $crumb) stays")
                assertEquals(stub, lengthOf(tail[0]), 1e-6)
                kept += 1
            }
        }
        assertTrue(dropped > 20 && kept > 20, "both sides of the limit are covered ($dropped dropped, $kept kept)")
    }
}
