package ch.fasrv.fanotes

import android.content.Context
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import ch.fasrv.fanotes.desk.DOC_INDEX_ENTRY_CHARS
import ch.fasrv.fanotes.desk.DOC_INDEX_PDF
import ch.fasrv.fanotes.desk.DOC_INDEX_TOTAL_CHARS
import ch.fasrv.fanotes.desk.DocIndexEntry
import ch.fasrv.fanotes.desk.DocIndexStatus
import ch.fasrv.fanotes.desk.DocSource
import ch.fasrv.fanotes.desk.SearchHit
import ch.fasrv.fanotes.desk.desktopPageTextPages
import ch.fasrv.fanotes.desk.desktopPageTextSidecar
import ch.fasrv.fanotes.desk.desktopPdfOcrPages
import ch.fasrv.fanotes.desk.desktopPdfOcrSidecar
import ch.fasrv.fanotes.desk.docIndexDeleteLine
import ch.fasrv.fanotes.desk.docIndexJournal
import ch.fasrv.fanotes.desk.docIndexLine
import ch.fasrv.fanotes.desk.docIndexNeedsCompaction
import ch.fasrv.fanotes.desk.docSources
import ch.fasrv.fanotes.desk.famdSearchLines
import ch.fasrv.fanotes.desk.noteIndexEntries
import ch.fasrv.fanotes.desk.parseDocIndex
import ch.fasrv.fanotes.desk.pdfByteStamp
import ch.fasrv.fanotes.desk.pdfIndexEntry
import ch.fasrv.fanotes.desk.planDocIndex
import ch.fasrv.fanotes.desk.searchDocIndex
import ch.fasrv.fanotes.desk.syncedPdfPages
import ch.fasrv.fanotes.famd.parseFamd
import ch.fasrv.fanotes.study.PdfTextApi
import ch.fasrv.fanotes.study.PdfTextSnapshot
import ch.fasrv.fanotes.study.linesFromRuns
import ch.fasrv.fanotes.study.searchPageTexts
import ch.fasrv.fanotes.vault.VaultEntry
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap

/**
 * The local search index of the open vault (see `desk/DocIndex.kt`). It is read from its journal file once, built
 * and updated on a single background thread at low priority, and queried from memory. A query never reads the vault.
 * Only files whose size or modification time changed are read again, so the build continues where it stopped.
 */
