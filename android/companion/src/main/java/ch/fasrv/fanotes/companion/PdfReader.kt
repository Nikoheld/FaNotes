package ch.fasrv.fanotes.companion

import android.graphics.Bitmap
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ChevronLeft
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.PictureAsPdf
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/** Rectangles of [words] on [page], in page points. Needs the text API of Android 15 / extension 13. */
@androidx.annotation.RequiresExtension(extension = android.os.Build.VERSION_CODES.R, version = 13)
private fun pdfMatchRects(page: PdfRenderer.Page, words: List<String>): List<android.graphics.RectF> =
    words.flatMap { word -> runCatching { page.searchText(word).flatMap { it.bounds } }.getOrDefault(emptyList()) }

/**
 * Render one original PDF page at a time, bounding bitmap memory on a phone. A search hit opens
 * at [startPage] (1-based) and marks [query] where Android can locate the words on the page.
 */
@Composable
fun PdfReader(file: File, startPage: Int = 0, query: String = "") {
    var page by rememberSaveable(file.path, startPage) { mutableStateOf((startPage - 1).coerceAtLeast(0)) }
    var marked by remember(file.path) { mutableStateOf(-1) }
    val mark = MaterialTheme.colorScheme.primary.copy(alpha = 0.32f).let { android.graphics.Color.argb((it.alpha * 255).toInt(), (it.red * 255).toInt(), (it.green * 255).toInt(), (it.blue * 255).toInt()) }
    var count by remember(file.path) { mutableStateOf(0) }
    var bitmap by remember(file.path) { mutableStateOf<Bitmap?>(null) }
    var failed by remember(file.path) { mutableStateOf(false) }
    LaunchedEffect(file.path, page) {
        failed = false
        try {
            val rendered = withContext(Dispatchers.IO) {
                ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY).use { descriptor ->
                    PdfRenderer(descriptor).use { renderer ->
                        val total = renderer.pageCount
                        renderer.openPage(page.coerceIn(0, (total - 1).coerceAtLeast(0))).use { pdfPage ->
                            val width = 1000
                            val height = (width.toDouble() * pdfPage.height / pdfPage.width).toInt().coerceIn(1, 6000)
                            val image = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
                            image.eraseColor(android.graphics.Color.WHITE)
                            pdfPage.render(image, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                            val words = query.split(Regex("\\s+")).filter { it.length >= 2 }
                            var found = -1
                            if (words.isNotEmpty() && pdfTextLayerAvailable()) {
                                val rects = pdfMatchRects(pdfPage, words)
                                found = rects.size
                                val scale = width.toFloat() / pdfPage.width
                                val canvas = android.graphics.Canvas(image)
                                val paint = android.graphics.Paint().apply { color = mark }
                                rects.forEach { r -> canvas.drawRect(r.left * scale, r.top * scale, r.right * scale, r.bottom * scale, paint) }
                            }
                            marked = if (words.isEmpty()) -1 else found
                            image to total
                        }
                    }
                }
            }
            bitmap = rendered.first; count = rendered.second
        } catch (error: Exception) { if (error is kotlinx.coroutines.CancellationException) throw error; failed = true }
    }
    if (failed) EmptyState(Icons.Outlined.PictureAsPdf, t(R.string.pdf_preview_unavailable), t(R.string.this_document_may_be_encrypted_or_unreadable_its))
    else {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
            ActionIcon(Icons.Outlined.ChevronLeft, t(R.string.previous_pdf_page), page > 0) { page-- }
            Text(if (count == 0) t(R.string.loading_pdf) else t(R.string.page_of, page + 1, count), style = MaterialTheme.typography.labelMedium)
            ActionIcon(Icons.Outlined.ChevronRight, t(R.string.next_pdf_page), page < count - 1) { page++ }
        }
        if (query.isNotBlank() && marked == 0 || (query.isNotBlank() && marked == -1 && page == (startPage - 1).coerceAtLeast(0))) {
            Text(t(R.string.doc_highlight_unavailable), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 4.dp))
        }
        bitmap?.let { image -> Image(image.asImageBitmap(), t(R.string.pdf_page, page + 1), Modifier.fillMaxWidth().aspectRatio(image.width.toFloat() / image.height).background(Color.White)) }
    }
}
