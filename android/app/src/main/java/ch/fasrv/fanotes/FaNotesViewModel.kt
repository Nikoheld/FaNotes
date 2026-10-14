package ch.fasrv.fanotes

import android.app.Application
import android.graphics.Bitmap
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.ParcelFileDescriptor
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import ch.fasrv.fanotes.famd.companionPath
import ch.fasrv.fanotes.famd.isoNow
import ch.fasrv.fanotes.ink.InkSession
import ch.fasrv.fanotes.ink.InkTool
import ch.fasrv.fanotes.ink.PAGE_START_WIDTH
import ch.fasrv.fanotes.ink.StrokeStyle
import ch.fasrv.fanotes.ink.layoutPdfStack
import ch.fasrv.fanotes.ink.newInkDocument
import ch.fasrv.fanotes.ink.pdfStackHeight
import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.parseJson
import ch.fasrv.fanotes.sync.SyncStatus
import ch.fasrv.fanotes.vault.NoteKind
import ch.fasrv.fanotes.vault.OpenNote
import ch.fasrv.fanotes.vault.VaultNode
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.File

class FaNotesViewModel(app: Application) : AndroidViewModel(app) {
    private val graph = (app as FaNotesApplication).graph
    val session = InkSession(newInkDocument("Note", "dots", isoNow()))
    val tree = MutableStateFlow<List<VaultNode>>(emptyList())
    val open = MutableStateFlow<OpenNote?>(null)
    val markdown = MutableStateFlow("")
    val tool = MutableStateFlow(InkTool.PEN)
    val style = MutableStateFlow(StrokeStyle())
    val fingerDraws = MutableStateFlow(false)
    val showText = MutableStateFlow(false)
    val showList = MutableStateFlow(true)
    val message = MutableStateFlow<String?>(null)
    val backdrop = MutableStateFlow<List<BackdropSlice>>(emptyList())
    val sync = graph.engine.state.stateIn(viewModelScope, SharingStarted.Eagerly, graph.engine.state.value)
    private val _vaultLabel = MutableStateFlow(graph.initialVaultLabel)
    val vaultLabel = _vaultLabel.asStateFlow()
    val canvasToken = MutableStateFlow(0)
    private var saveJob: Job? = null
    private var editRevision = 0
    private var dirty = false
    private val saveMutex = Mutex()

    init {
        synchronized(graph.remoteListeners) {
            graph.remoteListeners += { written, _ ->
                viewModelScope.launch {
                    refreshTree()
                    val current = open.value ?: return@launch
                    val famd = if (current.path.endsWith(".famd")) current.path else companionPath(current.path, ".famd")
                    if (!dirty && (current.path in written || famd in written)) openPath(current.path, force = true)
                }
            }
        }
        viewModelScope.launch {
            refreshTree()
            if (tree.value.isEmpty()) {
                val path = withContext(Dispatchers.IO) {
                    graph.store.createMarkdown("", "Welcome")
                }
                val note = withContext(Dispatchers.IO) { graph.store.readNote(path) }
                val welcome = "# Willkommen\n\nDer Stift schreibt. Ein Finger blättert, zwei Finger zoomen, und ein Wisch wechselt die Notiz.\n"
                withContext(Dispatchers.IO) { graph.store.save(note, note.document, welcome) }
                refreshTree()
            }
            tree.value.firstOrNull { it.kind != NoteKind.FOLDER }?.let { openPath(it.path, force = true) }
            graph.engine.start()
        }
    }

    fun refreshTree() {
        viewModelScope.launch {
            tree.value = withContext(Dispatchers.IO) { graph.store.tree() }
        }
    }

    fun openPath(path: String, force: Boolean = false) {
        viewModelScope.launch {
            if (!force) saveNow()
            val note = withContext(Dispatchers.IO) { graph.store.readNote(path) }
            session.replace(note.document)
            open.value = note
            markdown.value = note.markdown
            style.value = style.value.copy()
            showList.value = false
            loadBackdrop(note)
        }
    }

