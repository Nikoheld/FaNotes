package ch.fasrv.fanotes.companion

import android.app.Application
import android.os.Looper
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import ch.fasrv.fanotes.ink.InkDocument
import ch.fasrv.fanotes.ink.InkStroke
import ch.fasrv.fanotes.ink.StrokePoint
import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.jsonString
import ch.fasrv.fanotes.vault.NoteKind
import ch.fasrv.fanotes.vault.VaultNode
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/** Previews of big handwriting notes: gate, reduced document, bounded cache, and a list that never parses them. */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [34], application = Application::class, qualifiers = "w411dp-h891dp-xxhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class NotePreviewMemoryTest {
    @get:Rule val rule = createComposeRule()

    private fun bigStrokes(strokes: Int, points: Int) = List(strokes) { s ->
        InkStroke(List(points) { i -> StrokePoint(i / points.toDouble(), s / strokes.toDouble(), i * 8.0, 0.5, 0.0, 0.0, "pen") }, 2.0, true, "#112233", figurePaths = listOf("M0 0"))
    }

    @Test fun thePreviewGateIsTwoMegabytesOrAnEighthOfTheLimit() {
        assertEquals(2L * 1024 * 1024, previewParseLimit(100L * 1024 * 1024))
        assertEquals(512L * 1024, previewParseLimit(4L * 1024 * 1024))
        assertEquals(128L * 1024, previewParseLimit(1024L * 1024))
    }

    @Test fun theReducedDocumentIsBoundedAndKeepsWhatTheThumbnailDraws() {
        val doc = InkDocument("T", "dots", 1000.0, 1400.0, bigStrokes(900, 5000), "a", "b",
            extras = JsonValue.Obj().also { it.put("searchTranscript", jsonString("x".repeat(10_000))) })
        val reduced = reduceForThumbnail(doc)
        assertEquals(400, reduced.strokes.size)
        assertTrue(reduced.strokes.sumOf { it.points.size } <= 12_500)
        assertTrue(reduced.strokes.all { it.points.size <= 200 && it.figurePaths.isEmpty() })
        assertTrue(reduced.extras.fields.isEmpty())
        // First and last points of a stroke survive.
        assertEquals(doc.strokes[0].points.first(), reduced.strokes[0].points.first())
        assertEquals(doc.strokes[0].points.last(), reduced.strokes[0].points.last())
        assertEquals(1000.0, reduced.sourceWidth, 0.0)
        val small = NotePreview("x", reduced)
        assertTrue("estimate ${small.estimatedBytes()}", small.estimatedBytes() < PREVIEW_CACHE_BYTES)
    }

    /** A famd sidecar over the 2 MB gate whose JSON would parse fine: only a size check keeps it unparsed. */
    private fun writeBig(dir: File, name: String) {
        val pad = "p".repeat(2_300_000)
        val json = """{"schema":"fanotes-famd-v1","updatedAt":"2026-01-01T00:00:00.000Z","ink":null,"pad":"$pad","worksheets":[]}"""
        File(dir, "$name.md").writeText("# $name\n\nSynthetic text $name.\n")
        File(dir, "$name.famd").writeText("# $name\n\n<!-- fanotes-famd:v1 chars=${json.length} -->\n$json\n")
    }

    @Test fun theListShowsBigHandwritingNotesWithoutParsingThem() {
        val fixture = ReaderFixture()
        repeat(5) { writeBig(fixture.vault, "Big$it") }
        val model = fixture.model()
        val nodes = (0 until 5).map { VaultNode("Big$it", "Big$it.md", NoteKind.MARKDOWN, File(fixture.vault, "Big$it.md").lastModified()) }
        // The sidecar is far above the gate, and a parse of it would succeed: largeInk proves it was skipped.
        val previews = nodes.map { runBlocking { model.loadPreview(it) } }
        assertTrue(previews.all { it.largeInk && it.ink.strokes.isEmpty() })
        assertTrue(previews[0].text.contains("Synthetic text"))
        assertTrue(model.graph.store.inkFileBytes("Big0.md") > 2L * 1024 * 1024)
        rule.setContent {
            CompanionTheme(themeId = "system", systemDark = false) {
                Surface { Column { nodes.forEach { NoteRow(model, it) {} } } }
            }
        }
        val start = System.currentTimeMillis()
        while (System.currentTimeMillis() - start < 10_000 && rule.onAllNodesWithText("Synthetic text", substring = true).fetchSemanticsNodes().size < 5) {
            rule.waitForIdle(); shadowOf(Looper.getMainLooper()).idle(); Thread.sleep(10)
        }
        assertEquals(5, rule.onAllNodesWithText("Synthetic text", substring = true).fetchSemanticsNodes().size)
        assertFalse(previews.any { !it.largeInk })
    }

    @Test fun openingANoteReleasesTheListCaches() {
        val fixture = ReaderFixture()
        fixture.write("Klein.md", "# Klein\n\nText.\n")
        val model = fixture.model()
        val node = VaultNode("Klein", "Klein.md", NoteKind.MARKDOWN, File(fixture.vault, "Klein.md").lastModified())
        runBlocking { model.loadPreview(node) }
        CompanionImageCache.putInk("k", 1, 1, android.graphics.Bitmap.createBitmap(1, 1, android.graphics.Bitmap.Config.ARGB_8888))
        model.releaseListMemory()
        assertEquals(null, CompanionImageCache.ink("k", 1, 1))
        val editor = fixture.open(model, "Klein.md")
        assertTrue(editor.note != null)
    }
}
