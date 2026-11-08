package ch.fasrv.fanotes.companion

import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.pdf.PdfRenderer
import android.os.Build
import android.os.ParcelFileDescriptor
import android.os.Process
import android.os.ext.SdkExtensions
import androidx.annotation.RequiresExtension
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.parseJson
import ch.fasrv.fanotes.vault.NoteKind
import com.googlecode.tesseract.android.TessBaseAPI
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.Executors

/** Android SQLite behind [IndexDb]. */
class AndroidIndexDb(file: File) : IndexDb {
    private val db = SQLiteDatabase.openOrCreateDatabase(file, null)
    private fun bind(args: Array<out Any?>): Array<Any?> = args.map { if (it is Boolean) (if (it) 1 else 0) else it }.toTypedArray()
    override fun exec(sql: String, vararg args: Any?) {
        if (args.isEmpty()) db.execSQL(sql) else db.execSQL(sql, bind(args))
    }
    override fun <T> query(sql: String, vararg args: Any?, row: (IndexRow) -> T): List<T> {
        val strings = args.map { it?.toString() }.toTypedArray()
        val cursor: Cursor = db.rawQuery(sql, strings)
        return cursor.use { c ->
            val out = ArrayList<T>(c.count.coerceAtLeast(0))
            val wrapper = object : IndexRow {
                override fun string(index: Int) = if (c.isNull(index)) null else c.getString(index)
                override fun long(index: Int) = if (c.isNull(index)) 0L else c.getLong(index)
                override fun double(index: Int) = if (c.isNull(index)) 0.0 else c.getDouble(index)
            }
            while (c.moveToNext()) out += row(wrapper)
            out
        }
    }
    override fun <T> transaction(block: () -> T): T {
        db.beginTransaction()
        try { val value = block(); db.setTransactionSuccessful(); return value } finally { db.endTransaction() }
    }
    override fun close() = db.close()
}

interface OcrEngine : AutoCloseable { fun recognize(bitmap: Bitmap): OcrResult }

/**
 * Tesseract (LSTM, German model from tessdata_fast, Apache 2.0) running on the device. No network.
 * The model ships in the APK and is copied to private storage on first use.
 */
class TesseractOcr private constructor(private val api: TessBaseAPI) : OcrEngine {
    override fun recognize(bitmap: Bitmap): OcrResult {
        api.setImage(bitmap)
        val text = api.utF8Text.orEmpty()
        val confidence = api.meanConfidence() / 100.0
        api.clear()
        return OcrResult(text, confidence)
    }
    override fun close() = api.recycle()

    companion object {
        const val LANGUAGE = "deu"
        fun open(context: Context): TesseractOcr? = runCatching {
            val root = File(context.noBackupFilesDir, "ocr")
            val data = File(root, "tessdata/$LANGUAGE.traineddata")
            if (!data.isFile || data.length() == 0L) {
                data.parentFile?.mkdirs()
                val temp = File(data.parentFile, "$LANGUAGE.part")
                context.assets.open("tessdata/$LANGUAGE.traineddata").use { input -> temp.outputStream().use { input.copyTo(it) } }
                temp.renameTo(data)
            }
            val api = TessBaseAPI()
            if (!api.init(root.absolutePath, LANGUAGE, TessBaseAPI.OEM_LSTM_ONLY)) { api.recycle(); return null }
            api.pageSegMode = TessBaseAPI.PageSegMode.PSM_AUTO
            TesseractOcr(api)
        }.getOrNull()
    }
}

