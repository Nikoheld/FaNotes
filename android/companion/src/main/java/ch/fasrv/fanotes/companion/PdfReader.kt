package ch.fasrv.fanotes.companion

import android.graphics.Bitmap
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import android.util.LruCache
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.PictureAsPdf
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import ch.fasrv.fanotes.desk.pdfNeedsPassword
import ch.fasrv.fanotes.desk.pdfPasswordSupported
import ch.fasrv.fanotes.ink.InkDocument
import ch.fasrv.fanotes.ink.pdfInkPages
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.File

/** Most pages the reader lists; later pages of a longer document are left out. */
const val PDF_READER_PAGE_CAP = 2000

/** One rendered page. [matches] is how many spots of the search words were marked, or -1 when none could be looked for. */
class PdfPageRender(val bitmap: Bitmap, val matches: Int = -1)

/** Where the reader gets its pages from. The device implementation wraps a [PdfRenderer]; tests inject synthetic bitmaps. */
interface PdfPageSource {
    /** Names the document in the page cache. */
    val id: String
    /** Height over width of every page. */
    val aspects: List<Float>
    /** Renders page [index] at [widthPx] and marks [words] when the text layer is available. May throw; never recycles. */
    suspend fun render(index: Int, widthPx: Int, words: List<String>, mark: Int): PdfPageRender
}

sealed interface PdfOpenResult {
    class Ready(val source: PdfPageSource) : PdfOpenResult
    /** The file needs a password; [rejected] is true when one was given and did not fit. */
    class Locked(val rejected: Boolean) : PdfOpenResult
    class Failed(val outOfMemory: Boolean = false) : PdfOpenResult
}

/** Rectangles of [words] on [page], in page points. Needs the text API of Android 15 / extension 13. */
@androidx.annotation.RequiresExtension(extension = android.os.Build.VERSION_CODES.R, version = 13)
private fun pdfMatchRects(page: PdfRenderer.Page, words: List<String>): List<android.graphics.RectF> =
    words.flatMap { word -> runCatching { page.searchText(word).flatMap { it.bounds } }.getOrDefault(emptyList()) }

/**
 * One [PdfRenderer] for the open file. The renderer allows a single open page at a time, so every access
 * (page sizes at open, every render, the close) goes through [lock].
 */
