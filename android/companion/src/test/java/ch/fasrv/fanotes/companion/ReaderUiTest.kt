package ch.fasrv.fanotes.companion

import android.app.Application
import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import ch.fasrv.fanotes.vault.NoteKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/** The read view on the JVM: zoom controls, lazy page rendering, and the read-only PDF note. English strings, synthetic data. */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [34], application = Application::class, qualifiers = "w411dp-h891dp-xxhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ReaderUiTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    @Before fun language() {
        AppLanguage.install(ApplicationProvider.getApplicationContext<Application>())
        AppLanguage.choose("en")
    }

    private fun idle() = shadowOf(Looper.getMainLooper()).idle()
    private fun settle(limitMs: Long = 15_000, done: () -> Boolean) {
        val start = System.currentTimeMillis()
        while (!done() && System.currentTimeMillis() - start < limitMs) { rule.waitForIdle(); idle(); Thread.sleep(10) }
        rule.waitForIdle()
    }

    @Test fun pdfPagesRenderLazilyAndTheZoomButtonsChangeTheLayout() {
        val source = FakePdfSource(pages = 40)
        rule.setContent { CompanionTheme(themeId = "system", systemDark = false) { Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) { PdfReaderContent(source) } } }
        settle { source.renders.get() > 0 }
        assertTrue("the visible pages render", source.renders.get() in 1..8)
        val before = source.lastWidth
        rule.onNodeWithText("100 %").assertExists()
        rule.onNodeWithContentDescription("Zoom in").performClick()
        rule.onNodeWithText("125 %").assertExists()
        // The new resolution is rendered after the zoom settles (250 ms of the test clock).
        rule.mainClock.advanceTimeBy(400)
        settle { source.lastWidth > before }
        assertTrue("re-rendered sharper at 125 percent: before=$before widths=${source.widths}", source.lastWidth > before)
        rule.onNodeWithText("125 %").performClick()
        rule.onNodeWithText("100 %").assertExists()
        rule.onNodeWithContentDescription("Zoom out").assertExists()
    }

    @Test fun aPdfNoteOpensForReadingOnlyWithoutTheTextAndInkTabs() {
        val fixture = ReaderFixture()
        fixture.writeBytes("Physik Skript.pdf", "%PDF-1.4\n".toByteArray())
        val model = fixture.model()
        val editor = fixture.open(model, "Physik Skript.pdf")
        assertEquals(NoteKind.PDF, editor.note?.kind)
        assertTrue(editor.readOnly)
        val source = FakePdfSource(pages = 3)
        rule.setContent {
            CompanionTheme(themeId = "system", systemDark = false) {
                CompositionLocalProvider(LocalPdfOpener provides { _, _ -> PdfOpenResult.Ready(source) }) {
                    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) { NoteEditorScreen(model) }
                }
            }
        }
        settle { source.renders.get() > 0 }
        rule.onNodeWithText("Text").assertDoesNotExist()
        rule.onNodeWithText("Ink").assertDoesNotExist()
        rule.onNodeWithText("Read").assertDoesNotExist()
        // Editing is refused at the controller too: nothing is written for a PDF.
        editor.editText("changed")
        assertFalse(editor.dirty)
        assertFalse(File(fixture.vault, "Physik Skript.famd").exists())
    }

    @Test fun aTextNoteShowsTabsAndRemembersItsTextZoom() {
        val fixture = ReaderFixture()
        fixture.write("Notiz.md", "# Titel\n\nEin Absatz Text.\n")
        val model = fixture.model()
        fixture.open(model, "Notiz.md")
        rule.setContent { CompanionTheme(themeId = "system", systemDark = false) { Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) { NoteEditorScreen(model) } } }
        settle { runCatching { rule.onNodeWithText("Ein Absatz Text.").assertExists() }.isSuccess }
        rule.onNodeWithText("Text").assertExists()
        rule.onNodeWithText("100 %").assertExists()
        rule.onNodeWithContentDescription("Zoom in").performClick()
        rule.onNodeWithText("125 %").assertExists()
        val app = ApplicationProvider.getApplicationContext<Application>()
        assertEquals(1.25f, readerTextZoom(app), 0f)
        rule.onNodeWithText("125 %").performClick()
        assertEquals(1f, readerTextZoom(app), 0f)
    }

    @Test fun anOversizedHandwritingNoteShowsTheBannerAndStaysReadOnly() {
        val fixture = ReaderFixture()
        fixture.write("Gross.md", "# Gross\n\nText bleibt sichtbar.\n")
        // A sidecar whose JSON is nested far past the parser's limit counts as too large (written by hand: the writer refuses it).
        val deep = "[".repeat(200) + "]".repeat(200)
        val json = """{"schema":"fanotes-famd-v1","updatedAt":"2026-01-01T00:00:00.000Z","ink":{"deep":$deep},"worksheets":[]}"""
        fixture.write("Gross.famd", "# Gross\n\n<!-- fanotes-famd:v1 chars=${json.length} -->\n$json\n")
        val sidecar = File(fixture.vault, "Gross.famd").readText()
        val model = fixture.model()
        val editor = fixture.open(model, "Gross.md")
        assertTrue(editor.note?.inkTooLarge == true)
        assertTrue(editor.readOnly)
        rule.setContent { CompanionTheme(themeId = "system", systemDark = false) { Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) { NoteEditorScreen(model) } } }
        settle { runCatching { rule.onNodeWithText("Handwriting too large for this phone").assertExists() }.isSuccess }
        rule.onNodeWithText("Handwriting too large for this phone").assertExists()
        rule.onNodeWithText("Text bleibt sichtbar.").assertExists()
        rule.onNodeWithText("Text").assertDoesNotExist()
        editor.editText("changed")
        assertFalse(editor.dirty)
        assertEquals(sidecar, File(fixture.vault, "Gross.famd").readText())
    }

    /** A source that fails the way a low-memory phone does: out of memory at full width, or always. */
    private class FailingSource(private val mode: String) : PdfPageSource {
        override val id = "failing-$mode"
        override val aspects = listOf(1.4f)
        val widths = java.util.Collections.synchronizedList(mutableListOf<Int>())
        override suspend fun render(index: Int, widthPx: Int, words: List<String>, mark: Int): PdfPageRender {
            widths += widthPx
            when (mode) {
                "memory-once" -> if (widths.size == 1) throw OutOfMemoryError("test")
                "broken" -> throw IllegalStateException("test")
            }
            return PdfPageRender(android.graphics.Bitmap.createBitmap(widthPx, (widthPx * 1.4f).toInt(), android.graphics.Bitmap.Config.ARGB_8888), -1)
        }
    }

    @Test fun outOfMemoryRetriesOnceAtHalfTheWidth() {
        PdfPageCache.clear()
        val source = FailingSource("memory-once")
        rule.setContent { CompanionTheme(themeId = "system", systemDark = false) { Surface(Modifier.fillMaxSize()) { PdfReaderContent(source) } } }
        settle { source.widths.size >= 2 }
        assertEquals(2, source.widths.size)
        assertEquals(source.widths[0] / 2, source.widths[1])
        rule.onNodeWithText("Page 1 could not be shown").assertDoesNotExist()
    }

    @Test fun aPageThatCannotBeRenderedShowsAPlaceholderNotACrash() {
        PdfPageCache.clear()
        val source = FailingSource("broken")
        rule.setContent { CompanionTheme(themeId = "system", systemDark = false) { Surface(Modifier.fillMaxSize()) { PdfReaderContent(source) } } }
        settle { runCatching { rule.onNodeWithText("Page 1 could not be shown").assertExists() }.isSuccess }
        rule.onNodeWithText("Page 1 could not be shown").assertExists()
    }
}