/** True when this Android version exposes a PDF's text layer (Android 15, or extension 13). */
fun pdfTextLayerAvailable(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && SdkExtensions.getExtensionVersion(Build.VERSION_CODES.R) >= 13

@RequiresExtension(extension = Build.VERSION_CODES.R, version = 13)
private fun pdfPageText(page: PdfRenderer.Page): String = page.textContents.joinToString("\n") { it.text }

/** Nearly uniform pixels: a blank page, which needs no text and is not an OCR failure. */
fun bitmapIsBlank(bitmap: Bitmap): Boolean {
    var sum = 0.0; var squares = 0.0; var n = 0
    val stepX = maxOf(1, bitmap.width / 48); val stepY = maxOf(1, bitmap.height / 64)
    var y = 0
    while (y < bitmap.height) {
        var x = 0
        while (x < bitmap.width) {
            val p = bitmap.getPixel(x, y)
            val l = 0.299 * Color.red(p) + 0.587 * Color.green(p) + 0.114 * Color.blue(p)
            sum += l; squares += l * l; n++; x += stepX
        }
        y += stepY
    }
    if (n == 0) return true
    val mean = sum / n
    return squares / n - mean * mean < 16.0
}

/** Reads notes, worksheets and PDFs for the index. One page bitmap at a time, at most 2400 px. */
class KantiDocExtractor(private val graph: CompanionGraph, private val ocr: () -> OcrEngine?) : DocExtractor {
    override fun open(source: DocSource): ExtractionSession =
        if (source.kind == DOC_KIND_PDF) PdfSession(source) else NoteSession(source)

    private inner class NoteSession(val source: DocSource) : ExtractionSession {
        private val note = try { graph.store.readNote(source.path) } catch (error: Exception) { throw DocExtractionException(DocProblem.Unreadable, true) }
        override val pageCount = 1
        override fun page(index: Int) = PageEntry(1, searchableNoteText(note.markdown), PageSource.Markdown)
        override fun extras(): List<PageEntry> {
            val out = mutableListOf<PageEntry>()
            val transcript = transcriptText(note.document.extras.string("searchTranscript").orEmpty())
            if (transcript.isNotBlank()) out += PageEntry(1, transcript, PageSource.Transcript, 0.9, label = "handwriting")
            note.worksheets.forEachIndexed { i, id -> out += worksheet(id, i + 1) }
            return out
        }
        private fun worksheet(id: String, number: Int): PageEntry {
            val label = "worksheet:$number"
            val record = graph.vault.read(".fanotes/worksheets/$id.json")?.decodeToString()
            val data = record?.let { runCatching { parseJson(it) as? JsonValue.Obj }.getOrNull() }
            val typed = data?.array("textBoxes")?.items.orEmpty().mapNotNull { (it as? JsonValue.Obj)?.string("text") }.joinToString("\n")
            val file = ch.fasrv.fanotes.famd.safeWorksheetSource(id, data?.string("sourceRelativePath"))?.let { graph.root.resolve(it) }
            if (file == null || !file.isFile) return PageEntry(1, typed, PageSource.Markdown, 1.0, if (typed.isBlank()) DocProblem.ImageUnreadable else DocProblem.None, label)
            val bitmap = decodeBounded(file) ?: return PageEntry(1, typed, PageSource.Markdown, 1.0, DocProblem.ImageUnreadable, label)
            return try {
                val read = recognize(bitmap)
                val text = listOf(typed, read.first.text).filter { it.isNotBlank() }.joinToString("\n")
                PageEntry(1, text, if (read.first.text.isBlank()) PageSource.Markdown else PageSource.Ocr, read.first.confidence, read.second, label)
            } finally { bitmap.recycle() }
        }
        override fun close() = Unit
    }

    private inner class PdfSession(val source: DocSource) : ExtractionSession {
        private val file = graph.root.resolve(source.path)
        private val descriptor: ParcelFileDescriptor
        private val renderer: PdfRenderer
        private val desktop: Map<Int, String>
        private var ocrUsed = 0
        override val stamp: String
        init {
            if (!file.isFile) throw DocExtractionException(DocProblem.Unreadable, true)
            if (file.length() > 96L * 1024 * 1024) throw DocExtractionException(DocProblem.TooLarge, false)
            stamp = runCatching { pdfFileStamp(file) }.getOrDefault("")
            descriptor = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
            renderer = try { PdfRenderer(descriptor) } catch (error: SecurityException) {
                descriptor.close(); throw DocExtractionException(DocProblem.Encrypted, false)
            } catch (error: Exception) {
                descriptor.close(); throw DocExtractionException(DocProblem.Unreadable, false)
            }
            desktop = desktopPdfOcrPages(graph.vault.read(desktopPdfOcrSidecar(source.path))?.decodeToString(), source.path, file.length(), stamp)
        }
        override val pageCount get() = renderer.pageCount
        override fun page(index: Int): PageEntry = renderer.openPage(index).use { page ->
            val layer = if (pdfTextLayerAvailable()) runCatching { pdfPageText(page) }.getOrDefault("") else ""
            if (layer.trim().length >= PDF_MIN_TEXT) return@use PageEntry(index + 1, layer, PageSource.TextLayer)
            desktop[index + 1]?.takeIf { it.isNotBlank() }?.let { return@use PageEntry(index + 1, it, PageSource.DesktopOcr, 0.8) }
            if (ocrUsed >= PDF_OCR_MAX_PAGES) return@use PageEntry(index + 1, layer, PageSource.TextLayer, 1.0, DocProblem.OcrLimit)
            ocrUsed++
            val scale = 2400f / maxOf(page.width, page.height)
            val bitmap = Bitmap.createBitmap((page.width * scale).toInt().coerceAtLeast(1), (page.height * scale).toInt().coerceAtLeast(1), Bitmap.Config.ARGB_8888)
            try {
                bitmap.eraseColor(android.graphics.Color.WHITE)
                page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_PRINT)
                val (result, problem) = recognize(bitmap)
                val text = listOf(layer, result.text).filter { it.isNotBlank() }.joinToString("\n")
                PageEntry(index + 1, text, if (result.text.isBlank()) PageSource.TextLayer else PageSource.Ocr, result.confidence, problem)
            } finally { bitmap.recycle() }
        }
        override fun extras(): List<PageEntry> {
            val companion = source.path.removeSuffix(".pdf") + ".famd"
            val markdown = runCatching { graph.store.readNote(source.path).markdown }.getOrDefault("")
            val annotations = searchableNoteText(markdown).trim()
            return if (annotations.isBlank() || !graph.vault.exists(companion)) emptyList() else listOf(PageEntry(1, annotations, PageSource.Markdown, label = "annotations"))
        }
        override fun close() { renderer.close(); descriptor.close() }
    }

    /** OCR with an orientation retry: rotated or upside-down scans read at 90/180/270 degrees. */
    private fun recognize(bitmap: Bitmap): Pair<OcrResult, DocProblem> {
        if (bitmapIsBlank(bitmap)) return OcrResult("", 1.0) to DocProblem.None
        val engine = ocr() ?: return OcrResult("", 0.0) to DocProblem.NoOcrEngine
        return try {
            val upright = engine.recognize(bitmap)
            val results = mutableListOf(0 to upright)
            if (!ocrUsable(upright) || upright.confidence < 0.6) {
                for (degrees in listOf(90, 270, 180)) {
                    val rotated = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, Matrix().apply { postRotate(degrees.toFloat()) }, true)
                    try { results += degrees to engine.recognize(rotated) } finally { rotated.recycle() }
                    if (ocrUsable(results.last().second) && results.last().second.confidence >= 0.75) break
                }
            }
            val best = bestOrientation(results)?.second ?: return OcrResult("", 0.0) to DocProblem.OcrEmpty
            if (!ocrUsable(best)) best to DocProblem.OcrEmpty else best to DocProblem.None
        } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            OcrResult("", 0.0) to DocProblem.OcrFailed
        }
    }

    private fun decodeBounded(file: File): Bitmap? = runCatching {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.path, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / sample > 2400) sample *= 2
        BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample; inPreferredConfig = Bitmap.Config.ARGB_8888 })
    }.getOrNull()
}

