package ch.fasrv.fanotes.study

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class StudyCropTest {
    @Test fun cornersAreSortedAndClamped() {
        val r = cropFromCorners(0.8, 1.4, -0.2, 0.3)
        assertEquals(SRect(0.0, 0.3, 0.8, 1.0), r)
    }

    @Test fun tinyCropIsRejected() {
        assertFalse(cropIsUsable(cropFromCorners(0.1, 0.1, 0.11, 0.5)))
        assertTrue(cropIsUsable(cropFromCorners(0.1, 0.1, 0.13, 0.13)))
    }

    @Test fun gripPrefersCornersThenBody() {
        val r = SRect(0.2, 0.2, 0.6, 0.5)
        assertEquals(CropGrip.TL, cropGripAt(r, 0.21, 0.19, 0.03, 0.03))
        assertEquals(CropGrip.BR, cropGripAt(r, 0.6, 0.5, 0.03, 0.03))
        assertEquals(CropGrip.MOVE, cropGripAt(r, 0.4, 0.35, 0.03, 0.03))
        assertEquals(CropGrip.NONE, cropGripAt(r, 0.9, 0.9, 0.03, 0.03))
    }

    @Test fun moveKeepsSizeAndStaysOnPage() {
        val r = SRect(0.2, 0.2, 0.6, 0.5)
        val m = cropDragged(r, CropGrip.MOVE, 0.9, -0.9)
        assertEquals(0.4, m.r - m.l, 1e-9)
        assertEquals(0.3, m.b - m.t, 1e-9)
        assertEquals(1.0, m.r, 1e-9)
        assertEquals(0.0, m.t, 1e-9)
    }

    @Test fun cornerResizeKeepsMinimum() {
        val r = SRect(0.2, 0.2, 0.6, 0.5)
        val a = cropDragged(r, CropGrip.TL, 5.0, 5.0)
        assertEquals(0.6 - CROP_MIN, a.l, 1e-9)
        assertEquals(0.5 - CROP_MIN, a.t, 1e-9)
        val b = cropDragged(r, CropGrip.BR, -5.0, 5.0)
        assertEquals(0.2 + CROP_MIN, b.r, 1e-9)
        assertEquals(1.0, b.b, 1e-9)
    }

    @Test fun renderSizeIsCapped() {
        // Whole A4 page: 2400 x 3394 would exceed the cap, so the long edge is 1800.
        val (w, h) = cropRenderSize(SRect(0.0, 0.0, 1.0, 1.0), 1.414)
        assertEquals(1800, h)
        assertEquals(1273, w)
        // A small figure keeps its natural size.
        val (sw, sh) = cropRenderSize(SRect(0.1, 0.1, 0.3, 0.2), 1.414)
        assertEquals(480, sw)
        assertEquals(339, sh)
    }

    @Test fun fitWithinNeverEnlarges() {
        assertEquals(800 to 600, fitWithin(800, 600, 1600))
        assertEquals(1600 to 800, fitWithin(4000, 2000, 1600))
        assertEquals(1 to 1600, fitWithin(1, 100000, 1600))
        assertEquals(1400, studyImageEdge(true))
        assertEquals(1600, studyImageEdge(false))
        assertEquals(979, shrunkEdge(1400))
    }

    @Test fun placementMatchesDesktop() {
        val beside = cropPlacement(SRect(0.1, 0.2, 0.3, 0.4))
        assertEquals(0.32, beside.x, 1e-9)
        assertEquals(0.2, beside.w, 1e-9)
        assertEquals(0.2, beside.y, 1e-9)
        val edge = cropPlacement(SRect(0.5, 0.2, 0.95, 0.4))
        assertEquals(0.45, edge.w, 1e-9)
        assertEquals(0.53, edge.x, 1e-9)
    }

    @Test fun compareSplitFollowsOrientation() {
        val land = compareLayout(2000, 1200)
        assertEquals(CompareDock.LEFT, land.dock)
        assertEquals(800, land.panelPx)
        val port = compareLayout(1200, 2000)
        assertEquals(CompareDock.BOTTOM, port.dock)
        assertEquals(760, port.panelPx)
        assertEquals(60, compareLayout(300, 200).panelPx)
    }
}
