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
    }
}