    fun noteChanged() {
        dirty = true
        editRevision += 1
        canvasToken.value += 1
        publishBusy()
        saveJob?.cancel()
        saveJob = viewModelScope.launch {
            kotlinx.coroutines.delay(750)
            saveNow()
        }
    }

    fun updateMarkdown(value: String) {
        markdown.value = value
        noteChanged()
    }

    fun setPaper(styleId: String) {
        session.setPaperStyle(styleId, isoNow())
        noteChanged()
    }

    /**
     * Writes the latest snapshot. A stroke that lands while the file is being
     * written is saved again before this returns, so an older snapshot cannot
     * replace a newer one.
     */
    suspend fun saveNow() {
        saveMutex.withLock {
            if (!dirty) return
            while (true) {
                val note = open.value ?: return
                val revision = editRevision
                val document = session.document
                val text = markdown.value
                val saved = withContext(Dispatchers.IO) { graph.store.save(note, document, text) }
                if (revision != editRevision) continue
                open.value = saved
                dirty = false
                graph.busyPaths = emptySet()
                graph.engine.notifyLocalChange()
                refreshTree()
                return
            }
        }
    }

    fun createNote(title: String) {
        viewModelScope.launch {
            val path = withContext(Dispatchers.IO) { graph.store.createMarkdown("", title) }
            refreshTree()
            openPath(path, force = true)
        }
    }

    fun createFolder(title: String) {
        viewModelScope.launch {
            withContext(Dispatchers.IO) { graph.store.createFolder("", title) }
            refreshTree()
        }
    }

    fun rename(path: String, title: String) {
        viewModelScope.launch {
            withContext(Dispatchers.IO) { graph.store.rename(path, title) }
            refreshTree()
        }
    }

    fun delete(path: String) {
        viewModelScope.launch {
            if (open.value?.path == path) {
                open.value = null
                session.replace(newInkDocument("Note", "dots", isoNow()))
            }
            withContext(Dispatchers.IO) { graph.store.delete(path) }
            refreshTree()
            graph.engine.notifyLocalChange()
        }
    }

    fun importBytes(name: String, bytes: ByteArray, pdf: Boolean) {
        viewModelScope.launch {
            val path = withContext(Dispatchers.IO) {
                if (pdf) graph.store.importPdf("", name, bytes)
                else graph.store.importImageWorksheet("", name, bytes, if (name.endsWith(".png", true)) "image/png" else "image/jpeg")
            }
            refreshTree()
            openPath(path, force = true)
            graph.engine.notifyLocalChange()
        }
    }

    fun readUri(uri: Uri): ByteArray? = getApplication<Application>().contentResolver.openInputStream(uri)?.use { it.readBytes() }

    fun useTree(uri: Uri) {
        val app = getApplication<Application>()
        graph.useSaf(SafVault(app, uri), uri.toString())
        graph.rememberTree(uri.toString())
        _vaultLabel.value = "Ausgewählter Ordner"
        viewModelScope.launch {
            graph.engine.switchVault()
            refreshTree()
        }
    }

    fun usePrivateVault() {
        graph.useDirectory(graph.defaultRoot)
        graph.rememberTree(null)
        _vaultLabel.value = "Auf diesem Tablet"
        viewModelScope.launch {
            graph.engine.switchVault()
            refreshTree()
        }
    }

    fun login(email: String, password: String, register: Boolean) {
        viewModelScope.launch {
            try {
                if (register) graph.engine.register(email, password) else graph.engine.login(email, password)
                message.value = null
            } catch (error: Exception) {
                message.value = error.message ?: "Sign-in failed"
            }
        }
    }

    fun logout() {
        viewModelScope.launch { graph.engine.logout() }
    }

    fun syncNow() {
        viewModelScope.launch { graph.engine.syncNow() }
    }

    fun undo() {
        if (session.undo()) noteChanged()
    }

    fun redo() {
        if (session.redo()) noteChanged()
    }

    fun deleteSelection() {
        session.deleteSelection(isoNow())
        noteChanged()
    }

