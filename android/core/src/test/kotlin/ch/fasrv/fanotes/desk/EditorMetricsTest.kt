package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals

class EditorMetricsTest {
    @Test
    fun missingSettingsUseTheDesktopDefaultsAndExtremesClamp() {
        val defaults = editorMetrics(emptyMap())
        assertEquals(16, defaults.fontSizePx)
        assertEquals(1.72, defaults.lineHeight)
        assertEquals(820, defaults.contentWidthPx)
        assertEquals(3.25, defaults.zoomMax)
        assertEquals(750L, defaults.autosaveMs)
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
        assertEquals("#202333", pen.color)
        val custom = penSettings(mapOf("pen-width" to "40", "pressure" to "off", "paper" to "grid", "shape-snap" to "80", "scribble" to "0", "pen-color" to "#2457D6"))
        assertEquals(18.0, custom.width)
        assertEquals(false, custom.pressure)
        assertEquals("grid", custom.paper)
        assertEquals(80, custom.shapeSnap)
        assertEquals(0, custom.scribble)
        assertEquals("#2457d6", custom.color)
    }
}
