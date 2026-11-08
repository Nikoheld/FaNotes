package ch.fasrv.fanotes.companion

/*
 * Kanti+ document index. App-private SQLite with FTS4, one database per FaNotes account, never
 * written into the synced vault. Not a shared FaNotes format: see docs/DOCUMENT_SEARCH.md.
 */

/** Minimal SQL surface so the same index code runs on Android SQLite and on JDBC in tests. */
interface IndexDb {
    fun exec(sql: String, vararg args: Any?)
    fun <T> query(sql: String, vararg args: Any?, row: (IndexRow) -> T): List<T>
    fun <T> transaction(block: () -> T): T
    fun close()
}

interface IndexRow {
    fun string(index: Int): String?
    fun long(index: Int): Long
    fun double(index: Int): Double
}

const val DOC_INDEX_SCHEMA = 1

/** Bump when extraction improves, so already indexed documents are read again. */
const val DOC_EXTRACTOR_VERSION = 1

enum class DocStatus(val id: String) {
    Indexed("indexed"), Partial("partial"), Pending("pending"), Failed("failed"), Unsupported("unsupported");
    companion object { fun of(id: String?) = entries.firstOrNull { it.id == id } ?: Pending }
}

/** Why a page or a document has no searchable text. Shown to the user as is, never hidden. */
enum class DocProblem(val id: String) {
    None(""), Encrypted("encrypted"), Unreadable("unreadable"), TooLarge("too-large"), OcrFailed("ocr-failed"),
    OcrEmpty("ocr-empty"), OcrLimit("ocr-limit"), PageLimit("page-limit"), NoOcrEngine("no-ocr-engine"), ImageUnreadable("image-unreadable");
    companion object { fun of(id: String?) = entries.firstOrNull { it.id == id } ?: None }
}

data class DocRecord(
    val path: String,
    val title: String,
    val kind: String,
    val fingerprint: String,
    val stamp: String = "",
    val status: DocStatus = DocStatus.Pending,
    val pages: Int = 0,
    val ocrPages: Int = 0,
    val failedPages: Int = 0,
    val problem: DocProblem = DocProblem.None,
    val attempts: Int = 0,
    val nextRetryAt: Long = 0,
    val indexedAt: Long = 0,
    val resumePage: Int = 0,
    val extractor: Int = DOC_EXTRACTOR_VERSION,
)

data class PageEntry(
    val page: Int,
    val text: String,
    val source: PageSource,
    val confidence: Double = 1.0,
    val problem: DocProblem = DocProblem.None,
    /** Label shown instead of a page number, such as a worksheet. Empty for normal pages. */
    val label: String = "",
)

data class DocHit(
    val path: String,
    val title: String,
    val kind: String,
    val page: Int,
    val label: String,
    val snippet: Snippet,
    val source: PageSource,
    val confidence: Double,
    val score: Double,
    val duplicates: Int = 0,
)

data class DocIndexStats(val documents: Int, val pages: Int, val ocrPages: Int, val failed: Int, val unsupported: Int, val pending: Int)

/** Longest text kept per page. Longer pages are cut, never split into invisible pages. */
const val DOC_MAX_PAGE_CHARS = 20_000

class DocIndex(private val db: IndexDb) {
    init { migrate() }

    private fun migrate() {
        val version = db.query("PRAGMA user_version") { it.long(0) }.firstOrNull() ?: 0L
        if (version == DOC_INDEX_SCHEMA.toLong()) return
        // An older or unknown layout is stale: rebuild rather than guess.
        db.exec("DROP TABLE IF EXISTS pages_fts")
        db.exec("DROP TABLE IF EXISTS pages")
        db.exec("DROP TABLE IF EXISTS docs")
        db.exec("""CREATE TABLE docs(path TEXT PRIMARY KEY, title TEXT, kind TEXT, fingerprint TEXT, stamp TEXT, status TEXT, pages INTEGER,
            ocr_pages INTEGER, failed_pages INTEGER, problem TEXT, attempts INTEGER, next_retry INTEGER, indexed_at INTEGER, resume_page INTEGER, extractor INTEGER)""")
        db.exec("CREATE TABLE pages(id INTEGER PRIMARY KEY, path TEXT, page INTEGER, label TEXT, source TEXT, confidence REAL, problem TEXT, text TEXT)")
        db.exec("CREATE INDEX pages_path ON pages(path, page)")
        db.exec("CREATE VIRTUAL TABLE pages_fts USING fts4(title, body, tokenize=simple)")
        db.exec("PRAGMA user_version = $DOC_INDEX_SCHEMA")
    }

