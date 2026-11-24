package ch.fasrv.fanotes.companion

import android.app.Application
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onRoot
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.File
import org.junit.Assert.assertNotNull
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Renders the read view to PNG for a design review (German, phone size, synthetic data): a PDF with the desktop's
 * handwriting over it, an image, the audio player, a story, a text note at 1.5x text size, and a PDF note with its
 * read-only tabs. Runs only with KANTI_SHOT_DIR set; CI never sets it. Files are named reader-*.png.
 */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [34], application = Application::class, qualifiers = "w411dp-h891dp-xxhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ReaderShotTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()
    private val out = System.getenv("KANTI_SHOT_DIR").orEmpty()

    @Before fun language() {
        assumeTrue(out.isNotBlank())
        AppLanguage.install(ApplicationProvider.getApplicationContext<Application>())
        AppLanguage.choose("de")
    }

    private fun idle() = shadowOf(Looper.getMainLooper()).idle()
    private fun settle(ms: Long = 3000) {
        val end = System.currentTimeMillis() + ms
        while (System.currentTimeMillis() < end) { rule.waitForIdle(); idle(); Thread.sleep(20) }
    }

    private fun shot(name: String, content: @Composable () -> Unit) {
        rule.setContent {
            CompanionTheme(themeId = "system", systemDark = false) {
                Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) { content() }
            }
        }
        settle()
        save(name)
    }

    private fun save(name: String) {
        val bitmap = rule.onRoot().captureToImage().asAndroidBitmap()
        File(out).mkdirs()
        File(out, "reader-$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Test fun pdfReadViewWithDesktopHandwriting() {
        val source = FakePdfSource(pages = 5)
        shot("pdf") { PdfReaderContent(source, ink = fakePdfInk(5)) }
    }

    @Test fun imageViewer() {
        val app = ApplicationProvider.getApplicationContext<Application>()
        val file = File(app.cacheDir, "foto.png")
        val bitmap = Bitmap.createBitmap(1200, 800, Bitmap.Config.ARGB_8888)
        Canvas(bitmap).apply {
            drawColor(Color.rgb(0xdd, 0xe8, 0xf4))
            val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(0x2a, 0x6f, 0x97) }
            drawCircle(800f, 260f, 120f, paint)
            paint.color = Color.rgb(0x0f, 0x7b, 0x6c)
            drawRect(0f, 520f, 1200f, 800f, paint)
            paint.color = Color.rgb(0x9a, 0xa6, 0xb8)
            drawRect(150f, 330f, 500f, 520f, paint)
        }
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        shot("image") { ImageFileView(file) }
    }

    @Test fun audioPlayer() {
        shot("audio") { AudioPlayerContent("Aufnahme Biologie.m4a", playing = true, positionMs = 83_000, durationMs = 214_000, onToggle = {}, onSeek = {}) }
    }

    @Test fun storyReader() {
        val story = readStoryText { StorySample.files[it] }
        assertNotNull(story)
        shot("story") { StoryContent(story!!, initialZoom = 1f) }
    }

    @Test fun textNoteAtOneAndAHalfTimes() {
        val app = ApplicationProvider.getApplicationContext<Application>()
        saveReaderTextZoom(app, 1.5f)
        val fixture = ReaderFixture(app)
        fixture.write("Biologie Zelle.md", "# Die Zelle\n\nDie **Zelle** ist die kleinste lebende Einheit. Sie besteht aus Zellmembran, Zytoplasma und Zellkern.\n\n## Organellen\n\n- Mitochondrien liefern Energie\n- Ribosomen bauen Proteine\n- Der Zellkern speichert die Erbinformation\n\nDie Zellwand kommt nur bei Pflanzen vor.\n")
        val model = fixture.model()
        fixture.open(model, "Biologie Zelle.md")
        shot("text-zoom") { NoteEditorScreen(model) }
    }

    @Test fun pdfNoteWithReadOnlyTabs() {
        val fixture = ReaderFixture()
        fixture.writeBytes("Physik Skript.pdf", "%PDF-1.4\n".toByteArray())
        val model = fixture.model()
        fixture.open(model, "Physik Skript.pdf")
        val source = FakePdfSource(pages = 5)
        shot("pdf-note") {
            CompositionLocalProvider(LocalPdfOpener provides { _, _ -> PdfOpenResult.Ready(source) }) { NoteEditorScreen(model) }
        }
    }
}

/** A synthetic story project: two chapters, one excluded scene. */
object StorySample {
    private fun scene(id: String, vararg paragraphs: Pair<String, String>) =
        """{"format":"fanotes-story-scene-v1","id":"$id","paragraphs":[${paragraphs.mapIndexed { i, (style, text) -> """{"id":"para${id.takeLast(3)}$i","key":"a$i","v":{},"style":"$style","runs":[{"text":"$text"}]}""" }.joinToString(",")}]}"""

    val files = mapOf(
        "story.json" to """{"format":"fanotes-story-v1","id":"story00001","title":"Der Leuchtturm","subtitle":"Eine Kurzgeschichte","author":"Testautorin","binder":[
            {"id":"chap000001","kind":"chapter","title":"Kapitel 1: Ankunft","children":[
              {"id":"scene00001","kind":"scene","title":"Am Hafen"},
              {"id":"scene00002","kind":"scene","title":"Verworfen","exclude":true}]},
            {"id":"chap000002","kind":"chapter","title":"Kapitel 2: Der Sturm","children":[
              {"id":"scene00003","kind":"scene","title":"Nachts"}]}]}""",
        "scenes/scene00001.json" to scene("scene00001",
            "body" to "Der Nebel lag schwer über dem Wasser, als das Boot am Steg festmachte.",
            "body" to "Mara stieg aus und sah zum Turm hinauf, dessen Licht seit Jahren nicht mehr brannte.",
            "quote" to "Wer das Licht hütet, hütet auch die Rückkehr."),
        "scenes/scene00002.json" to scene("scene00002", "body" to "Das steht nicht im Manuskript."),
        "scenes/scene00003.json" to scene("scene00003",
            "body" to "Gegen Mitternacht drehte der Wind, und die Fenster begannen zu klirren.",
            "body" to "Dann, ganz plötzlich, flammte oben das Licht auf."),
    )
}