data class DocSearchStatus(
    val enabled: Boolean = false,
    val ready: Boolean = false,
    val running: Boolean = false,
    val paused: Boolean = false,
    val progress: DocProgress = DocProgress(0, 0),
    val stats: DocIndexStats = DocIndexStats(0, 0, 0, 0, 0, 0),
    val ocrAvailable: Boolean = true,
    val textLayer: Boolean = false,
)

/**
 * Owns the per-account index. Reads run on one low-priority thread, one document at a time.
 * In the foreground the app runs passes itself; in the background a WorkManager job continues
 * within its time limit. Signing out deletes every index on the device.
 */
class DocSearchService(private val context: Context, private val graph: CompanionGraph, private val scope: CoroutineScope) {
    val status = MutableStateFlow(DocSearchStatus(paused = prefs().getBoolean(PAUSED, false), textLayer = pdfTextLayerAvailable()))
    private val dispatcher = Executors.newSingleThreadExecutor { runnable ->
        Thread({ Process.setThreadPriority(Process.THREAD_PRIORITY_BACKGROUND); runnable.run() }, "kanti-doc-index")
    }.asCoroutineDispatcher()
    private val lock = Mutex()
    private var open: Pair<String, DocIndex>? = null
    private var openDb: AndroidIndexDb? = null
    /** Set while a sign-out wipe is pending, so a running pass stops at the next page. */
    @Volatile private var forgetting = false
    private var ocrEngine: OcrEngine? = null
    private var ocrTried = false
    private var job: Job? = null
    private val worksheetCache = HashMap<String, Pair<String, List<String>>>()

