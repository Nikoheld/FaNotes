package ch.fasrv.fanotes.companion

import android.app.Application
import android.graphics.Bitmap
import android.graphics.Color
import androidx.test.ext.junit.runners.AndroidJUnit4
import ch.fasrv.fanotes.ink.InkDocument
import ch.fasrv.fanotes.ink.InkStroke
import ch.fasrv.fanotes.ink.StrokePoint
import ch.fasrv.fanotes.ink.desktopPdfInkPages
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Desktop ink over a PDF page lands on the spot it was written on (coordinates measured in the desktop UI). */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [34], application = Application::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class PdfInkOverlayTest {
    private val ratios = listOf(842.0 / 595.0, 842.0 / 595.0, 792.0 / 612.0)

    private fun dot(x: Double, y: Double) = InkStroke(listOf(StrokePoint(x, y, 0.0, 0.5, 0.0, 0.0, "pen")), 6.0, false, "#000000")

    private fun dark(bitmap: Bitmap, x: Int, y: Int, radius: Int = 6): Boolean =
        (-radius..radius).any { dx -> (-radius..radius).any { dy ->
            val px = (x + dx).coerceIn(0, bitmap.width - 1); val py = (y + dy).coerceIn(0, bitmap.height - 1)
            Color.red(bitmap.getPixel(px, py)) < 100
        } }

    @Test
    fun theCentreOfPageOneIsDrawnAtTheCentreOfThePage() {
        // Drawn at 1400 px window width: the sheet was 1114 × 3468, the stroke at the middle of page 1.
        val document = InkDocument("PDF", "blank", 1114.0, 3468.0, listOf(dot(0.499995, 0.172488), dot(0.168756, 0.021917)), "", "")
        val page = desktopPdfInkPages(1114.0, 3468.0, ratios)[0]
        val bitmap = Bitmap.createBitmap(600, (600 * ratios[0]).toInt(), Bitmap.Config.ARGB_8888).apply { eraseColor(Color.WHITE) }
        drawInkOnPdfPage(bitmap, document, page)
        assertTrue("centre stroke", dark(bitmap, 300, bitmap.height / 2))
        assertTrue("top-left stroke", dark(bitmap, 30, (bitmap.height * 0.05).toInt()))
        // The old mapping drew the corner stroke a sixth of the page to the right.
        assertTrue("nothing where the old mapping put it", !dark(bitmap, (0.168756 * 1114 / 900 * 600).toInt(), (bitmap.height * 0.05).toInt(), 3))
    }
}
