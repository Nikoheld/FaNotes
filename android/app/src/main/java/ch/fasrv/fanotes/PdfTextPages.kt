package ch.fasrv.fanotes

import android.graphics.Point
import android.graphics.RectF
import android.graphics.pdf.LoadParams
import android.graphics.pdf.PdfRenderer
import android.graphics.pdf.PdfRendererPreV
import android.graphics.pdf.models.selection.PageSelection
import android.graphics.pdf.models.selection.SelectionBoundary
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import androidx.annotation.RequiresApi
import androidx.annotation.RequiresExtension
import ch.fasrv.fanotes.study.PdfTextApi
import java.io.File
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicReference

/** A text selection on one PDF page: `[start, end)` of the page text, its words and the line boxes in PDF points. */
data class PdfTextPick(val page: Int, val start: Int, val end: Int, val text: String, val rects: List<RectF>, val pageText: String)

/** Line boxes of one character range, in PDF points of its page. */
data class PdfRangeBoxes(val start: Int, val end: Int, val rects: List<RectF>)

/**
 * The text layer of the open PDF note for on-page selection and painted marks. It keeps its own [PdfRenderer]
 * (Android 15) or [PdfRendererPreV] (Android 12-14 with SDK extension 13) open on a private copy of the file, on one
 * background thread: `PdfRenderer` allows one open page at a time and is not thread-safe, and the page renderer in
 * the view model must not wait for it. Results come back on the main thread.
 *
 * Indexes are those of `SelectionBoundary(int)`: positions in the page text as `getTextContents` returns it.
 */
internal class PdfTextPages(private val tempDir: () -> File) {
    private val main = Handler(Looper.getMainLooper())
    private var executor: ExecutorService? = null
    private var doc: Doc? = null
    @Volatile private var openKey: String? = null
    @Volatile var failed = false
        private set
    private val latestPick = AtomicReference<PickRequest?>(null)

    private data class PickRequest(val page: Int, val from: Point, val to: Point, val serial: Int, val done: (PdfTextPick?) -> Unit)

    private var pickSerial = 0

    /** Called on the main thread once a PDF is open, so pending geometry can be asked for again. */
    var onOpened: () -> Unit = {}

    /** The API this device offers; [PdfTextApi.NONE] when there is no on-page text here. */
    val api: PdfTextApi get() = if (failed) PdfTextApi.NONE else PdfTextLayer.api()

    private fun worker(): ExecutorService = executor?.takeUnless { it.isShutdown }
        ?: Executors.newSingleThreadExecutor { runnable -> Thread(runnable, "fanotes-pdf-text").apply { isDaemon = true } }.also { executor = it }

    /**
     * Opens the PDF identified by [key] (path and password); [bytes] is called on the worker thread. Nothing happens
     * when that PDF is already open.
     */
    fun open(key: String, password: String, bytes: () -> ByteArray?) {
        if (openKey == key) return
        openKey = key
        failed = false
        val api = PdfTextLayer.api()
        if (api == PdfTextApi.NONE) return
        // The first PDF pages render right after a note opens; the text layer waits a moment instead of competing.
        main.postDelayed({ if (openKey == key) worker().execute { openNow(key, api, password, bytes) } }, OPEN_DELAY_MS)
    }