    private fun prefs() = context.getSharedPreferences("fanotes-companion", Context.MODE_PRIVATE)
    private fun directory() = File(context.noBackupFilesDir, "doc-search").apply { mkdirs() }
    private fun keyFor(accountId: String) = MessageDigest.getInstance("SHA-256").digest(accountId.toByteArray()).joinToString("") { "%02x".format(it) }.take(24)

    /** The index for the signed-in account, or null without one. Other accounts' indexes are deleted. */
    private fun indexForAccount(): DocIndex? {
        val account = graph.engine.state.value.account?.accountId
        if (account.isNullOrBlank()) { if (open != null || directory().listFiles()?.isNotEmpty() == true) wipeLocked(); return null }
        val key = keyFor(account)
        open?.let { (k, index) -> if (k == key) return index }
        closeIndex()
        directory().listFiles()?.filter { !it.name.startsWith(key) }?.forEach { it.delete() }
        val file = File(directory(), "$key.db")
        val (db, index) = try { AndroidIndexDb(file).let { it to DocIndex(it) } } catch (error: Exception) {
            // A damaged index is rebuilt; it only holds text derived from the vault.
            runCatching { openDb?.close() }
            file.delete(); AndroidIndexDb(file).let { it to DocIndex(it) }
        }
        open = key to index
        openDb = db
        return index
    }

    private fun closeIndex() { open = null; runCatching { openDb?.close() }; openDb = null }

    /** Caller holds [lock]: closes the database and deletes every index file. */
    private fun wipeLocked() {
        closeIndex()
        directory().listFiles()?.forEach { it.delete() }
        status.value = status.value.copy(enabled = false, ready = false, running = false, stats = DocIndexStats(0, 0, 0, 0, 0, 0))
    }

    /**
     * Removes all indexed text from the device (sign-out, no account). A running pass is stopped
     * first and the files go once it has released the database, so nothing writes to a closed one.
     */
    fun forgetAll() {
        forgetting = true
        job?.cancel()
        status.value = status.value.copy(enabled = false, ready = false, running = false)
        scope.launch(dispatcher) { lock.withLock { wipeLocked(); forgetting = false } }
    }

    private fun ocr(): OcrEngine? {
        if (!ocrTried) { ocrTried = true; ocrEngine = TesseractOcr.open(context); status.value = status.value.copy(ocrAvailable = ocrEngine != null) }
        return ocrEngine
    }

    /** Documents the Notes library shows. Managed files, trash and `.fanotes` data never qualify. */
    private fun sources(): List<DocSource> {
        val files = graph.vault.walkFiles().associateBy { it.path }
        fun stat(path: String) = files[path]?.let { "${it.size}:${it.mtimeMs}" } ?: "-"
        return flattenNotes(graph.store.tree()).map { node ->
            val pdf = node.kind == NoteKind.PDF
            val stem = node.path.substringBeforeLast('.')
            val deps = if (pdf) "" else worksheetsOf(node.path, stat(node.path)).joinToString(",") { id ->
                files.keys.firstOrNull { it.startsWith(".fanotes/worksheets/$id.") && !it.endsWith(".json") }?.let(::stat).orEmpty() + "/" + stat(".fanotes/worksheets/$id.json")
            }
            DocSource(node.path, ch.fasrv.fanotes.vault.displayNoteTitle(node.name, t(R.string.untitled_note)), if (pdf) DOC_KIND_PDF else DOC_KIND_NOTE,
                listOf(stat(node.path), stat("$stem.famd"), stat("$stem.md"), deps).joinToString("|"), node.modifiedAt)
        }
    }

    private fun worksheetsOf(path: String, stamp: String): List<String> {
        worksheetCache[path]?.let { (s, ids) -> if (s == stamp) return ids }
        val markdown = graph.vault.read(path)?.decodeToString().orEmpty()
        val ids = Regex("""<!--\s*fanotes-worksheet:([A-Za-z0-9_-]{1,96})\s*-->""").findAll(markdown).map { it.groupValues[1] }.toList()
        worksheetCache[path] = stamp to ids
        return ids
    }

