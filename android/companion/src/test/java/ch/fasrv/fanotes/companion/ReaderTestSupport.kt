package ch.fasrv.fanotes.companion

import android.app.Application
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import ch.fasrv.fanotes.ink.InkDocument
import ch.fasrv.fanotes.ink.InkStroke
import ch.fasrv.fanotes.ink.PAGE_START_WIDTH
import ch.fasrv.fanotes.ink.StrokePoint
import ch.fasrv.fanotes.ink.layoutPdfStack
import ch.fasrv.fanotes.ink.newInkDocument
import ch.fasrv.fanotes.ink.pdfStackHeight
import ch.fasrv.fanotes.schulnetz.DeskPrefs
import java.io.File
import java.util.concurrent.atomic.AtomicInteger
import org.robolectric.Shadows.shadowOf

/** Synthetic pages for the reader tests: PdfRenderer does not run on the JVM, so the source draws a page number and text bars. */
class FakePdfSource(pages: Int = 6, private val ratio: Float = 1.414f, override val id: String = "fake-pdf") : PdfPageSource {
    override val aspects: List<Float> = List(pages) { ratio }
    val renders = AtomicInteger()
    @Volatile var lastWidth = 0
    val widths: MutableList<Int> = java.util.Collections.synchronizedList(mutableListOf())

    override suspend fun render(index: Int, widthPx: Int, words: List<String>, mark: Int): PdfPageRender {
        renders.incrementAndGet(); lastWidth = widthPx; widths += widthPx
        val height = (widthPx * aspects[index]).toInt().coerceAtLeast(1)
        val bitmap = Bitmap.createBitmap(widthPx, height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        canvas.drawColor(Color.WHITE)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        paint.color = Color.rgb(0x2a, 0x2f, 0x45); paint.textSize = widthPx / 9f
        canvas.drawText("Seite ${index + 1}", widthPx * 0.1f, height * 0.12f, paint)
        paint.color = Color.rgb(0xc9, 0xcd, 0xd8)
        var y = height * 0.2f
        while (y < height * 0.9f) { canvas.drawRect(widthPx * 0.1f, y, widthPx * 0.9f, y + height * 0.012f, paint); y += height * 0.035f }
        return PdfPageRender(bitmap, if (words.isEmpty()) -1 else 0)
    }
}

/** A synthetic ink document laid over the fake pages: a few red strokes, in the app's PDF ink space. */
fun fakePdfInk(pages: Int = 6, ratio: Float = 1.414f): InkDocument {
    val stack = pdfStackHeight(layoutPdfStack(PAGE_START_WIDTH, List(pages) { ratio.toDouble() }))
    val base = newInkDocument("Skript", "blank", "2026-11-01T08:00:00.000Z")
    fun stroke(vararg xy: Pair<Double, Double>) = InkStroke(xy.map { StrokePoint(it.first, it.second, 0.0, 0.8, 0.0, 0.0, "pen") }, 4.0, false, "#c4554d")
    return base.copy(
        sourceWidth = PAGE_START_WIDTH, sourceHeight = stack,
        strokes = listOf(
            stroke(0.12 to 0.012, 0.35 to 0.020, 0.55 to 0.012),
            stroke(0.10 to 0.045, 0.60 to 0.045),
            stroke(0.15 to 0.30, 0.30 to 0.34, 0.45 to 0.31, 0.60 to 0.35),
        ),
    )
}

/** A vault with a note and a PDF note on disk, a model over it, and the loaded editor. */
class ReaderFixture(val app: Application = ApplicationProvider.getApplicationContext()) {
    val vault = File(app.filesDir, "vault").also { it.mkdirs() }
    private fun idle() = shadowOf(Looper.getMainLooper()).idle()

    fun write(path: String, text: String) { File(vault, path).also { it.parentFile?.mkdirs() }.writeText(text) }
    fun writeBytes(path: String, bytes: ByteArray) { File(vault, path).also { it.parentFile?.mkdirs() }.writeBytes(bytes) }

    fun model(): CompanionModel {
        val graph = CompanionGraph(app)
        graph.commuteRequestsAllowed = false
        graph.saveDeskPrefs(DeskPrefs(theme = "system"))
        graph.markOnboardingSeen(); graph.setLocalAccess(true)
        val model = CompanionModel(graph)
        model.notesAccount = true
        return model
    }

    /** Opens [path] in the editor and waits until it has loaded. */
    fun open(model: CompanionModel, path: String): NoteEditorController {
        model.openNote(path)
        val editor = model.editor!!
        val start = System.currentTimeMillis()
        while (editor.loading && System.currentTimeMillis() - start < 20_000) { idle(); Thread.sleep(10) }
        idle()
        return editor
    }
}
