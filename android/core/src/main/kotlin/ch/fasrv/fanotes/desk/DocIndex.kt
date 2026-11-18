package ch.fasrv.fanotes.desk

import ch.fasrv.fanotes.famd.companionPath
import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.escapeJson
import ch.fasrv.fanotes.json.parseJson
import ch.fasrv.fanotes.vault.VaultEntry
import java.util.Locale

/*
 * Local document index for the vault search: Markdown notes, the invisible handwriting transcript and typed text
 * boxes of a note, and PDFs (device text layer, or the text the desktop synced as `fanotes-page-text-v1` / OCR).
 * The index lives in a file next to the app's private data, is built in the background and only for files whose
 * size or modification time changed, so a query never reads the vault. Pure logic: the app supplies the bytes.
 */

const val DOC_INDEX_NOTE = "note"
const val DOC_INDEX_DRAWING = "drawing"
const val DOC_INDEX_PDF = "pdf"

/** Text kept per entry and in total. A vault over the total keeps working; the status says the index is full. */
const val DOC_INDEX_ENTRY_CHARS = 300_000
const val DOC_INDEX_TOTAL_CHARS = 64_000_000L

/** PDF pages are joined with this character, so a hit can name its page. */
const val DOC_PAGE_BREAK = '\u000c'

class DocIndexEntry(
    val path: String,
    val kind: String,
    /** `size:mtime` of every file the text came from. A different value means: read again. */
    val signature: String,
    val title: String,
    val text: String,
) {
    val key: String get() = docIndexKey(path, kind)
    internal val lower: String by lazy { text.lowercase(Locale.GERMAN) }
}

fun docIndexKey(path: String, kind: String) = "$path\u0000$kind"

private fun isMarkdownPath(path: String) = path.endsWith(".md", true) || path.endsWith(".markdown", true)

private fun isIndexedPdf(path: String) = path.endsWith(".pdf", true) && !path.startsWith(".")

/** One thing to read: a note with its handwriting file, or a PDF with the desktop's text files. */
data class DocSource(
    val path: String,
    /** [DOC_INDEX_NOTE] for a Markdown note or a handwriting-only page, [DOC_INDEX_PDF] for a PDF. */
    val type: String,
    val signature: String,
    /** The `.famd` file of a note, when it exists. */
    val famdPath: String? = null,
    val sidecars: List<String> = emptyList(),
    val markdownPath: String? = null,
)

private fun stamp(entry: VaultEntry?) = if (entry == null) "-" else "${entry.size}:${entry.mtimeMs}"

/** Every file of the vault that the index covers, with the signature of the files its text comes from. */
fun docSources(files: List<VaultEntry>): List<DocSource> {
    val byPath = HashMap<String, VaultEntry>(files.size * 2)
    for (file in files) if (!file.directory) byPath[file.path] = file
    val sources = ArrayList<DocSource>()
    val coveredFamd = HashSet<String>()
    for ((path, file) in byPath) {
        if (isMarkdownPath(path) && !path.startsWith(".")) {
            val famd = companionPath(path, ".famd")
            coveredFamd += famd
            sources += DocSource(
                path = path,
                type = DOC_INDEX_NOTE,
                signature = "${stamp(file)}|${stamp(byPath[famd])}",
                famdPath = famd.takeIf { it in byPath },
                markdownPath = path,
            )
        } else if (isIndexedPdf(path)) {
            val sidecars = listOf(desktopPageTextSidecar(path), desktopPdfOcrSidecar(path))
            val famd = companionPath(path, ".famd")
            coveredFamd += famd
            sources += DocSource(
                path = path,
                type = DOC_INDEX_PDF,
                signature = (listOf(stamp(file)) + sidecars.map { stamp(byPath[it]) } + stamp(byPath[famd])).joinToString("|"),
                famdPath = famd.takeIf { it in byPath },
                sidecars = sidecars.filter { it in byPath },
            )
        }
    }
    for ((path, file) in byPath) {
        if (path.endsWith(".famd", true) && !path.startsWith(".") && path !in coveredFamd) {
            sources += DocSource(path = path, type = DOC_INDEX_NOTE, signature = stamp(file), famdPath = path)
        }
    }
    return sources.sortedBy { it.path }
}

class DocIndexPlan(val todo: List<DocSource>, val drop: List<String>, val total: Int)

/** Which sources need a read and which entries belong to files that are gone. */
fun planDocIndex(sources: List<DocSource>, known: Collection<DocIndexEntry>): DocIndexPlan {
    val signatures = HashMap<String, String>()
    val keysBySource = HashMap<String, MutableList<String>>()
    for (entry in known) {
        signatures[entry.path] = entry.signature
        keysBySource.getOrPut(entry.path) { mutableListOf() } += entry.key
    }
    val live = sources.map { it.path }.toHashSet()
    val todo = sources.filter { signatures[it.path] != it.signature }
    val drop = keysBySource.filterKeys { it !in live }.values.flatten()
    return DocIndexPlan(todo, drop, sources.size)
}

