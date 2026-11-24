package ch.fasrv.fanotes.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ReaderZoomTest {
    private val m = ReaderZoomMath

    @Test fun zoomIsClampedToOneAndFive() {
        assertEquals(1f, m.clamp(0.3f), 0f)
        assertEquals(5f, m.clamp(9f), 0f)
        assertEquals(2.2f, m.clamp(2.2f), 0f)
        assertEquals(1f, m.clamp(Float.NaN), 0f)
        assertEquals(0.8f, m.clampText(0.1f), 0f)
        assertEquals(3f, m.clampText(7f), 0f)
    }

    @Test fun doubleTapTogglesBetweenOneAndTwoAndAHalf() {
        assertEquals(2.5f, m.doubleTapTarget(1f), 0f)
        assertEquals(1f, m.doubleTapTarget(2.5f), 0f)
        assertEquals(1f, m.doubleTapTarget(4f), 0f)
    }

    @Test fun stepsMoveOnAQuarterGridWithinTheRange() {
        assertEquals(1.25f, m.step(1f, up = true), 0f)
        assertEquals(1.5f, m.step(1.3f, up = true), 0f)
        assertEquals(1f, m.step(1.25f, up = false), 0f)
        assertEquals(1f, m.step(1f, up = false), 0f)
        assertEquals(5f, m.step(5f, up = true), 0f)
        assertEquals(0.8f, m.step(1f, up = false, low = m.TEXT_MIN, high = m.TEXT_MAX), 1e-6f)
        assertEquals(3f, m.step(3f, up = true, low = m.TEXT_MIN, high = m.TEXT_MAX), 0f)
        assertEquals(150, m.percent(1.5f))
    }

    @Test fun theFocalPointStaysUnderTheFingers() {
        // The content point under the fingers before and after the zoom must be the same page position.
        val viewport = 400f
        for ((from, to, ratio, offset) in listOf(
            Quad(150f, 150f, 2.5f, 0f), Quad(300f, 280f, 1.6f, 120f), Quad(40f, 40f, 4f, 0f), Quad(200f, 200f, 2f, 400f),
        )) {
            val zoomBefore = 1f + offset / viewport
            val next = m.refocus(offset, from, to, ratio, m.maxPan(viewport, zoomBefore * ratio))
            val before = (offset + from) / zoomBefore
            val after = (next + to) / (zoomBefore * ratio)
            // Only clamping at the edges may move it; these cases stay inside the range.
            assertEquals("from=$from", before, after, 0.01f)
        }
    }

    @Test fun theOffsetIsClampedAtTheEdges() {
        assertEquals(0f, m.refocus(0f, 10f, 200f, 1.5f, 200f), 0f)
        assertEquals(200f, m.refocus(150f, 390f, 10f, 3f, 200f), 0f)
        assertEquals(0f, m.maxPan(400f, 1f), 0f)
        assertEquals(1200f, m.maxPan(400f, 4f), 0f)
    }

    private data class Quad(val from: Float, val to: Float, val ratio: Float, val offset: Float)

    @Test fun pageStackScalesUniformlyWithTheZoom() {
        val aspects = listOf(1.4f, 1.4f, 0.7f)
        val one = m.slots(400f, 800f, 1f, aspects, fit = false, gap = 12f)
        val two = m.slots(400f, 800f, 2f, aspects, fit = false, gap = 12f)
        assertEquals(one.sum() * 2f, two.sum().toFloat(), 3f)
        assertEquals(400 * 1.4f + 12f, one[0].toFloat(), 1f)
    }

    @Test fun absoluteOffsetAndLocateAreInverse() {
        val slots = listOf(500, 500, 300, 700)
        for (absolute in listOf(0, 1, 499, 500, 999, 1000, 1299, 1300, 1999)) {
            val (index, offset) = m.locate(slots, absolute)
            assertEquals(absolute, m.absoluteOffset(slots, index, offset))
        }
        assertEquals(3 to 699, m.locate(slots, 99999))
        assertEquals(0 to 0, m.locate(emptyList(), 50))
    }

    @Test fun aSingleImageFitsTheViewportAtOneTimes() {
        val tall = m.pageBox(400f, 800f, 1f, 3f, fit = true, gap = 12f)
        assertEquals(800f / 3f, tall.width, 0.01f)
        assertEquals(800f, tall.height, 0.01f)
        val wide = m.pageBox(400f, 800f, 1f, 0.5f, fit = true, gap = 12f)
        assertEquals(400f, wide.width, 0.01f)
        assertEquals(800f, wide.slot, 0.01f)
        val zoomed = m.pageBox(400f, 800f, 4f, 0.5f, fit = true, gap = 12f)
        assertEquals(800f, zoomed.height, 0.01f)
        assertEquals(1600f, zoomed.width, 0.01f)
    }

    @Test fun renderWidthIsCappedByPixelsAndBytes() {
        assertEquals(1080, m.renderWidth(1080f, 1.41f))
        assertEquals(3000, m.renderWidth(9000f, 0.5f))
        assertEquals(2508, m.renderWidth(9000f, 1.0f))
        // A very tall page shrinks until it fits 24 MB: width * height * 4 <= 24 MB.
        val width = m.renderWidth(3000f, 5f)
        assertTrue(width.toLong() * (width * 5L) * 4 <= m.MAX_RENDER_BYTES)
        assertTrue(width < 3000)
        assertEquals(1, m.renderWidth(0f, 1f))
    }

    @Test fun imagesAreSampledDownToFourThousandPixelsAnd24Megabytes() {
        assertEquals(1, imageSampleSize(1200, 800))
        assertEquals(2, imageSampleSize(4096, 4096))
        assertEquals(2, imageSampleSize(6000, 4000))
        assertEquals(8, imageSampleSize(16000, 12000))
        // Within 4096 on the long side but over 24 MB: the byte cap decides.
        val sample = imageSampleSize(4096, 4096, maxSide = 4096, maxBytes = 8L * 1024 * 1024)
        assertTrue((4096L / sample) * (4096L / sample) * 4 <= 8L * 1024 * 1024)
        assertEquals(1, imageSampleSize(0, 0))
    }
}
