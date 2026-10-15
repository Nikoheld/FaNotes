package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class EditorMetricsTest {
    @Test
    fun missingSettingsUseTheDesktopDefaultsAndExtremesClamp() {
        val defaults = editorMetrics(emptyMap())
        assertEquals(16, defaults.fontSizePx)
        assertEquals(1.72, defaults.lineHeight)
        assertEquals(820, defaults.contentWidthPx)
        assertEquals(3.25, defaults.zoomMax)
        assertEquals(750L, defaults.autosaveMs)
        assertEquals(5, defaults.zoomSpeed)
        val clamped = editorMetrics(
            mapOf(
                "editor-font" to "8",
                "line-height" to "3",
                "content-width" to "2000",
                "zoom-max" to "900",
                "autosave" to "10",
            ),
        )
        assertEquals(12, clamped.fontSizePx)
        assertEquals(2.2, clamped.lineHeight)
        assertEquals(1200, clamped.contentWidthPx)
        assertEquals(6.0, clamped.zoomMax)
        assertEquals(250L, clamped.autosaveMs)
        assertEquals(18, editorMetrics(mapOf("editor-font" to "18")).fontSizePx)
        val pen = penSettings(emptyMap())
        assertEquals(3.5, pen.width)
        assertEquals(true, pen.pressure)
        assertEquals("dots", pen.paper)
        assertEquals(50, pen.shapeSnap)
        assertEquals(50, pen.scribble)
        assertEquals(0.68, pen.smoothing)
        assertEquals("#202333", pen.color)
        val custom = penSettings(mapOf("pen-width" to "40", "pressure" to "off", "paper" to "grid", "shape-snap" to "80", "scribble" to "0", "pen-color" to "#2457D6"))
        assertEquals(18.0, custom.width)
        assertEquals(false, custom.pressure)
        assertEquals("grid", custom.paper)
        assertEquals(80, custom.shapeSnap)
        assertEquals(0, custom.scribble)
        assertEquals(1.0, penSettings(mapOf("smoothing" to "4")).smoothing)
        assertEquals("#2457d6", custom.color)
    }

    @Test
    fun zoomSpeedMatchesTheDesktopWheelAndButtonSteps() {
        assertEquals(5, clampViewZoomSpeed(null))
        assertEquals(5, clampViewZoomSpeed(""))
        assertEquals(5, clampViewZoomSpeed("0"))
        assertEquals(1, clampViewZoomSpeed("-4"))
        assertEquals(10, clampViewZoomSpeed("12"))
        assertEquals(6, clampViewZoomSpeed("5.6"))
        assertEquals(0.28, zoomSensitivityFromSpeed(1))
        assertEquals(2.0, zoomSensitivityFromSpeed(10))
        assertEquals(0.125, zoomStepFromSpeed(5))
        assertEquals(15, VIEW_ROTATE_STEP)
        assertEquals(15.0, rotateViewBy(0.0, 1))
        assertEquals(false, sheetViewAdjusted(1.0, 0.0, 0.0, 0.0))
        assertEquals(true, sheetViewAdjusted(1.125, 0.0, 0.0, 0.0))
        assertEquals(true, sheetViewAdjusted(1.0, 15.0, 0.0, 0.0))
        assertEquals(true, sheetViewAdjusted(1.0, 0.0, 12.0, 0.0))
        assertEquals(false, sheetViewAdjusted(1.0, 360.0, 0.0, 0.0))
        assertEquals(-15.0, rotateViewBy(0.0, -1))
        assertEquals(-175.0, rotateViewBy(170.0, 1))
        assertEquals(180.0, normalizeRotation(-180.0))
        assertEquals(90.0, rotateViewBy(0.0, 1, 90))
        assertEquals(-90.0, rotateViewBy(180.0, 1, 90))
        assertEquals("zoom-in", sheetViewKey("+", ctrl = true, meta = false, alt = false, shift = false, textFocused = true))
        assertEquals("zoom-in", sheetViewKey("=", ctrl = true, meta = false, alt = false, shift = true, textFocused = false))
        assertEquals("zoom-out", sheetViewKey("-", ctrl = false, meta = true, alt = false, shift = false, textFocused = false))
        assertEquals("reset", sheetViewKey("0", ctrl = true, meta = false, alt = false, shift = false, textFocused = true))
        assertEquals(null, sheetViewKey("0", ctrl = true, meta = false, alt = false, shift = true, textFocused = false))
        assertEquals("rotate-ccw", sheetViewKey("[", ctrl = false, meta = false, alt = false, shift = false, textFocused = false))
        assertEquals("rotate-cw", sheetViewKey("]", ctrl = false, meta = false, alt = false, shift = false, textFocused = false))
        assertEquals(null, sheetViewKey("[", ctrl = false, meta = false, alt = false, shift = false, textFocused = true))
        assertEquals(null, sheetViewKey("[", ctrl = true, meta = false, alt = false, shift = false, textFocused = false))
        assertEquals(null, sheetViewKey("+", ctrl = true, meta = false, alt = true, shift = false, textFocused = false))
        assertEquals(2.0, pinchZoom(1.0, 2.0, 5))
        val slow = pinchZoom(1.0, 2.0, 1)
        val fast = pinchZoom(1.0, 2.0, 10)
        assertTrue(slow < 2.0)
        assertTrue(fast > 2.0)
        assertEquals(1, editorMetrics(mapOf("zoom-speed" to "1")).zoomSpeed)
    }

    @Test
    fun readableLinesUseThePageWidthWhenTheLimitIsOff() {
        assertEquals(true, editorMetrics(emptyMap()).readableLineLength)
        assertEquals(false, editorMetrics(mapOf("readable-lines" to "off")).readableLineLength)
        assertEquals(820f, effectiveContentWidth(820, 1200f, readable = true))
        assertEquals(1056f, effectiveContentWidth(820, 1200f, readable = false))
        assertEquals(856f, effectiveContentWidth(2000, 1000f, readable = true))
    }

    @Test
    fun editorFontPreviewSizeAndLineNumbersFollowTheDesktop() {
        val defaults = editorMetrics(emptyMap())
        assertEquals("jetbrains", defaults.editorFontId)
        assertEquals(17, defaults.previewFontPx)
        assertEquals(false, defaults.showLineNumbers)
        val chosen = editorMetrics(
            mapOf(
                "editor-face" to "'Fira Code', ui-monospace, monospace",
                "preview-font" to "40",
                "line-numbers" to "on",
            ),
        )
        assertEquals("fira", chosen.editorFontId)
        assertEquals(28, chosen.previewFontPx)
        assertEquals(true, chosen.showLineNumbers)
        assertEquals("plex", editorFontId("IBM Plex Mono"))
        assertEquals("system", editorFontId("ui-monospace, SFMono-Regular, monospace"))
        assertEquals(listOf(0), lineStartOffsets(""))
        assertEquals(listOf(0, 2), lineStartOffsets("a\n"))
        assertEquals(listOf("1", "2"), editorLineNumberLabels("a\nb"))
        assertEquals(18, lineNumberColumnPx("a\nb", 10f, 18))
        assertEquals(186, lineNumberColumnPx((1..100).joinToString("\n") { "x" }, 100f, 18))
    }
}