/** The invisible handwriting transcript and the typed text boxes of a `.famd` payload, one line each. */
fun famdSearchLines(payload: JsonValue.Obj?): String {
    if (payload == null) return ""
    val lines = ArrayList<String>()
    payload.obj("ink")?.string("searchTranscript")?.trim()?.takeIf { it.isNotEmpty() }?.let { lines += it }
    for (item in payload.array("textFields")?.items.orEmpty()) {
        val text = (item as? JsonValue.Obj)?.string("text")?.trim().orEmpty()
        if (text.isNotEmpty()) lines += text.replace('\n', ' ')
    }
    return lines.joinToString("\n")
}

private fun cap(text: String) = if (text.length > DOC_INDEX_ENTRY_CHARS) text.substring(0, DOC_INDEX_ENTRY_CHARS) else text

/** The entries of one note: its Markdown text and, separately, its handwriting and text boxes. */
fun noteIndexEntries(source: DocSource, markdown: String?, famdTranscript: String): List<DocIndexEntry> {
    val title = searchHitTitle(source.path)
    val out = ArrayList<DocIndexEntry>(2)
    if (markdown != null) {
        out += DocIndexEntry(source.path, DOC_INDEX_NOTE, source.signature, title, cap(markdown.replace("\r\n", "\n")))
    }
    if (famdTranscript.isNotBlank()) {
        out += DocIndexEntry(source.path, DOC_INDEX_DRAWING, source.signature, title, cap(famdTranscript))
    }
    return out
}

/** A PDF: one entry, pages in order, joined by [DOC_PAGE_BREAK]. A PDF without any text is indexed by its name only. */
fun pdfIndexEntry(source: DocSource, pages: List<String>): DocIndexEntry {
    val text = pages.joinToString(DOC_PAGE_BREAK.toString()) { it.replace(Regex("\\s+"), " ").trim() }
    return DocIndexEntry(source.path, DOC_INDEX_PDF, source.signature, searchHitTitle(source.path), cap(if (text.isBlank()) "" else text))
}

// ---- storage: an append-only journal, compacted when most of it is superseded ----

/** One JSON object per line. A line with `"x":1` deletes the entry. Later lines win. */
fun docIndexLine(entry: DocIndexEntry): String =
    "{\"p\":${escapeJson(entry.path)},\"k\":${escapeJson(entry.kind)},\"s\":${escapeJson(entry.signature)}," +
        "\"n\":${escapeJson(entry.title)},\"t\":${escapeJson(entry.text)}}"

fun docIndexDeleteLine(key: String): String {
    val (path, kind) = key.split('\u0000', limit = 2).let { it[0] to it.getOrElse(1) { "" } }
    return "{\"p\":${escapeJson(path)},\"k\":${escapeJson(kind)},\"x\":1}"
}

class DocIndexLoad(val entries: List<DocIndexEntry>, val lines: Int)

fun parseDocIndex(journal: String?): DocIndexLoad {
    if (journal.isNullOrEmpty()) return DocIndexLoad(emptyList(), 0)
    val map = LinkedHashMap<String, DocIndexEntry>()
    var lines = 0
    for (line in journal.lineSequence()) {
        if (line.isBlank()) continue
        lines += 1
        val obj = runCatching { parseJson(line) as? JsonValue.Obj }.getOrNull() ?: continue
        val path = obj.string("p") ?: continue
        val kind = obj.string("k") ?: continue
        val key = docIndexKey(path, kind)
        if (obj.double("x") != null) {
            map.remove(key)
            continue
        }
        map[key] = DocIndexEntry(path, kind, obj.string("s").orEmpty(), obj.string("n").orEmpty(), obj.string("t").orEmpty())
    }
    return DocIndexLoad(map.values.toList(), lines)
}

fun docIndexJournal(entries: Collection<DocIndexEntry>): String = entries.joinToString("\n", postfix = if (entries.isEmpty()) "" else "\n") { docIndexLine(it) }

/** More than this many journal lines per live entry (and at least this many lines) triggers a rewrite. */
fun docIndexNeedsCompaction(lines: Int, live: Int): Boolean = lines > 200 && lines > live * 2

// ---- search ----

private fun fastFind(lower: String, needle: String): Int {
    if (needle.indexOf('s') < 0 && needle.indexOf('ß') < 0) return lower.indexOf(needle)
    return findSharpS(lower, needle)?.first ?: -1
}

private fun fastCount(lower: String, needle: String): Int {
    if (needle.indexOf('s') < 0 && needle.indexOf('ß') < 0) {
        var count = 0
        var from = 0
        while (true) {
            val at = lower.indexOf(needle, from)
            if (at < 0) return count
            count += 1
            from = at + needle.length
        }
    }
    return countSharpS(lower, needle)
}

