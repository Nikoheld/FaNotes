package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class CustomCssTest {
    @Test
    fun sanitizeDropsStylesheetsThatCanLoadOrBreakOut() {
        assertEquals("", sanitizeCustomCss(null))
        assertEquals("", sanitizeCustomCss("  "))
        assertEquals("", sanitizeCustomCss("body{background:url(https://evil.example)}"))
        assertEquals("", sanitizeCustomCss("@import 'x.css'; :root { --radius: 4px; }"))
        assertEquals("", sanitizeCustomCss("a { behavior: url(x); }"))
        assertEquals("", sanitizeCustomCss("a { width: expression(alert(1)); }"))
        assertEquals("", sanitizeCustomCss("a { background: javascript:alert(1); }"))
        assertEquals("", sanitizeCustomCss("</style><script>"))
        assertEquals("", sanitizeCustomCss("\\url(https://evil.example)"))
        val kept = "/* @import */ :root { --radius: 14px; --accent: #c4554d; }"
        assertEquals(kept, sanitizeCustomCss(kept))
        assertEquals(CUSTOM_CSS_MAX, sanitizeCustomCss("a".repeat(CUSTOM_CSS_MAX + 5)).length)
    }

    @Test
    fun themeTokensOverrideTheShellAndEditorMeasures() {
        val css = """
            :root {
              --radius: 14px;
              --accent: #C4554D;
              --accent-secondary: #0f7b6c;
              --bg: #fff;
              --bg-elevated: #f7f6f3;
              --text: #252630;
              --sidebar-width: 240px;
              --content-width: 900px;
              --editor-size: 18px;
              --preview-size: 20px;
              --line-height: 1.5;
              --row-height: 24px;
              --text-primary: var(--text);
            }
            :root { --accent: #9065b0; }
        """.trimIndent()
        val chrome = parseCustomChrome(css)
        assertEquals("#9065b0", chrome.accent)
        assertEquals("#0f7b6c", chrome.accentSecondary)
        assertEquals("#ffffff", chrome.background)
        assertEquals("#f7f6f3", chrome.surface)
        assertEquals("#252630", chrome.text)
        assertEquals(14, chrome.radiusDp)
        assertEquals(240, chrome.sidebarDp)
        assertEquals(900, chrome.contentWidthPx)
        assertEquals(18, chrome.editorFontPx)
        assertEquals(20, chrome.previewFontPx)
        assertEquals(1.5, chrome.lineHeight)
        assertEquals(24, chrome.rowHeightDp)
        val desk = deskWithCustomCss(mapOf("accent" to "#2a6f97", "editor-font" to "16"), css)
        assertEquals("#9065b0", desk["accent"])
        assertEquals("18", desk["editor-font"])
        assertEquals("1.5", desk["line-height"])
        assertEquals("#2a6f97", deskWithCustomCss(mapOf("accent" to "#2a6f97"), "body{background:url(https://evil)}")["accent"])
        assertNull(parseCustomChrome("").accent)
    }
}