class DocIndexService(private val context: Context, private val graph: AppGraph) {
    val status = MutableStateFlow(DocIndexStatus())

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO.limitedParallelism(1))
    private val entries = ConcurrentHashMap<String, DocIndexEntry>()
    private var loadedVault: String? = null
    private var journalLines = 0
    private var totalChars = 0L
    private var job: Job? = null
    private var pending: Job? = null

    private fun journalFile(vaultId: String): File {
        val digest = MessageDigest.getInstance("SHA-256").digest(vaultId.toByteArray()).joinToString("") { "%02x".format(it) }.take(32)
        return File(File(context.filesDir, "doc-index").apply { mkdirs() }, "$digest.jsonl")
    }

    /** Loads the journal of the current vault (and drops the one of a vault that was closed). */
    @Synchronized
    private fun load(): File {
        val vaultId = graph.vaultId
        val file = journalFile(vaultId)
        if (loadedVault != vaultId) {
            entries.clear()
            journalLines = 0
            totalChars = 0
            val parsed = runCatching { parseDocIndex(file.takeIf { it.isFile && it.length() < 400L * 1024 * 1024 }?.readText()) }.getOrNull()
            if (parsed != null) {
                for (entry in parsed.entries) entries[entry.key] = entry
                journalLines = parsed.lines
                totalChars = parsed.entries.sumOf { it.text.length.toLong() }
            }
            loadedVault = vaultId
        }
        return file
    }

    /** Starts an update unless one runs. Called when the app starts, when the search opens and when files changed. */
    fun refresh() {
        if (job?.isActive == true) return
        job = scope.launch { runCatching { build() } }
    }

    /** A note was saved or synced: update in a few seconds, once for many changes. */
    fun changed() {
        pending?.cancel()
        pending = scope.launch {
            delay(4_000)
            refresh()
        }
    }

    fun search(query: String, cancelled: () -> Boolean = { false }): List<SearchHit> {
        load()
        return searchDocIndex(entries.values, query, cancelled = cancelled)
    }

    private suspend fun build() {
        val file = load()
        val vaultId = loadedVault
        status.value = status.value.copy(running = true, error = null)
        try {
            val files = withContext(Dispatchers.IO) { graph.vault.walkFiles() }
            val sizes = HashMap<String, Long>(files.size * 2)
            for (entry in files) sizes[entry.path] = entry.size
            val sources = docSources(files)
            val plan = planDocIndex(sources, entries.values)
            status.value = DocIndexStatus(total = plan.total, indexed = plan.total - plan.todo.size, running = true)
            if (plan.drop.isNotEmpty()) {
                for (key in plan.drop) entries.remove(key)?.let { totalChars -= it.text.length }
                append(file, plan.drop.joinToString("\n", postfix = "\n") { docIndexDeleteLine(it) })
            }
            val batch = StringBuilder()
            var done = 0
            var lastSave = System.currentTimeMillis()
            for (source in plan.todo) {
                currentCoroutineContext().ensureActive()
                if (vaultId != graph.vaultId) return
                if (totalChars >= DOC_INDEX_TOTAL_CHARS) {
                    status.value = status.value.copy(full = true)
                    break
                }
                val made = runCatching { extract(source, sizes[source.path] ?: 0) }.getOrElse { if (it is CancellationException) throw it else emptyList() }
                val forPath = made.ifEmpty { listOf(placeholder(source)) }
                for (entry in forPath) {
                    entries[entry.key]?.let { totalChars -= it.text.length }
                    entries[entry.key] = entry
                    totalChars += entry.text.length
                    batch.append(docIndexLine(entry)).append('\n')
                }
                done += 1
                status.value = status.value.copy(indexed = plan.total - plan.todo.size + done)
                if (batch.length > 1_000_000 || System.currentTimeMillis() - lastSave > 5_000) {
                    append(file, batch.toString())
                    batch.setLength(0)
                    lastSave = System.currentTimeMillis()
                }
                // Give the main thread and sync the disk between files; a large vault takes minutes, not seconds.
                delay(2)
            }
            if (batch.isNotEmpty()) append(file, batch.toString())
            if (docIndexNeedsCompaction(journalLines, entries.size)) {
                val temporary = File(file.parentFile, file.name + ".tmp")
                temporary.writeText(docIndexJournal(entries.values))
                if (temporary.renameTo(file)) journalLines = entries.size
            }
            val covered = plan.total - plan.todo.size + done
            status.value = status.value.copy(total = plan.total, indexed = covered.coerceAtMost(plan.total), running = false)
        } catch (cancelled: CancellationException) {
            status.value = status.value.copy(running = false)
            throw cancelled
        } catch (error: Exception) {
            status.value = status.value.copy(running = false, error = "Fehler beim Aufbau")
        }
    }

    private fun append(file: File, text: String) {
        file.appendText(text)
        journalLines += text.count { it == '\n' }
    }

    /** A file that could not be read still gets an entry, so it is not retried until it changes. */
    private fun placeholder(source: DocSource): DocIndexEntry =
        DocIndexEntry(source.path, if (source.type == DOC_INDEX_PDF) DOC_INDEX_PDF else ch.fasrv.fanotes.desk.DOC_INDEX_NOTE, source.signature, ch.fasrv.fanotes.desk.searchHitTitle(source.path), "")

    private fun extract(source: DocSource, size: Long): List<DocIndexEntry> =
        if (source.type == DOC_INDEX_PDF) listOf(extractPdf(source, size)) else extractNote(source)

    private fun extractNote(source: DocSource): List<DocIndexEntry> {
        val vault = graph.vault
        val markdown = source.markdownPath?.let { vault.readHead(it, NOTE_BYTES)?.bytes?.decodeToString() }
        val stripped = markdown?.let { ch.fasrv.fanotes.famd.stripFamdPayload(it) }
        var famdText: String? = source.famdPath?.let { path -> vault.readHead(path, FAMD_BYTES)?.takeIf { it.complete }?.bytes?.decodeToString() }
        if (famdText == null && markdown != null && markdown.contains("fanotes-famd:")) famdText = markdown
        val payload = famdText?.let { text -> runCatching { parseFamd(text, unpackPoints = false).payload }.getOrNull() }
        val body = stripped ?: famdText?.let { ch.fasrv.fanotes.famd.stripFamdPayload(it) }
        val markdownForIndex = if (source.markdownPath != null) stripped else body
        return noteIndexEntries(source, markdownForIndex, famdSearchLines(payload))
    }

    private fun extractPdf(source: DocSource, size: Long): DocIndexEntry {
        if (size > PDF_BYTES) return pdfIndexEntry(source, emptyList())
        val bytes = graph.vault.read(source.path) ?: return pdfIndexEntry(source, emptyList())
        val synced = syncedText(source.path, bytes)
        var api = PdfTextLayer.api()
        var layer: List<List<String>>? = null
        if (api != PdfTextApi.NONE) {
            val file = File.createTempFile("fanotes-index", ".pdf", context.cacheDir)
            try {
                file.writeBytes(bytes)
                layer = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY).use { descriptor ->
                    PdfTextLayer.read(api, descriptor, PDF_PAGES, { PdfRenderer(it) })?.map { linesFromRuns(it) }
                }
            } catch (_: LinkageError) {
                PdfTextLayer.markMissing()
                api = PdfTextApi.NONE
            } catch (_: Exception) {
                layer = null
            } finally {
                file.delete()
            }
        }
        return pdfIndexEntry(source, searchPageTexts(PdfTextSnapshot(api, layer, synced), PDF_PAGES))
    }

    private fun syncedText(path: String, bytes: ByteArray): Map<Int, String> {
        fun text(sidecar: String) = runCatching { graph.vault.read(sidecar)?.decodeToString() }.getOrNull()
        val stamp = pdfByteStamp(bytes)
        val length = bytes.size.toLong()
        return syncedPdfPages(
            desktopPageTextPages(text(desktopPageTextSidecar(path)), path, length, stamp),
            desktopPdfOcrPages(text(desktopPdfOcrSidecar(path)), path, length, stamp),
        )
    }

    private companion object {
        const val NOTE_BYTES = DOC_INDEX_ENTRY_CHARS * 3
        const val FAMD_BYTES = 16 * 1024 * 1024
        const val PDF_BYTES = 80L * 1024 * 1024
        const val PDF_PAGES = 400
    }
}