private fun excerpt(text: String, index: Int, length: Int): String =
    text.substring((index - 60).coerceAtLeast(0), (index + length + 120).coerceAtMost(text.length))
        .replace(Regex("[#*_`]"), "").replace('\n', ' ').replace(DOC_PAGE_BREAK, ' ').trim()

private fun transcriptLine(entry: DocIndexEntry, needle: String): Pair<Double?, String> {
    for (raw in entry.text.split('\n')) {
        val line = raw.trim()
        if (line.isEmpty()) continue
        val match = Regex("^(\\d+(?:\\.\\d+)?)\\t(.*)$").find(line)
        val text = match?.groupValues?.get(2)?.trim() ?: line
        if (fastFind(text.lowercase(Locale.GERMAN), needle) >= 0) {
            return match?.groupValues?.get(1)?.toDoubleOrNull()?.coerceIn(0.0, 1.0) to text
        }
    }
    return null to ""
}

/**
 * Hits for [query] over the index, notes first, then handwriting, then PDFs. Same shape as `searchVault` and
 * `searchTranscriptHits`, so the result list needs no change. A PDF hit names its page in the excerpt.
 */
fun searchDocIndex(entries: Collection<DocIndexEntry>, query: String, limit: Int = 250, cancelled: () -> Boolean = { false }): List<SearchHit> {
    val needle = query.trim().lowercase(Locale.GERMAN)
    if (needle.length < 2) return emptyList()
    val notes = ArrayList<SearchHit>()
    val drawings = ArrayList<SearchHit>()
    val pdfs = ArrayList<SearchHit>()
    for (entry in entries) {
        if (cancelled()) return emptyList()
        val pathMatch = fastFind(entry.path.lowercase(Locale.GERMAN), needle) >= 0
        when (entry.kind) {
            DOC_INDEX_NOTE -> {
                val at = fastFind(entry.lower, needle)
                if (at < 0 && !pathMatch) continue
                val text = entry.text
                val count = fastCount(entry.lower, needle) + if (pathMatch) 1 else 0
                val line = if (at < 0) 1 else text.take(at).count { it == '\n' } + 1
                val shown = if (at >= 0) excerpt(text, at, needle.length) else "Dateiname · ${entry.path}"
                notes += SearchHit(entry.path, line, shown.take(180), title = entry.title, matches = count.coerceAtLeast(1), kind = "note")
            }
            DOC_INDEX_DRAWING -> {
                if (fastFind(entry.lower, needle) < 0) continue
                val (anchor, text) = transcriptLine(entry, needle)
                drawings += SearchHit(
                    entry.path, 0, text.ifEmpty { query.trim() }.take(180), anchor ?: 0.15,
                    title = entry.title, matches = fastCount(entry.lower, needle).coerceAtLeast(1), kind = "drawing",
                )
            }
            DOC_INDEX_PDF -> {
                val at = fastFind(entry.lower, needle)
                if (at < 0 && !pathMatch) continue
                if (at < 0) {
                    pdfs += SearchHit(entry.path, 1, "PDF · ${entry.path}".take(180), title = entry.title, matches = 1, kind = "note")
                } else {
                    val page = entry.text.substring(0, at).count { it == DOC_PAGE_BREAK } + 1
                    pdfs += SearchHit(
                        entry.path, page, "S. $page · ${excerpt(entry.text, at, needle.length)}".take(180),
                        title = entry.title, matches = fastCount(entry.lower, needle).coerceAtLeast(1), kind = "note",
                    )
                }
            }
        }
    }
    val byPath = compareBy<SearchHit>({ -it.matches }, { it.path })
    return (notes.sortedWith(byPath) + drawings.sortedWith(byPath) + pdfs.sortedWith(byPath)).take(limit)
}

/** What the status chip next to the search field shows. */
data class DocIndexStatus(
    val total: Int = 0,
    val indexed: Int = 0,
    val running: Boolean = false,
    val full: Boolean = false,
    val error: String? = null,
) {
    val pending: Int get() = (total - indexed).coerceAtLeast(0)
}

fun docIndexStatusLabel(status: DocIndexStatus): String = when {
    status.error != null -> "Suchindex: ${status.error}"
    status.full -> "Suchindex voll · ${status.indexed} Dateien"
    status.running && status.total > 0 -> "Suchindex wird aufgebaut · ${status.indexed} von ${status.total}"
    status.running -> "Suchindex wird aufgebaut …"
    status.pending > 0 -> "Suchindex unvollständig · ${status.pending} offen"
    status.total == 0 -> "Suchindex leer"
    else -> "Suchindex aktuell · ${status.indexed} Dateien"
}