    /** Asks for a pass soon. Calls during a pass are merged into one follow-up pass. */
    fun request() {
        if (status.value.paused) return
        if (job?.isActive == true) { again = true; return }
        job = scope.launch(dispatcher) {
            delay(1_500)
            do { again = false; runPass(null) } while (again && !status.value.paused)
        }
    }
    @Volatile private var again = false

    /** One incremental pass. [deadline] (elapsed ms) bounds a background run. Returns true when work remains. */
    suspend fun runPass(deadline: Long?): Boolean = withContext(dispatcher) {
        lock.withLock {
            val index = indexForAccount() ?: return@withLock false
            status.value = status.value.copy(enabled = true, running = true)
            val extractor = KantiDocExtractor(graph) { ocr() }
            val result = try {
                DocIndexRunner(index, extractor).run(sources(), keepGoing = {
                    !forgetting && !status.value.paused && (deadline == null || android.os.SystemClock.elapsedRealtime() < deadline) && open?.second === index
                }) { progress -> status.value = status.value.copy(progress = progress) }
            } catch (error: Exception) {
                if (error is kotlinx.coroutines.CancellationException) throw error
                // A broken pass must never take the app down; the next pass starts over.
                ch.fasrv.fanotes.schulnetz.DiagnosticTrace.record("docsearch", "pass", 0, "error", error.javaClass.simpleName)
                DocRunResult(0, 1, 0, true)
            } finally {
                status.value = status.value.copy(running = false, stats = runCatching { index.stats() }.getOrDefault(status.value.stats))
            }
            if (!result.cancelled) status.value = status.value.copy(ready = true)
            result.cancelled
        }
    }

    suspend fun search(query: String, limit: Int = 50): List<DocHit> = withContext(kotlinx.coroutines.Dispatchers.IO) {
        val parsed = parseDocQuery(query)
        if (parsed.isEmpty) return@withContext emptyList()
        // Searching under the lock keeps a sign-out wipe from closing the database mid-query.
        lock.withLock { indexForAccount()?.search(parsed, limit) }.orEmpty()
    }

    suspend fun problems(): List<Pair<DocRecord, List<PageEntry>>> = withContext(dispatcher) { lock.withLock { indexForAccount()?.problems().orEmpty() } }

    fun setPaused(paused: Boolean) {
        prefs().edit().putBoolean(PAUSED, paused).apply()
        status.value = status.value.copy(paused = paused)
        if (!paused) request()
    }

    /** Failed documents become due now; unsupported ones are read again too. */
    fun retryFailed() = scope.launch(dispatcher) {
        lock.withLock {
            val index = indexForAccount() ?: return@withLock
            index.documents().filter { it.status == DocStatus.Failed || it.status == DocStatus.Unsupported || it.status == DocStatus.Partial }
                .forEach { index.putRecord(it.copy(fingerprint = "retry", nextRetryAt = 0)) }
        }
        request()
    }

    fun rebuild() = scope.launch(dispatcher) { lock.withLock { wipeLocked() }; request() }

    /** The app left the foreground: stop in-process work and let WorkManager continue within its limits. */
    fun handOff() {
        job?.cancel()
        if (status.value.enabled && !status.value.paused) DocIndexWorker.schedule(context)
    }

    companion object { const val PAUSED = "doc-index-paused" }
}

/** Background continuation: at most eight minutes per run, on battery that is not low. */
class DocIndexWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val graph = (applicationContext as CompanionApplication).graph
        val remaining = runCatching { graph.docSearch.runPass(android.os.SystemClock.elapsedRealtime() + 8 * 60_000L) }.getOrDefault(true)
        return if (remaining && !graph.docSearch.status.value.paused) Result.retry() else Result.success()
    }

    companion object {
        fun schedule(context: Context) {
            val request = OneTimeWorkRequestBuilder<DocIndexWorker>()
                .setConstraints(Constraints.Builder().setRequiresBatteryNotLow(true).setRequiresStorageNotLow(true).build())
                .setBackoffCriteria(androidx.work.BackoffPolicy.LINEAR, 60, java.util.concurrent.TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork("kanti-doc-index", ExistingWorkPolicy.KEEP, request)
        }
    }
}