    fun flatNotes(): List<VaultNode> {
        val found = mutableListOf<VaultNode>()
        fun visit(nodes: List<VaultNode>) {
            for (node in nodes) {
                if (node.kind == NoteKind.FOLDER) visit(node.children) else found += node
            }
        }
        visit(tree.value)
        return found
    }

    fun swipe(direction: Int) {
        val notes = flatNotes()
        val index = notes.indexOfFirst { it.path == open.value?.path }
        val next = notes.getOrNull(index + direction) ?: return
        openPath(next.path)
    }

    private fun publishBusy() {
        val note = open.value ?: return
        val famd = if (note.path.endsWith(".famd")) note.path else companionPath(note.path, ".famd")
        val asset = ".fanotes/assets/${note.inkId}.json"
        graph.busyPaths = setOf(note.path, famd, asset)
    }

    private suspend fun loadBackdrop(note: OpenNote) {
        backdrop.value.forEach { it.bitmap?.recycle() }
        backdrop.value = emptyList()
        val slices = withContext(Dispatchers.Default) {
            when (note.kind) {
                NoteKind.PDF -> renderPdf(note)
                else -> renderWorksheet(note)
            }
        }
        backdrop.value = slices
        if (note.kind == NoteKind.PDF && session.document.strokes.isEmpty()) {
            val height = slices.lastOrNull()?.let { it.topPagePx + it.heightPagePx } ?: return
            if (height > 64) {
                session.replace(
                    session.document.copy(sourceWidth = PAGE_START_WIDTH, sourceHeight = height.toDouble(), paperStyle = "blank"),
                )
            }
        }
    }

    private fun renderPdf(note: OpenNote): List<BackdropSlice> {
        val bytes = graph.vault.read(note.path) ?: return emptyList()
        val file = File.createTempFile("fanotes-pdf", ".pdf")
        return try {
        file.writeBytes(bytes)
        ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY).use { descriptor ->
            PdfRenderer(descriptor).use { renderer ->
                val aspects = (0 until renderer.pageCount.coerceAtMost(40)).map { index ->
                    renderer.openPage(index).use { page -> page.height.toDouble() / page.width.toDouble() }
                }
                val boxes = layoutPdfStack(PAGE_START_WIDTH, aspects)
                val stack = pdfStackHeight(boxes)
                val scaleY = if (note.document.strokes.isEmpty() || stack <= 0) 1.0 else note.document.sourceHeight / stack
                return boxes.map { box ->
                    val page = renderer.openPage(box.index)
                    val width = 1200
                    val height = (width * (page.height.toFloat() / page.width)).toInt().coerceAtLeast(1)
                    val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
                    page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                    page.close()
                    BackdropSlice(
                        topPagePx = (box.top * scaleY).toFloat(),
                        heightPagePx = (box.height * scaleY).toFloat(),
                        widthPagePx = PAGE_START_WIDTH.toFloat(),
                        bitmap = bitmap,
                    )
                }
            }
        }
        } finally {
            file.delete()
        }
    }

    private fun renderWorksheet(note: OpenNote): List<BackdropSlice> {
        val id = note.worksheets.firstOrNull() ?: return emptyList()
        val record = graph.vault.read(".fanotes/worksheets/$id.json")?.decodeToString() ?: return emptyList()
        val json = parseJson(record) as? JsonValue.Obj ?: return emptyList()
        val source = json.string("sourceRelativePath") ?: return emptyList()
        val bytes = graph.vault.read(source) ?: return emptyList()
        val bitmap = android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return emptyList()
        return listOf(
            BackdropSlice(0f, note.document.sourceHeight.toFloat(), note.document.sourceWidth.toFloat(), bitmap),
        )
    }

    fun syncLabel(): String = when (sync.value.status) {
        SyncStatus.SYNCING -> "Synchronisiert…"
        SyncStatus.IDLE -> "Synchron"
        SyncStatus.OFFLINE -> "Offline"
        SyncStatus.ERROR -> "Sync-Fehler"
        SyncStatus.SIGNED_OUT -> "Anmelden"
        else -> "Sync"
    }
}