    private fun openNow(key: String, api: PdfTextApi, password: String, bytes: () -> ByteArray?) {
        closeDoc()
        if (openKey != key) return
        val data = try { bytes() } catch (_: Exception) { null } ?: return
        val file = File.createTempFile("fanotes-pdf-select", ".pdf", tempDir())
        var descriptor: ParcelFileDescriptor? = null
        try {
            file.writeBytes(data)
            descriptor = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
            // The renderer owns the descriptor from here on and closes it with itself.
            doc = when (api) {
                PdfTextApi.PLATFORM -> if (Build.VERSION.SDK_INT >= 35) PlatformDoc(descriptor, password, file) else null
                PdfTextApi.PRE_V -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && preVAvailable()) PreVDoc(descriptor, password, file) else null
                PdfTextApi.NONE -> null
            }
            if (doc == null) {
                descriptor.close()
                file.delete()
            } else {
                main.post { if (openKey == key) onOpened() }
            }
        } catch (_: LinkageError) {
            PdfTextLayer.markMissing()
            failed = true
            runCatching { descriptor?.close() }
            file.delete()
        } catch (_: Exception) {
            // A damaged file or a wrong password: no text layer for this PDF.
            failed = true
            runCatching { descriptor?.close() }
            file.delete()
        }
    }

    fun close() {
        openKey = null
        latestPick.set(null)
        executor?.execute { closeDoc() }
    }

    /** Shuts the worker down for good (the view left the window). */
    fun release() {
        close()
        executor?.shutdown()
        executor = null
    }

    private fun closeDoc() {
        val current = doc ?: return
        doc = null
        runCatching { current.close() }
    }

    /**
     * The text between two points of [page] (PDF points). Only the newest request still waiting is answered, so a
     * drag does not queue up selections.
     */
    fun pick(page: Int, from: Point, to: Point, done: (PdfTextPick?) -> Unit) {
        pickSerial += 1
        latestPick.set(PickRequest(page, from, to, pickSerial, done))
        worker().execute {
            val request = latestPick.getAndSet(null) ?: return@execute
            val result = guarded { doc?.pick(request.page, request.from, request.to) }
            main.post { request.done(result) }
        }
    }

    /** The word under [point] of [page] (PDF points), for a long press. */
    fun pickWord(page: Int, point: Point, done: (PdfTextPick?) -> Unit) {
        worker().execute {
            val result = guarded { doc?.pickWord(page, point) }
            main.post { done(result) }
        }
    }

    /** Page text and size, then the line boxes of [ranges] (from [rangesFor], run on the worker). */
    fun boxes(
        page: Int,
        rangesFor: (String) -> List<IntRange>,
        failed: () -> Unit,
        done: (text: String, width: Float, height: Float, boxes: List<PdfRangeBoxes>) -> Unit,
    ) {
        worker().execute {
            val result = guarded {
                val current = doc ?: return@guarded null
                val text = current.text(page) ?: return@guarded null
                val size = current.size(page) ?: return@guarded null
                val ranges = rangesFor(text)
                val found = current.rangeBoxes(page, ranges, text)
                Triple(text, size, found)
            }
            if (result != null) main.post { done(result.first, result.second.first, result.second.second, result.third) } else main.post(failed)
        }
    }

    /** Page text, or null when there is none here. */
    fun text(page: Int, done: (String?) -> Unit) {
        worker().execute {
            val text = guarded { doc?.text(page) }
            main.post { done(text) }
        }
    }

    private inline fun <T> guarded(block: () -> T?): T? = try {
        block()
    } catch (_: LinkageError) {
        PdfTextLayer.markMissing()
        failed = true
        null
    } catch (_: Exception) {
        null
    }

    private companion object {
        const val OPEN_DELAY_MS = 1200L
    }

    private fun preVAvailable(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
        android.os.ext.SdkExtensions.getExtensionVersion(Build.VERSION_CODES.S) >= ch.fasrv.fanotes.study.PDF_TEXT_EXTENSION

    /** The two renderer flavours behind one face. Called on the worker only. */
    private abstract class Doc(private val file: File) {
        private val texts = HashMap<Int, String>()
        private val sizes = HashMap<Int, Pair<Float, Float>>()

        abstract val pageCount: Int
        protected abstract fun readText(index: Int): String
        protected abstract fun readSize(index: Int): Pair<Float, Float>
        protected abstract fun select(index: Int, start: SelectionBoundary, stop: SelectionBoundary): PageSelection?
        protected abstract fun search(index: Int, query: String): List<Pair<Int, List<RectF>>>
        protected abstract fun closeRenderer()

        fun text(page: Int): String? {
            if (page < 1 || page > pageCount) return null
            return texts.getOrPut(page) { readText(page - 1) }
        }

        fun size(page: Int): Pair<Float, Float>? {
            if (page < 1 || page > pageCount) return null
            return sizes.getOrPut(page) { readSize(page - 1) }
        }

        fun pick(page: Int, from: Point, to: Point): PdfTextPick? {
            val text = text(page) ?: return null
            val selection = select(page - 1, SelectionBoundary(from), SelectionBoundary(to)) ?: return null
            val contents = selection.selectedTextContents
            val picked = contents.joinToString("") { it.text }
            val rects = contents.flatMap { it.bounds }
            if (picked.isBlank() || rects.isEmpty()) return null
            var start = minOf(selection.start.index, selection.stop.index)
            var end = maxOf(selection.start.index, selection.stop.index)
            // The indexes should cover the picked text; when the system counts differently, find the text near them.
            if (start < 0 || end > text.length || !sameText(text.substring(start, end), picked)) {
                val located = locate(text, picked, start) ?: return null
                start = located.first
                end = located.last + 1
            }
            return PdfTextPick(page, start, end, picked, rects, text)
        }

        /** The word under [point], widened from the character the system finds there. */
        fun pickWord(page: Int, point: Point): PdfTextPick? {
            val text = text(page) ?: return null
            val tiny = pick(page, Point(point.x - 1, point.y), Point(point.x + 1, point.y)) ?: return null
            val word = ch.fasrv.fanotes.desk.pdfWordAlignedRange(text, tiny.start, maxOf(tiny.end, tiny.start + 1)) ?: return tiny
            val boxes = rangeBoxes(page, listOf(word), text).firstOrNull() ?: return tiny
            return PdfTextPick(page, word.first, word.last + 1, text.substring(word.first, word.last + 1), boxes.rects, text)
        }

        fun rangeBoxes(page: Int, ranges: List<IntRange>, text: String): List<PdfRangeBoxes> = ranges.mapNotNull { range ->
            val byIndex = runCatching {
                select(page - 1, SelectionBoundary(range.first), SelectionBoundary(range.last + 1))
                    ?.selectedTextContents?.flatMap { it.bounds }
            }.getOrNull().orEmpty()
            val rects = byIndex.ifEmpty {
                // Some builds only answer selections by point: find the words by search instead.
                val query = text.substring(range.first, range.last + 1)
                search(page - 1, query).minByOrNull { kotlin.math.abs(it.first - range.first) }?.second.orEmpty()
            }
            if (rects.isEmpty()) null else PdfRangeBoxes(range.first, range.last + 1, rects)
        }

        fun close() {
            closeRenderer()
            file.delete()
        }

        private fun compact(value: String) = value.filterNot { it.isWhitespace() }

        private fun sameText(left: String, right: String) = compact(left) == compact(right)

        /** Raw range of [picked] in [text] whose start lies nearest to [near]. */
        private fun locate(text: String, picked: String, near: Int): IntRange? {
            val index = ch.fasrv.fanotes.desk.PdfPageTextIndex(text)
            val needle = compact(picked)
            if (needle.isEmpty()) return null
            var best: Int? = null
            var at = index.compact.indexOf(needle)
            val target = index.compactAtOrAfter(near.coerceAtLeast(0))
            while (at >= 0) {
                if (best == null || kotlin.math.abs(at - target) < kotlin.math.abs(best - target)) best = at
                at = index.compact.indexOf(needle, at + 1)
            }
            return best?.let { index.rawRange(it, it + needle.length) }
        }
    }

    @RequiresApi(35)
    private class PlatformDoc(descriptor: ParcelFileDescriptor, password: String, file: File) : Doc(file) {
        private val renderer = if (password.isNotEmpty()) {
            PdfRenderer(descriptor, LoadParams.Builder().setPassword(password).build())
        } else {
            PdfRenderer(descriptor)
        }
        override val pageCount: Int = renderer.pageCount
        override fun readText(index: Int): String = renderer.openPage(index).use { page -> page.textContents.joinToString("") { it.text } }
        override fun readSize(index: Int): Pair<Float, Float> = renderer.openPage(index).use { page -> page.width.toFloat() to page.height.toFloat() }
        override fun select(index: Int, start: SelectionBoundary, stop: SelectionBoundary): PageSelection? =
            renderer.openPage(index).use { page -> page.selectContent(start, stop) }
        override fun search(index: Int, query: String): List<Pair<Int, List<RectF>>> =
            renderer.openPage(index).use { page -> page.searchText(query).map { it.textStartIndex to it.bounds } }
        override fun closeRenderer() = renderer.close()
    }

    @RequiresExtension(extension = Build.VERSION_CODES.S, version = 13)
    private class PreVDoc(descriptor: ParcelFileDescriptor, password: String, file: File) : Doc(file) {
        private val renderer = if (password.isNotEmpty()) {
            PdfRendererPreV(descriptor, LoadParams.Builder().setPassword(password).build())
        } else {
            PdfRendererPreV(descriptor)
        }
        override val pageCount: Int = renderer.pageCount
        override fun readText(index: Int): String = renderer.openPage(index).use { page -> page.textContents.joinToString("") { it.text } }
        override fun readSize(index: Int): Pair<Float, Float> = renderer.openPage(index).use { page -> page.width.toFloat() to page.height.toFloat() }
        override fun select(index: Int, start: SelectionBoundary, stop: SelectionBoundary): PageSelection? =
            renderer.openPage(index).use { page -> page.selectContent(start, stop) }
        override fun search(index: Int, query: String): List<Pair<Int, List<RectF>>> =
            renderer.openPage(index).use { page -> page.searchText(query).map { it.textStartIndex to it.bounds } }
        override fun closeRenderer() = renderer.close()
    }
}
