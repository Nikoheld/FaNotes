package ch.fasrv.fanotes.companion

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import ch.fasrv.fanotes.famd.companionPath
import ch.fasrv.fanotes.ink.InkDocument
import ch.fasrv.fanotes.ink.InkSession
import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.vault.OpenNote
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** Owns drafts and serialized writes across recomposition, rotation, and editor mode changes. */
class NoteEditorController(private val graph: CompanionGraph, private val scope: CoroutineScope, val path: String) {
    var note by mutableStateOf<OpenNote?>(null); private set
    var markdown by mutableStateOf(""); private set
    var document by mutableStateOf<InkDocument?>(null); private set
    var session: InkSession? = null; private set
    var loading by mutableStateOf(true); private set
    var error by mutableStateOf<String?>(null); private set
    var saving by mutableStateOf(false); private set
    var dirty by mutableStateOf(false); private set
    var canUndo by mutableStateOf(false); private set
    var canRedo by mutableStateOf(false); private set
    private var revision = 0L
    private var savedRevision = 0L
    private var debounce: Job? = null
    private val mutex = Mutex()
    private var protected = setOf(path, companionPath(path, ".famd"), companionPath(path, ".md"))

    init { load() }
    fun load() {
        graph.busyPaths += protected
        loading = true; error = null
        scope.launch {
            try {
                val loaded = withContext(Dispatchers.IO) {
                    check(graph.vault.exists(path)) { t(R.string.note_gone) }
                    graph.store.readNote(path)
                }
                note = loaded
                // Remove only the ink marker, preserving worksheet markers and surrounding prose.
                markdown = loaded.markdown.replace(Regex("<!--\\s*fanotes-ink:[a-zA-Z0-9_-]{1,96}\\s*-->"), "").trimEnd()
                session = InkSession(loaded.document)
                document = loaded.document
                protected = protected + ".fanotes/assets/${loaded.inkId}.json"
                graph.busyPaths += protected
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) { error = failure.message?.takeIf { it.isNotBlank() }?.let(::shownText) ?: t(R.string.could_not_open_note) }
            finally { loading = false }
        }
    }
    fun editText(value: String) { markdown = value; changed() }
    fun inkChanged() {
        document = session?.document
        canUndo = session?.canUndo == true; canRedo = session?.canRedo == true
        changed()
    }
    fun undo() { if (session?.undo() == true) inkChanged() }
    fun redo() { if (session?.redo() == true) inkChanged() }
    private fun changed() {
        revision++; dirty = true; error = null
        debounce?.cancel()
        debounce = scope.launch { delay(750); save() }
    }
    fun flush() { debounce?.cancel(); scope.launch { save() } }
    suspend fun save(): Boolean = mutex.withLock {
        val opened = note ?: return@withLock !loading
        if (savedRevision == revision) return@withLock true
        val target = revision
        val ink = document ?: return@withLock false
        val text = markdown
        // Only a real edit that removes the prose and the strokes may replace a note with a blank file.
        if (!noteBlank(opened.markdown, opened.document) && noteBlank(text, ink)) rememberCleared(opened)
        saving = true
        try {
            val saved = withContext(Dispatchers.IO) { graph.store.save(opened, ink, text).also { graph.engine.notifyLocalChange() } }
            note = saved
            savedRevision = target
            dirty = revision != target
            error = null
            true
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) { error = failure.message?.takeIf { it.isNotBlank() }?.let(::shownText) ?: t(R.string.could_not_save_draft); false }
        finally { saving = false }
    }
    private fun rememberCleared(opened: OpenNote) {
        val path = opened.path
        val lower = path.lowercase()
        when {
            lower.endsWith(".pdf") -> graph.engine.markCleared(companionPath(path, ".famd"))
            lower.endsWith(".famd") -> {
                graph.engine.markCleared(path)
                graph.engine.markCleared(companionPath(path, ".md"))
            }
            else -> {
                graph.engine.markCleared(path)
                graph.engine.markCleared(companionPath(path, ".famd"))
            }
        }
    }

    private fun noteBlank(text: String, document: InkDocument): Boolean {
        val prose = text.replace(Regex("<!--\\s*fanotes-ink:[a-zA-Z0-9_-]{1,96}\\s*-->"), "").trim()
        if (prose.isNotEmpty()) return false
        if (document.strokes.any { it.points.isNotEmpty() || it.figurePaths.isNotEmpty() }) return false
        val fields = document.extras.array("textFields")?.items.orEmpty()
        return fields.none { field ->
            val value = (field as? JsonValue.Obj)?.string("text")
            !value.isNullOrBlank()
        }
    }

    suspend fun close(): Boolean {
        debounce?.cancel()
        if (loading) return false
        // Repeat if input changed while the IO save was in flight.
        do { if (!save()) return false } while (dirty)
        graph.busyPaths -= protected
        return true
    }
}