private class RendererPageSource(
    override val id: String,
    private val descriptor: ParcelFileDescriptor,
    private val renderer: PdfRenderer,
    override val aspects: List<Float>,
) : PdfPageSource, AutoCloseable {
    private val lock = Mutex()
    private var closed = false

    override suspend fun render(index: Int, widthPx: Int, words: List<String>, mark: Int): PdfPageRender = withContext(Dispatchers.IO) {
        lock.withLock {
            if (closed) throw CancellationException("The document was closed")
            renderer.openPage(index).use { page ->
                val width = widthPx.coerceAtLeast(1)
                val height = (width.toLong() * page.height / page.width.coerceAtLeast(1)).toInt().coerceAtLeast(1)
                val image = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
                image.eraseColor(android.graphics.Color.WHITE)
                page.render(image, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                var found = -1
                if (words.isNotEmpty() && pdfTextLayerAvailable()) {
                    val rects = pdfMatchRects(page, words)
                    found = rects.size
                    val scale = width.toFloat() / page.width
                    val canvas = android.graphics.Canvas(image)
                    val paint = android.graphics.Paint().apply { color = mark }
                    rects.forEach { r -> canvas.drawRect(r.left * scale, r.top * scale, r.right * scale, r.bottom * scale, paint) }
                }
                PdfPageRender(image, found)
            }
        }
    }

    /** Closes once the page being rendered is done. Never blocks the caller. */
    override fun close() {
        CoroutineScope(Dispatchers.IO).launch {
            lock.withLock {
                if (closed) return@withLock
                closed = true
                runCatching { renderer.close() }
                runCatching { descriptor.close() }
            }
        }
    }
}

/** How [PdfReader] opens a file. Tests replace it with synthetic pages, since [PdfRenderer] does not run on the JVM. */
val LocalPdfOpener = staticCompositionLocalOf<suspend (File, String) -> PdfOpenResult> { { file, password -> openPdfPageSource(file, password) } }

/** Opens [file] on the IO dispatcher. Every failure except cancellation comes back as a result, never as a crash. */
suspend fun openPdfPageSource(file: File, password: String = ""): PdfOpenResult = withContext(Dispatchers.IO) {
    var descriptor: ParcelFileDescriptor? = null
    var renderer: PdfRenderer? = null
    try {
        descriptor = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
        renderer = if (password.isNotEmpty() && pdfPasswordSupported(android.os.Build.VERSION.SDK_INT)) {
            PdfRenderer(descriptor, android.graphics.pdf.LoadParams.Builder().setPassword(password).build())
        } else {
            PdfRenderer(descriptor)
        }
        val count = renderer.pageCount.coerceAtMost(PDF_READER_PAGE_CAP)
        if (count <= 0) throw IllegalStateException("The document has no pages")
        val aspects = ArrayList<Float>(count)
        for (index in 0 until count) {
            aspects += renderer.openPage(index).use { page -> page.height.toFloat() / page.width.coerceAtLeast(1) }
        }
        val id = "${file.path}:${file.lastModified()}:${file.length()}"
        PdfOpenResult.Ready(RendererPageSource(id, descriptor, renderer, aspects))
    } catch (cancelled: CancellationException) {
        runCatching { renderer?.close() }; runCatching { descriptor?.close() }
        throw cancelled
    } catch (failure: Throwable) {
        runCatching { renderer?.close() }; runCatching { descriptor?.close() }
        when {
            failure is OutOfMemoryError -> PdfOpenResult.Failed(outOfMemory = true)
            pdfNeedsPassword(failure.javaClass.simpleName, failure.message.orEmpty()) -> PdfOpenResult.Locked(rejected = password.isNotEmpty())
            else -> PdfOpenResult.Failed()
        }
    }
}

/** Rendered pages, bounded by their size in bytes. Evicted bitmaps are left to the garbage collector: one may still be on screen. */
object PdfPageCache {
    private val cache = object : LruCache<String, Bitmap>((Runtime.getRuntime().maxMemory() / 8).coerceIn(8L * 1024 * 1024, Int.MAX_VALUE.toLong()).toInt()) {
        override fun sizeOf(key: String, value: Bitmap): Int = value.byteCount.coerceAtLeast(1)
    }
    fun get(key: String): Bitmap? = cache.get(key)
    fun put(key: String, bitmap: Bitmap) { cache.put(key, bitmap) }
    fun clear() = cache.evictAll()
}

/**
 * Reads a PDF as one continuous column of pages that zooms from 1x to 5x. A search hit opens at [startPage] (1-based)
 * and marks [query] where Android can locate the words. [ink] is the desktop handwriting drawn over the pages.
 */
@Composable
fun PdfReader(file: File, startPage: Int = 0, query: String = "", ink: InkDocument? = null, modifier: Modifier = Modifier) {
    // Kept out of saved state on purpose: a password must not reach the instance-state bundle.
    var password by remember(file.path) { mutableStateOf("") }
    val opener = LocalPdfOpener.current
    val opened by produceState<PdfOpenResult?>(null, file.path, file.lastModified(), password) {
        value = null
        var source: AutoCloseable? = null
        try {
            val result = opener(file, password)
            source = (result as? PdfOpenResult.Ready)?.source as? AutoCloseable
            value = result
            awaitCancellation()
        } finally {
            source?.close()
        }
    }
    when (val result = opened) {
        null -> LoadingState(t(R.string.loading_pdf))
        is PdfOpenResult.Ready -> PdfReaderContent(result.source, startPage, query, ink, modifier)
        is PdfOpenResult.Locked -> {
            if (pdfPasswordSupported(android.os.Build.VERSION.SDK_INT)) PdfPasswordPrompt(result.rejected, modifier) { password = it }
            else EmptyState(Icons.Outlined.Lock, t(R.string.pdf_password_title), t(R.string.pdf_password_unsupported))
        }
        is PdfOpenResult.Failed -> {
            if (result.outOfMemory) EmptyState(Icons.Outlined.PictureAsPdf, t(R.string.pdf_preview_unavailable), t(R.string.too_large_for_memory_body))
            else EmptyState(Icons.Outlined.PictureAsPdf, t(R.string.pdf_preview_unavailable), t(R.string.this_document_may_be_encrypted_or_unreadable_its))
        }
    }
}

@Composable
private fun PdfPasswordPrompt(rejected: Boolean, modifier: Modifier, onSubmit: (String) -> Unit) {
    var typed by remember { mutableStateOf("") }
    Column(modifier.fillMaxWidth().padding(Space.page), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        EmptyState(Icons.Outlined.Lock, t(R.string.pdf_password_title), t(R.string.pdf_password_body))
        OutlinedTextField(
            typed, { typed = it }, Modifier.fillMaxWidth(), singleLine = true,
            label = { Text(t(R.string.pdf_password_label)) },
            isError = rejected,
            supportingText = if (rejected) ({ Text(t(R.string.pdf_password_wrong)) }) else null,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
        )
        PrimaryButton(t(R.string.pdf_password_open), { onSubmit(typed) }, Modifier.fillMaxWidth(), enabled = typed.isNotEmpty())
    }
}

/** The pages of an opened [source]. Public so a screenshot test can feed synthetic pages. */
@Composable
fun PdfReaderContent(source: PdfPageSource, startPage: Int = 0, query: String = "", ink: InkDocument? = null, modifier: Modifier = Modifier, zoom: ReaderZoomState = rememberReaderZoomState()) {
    val count = source.aspects.size
    val first = (startPage - 1).coerceIn(0, (count - 1).coerceAtLeast(0))
    val listState = rememberLazyListState(initialFirstVisibleItemIndex = first)
    val words = remember(query) { query.split(Regex("\\s+")).filter { it.length >= 2 } }
    val markColor = MaterialTheme.colorScheme.primary.copy(alpha = 0.32f).let {
        android.graphics.Color.argb((it.alpha * 255).toInt(), (it.red * 255).toInt(), (it.green * 255).toInt(), (it.blue * 255).toInt())
    }
    val inkPages = remember(source.id, ink?.updatedAt, ink?.strokes?.size) {
        ink?.takeIf { it.strokes.isNotEmpty() }?.let { document -> pdfInkPages(document.sourceHeight, true, source.aspects.map { it.toDouble() }) }
    }
    val inkKey = if (inkPages == null) "-" else "${ink?.updatedAt}:${ink?.strokes?.size}"
    var startMatches by remember(source.id, query) { mutableStateOf<Int?>(null) }
    Column(modifier.fillMaxSize()) {
        // The exact spot of a hit cannot always be marked: without the text layer, or when the words are not found there.
        if (query.isNotBlank() && (!pdfTextLayerAvailable() || startMatches == 0)) {
            Text(t(R.string.doc_highlight_unavailable), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = Space.page, vertical = 4.dp))
        }
        ZoomablePages(source.aspects, Modifier.weight(1f).fillMaxWidth().background(LocalCompanionSemantics.current.sunken), zoom, listState) { index, widthPx, _ ->
            PdfPageView(source, index, widthPx, words, markColor, ink, inkPages?.getOrNull(index), inkKey) { matches -> if (index == first) startMatches = matches }
        }
    }
}

