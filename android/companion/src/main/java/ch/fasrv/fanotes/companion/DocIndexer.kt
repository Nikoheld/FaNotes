package ch.fasrv.fanotes.companion

import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.yield

/** A document the user can open in Kanti+: a note (with its worksheets) or a PDF note. */
data class DocSource(
    val path: String,
    val title: String,
    val kind: String,
    /** Changes whenever the document or anything it embeds changes. */
    val fingerprint: String,
    val modifiedAt: Long = 0,
)

/** Opening target of a search hit: page 1-based (0 = start) and the words to highlight. */
data class DocTarget(val page: Int, val label: String, val query: String)

const val DOC_KIND_NOTE = "note"
const val DOC_KIND_PDF = "pdf"

data class IndexPlan(val read: List<DocSource>, val resume: List<DocSource>, val remove: List<String>) {
    val work get() = read.size + resume.size + remove.size
}

/**
 * What to do for every document. New, edited, re-extracted and due-for-retry documents are read
 * again from the start; an interrupted read resumes; documents that are gone or no longer
 * accessible are removed. Unsupported documents wait until their file changes.
 */
fun planIndex(sources: List<DocSource>, records: List<DocRecord>, now: Long): IndexPlan {
    val byPath = records.associateBy { it.path }
    val read = mutableListOf<DocSource>()
    val resume = mutableListOf<DocSource>()
    for (source in sources.sortedByDescending { it.modifiedAt }) {
        val record = byPath[source.path]
        when {
            record == null -> read += source
            record.fingerprint != source.fingerprint || record.extractor < DOC_EXTRACTOR_VERSION -> read += source
            record.status == DocStatus.Pending -> resume += source
            record.status == DocStatus.Failed && record.nextRetryAt <= now -> read += source
            else -> Unit
        }
    }
    val live = sources.map { it.path }.toSet()
    return IndexPlan(read, resume, records.map { it.path }.filter { it !in live })
}

class DocExtractionException(val problem: DocProblem, val retryable: Boolean, message: String = problem.id) : Exception(message)

/** One open document. Implementations hold at most one page in memory at a time. */
interface ExtractionSession : AutoCloseable {
    val pageCount: Int
    /** Reads page [index] (0-based). A page that cannot be read returns an entry with a problem. */
    fun page(index: Int): PageEntry
    /** Content that is not a page of the original, such as worksheets or PDF annotations. */
    fun extras(): List<PageEntry> = emptyList()
    val stamp: String get() = ""
}

fun interface DocExtractor { fun open(source: DocSource): ExtractionSession }

data class DocProgress(val done: Int, val total: Int, val current: String = "", val page: Int = 0, val pages: Int = 0)

data class DocRunResult(val indexed: Int, val failed: Int, val removed: Int, val cancelled: Boolean)

/** Highest page read per document; later pages are recorded as a limit, not silently dropped. */
const val DOC_MAX_PAGES = 500

/**
 * Reads planned documents one at a time and commits every [batch] pages, so cancellation, a
 * killed process or a WorkManager time limit loses at most one batch. [keepGoing] is checked
 * between pages (pause, deadline); coroutine cancellation is honoured as well.
 */
class DocIndexRunner(
    private val index: DocIndex,
    private val extractor: DocExtractor,
    private val now: () -> Long = System::currentTimeMillis,
    private val batch: Int = 4,
) {
    suspend fun run(sources: List<DocSource>, keepGoing: () -> Boolean = { true }, progress: (DocProgress) -> Unit = {}): DocRunResult {
        val plan = planIndex(sources, index.documents(), now())
        var done = 0
        var indexed = 0
        var failed = 0
        val total = plan.work
        for (path in plan.remove) { index.remove(path); done++ }
        progress(DocProgress(done, total))
        val queue = plan.resume.map { it to true } + plan.read.map { it to false }
        for ((source, resuming) in queue) {
            currentCoroutineContext().ensureActive()
            if (!keepGoing()) return DocRunResult(indexed, failed, plan.remove.size, true)
            val outcome = readOne(source, resuming, keepGoing) { page, pages -> progress(DocProgress(done, total, source.title, page, pages)) }
            when (outcome) {
                Outcome.Indexed -> indexed++
                Outcome.Failed -> failed++
                Outcome.Stopped -> return DocRunResult(indexed, failed, plan.remove.size, true)
            }
            done++
            progress(DocProgress(done, total))
            yield()
        }
        return DocRunResult(indexed, failed, plan.remove.size, false)
    }

    private enum class Outcome { Indexed, Failed, Stopped }

    private suspend fun readOne(source: DocSource, resuming: Boolean, keepGoing: () -> Boolean, onPage: (Int, Int) -> Unit): Outcome {
        val previous = index.document(source.path)
        val start = if (resuming) previous?.resumePage ?: 0 else 0
        if (!resuming) index.begin(DocRecord(source.path, source.title, source.kind, source.fingerprint, attempts = previous?.attempts ?: 0))
        val session = try {
            extractor.open(source)
        } catch (error: DocExtractionException) {
            index.fail(source.path, error.problem, now(), error.retryable); return Outcome.Failed
        } catch (error: Exception) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            index.fail(source.path, DocProblem.Unreadable, now(), true); return Outcome.Failed
        }
        session.use { open ->
            if (open.stamp.isNotBlank()) index.document(source.path)?.let { index.putRecord(it.copy(stamp = open.stamp)) }
            val last = minOf(open.pageCount, DOC_MAX_PAGES)
            val pending = mutableListOf<PageEntry>()
            var cursor = start
            while (cursor < last) {
                currentCoroutineContext().ensureActive()
                if (!keepGoing()) { index.addPages(source.path, source.title, pending, cursor); return Outcome.Stopped }
                onPage(cursor + 1, open.pageCount)
                val entry = try {
                    open.page(cursor)
                } catch (error: Exception) {
                    if (error is kotlinx.coroutines.CancellationException) throw error
                    PageEntry(cursor + 1, "", PageSource.None, 0.0, if (error is DocExtractionException) error.problem else DocProblem.Unreadable)
                }
                pending += entry
                cursor++
                if (pending.size >= batch) { index.addPages(source.path, source.title, pending, cursor); pending.clear() }
                yield()
            }
            val extras = runCatching { open.extras() }.getOrElse { if (it is kotlinx.coroutines.CancellationException) throw it; emptyList() }
            index.addPages(source.path, source.title, pending + extras, cursor)
            val limit = open.pageCount > DOC_MAX_PAGES
            val anyProblem = limit || index.problemPages(source.path) > 0
            index.finish(source.path, if (anyProblem) DocStatus.Partial else DocStatus.Indexed, if (limit) DocProblem.PageLimit else DocProblem.None, now())
        }
        return Outcome.Indexed
    }
}