    fun documents(): List<DocRecord> = db.query("SELECT path,title,kind,fingerprint,stamp,status,pages,ocr_pages,failed_pages,problem,attempts,next_retry,indexed_at,resume_page,extractor FROM docs") { r ->
        DocRecord(r.string(0)!!, r.string(1).orEmpty(), r.string(2).orEmpty(), r.string(3).orEmpty(), r.string(4).orEmpty(), DocStatus.of(r.string(5)),
            r.long(6).toInt(), r.long(7).toInt(), r.long(8).toInt(), DocProblem.of(r.string(9)), r.long(10).toInt(), r.long(11), r.long(12), r.long(13).toInt(), r.long(14).toInt())
    }

    fun document(path: String): DocRecord? = documents().firstOrNull { it.path == path }

    fun putRecord(record: DocRecord) {
        db.exec("INSERT OR REPLACE INTO docs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", record.path, record.title, record.kind, record.fingerprint, record.stamp,
            record.status.id, record.pages, record.ocrPages, record.failedPages, record.problem.id, record.attempts, record.nextRetryAt, record.indexedAt, record.resumePage, record.extractor)
    }

    /** Starts a fresh read of [record]: old pages go, so an edited document never mixes versions. */
    fun begin(record: DocRecord) = db.transaction {
        deletePages(record.path)
        putRecord(record.copy(status = DocStatus.Pending, resumePage = 0, pages = 0, ocrPages = 0, failedPages = 0))
    }

    /** Adds pages and moves the resume point, in one transaction, so a killed process resumes there. */
    fun addPages(path: String, title: String, pages: List<PageEntry>, resumePage: Int) = db.transaction {
        val foldedTitle = foldPlain(title)
        for (entry in pages) {
            val text = entry.text.take(DOC_MAX_PAGE_CHARS)
            db.exec("DELETE FROM pages_fts WHERE rowid IN (SELECT id FROM pages WHERE path=? AND page=? AND label=?)", path, entry.page, entry.label)
            db.exec("DELETE FROM pages WHERE path=? AND page=? AND label=?", path, entry.page, entry.label)
            db.exec("INSERT INTO pages(path,page,label,source,confidence,problem,text) VALUES(?,?,?,?,?,?,?)", path, entry.page, entry.label, entry.source.id, entry.confidence, entry.problem.id, text)
            val id = db.query("SELECT last_insert_rowid()") { it.long(0) }.first()
            db.exec("INSERT INTO pages_fts(rowid,title,body) VALUES(?,?,?)", id, foldedTitle, foldPlain(text))
        }
        db.exec("UPDATE docs SET resume_page=? WHERE path=?", resumePage, path)
    }

    fun finish(path: String, status: DocStatus, problem: DocProblem, now: Long) = db.transaction {
        val counts = db.query("SELECT COUNT(*), SUM(CASE WHEN source IN ('ocr','desktop-ocr') THEN 1 ELSE 0 END), SUM(CASE WHEN problem!='' THEN 1 ELSE 0 END) FROM pages WHERE path=?", path) {
            Triple(it.long(0).toInt(), it.long(1).toInt(), it.long(2).toInt())
        }.first()
        db.exec("UPDATE docs SET status=?, problem=?, pages=?, ocr_pages=?, failed_pages=?, indexed_at=?, attempts=0, next_retry=0, resume_page=0 WHERE path=?",
            status.id, problem.id, counts.first, counts.second, counts.third, now, path)
    }

    /** Records a failed attempt with exponential backoff (1 min, 2, 4 … capped at 6 h). */
    fun fail(path: String, problem: DocProblem, now: Long, retryable: Boolean) = db.transaction {
        val attempts = (document(path)?.attempts ?: 0) + 1
        val wait = if (!retryable) Long.MAX_VALUE / 4 else minOf(6 * 60 * 60_000L, 60_000L shl minOf(attempts - 1, 12))
        db.exec("UPDATE docs SET status=?, problem=?, attempts=?, next_retry=?, indexed_at=? WHERE path=?",
            (if (retryable) DocStatus.Failed else DocStatus.Unsupported).id, problem.id, attempts, now + wait, now, path)
    }

    fun remove(path: String) = db.transaction {
        deletePages(path)
        db.exec("DELETE FROM docs WHERE path=?", path)
    }