@Composable
private fun PdfPageView(
    source: PdfPageSource,
    index: Int,
    widthPx: Int,
    words: List<String>,
    mark: Int,
    ink: InkDocument?,
    inkPage: ch.fasrv.fanotes.ink.PdfInkPage?,
    inkKey: String,
    onMatches: (Int) -> Unit,
) {
    val aspect = source.aspects.getOrElse(index) { 1.4f }
    val target = ReaderZoomMath.renderWidth(widthPx.toFloat(), aspect)
    val flavor = "${words.joinToString(",")}:$inkKey"
    fun key(width: Int) = "${source.id}:$index:$width:$flavor"
    var shown by remember(source.id, index) { mutableStateOf(PdfPageCache.get(key(target))) }
    var failed by remember(source.id, index) { mutableStateOf(false) }
    LaunchedEffect(source.id, index, target, flavor) {
        PdfPageCache.get(key(target))?.let { shown = it; failed = false; return@LaunchedEffect }
        // A zoom change settles first; the older bitmap stays on screen meanwhile.
        if (shown != null) delay(250)
        suspend fun draw(width: Int): PdfPageRender {
            val rendered = source.render(index, width, words, mark)
            if (ink != null && inkPage != null) drawInkOnPdfPage(rendered.bitmap, ink, inkPage)
            return rendered
        }
        var result: PdfPageRender? = null
        try {
            result = draw(target)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: OutOfMemoryError) {
            // Free what the cache holds, then try once more at half the width.
            PdfPageCache.clear()
            result = try { draw((target / 2).coerceAtLeast(1)) } catch (cancelled: CancellationException) { throw cancelled } catch (_: Throwable) { null }
        } catch (_: Throwable) {
            result = null
        }
        if (result == null) { failed = true; return@LaunchedEffect }
        failed = false
        PdfPageCache.put(key(target), result.bitmap)
        shown = result.bitmap
        onMatches(result.matches)
    }
    val image = shown
    Box(Modifier.fillMaxSize().background(Color.White), contentAlignment = Alignment.Center) {
        if (image != null) {
            val bitmap = remember(image) { image.asImageBitmap() }
            Image(bitmap, t(R.string.pdf_page, index + 1), Modifier.fillMaxSize(), contentScale = ContentScale.FillBounds, filterQuality = FilterQuality.Medium)
        } else if (failed) {
            Text(t(R.string.pdf_page_unavailable, index + 1), style = MaterialTheme.typography.bodyMedium, color = Color(0xFF55596B), modifier = Modifier.padding(16.dp))
        }
    }
}
