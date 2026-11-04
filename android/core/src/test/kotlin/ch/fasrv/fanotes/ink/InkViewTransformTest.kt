package ch.fasrv.fanotes.ink

import kotlin.math.abs
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class InkViewTransformTest {
    private val width = 900.0
    private val height = 1273.0
    private val viewW = 900f
    private val viewH = 1273f

    @Test
    fun pinchAtTheCentreKeepsThePagePointUnderTheFingers() {
        val start = InkCamera()
        val (cx, cy) = 450f to 636.5f
        val zoomed = pinchPan(start, cx, cy, 200f, cx, cy, 400f, viewW, viewH, width, height)
        assertEquals(2f, zoomed.zoom, 0.001f)
        val (nx, ny) = screenToNormalized(cx, cy, zoomed, viewW, width, height)
        assertEquals(0.5, nx, 0.002)
        assertEquals(0.5, ny, 0.002)
    }

    @Test
    fun pinchAtACornerKeepsThatPagePointAndDoesNotJump() {
        val start = InkCamera()
        val (fx, fy) = 90f to 80f
        val zoomed = pinchPan(start, fx, fy, 120f, fx, fy, 240f, viewW, viewH, width, height)
        val before = screenToNormalized(fx, fy, start, viewW, width, height)
        val after = screenToNormalized(fx, fy, zoomed, viewW, width, height)
        assertEquals(before.first, after.first, 0.002)
        assertEquals(before.second, after.second, 0.002)
        assertEquals(2f, zoomed.zoom, 0.001f)
    }

    @Test
    fun twoFingerMoveAtConstantSpanPansThePagePointToTheNewCentroid() {
        val start = zoomAtFocus(InkCamera(), 450f, 636.5f, 2f, viewW, viewH, width, height)
        val old = 200f to 300f
        val moved = pinchPan(start, old.first, old.second, 180f, 280f, 340f, 180f, viewW, viewH, width, height)
        assertEquals(2f, moved.zoom, 0.001f)
        val expected = screenToNormalized(old.first, old.second, start, viewW, width, height)
        val actual = screenToNormalized(280f, 340f, moved, viewW, width, height)
        assertEquals(expected.first, actual.first, 0.002)
        assertEquals(expected.second, actual.second, 0.002)
    }

    @Test
    fun zoomIsClampedBetweenOneAndSixAndScrollStaysInRange() {
        val over = zoomAtFocus(InkCamera(), 450f, 600f, 12f, viewW, viewH, width, height)
        assertEquals(INK_ZOOM_MAX, over.zoom)
        val under = zoomAtFocus(over, 450f, 600f, 0.2f, viewW, viewH, width, height)
        assertEquals(INK_ZOOM_MIN, under.zoom)
        assertEquals(0f, under.pageX, 0.01f)
        assertEquals(0f, under.pageY, 0.01f)
        val panned = panInkCamera(over, -8_000f, -8_000f, viewW, viewH, width, height)
        assertTrue(panned.pageX >= 0f)
        assertTrue(panned.pageY >= 0f)
        val scale = displayedScale(viewW, width, panned.zoom)
        assertTrue(panned.pageX <= width.toFloat() - viewW / scale + 0.05f)
        assertTrue(panned.pageY <= height.toFloat() - viewH / scale + 0.05f)
    }

    @Test
    fun screenAndPageMappingRoundTripUnderThePen() {
        val camera = zoomAtFocus(InkCamera(), 200f, 400f, 3f, viewW, viewH, width, height)
        val (nx, ny) = screenToNormalized(120f, 640f, camera, viewW, width, height)
        val (sx, sy) = normalizedToScreen(nx, ny, camera, viewW, width, height)
        assertEquals(120f, sx, 0.8f)
        assertEquals(640f, sy, 0.8f)
    }

    @Test
    fun doubleTapZoomsInThenResetsWithoutLeavingTheFocus() {
        val start = InkCamera()
        val zoomed = doubleTapZoom(start, 300f, 500f, viewW, viewH, width, height)
        assertEquals(2.5f, zoomed.zoom, 0.001f)
        val before = screenToNormalized(300f, 500f, start, viewW, width, height)
        val after = screenToNormalized(300f, 500f, zoomed, viewW, width, height)
        assertEquals(before.first, after.first, 0.003)
        assertEquals(before.second, after.second, 0.003)
        val reset = doubleTapZoom(zoomed, 300f, 500f, viewW, viewH, width, height)
        assertEquals(1f, reset.zoom, 0.001f)
        assertEquals(0f, reset.pageX, 0.05f)
        assertEquals(0f, reset.pageY, 0.05f)
    }

    @Test
    fun rotationReclampsWithoutSnappingThePagePointUnderAFixedFocus() {
        val camera = zoomAtFocus(InkCamera(), 400f, 500f, 3f, viewW, viewH, width, height)
        val focus = screenToNormalized(400f, 500f, camera, viewW, width, height)
        val rotated = clampInkCamera(camera, 1273f, 900f, width, height)
        assertEquals(3f, rotated.zoom, 0.001f)
        assertTrue(rotated.pageX >= 0f && rotated.pageY >= 0f)
        val (sx, sy) = normalizedToScreen(focus.first, focus.second, rotated, 1273f, width, height)
        assertTrue(sx.isFinite() && sy.isFinite())
        assertTrue(abs(rotated.pageX - camera.pageX) < width.toFloat())
    }

    @Test
    fun resettingThePinchBaselineLeavesTheCameraUnchanged() {
        val camera = zoomAtFocus(InkCamera(), 450f, 600f, 2f, viewW, viewH, width, height)
        val same = pinchPan(camera, 120f, 140f, 90f, 120f, 140f, 90f, viewW, viewH, width, height)
        assertEquals(camera.zoom, same.zoom, 0.001f)
        assertEquals(camera.pageX, same.pageX, 0.05f)
        assertEquals(camera.pageY, same.pageY, 0.05f)
    }
}
