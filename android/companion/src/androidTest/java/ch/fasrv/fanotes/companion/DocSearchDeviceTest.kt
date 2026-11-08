package ch.fasrv.fanotes.companion

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.pdf.PdfDocument
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Device checks for the parts the JVM cannot run: PdfRenderer, the PDF text layer, Tesseract
 * and Android SQLite FTS4. Synthetic documents only; nothing is written into the user's vault.
 */
@RunWith(AndroidJUnit4::class)
class DocSearchDeviceTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    private fun syntheticPdf(file: File) {
        val pdf = PdfDocument()
        val paint = Paint().apply { color = Color.BLACK; textSize = 14f; isAntiAlias = true }
        // Page 1: a real text layer.
        pdf.startPage(PdfDocument.PageInfo.Builder(595, 842, 1).create()).also { page ->
            page.canvas.drawText("Die Größe der Kräfte hängt von der Masse ab.", 40f, 80f, paint)
            pdf.finishPage(page)
        }
        // Page 2: text drawn into a bitmap only, like a scan; it needs OCR.
        pdf.startPage(PdfDocument.PageInfo.Builder(595, 842, 2).create()).also { page ->
            val scan = Bitmap.createBitmap(1190, 400, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.WHITE) }
            Canvas(scan).drawText("Übungsaufgabe Straße Fußgänger", 40f, 120f, Paint().apply { color = Color.BLACK; textSize = 56f; isAntiAlias = true })
            page.canvas.drawBitmap(scan, null, android.graphics.RectF(0f, 0f, 595f, 200f), null)
            scan.recycle()
            pdf.finishPage(page)
        }
        file.outputStream().use { pdf.writeTo(it) }
        pdf.close()
    }

    @Test fun ocrEngineStartsOffline() {
        val engine = TesseractOcr.open(context)
        assertTrue("bundled German model loads", engine != null)
        val bitmap = Bitmap.createBitmap(900, 160, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.WHITE) }
        Canvas(bitmap).drawText("Prüfung über Zellatmung", 20f, 100f, Paint().apply { color = Color.BLACK; textSize = 64f; isAntiAlias = true })
        val result = engine!!.recognize(bitmap)
        engine.close()
        assertTrue(result.text, foldPlain(result.text).contains("zellatmung"))
    }

    @Test fun androidSqliteFts4BuildsAndFindsGermanText() {
        val file = File(context.cacheDir, "doc-search-test.db").apply { delete() }
        val index = DocIndex(AndroidIndexDb(file))
        index.begin(DocRecord("A.pdf", "Skript", DOC_KIND_PDF, "1"))
        index.addPages("A.pdf", "Skript", listOf(PageEntry(3, "Die Straßenbahn fährt über die Brücke.", PageSource.TextLayer)), 3)
        index.finish("A.pdf", DocStatus.Indexed, DocProblem.None, 0)
        assertEquals(3, index.search(parseDocQuery("STRASSENBAHN brucke")).single().page)
        file.delete()
    }

    @Test fun pdfPagesUseTheTextLayerOrOcr() = runBlocking {
        val dir = File(context.cacheDir, "doc-search-pdf").apply { deleteRecursively(); mkdirs() }
        val pdf = File(dir, "Synthetisch.pdf").also(::syntheticPdf)
        val engine = TesseractOcr.open(context)
        val renderer = android.graphics.pdf.PdfRenderer(android.os.ParcelFileDescriptor.open(pdf, android.os.ParcelFileDescriptor.MODE_READ_ONLY))
        val scanPage = renderer.openPage(1)
        val bitmap = Bitmap.createBitmap(2400, (2400f * scanPage.height / scanPage.width).toInt(), Bitmap.Config.ARGB_8888).apply { eraseColor(Color.WHITE) }
        scanPage.render(bitmap, null, null, android.graphics.pdf.PdfRenderer.Page.RENDER_MODE_FOR_PRINT)
        scanPage.close(); renderer.close()
        val read = engine!!.recognize(bitmap)
        engine.close(); bitmap.recycle()
        assertTrue(read.text, foldPlain(read.text).contains("strasse"))
        if (pdfTextLayerAvailable()) {
            val again = android.graphics.pdf.PdfRenderer(android.os.ParcelFileDescriptor.open(pdf, android.os.ParcelFileDescriptor.MODE_READ_ONLY))
            again.openPage(0).use { page -> assertTrue(foldPlain(page.textContents.joinToString { it.text }).contains("krafte")) }
            again.close()
        }
        dir.deleteRecursively()
    }
}