    private fun deletePages(path: String) {
        db.exec("DELETE FROM pages_fts WHERE rowid IN (SELECT id FROM pages WHERE path=?)", path)
        db.exec("DELETE FROM pages WHERE path=?", path)
    }

    fun problemPages(path: String): Int = db.query("SELECT COUNT(*) FROM pages WHERE path=? AND problem!=''", path) { it.long(0).toInt() }.first()

    /** Pages with a problem, for the status screen: why a document is only partly searchable. */
    fun problems(limit: Int = 200): List<Pair<DocRecord, List<PageEntry>>> {
        val docs = documents().filter { it.status != DocStatus.Indexed }
        return docs.take(limit).map { doc ->
            doc to db.query("SELECT page,label,source,confidence,problem FROM pages WHERE path=? AND problem!='' ORDER BY page LIMIT 20", doc.path) { r ->
                PageEntry(r.long(0).toInt(), "", PageSource.of(r.string(2)), r.double(3), DocProblem.of(r.string(4)), r.string(1).orEmpty())
            }
        }
    }

    fun pageText(path: String, page: Int, label: String = ""): String? =
        db.query("SELECT text FROM pages WHERE path=? AND page=? AND label=?", path, page, label) { it.string(0) }.firstOrNull()

    fun stats(): DocIndexStats {
        val docs = documents()
        val pages = db.query("SELECT COUNT(*), SUM(CASE WHEN source IN ('ocr','desktop-ocr') THEN 1 ELSE 0 END) FROM pages") { it.long(0).toInt() to it.long(1).toInt() }.first()
        return DocIndexStats(docs.size, pages.first, pages.second, docs.count { it.status == DocStatus.Failed }, docs.count { it.status == DocStatus.Unsupported }, docs.count { it.status == DocStatus.Pending })
    }

    /**
     * Ranked page hits. At most [candidates] FTS rows are scored, so a common word in a huge
     * library stays bounded. Identical page text in several files (duplicates) shows once.
     */
    fun search(query: DocQuery, limit: Int = 50, candidates: Int = 400): List<DocHit> {
        if (query.isEmpty) return emptyList()
        val match = ftsMatch(query)
        if (match.isBlank()) return emptyList()
        val rows = db.query("""SELECT p.path, d.title, d.kind, p.page, p.label, p.source, p.confidence, p.text, f.body, f.title
            FROM pages_fts f JOIN pages p ON p.id = f.rowid JOIN docs d ON d.path = p.path
            WHERE pages_fts MATCH ? LIMIT ?""", match, candidates) { r ->
            Row(r.string(0)!!, r.string(1).orEmpty(), r.string(2).orEmpty(), r.long(3).toInt(), r.string(4).orEmpty(), PageSource.of(r.string(5)), r.double(6), r.string(7).orEmpty(), r.string(8).orEmpty(), r.string(9).orEmpty())
        }
        val documents = maxOf(1, db.query("SELECT COUNT(*) FROM pages") { it.long(0).toInt() }.first())
        val df = query.terms.associateWith { term -> rows.count { row -> row.body.split(' ').any { it.startsWith(term) } } }
        val scored = rows.map { row -> row to scorePage(row.body, row.foldedTitle, query.terms, row.source, row.confidence, documents, df) }
            .sortedWith(compareByDescending<Pair<Row, Double>> { it.second }.thenBy { it.first.title }.thenBy { it.first.page })
        val seen = LinkedHashMap<String, Pair<Row, Double>>()
        val dupes = HashMap<String, Int>()
        for ((row, score) in scored) {
            // Same text in another file is a duplicate; the same text twice in one file is not.
            var key = row.body.hashCode().toString() + ":" + row.body.length
            if (seen[key]?.first?.path == row.path) key += ":" + row.path + ":" + row.page + ":" + row.label
            if (key in seen) dupes[key] = (dupes[key] ?: 0) + 1 else seen[key] = row to score
        }
        return seen.entries.take(limit).map { (key, value) ->
            val (row, score) = value
            DocHit(row.path, row.title, row.kind, row.page, row.label, buildSnippet(row.text, query.terms), row.source, row.confidence, score, dupes[key] ?: 0)
        }
    }

    private class Row(val path: String, val title: String, val kind: String, val page: Int, val label: String, val source: PageSource, val confidence: Double, val text: String, val body: String, val foldedTitle: String)
}
