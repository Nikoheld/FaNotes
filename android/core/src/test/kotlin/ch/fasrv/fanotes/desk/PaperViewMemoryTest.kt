package ch.fasrv.fanotes.desk

import kotlin.math.abs
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class PaperViewMemoryTest {
    @Test
    fun aCameraRoundTripsAndDropsBrokenEntries() {
        var store = parsePaperViewMemory(null)
        assertTrue(store.isEmpty())
        store = rememberPaperView(
            store,
            "Math/Algebra.md",
            zoom = 2.4431,
            rotation = 0.0,
            centreX = 309.42,
            centreY = 2880.444,
            pageWidth = 512.48,
            pageHeight = 5588.87,
            anchor = PaperTextAnchor(1844, 67.373),
        )
        val reloaded = parsePaperViewMemory(serializePaperViewMemory(store))
        val entry = recallPaperView(reloaded, "Math/Algebra.md")
        assertEquals(2.443, entry?.zoom)
        assertEquals(309.42, entry?.centreX)
        assertEquals(512.48, entry?.pageWidth)
        assertEquals(PaperTextAnchor(1844, 67.37), entry?.anchor)
        assertTrue((entry?.at ?: 0L) > 0L)
        assertNull(recallPaperView(reloaded, "Other.md"))
        assertEquals("Math/Algebra.md", paperViewMemoryKey("split:Math/Algebra.md"))
        assertEquals("", paperViewMemoryKey(""))
        assertEquals(defaultPaperView(), paperViewFromMemory(null))
        assertEquals(2.443, paperViewFromMemory(entry).zoom)
        assertTrue(parsePaperViewMemory("{not json").isEmpty())
        assertTrue(parsePaperViewMemory("[1,2]").isEmpty())
        val dirty = parsePaperViewMemory(
            """{"ok":{"zoom":1.5,"centreX":10,"centreY":20,"at":5},"noZoom":{"centreX":1},"nanZoom":{"zoom":"x","centreX":1},"badAnchor":{"zoom":1,"centreX":0,"centreY":0,"anchor":{"pos":-3,"offset":"y"}}}""",
        )
        assertEquals(listOf("badAnchor", "ok"), dirty.keys.sorted())
        assertNull(dirty["badAnchor"]?.anchor)
        assertEquals(12, normalizeTextAnchor(12.4, -3.456)?.pos)
        assertEquals(-3.46, normalizeTextAnchor(12.0, -3.456)?.offset)
        assertNull(normalizeTextAnchor(Double.POSITIVE_INFINITY, 0.0))
    }

    @Test
    fun pruningKeepsTheNewestCameras() {
        var big = emptyMap<String, PaperViewMemoryEntry>()
        for (index in 0 until 12) {
            big = rememberPaperView(big, "n$index.md", zoom = 1.0, centreX = 0.0, centreY = 0.0, at = 1000L + index, max = 400)
        }
        val pruned = prunePaperViewMemory(big, 5)
        assertEquals(listOf("n10.md", "n11.md", "n7.md", "n8.md", "n9.md"), pruned.keys.sorted())
        assertEquals("fanotes.paperView.v1", PAPER_VIEW_MEMORY_KEY)
    }

    @Test
    fun theCentreRoundTripsThroughTheCameraAndScalesWithThePage() {
        val scroller = PaperScroller(1252, 858, 1498.0, 11925.0)
        val scrollerRect = PaperRect(300.0, 102.0, 1252.0, 858.0)
        val zoom = 2.443
        val pageRect = PaperRect(300.0 - 130.0, 102.0 - 9000.0, 512.48 * zoom, 4113.0 * zoom)
        val centre = paperCentreFromCamera(scroller, scrollerRect, pageRect, zoom)
        val expectedX = kotlin.math.floor(((300.0 + 626.0 - 170.0) / zoom) * 100.0 + 0.5) / 100.0
        assertEquals(expectedX, centre.centreX)
        val camera = cameraForPaperCentre(scroller, scrollerRect, pageRect, zoom, centre)
        assertTrue(abs(camera.scrollLeft - scroller.scrollLeft) < 0.02)
        assertTrue(abs(camera.scrollTop - scroller.scrollTop) < 0.02)
        assertEquals(PaperCentre(320.0, 2400.0), scaledPaperCentre(400.0, 3000.0, 1000.0, 800.0, proportional = true))
        assertEquals(PaperCentre(320.0, 3000.0), scaledPaperCentre(400.0, 3000.0, 1000.0, 800.0, proportional = false))
        assertEquals(PaperCentre(400.0, 3000.0), scaledPaperCentre(400.0, 3000.0, 1000.0, 1000.2, proportional = true))
        assertEquals(PaperCentre(400.0, 3000.0), scaledPaperCentre(400.0, 3000.0, null, 800.0, proportional = true))
    }

    @Test
    fun aTextAnchorSurvivesAChangedLineHeightEstimate() {
        val lineChars = 34
        val lineCount = 122
        val zoom = 2.443
        val estimated = DoubleArray(lineCount) { it * 60.0 }
        val measured = DoubleArray(lineCount) { it * 60.0 + maxOf(0, it - 60) * 40.0 }
        val froms = IntArray(lineCount) { it * lineChars }
        val before = LineBlockView(-5000.0, zoom, lineChars * lineCount, froms, measured)
        val anchor = textAnchorFromView(before, 102.0)
        assertTrue(anchor != null && anchor.pos % lineChars == 0 && anchor.pos > 60 * lineChars)
        val lineTopBefore = before.documentTop + before.lineBlockAt(anchor!!.pos).second
        assertTrue(abs((lineTopBefore + anchor.offset * zoom) - 102.0) < 0.05)
        val after = LineBlockView(-3815.0, zoom, lineChars * lineCount, froms, estimated)
        val y = clientYFromTextAnchor(after, anchor)!!
        val lineTopAfter = after.documentTop + after.lineBlockAt(anchor.pos).second
        assertTrue(abs(y - (lineTopAfter + anchor.offset * zoom)) < 0.05)
        assertEquals(
            kotlin.math.floor((5476.0 + y - 102.0) * 100.0 + 0.5) / 100.0,
            scrollTopForAnchorClientY(5476.0, 102.0, y),
        )
        assertEquals(0.0, scrollTopForAnchorClientY(10.0, 100.0, 20.0))
        val clamped = clientYFromTextAnchor(after, PaperTextAnchor(99999, 0.0))
        assertEquals(after.documentTop + after.lineBlockAt(lineChars * lineCount).second, clamped)
        val high = textAnchorFromView(before, before.documentTop - 500.0)!!
        assertTrue(high.offset < 0.0)
        assertTrue(abs(clientYFromTextAnchor(before, high)!! - (before.documentTop - 500.0)) < 0.05)
        assertTrue(textAnchorFromView(LineBlockView(0.0, 0.0, lineChars * lineCount, froms, estimated), 50.0)!!.offset.isFinite())
    }

    @Test
    fun restoreStopsForTheUserAndForARealKey() {
        assertTrue(isProgrammaticScroll(1498.0, 11925.0, 1498.0, 11926.0))
        assertTrue(!isProgrammaticScroll(1498.0, 8650.0, 1498.0, 11925.0))
        assertTrue(!isProgrammaticScroll(0.0, 0.0, null, null))
        assertTrue(shouldKeepRestoringPaperView(0L, 1000L, false))
        assertTrue(!shouldKeepRestoringPaperView(0L, 1000L, true))
        assertTrue(!shouldKeepRestoringPaperView(0L, 5000L, false))
        assertTrue(isPaperViewTakeoverKey("ArrowDown"))
        assertTrue(isPaperViewTakeoverKey("Enter"))
        assertTrue(!isPaperViewTakeoverKey("Tab", repeat = true))
        assertTrue(!isPaperViewTakeoverKey("Control"))
        assertTrue(!isPaperViewTakeoverKey("Shift", repeat = true))
    }
}