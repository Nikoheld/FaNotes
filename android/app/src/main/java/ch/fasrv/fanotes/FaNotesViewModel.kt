package ch.fasrv.fanotes

import android.app.Application
import android.graphics.Bitmap
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.ParcelFileDescriptor
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import ch.fasrv.fanotes.desk.CalendarEvent
import ch.fasrv.fanotes.desk.HomeworkDocument
import ch.fasrv.fanotes.desk.HomeworkTask
import ch.fasrv.fanotes.desk.homeworkChannelIdValid
import ch.fasrv.fanotes.desk.homeworkPublishBody
import ch.fasrv.fanotes.desk.homeworkPublishUrl
import ch.fasrv.fanotes.desk.homeworkSecretReady
import ch.fasrv.fanotes.desk.newHomeworkChannelId
import ch.fasrv.fanotes.desk.newHomeworkSecret
import ch.fasrv.fanotes.desk.SearchHit
import ch.fasrv.fanotes.desk.SubjectBook
import ch.fasrv.fanotes.desk.applyReview
import ch.fasrv.fanotes.desk.cardsFromMarkdown
import ch.fasrv.fanotes.desk.dailyNotePath
import ch.fasrv.fanotes.desk.emptyCalendar
import ch.fasrv.fanotes.desk.parseCalendarMarkdown
import ch.fasrv.fanotes.desk.FOLDER_COLOR_CHOICES
import ch.fasrv.fanotes.desk.FOLDER_COLORS_PATH
import ch.fasrv.fanotes.desk.isMarkdownConflictPath
import ch.fasrv.fanotes.desk.TEMPLATES_FOLDER
import ch.fasrv.fanotes.desk.NOTE_TEMPLATES
import ch.fasrv.fanotes.desk.StudyPicture
import ch.fasrv.fanotes.desk.aggregateStudy
import ch.fasrv.fanotes.desk.openPageStats
import ch.fasrv.fanotes.desk.mergePageStats
import ch.fasrv.fanotes.desk.parseFolderColors
import ch.fasrv.fanotes.desk.parsePageStats
import ch.fasrv.fanotes.desk.profileFolders
import ch.fasrv.fanotes.desk.templatePath
import ch.fasrv.fanotes.desk.templatesToSeed
import ch.fasrv.fanotes.desk.resolveMarkdownConflict
import ch.fasrv.fanotes.desk.serializeFolderColors
import ch.fasrv.fanotes.desk.withFolderColor
import ch.fasrv.fanotes.desk.createNoteBackup
import ch.fasrv.fanotes.desk.noteBackupsJson
import ch.fasrv.fanotes.desk.parseHomeworkMarkdown
import ch.fasrv.fanotes.desk.parseNoteBackups
import ch.fasrv.fanotes.desk.restoreNoteBackup
import ch.fasrv.fanotes.desk.searchTranscriptHits
import ch.fasrv.fanotes.desk.SUBJECT_BOOKS_PATH
import ch.fasrv.fanotes.desk.WorksheetHighlight
import ch.fasrv.fanotes.desk.attachSubjectBook
import ch.fasrv.fanotes.desk.parseSubjectBooks
import ch.fasrv.fanotes.desk.parseWorksheetHighlights
import ch.fasrv.fanotes.desk.recordSubjectBookPage
import ch.fasrv.fanotes.desk.serializeSubjectBooks
import ch.fasrv.fanotes.desk.subjectBookForNote
import ch.fasrv.fanotes.desk.parseWorksheetBoxes
import ch.fasrv.fanotes.desk.searchVault
import ch.fasrv.fanotes.desk.serializeCalendarMarkdown
import ch.fasrv.fanotes.desk.serializeHomeworkMarkdown
import ch.fasrv.fanotes.desk.Backlink
import ch.fasrv.fanotes.desk.backlinksFor
import ch.fasrv.fanotes.desk.resolveWikiTarget
import ch.fasrv.fanotes.desk.chooseRestoredNote
import ch.fasrv.fanotes.desk.collectNotePaths
import ch.fasrv.fanotes.desk.replaceTranscriptWord
import ch.fasrv.fanotes.desk.addPdfMark
import ch.fasrv.fanotes.desk.readPdfMarks
import ch.fasrv.fanotes.desk.writePdfMarks
import ch.fasrv.fanotes.desk.formatNoteDiff
import ch.fasrv.fanotes.desk.applyNoteTags
import ch.fasrv.fanotes.desk.parseNoteTags
import ch.fasrv.fanotes.desk.applyHomeworkToCalendar
import ch.fasrv.fanotes.desk.exportIcs
import ch.fasrv.fanotes.desk.importIcs
import ch.fasrv.fanotes.desk.DeskTab
import ch.fasrv.fanotes.desk.NoteTrail
import ch.fasrv.fanotes.desk.SwitcherNote
import ch.fasrv.fanotes.desk.WorkspaceMemory
import ch.fasrv.fanotes.desk.forgetNoteHistory
import ch.fasrv.fanotes.desk.isSelfOrInside
import ch.fasrv.fanotes.desk.parseWorkspaceMemory
import ch.fasrv.fanotes.desk.pruneWorkspaceMemory
import ch.fasrv.fanotes.desk.rankSwitcherNotes
import ch.fasrv.fanotes.desk.rememberClosedTab
import ch.fasrv.fanotes.desk.remapNoteHistory
import ch.fasrv.fanotes.desk.remapPath
import ch.fasrv.fanotes.desk.sortPinnedFirst
import ch.fasrv.fanotes.desk.stepNoteHistory
import ch.fasrv.fanotes.desk.tabsToClose
import ch.fasrv.fanotes.desk.togglePinnedTab
import ch.fasrv.fanotes.desk.visitNote
import ch.fasrv.fanotes.desk.wikiTargets
import ch.fasrv.fanotes.desk.wordCount
import ch.fasrv.fanotes.desk.workspaceMemoryJson
import ch.fasrv.fanotes.famd.companionPath
import ch.fasrv.fanotes.famd.parseFamd
import ch.fasrv.fanotes.famd.stripFamdPayload
import ch.fasrv.fanotes.famd.isoNow
import ch.fasrv.fanotes.ink.InkSession
import ch.fasrv.fanotes.ink.InkTool
import ch.fasrv.fanotes.ink.PAGE_START_WIDTH
import ch.fasrv.fanotes.ink.StrokeStyle
import ch.fasrv.fanotes.ink.layoutPdfStack
import ch.fasrv.fanotes.ink.parseInkDocument
import ch.fasrv.fanotes.ink.newInkDocument
import ch.fasrv.fanotes.ink.pdfStackHeight
import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.deepCopy
import ch.fasrv.fanotes.json.jsonNumber
import ch.fasrv.fanotes.json.jsonObject
import ch.fasrv.fanotes.json.jsonString
import ch.fasrv.fanotes.json.parseJson
import ch.fasrv.fanotes.json.stringify
import ch.fasrv.fanotes.sync.SyncConflict
import ch.fasrv.fanotes.sync.SyncStatus
import ch.fasrv.fanotes.vault.HistorySnapshot
import ch.fasrv.fanotes.vault.NoteKind
import ch.fasrv.fanotes.vault.listNoteHistory
import ch.fasrv.fanotes.vault.readNoteHistory
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
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.MediaType.Companion.toMediaType
import java.io.File

data class BookPaneState(
    val bookPath: String,
    val subjectPath: String,
    val page: Int,
    val pageCount: Int,
    val bitmap: Bitmap?,
    val title: String,
)

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
            loadTree()
            if (tree.value.none { it.kind != NoteKind.FOLDER }) {
                val path = withContext(Dispatchers.IO) {
                    runCatching { graph.store.createMarkdown("", "Welcome") }.getOrNull()
                }
                if (path != null) {
                    val note = withContext(Dispatchers.IO) { graph.store.readNote(path) }
                    val welcome = "# Willkommen\n\nDer Stift schreibt. Ein Finger blättert, zwei Finger zoomen, und ein Wisch wechselt die Notiz.\n"
                    withContext(Dispatchers.IO) { graph.store.save(note, note.document, welcome) }
                    loadTree()
                }
            }
            if (!restoreWorkspace()) openRestoredNote()
            refreshTagIndex()
            graph.engine.start()
        }
    }

    fun refreshTree() {
        viewModelScope.launch { loadTree() }
    }

    private suspend fun loadTree() {
        val loaded = withContext(Dispatchers.IO) {
            graph.store.tree() to (graph.vault.read(FOLDER_COLORS_PATH)?.decodeToString()?.let(::parseFolderColors).orEmpty())
        }
        tree.value = loaded.first
        folderColors.value = loaded.second
    }

    private suspend fun refreshTagIndex() {
        val nodes = tree.value
        tagIndex.value = withContext(Dispatchers.IO) { indexTags(nodes) }
    }

    private fun indexTags(nodes: List<VaultNode>): Map<String, List<String>> {
        val index = linkedMapOf<String, List<String>>()
        fun walk(list: List<VaultNode>) {
            for (node in list) {
                if (node.kind == NoteKind.FOLDER) walk(node.children)
                else {
                    val tags = runCatching { parseNoteTags(graph.store.readNote(node.path).markdown) }.getOrDefault(emptyList())
                    if (tags.isNotEmpty()) index[node.path] = tags
                }
            }
        }
        walk(nodes)
        return index
    }

    private fun rememberTags(path: String, content: String) {
        val tags = parseNoteTags(content)
        tagIndex.value = if (tags.isEmpty()) tagIndex.value - path else tagIndex.value + (path to tags)
    }

    fun toggleTagFilter(tag: String) {
        val wanted = ch.fasrv.fanotes.desk.normalizeTag(tag)
        tagFilter.value = if (tagFilter.value == wanted || wanted.isEmpty()) null else wanted
    }

    private var openGeneration = 0

    fun openPath(path: String, force: Boolean = false, fromHistory: NoteTrail? = null) {
        val generation = ++openGeneration
        viewModelScope.launch {
            try {
                if (!force) saveNow()
                val note = withContext(Dispatchers.IO) { graph.store.readNote(path) }
                if (generation != openGeneration) return@launch
                session.replace(note.document)
                open.value = noteOpened(note)
                markdown.value = note.markdown
                rememberTags(path, note.markdown)
                refreshBacklinks(path)
                rememberTab(path)
                refreshOverlays()
                style.value = style.value.copy()
                showList.value = false
                loadBackdrop(note)
                refreshBook(note)
                if (fromHistory == null) noteTrail.value = visitNote(noteTrail.value, path)
                rememberLastOpen(path)
                persistWorkspace()
            } catch (error: Exception) {
                if (generation == openGeneration && fromHistory != null) noteTrail.value = fromHistory
                message.value = error.message ?: "Die Notiz konnte nicht geöffnet werden."
            }
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

    private fun withDwell(note: OpenNote): OpenNote {
        if (openedAtMs <= 0L) return note
        val now = System.currentTimeMillis()
        val elapsed = (now - openedAtMs).coerceAtLeast(0)
        openedAtMs = now
        val stats = parsePageStats(note.payload.obj("pageStats"), now)
        val weekday = java.time.Instant.ofEpochMilli(now).atZone(java.time.ZoneId.systemDefault()).dayOfWeek.value % 7
        val payload = (note.payload.deepCopy() as ch.fasrv.fanotes.json.JsonValue.Obj)
        payload.put("pageStats", mergePageStats(note.payload.obj("pageStats"), ch.fasrv.fanotes.desk.addDwell(stats, elapsed, weekday)))
        return note.copy(payload = payload)
    }

    private fun noteOpened(note: OpenNote): OpenNote {
        val now = System.currentTimeMillis()
        openedAtMs = now
        val stats = openPageStats(parsePageStats(note.payload.obj("pageStats"), now), now)
        val payload = (note.payload.deepCopy() as ch.fasrv.fanotes.json.JsonValue.Obj)
        payload.put("pageStats", mergePageStats(note.payload.obj("pageStats"), stats))
        return note.copy(payload = payload)
    }

    fun updateMarkdown(value: String) {
        markdown.value = value
        open.value?.path?.let { rememberTags(it, value) }
        noteChanged()
    }

    fun addPdfQuote(page: Int, quote: String, kind: String) {
        if (open.value?.kind != NoteKind.PDF) return
        updateMarkdown(writePdfMarks(markdown.value, addPdfMark(readPdfMarks(markdown.value), page, quote, kind)))
    }

    fun removePdfQuote(id: String) {
        if (open.value?.kind != NoteKind.PDF) return
        updateMarkdown(writePdfMarks(markdown.value, readPdfMarks(markdown.value).filter { it.id != id }))
    }

    fun correctTranscriptWord(from: String, to: String) {
        val replacement = to.trim()
        if (from.isBlank() || replacement.isEmpty() || from == replacement) return
        val document = session.document
        val transcript = document.extras.string("searchTranscript") ?: return
        val next = replaceTranscriptWord(transcript, from, replacement)
        if (next == transcript) return
        val extras = document.extras.deepCopy() as ch.fasrv.fanotes.json.JsonValue.Obj
        extras.put("searchTranscript", ch.fasrv.fanotes.json.jsonString(next))
        session.replace(document.copy(extras = extras, updatedAt = isoNow()))
        noteChanged()
    }

    fun setNoteTags(tags: List<String>) {
        if (open.value == null) return
        updateMarkdown(applyNoteTags(markdown.value, tags))
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
                val note = open.value?.let(::withDwell) ?: return
                val revision = editRevision
                val document = session.document
                val text = markdown.value
                val saved = withContext(Dispatchers.IO) {
                    val written = graph.store.save(note, document, text)
                    written to listNoteHistory(graph.vault, historyPathFor(written))
                }
                if (revision != editRevision) continue
                open.value = saved.first
                noteHistory.value = saved.second
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
            if (open.value?.path?.let { isSelfOrInside(it, path) } == true) saveNow()
            val next = try {
                withContext(Dispatchers.IO) { graph.store.rename(path, title) }
            } catch (error: Exception) {
                message.value = error.message ?: "Umbenennen ist fehlgeschlagen."
                return@launch
            }
            if (next != path) moveReferences(path, next)
            loadTree()
        }
    }

    fun delete(path: String) {
        viewModelScope.launch {
            noteTrail.value = forgetNoteHistory(noteTrail.value, path)
            openTabs.value = openTabs.value.filterNot { isSelfOrInside(it, path) }
            pinnedTabs.value = pinnedTabs.value.filterNot { isSelfOrInside(it, path) }.toSet()
            closedTabs.value = closedTabs.value.filterNot { isSelfOrInside(it, path) }
            tagIndex.value = tagIndex.value.filterKeys { !isSelfOrInside(it, path) }
            if (deskSettings.value["last-open"]?.let { isSelfOrInside(it, path) } == true) updateDesk("last-open", "")
            if (splitPath.value?.let { isSelfOrInside(it, path) } == true) splitPath.value = null
            if (open.value?.path?.let { isSelfOrInside(it, path) } == true) {
                open.value = null
                markdown.value = ""
                session.replace(newInkDocument("Note", "dots", isoNow()))
                openTabs.value.firstOrNull()?.let { openPath(it, force = true) }
            }
            withContext(Dispatchers.IO) { graph.store.delete(path) }
            loadTree()
            graph.engine.notifyLocalChange()
            persistWorkspace()
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
            loadTree()
            adoptWorkspace()
            refreshTagIndex()
        }
    }

    fun usePrivateVault() {
        graph.useDirectory(graph.defaultRoot)
        graph.rememberTree(null)
        _vaultLabel.value = "Auf diesem Tablet"
        viewModelScope.launch {
            graph.engine.switchVault()
            loadTree()
            adoptWorkspace()
            refreshTagIndex()
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

    fun duplicateSelection() {
        session.duplicateSelection(isoNow())
        noteChanged()
    }

    fun clearInk() {
        session.clearInk(isoNow())
        noteChanged()
    }

    fun insertSection(y: Double) {
        session.replace(ch.fasrv.fanotes.ink.insertSection(session.document, y))
        noteChanged()
    }

    fun toggleInkSection(id: String) {
        session.replace(ch.fasrv.fanotes.ink.toggleSection(session.document, id))
        noteChanged()
    }

    val noteLinks = MutableStateFlow<List<ch.fasrv.fanotes.desk.NoteLinkMark>>(emptyList())
    val worksheetBoxes = MutableStateFlow<List<ch.fasrv.fanotes.desk.WorksheetBox>>(emptyList())
    val worksheetHighlights = MutableStateFlow<List<WorksheetHighlight>>(emptyList())
    val bookPane = MutableStateFlow<BookPaneState?>(null)

    fun refreshOverlays() {
        val note = open.value
        viewModelScope.launch {
            val links = ch.fasrv.fanotes.desk.parseNoteLinkMarks(note?.payload)
            val overlay = withContext(Dispatchers.IO) {
                val worksheet = note?.worksheets?.firstOrNull() ?: return@withContext emptyList<ch.fasrv.fanotes.desk.WorksheetBox>() to emptyList()
                val raw = graph.vault.read(".fanotes/worksheets/$worksheet.json")?.decodeToString().orEmpty()
                parseWorksheetBoxes(raw) to parseWorksheetHighlights(raw)
            }
            noteLinks.value = links
            worksheetBoxes.value = overlay.first
            worksheetHighlights.value = overlay.second
        }
    }

    fun addWorksheetHighlight(mark: WorksheetHighlight) {
        val worksheet = open.value?.worksheets?.firstOrNull() ?: return
        viewModelScope.launch {
            withContext(Dispatchers.IO) { mutateHighlights(worksheet) { it + mark } }
            refreshOverlays()
            graph.engine.notifyLocalChange()
        }
    }

    fun removeWorksheetHighlight(id: String) {
        val worksheet = open.value?.worksheets?.firstOrNull() ?: return
        viewModelScope.launch {
            withContext(Dispatchers.IO) { mutateHighlights(worksheet) { marks -> marks.filter { it.id != id } } }
            refreshOverlays()
            graph.engine.notifyLocalChange()
        }
    }

    private fun mutateHighlights(worksheet: String, transform: (List<WorksheetHighlight>) -> List<WorksheetHighlight>) {
        val path = ".fanotes/worksheets/$worksheet.json"
        val raw = graph.vault.read(path)?.decodeToString() ?: return
        val root = parseJson(raw) as? ch.fasrv.fanotes.json.JsonValue.Obj ?: return
        val next = transform(parseWorksheetHighlights(raw))
        root.put("highlights", ch.fasrv.fanotes.json.JsonValue.Arr(next.map { mark ->
            ch.fasrv.fanotes.json.jsonObject(
                "id" to ch.fasrv.fanotes.json.jsonString(mark.id),
                "page" to ch.fasrv.fanotes.json.jsonNumber(mark.page.toDouble()),
                "x" to ch.fasrv.fanotes.json.jsonNumber(mark.x),
                "y" to ch.fasrv.fanotes.json.jsonNumber(mark.y),
                "width" to ch.fasrv.fanotes.json.jsonNumber(mark.width),
                "height" to ch.fasrv.fanotes.json.jsonNumber(mark.height),
                "color" to ch.fasrv.fanotes.json.jsonString(mark.color),
            )
        }.toMutableList()))
        root.put("updatedAt", ch.fasrv.fanotes.json.jsonString(isoNow()))
        graph.vault.write(path, root.stringify().encodeToByteArray())
    }

    fun attachSubjectBook(folder: String, pdf: String) {
        viewModelScope.launch {
            books.value = withContext(Dispatchers.IO) {
                val current = graph.vault.read(SUBJECT_BOOKS_PATH)?.decodeToString()?.let(::parseSubjectBooks).orEmpty()
                val next = attachSubjectBook(current, folder, pdf, 1)
                graph.vault.write(SUBJECT_BOOKS_PATH, serializeSubjectBooks(next).encodeToByteArray())
                next
            }
            graph.engine.notifyLocalChange()
            open.value?.let { refreshBook(it) }
        }
    }

    fun turnBook(delta: Int) {
        val current = bookPane.value ?: return
        val nextPage = (current.page + delta).coerceIn(1, current.pageCount)
        if (nextPage == current.page) return
        viewModelScope.launch {
            val next = withContext(Dispatchers.IO) {
                val stored = graph.vault.read(SUBJECT_BOOKS_PATH)?.decodeToString()?.let(::parseSubjectBooks).orEmpty()
                val updated = recordSubjectBookPage(stored, current.subjectPath, nextPage)
                graph.vault.write(SUBJECT_BOOKS_PATH, serializeSubjectBooks(updated).encodeToByteArray())
                books.value = updated
                renderBookPage(updated.first { it.subjectPath == current.subjectPath })
            }
            val old = bookPane.value?.bitmap
            bookPane.value = next
            if (old != null && old !== next?.bitmap) old.recycle()
            graph.engine.notifyLocalChange()
        }
    }

    private fun refreshBook(note: OpenNote) {
        viewModelScope.launch {
            val next = withContext(Dispatchers.IO) {
                val stored = graph.vault.read(SUBJECT_BOOKS_PATH)?.decodeToString()?.let(::parseSubjectBooks).orEmpty()
                books.value = stored
                val record = subjectBookForNote(stored, note.path) ?: return@withContext null
                renderBookPage(record)
            }
            val old = bookPane.value?.bitmap
            bookPane.value = next
            if (old != null && old !== next?.bitmap) old.recycle()
        }
    }

    private fun renderBookPage(record: SubjectBook): BookPaneState? {
        val bytes = graph.vault.read(record.bookPath) ?: return null
        val file = java.io.File.createTempFile("fanotes-book", ".pdf")
        return try {
            file.writeBytes(bytes)
            android.os.ParcelFileDescriptor.open(file, android.os.ParcelFileDescriptor.MODE_READ_ONLY).use { descriptor ->
                android.graphics.pdf.PdfRenderer(descriptor).use { renderer ->
                    if (renderer.pageCount == 0) return null
                    val index = (record.lastPage - 1).coerceIn(0, renderer.pageCount - 1)
                    val page = renderer.openPage(index)
                    val width = 900
                    val height = (width * page.height.toFloat() / page.width.toFloat()).toInt().coerceAtLeast(1)
                    val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
                    page.render(bitmap, null, null, android.graphics.pdf.PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                    page.close()
                    BookPaneState(record.bookPath, record.subjectPath, index + 1, renderer.pageCount, bitmap, record.bookPath.substringAfterLast('/'))
                }
            }
        } finally {
            file.delete()
        }
    }

    fun placeNoteLink(page: Int, x: Double, y: Double, style: String) {
        val source = open.value ?: return
        viewModelScope.launch {
            try {
                val created = withContext(Dispatchers.IO) {
                    graph.store.createMarkdown(ch.fasrv.fanotes.desk.linkedNoteParent(source.path), ch.fasrv.fanotes.desk.linkedNotePreferredName(source.path))
                }
                val link = ch.fasrv.fanotes.desk.placeNewNoteLink(
                    sourcePath = source.path,
                    targetPath = created,
                    page = page,
                    x = x,
                    y = y,
                    style = style,
                )
                val links = ch.fasrv.fanotes.desk.parseNoteLinkMarks(source.payload) + link
                val payload = (source.payload.deepCopy() as ch.fasrv.fanotes.json.JsonValue.Obj)
                payload.put("noteLinks", ch.fasrv.fanotes.desk.noteLinksJson(links))
                open.value = source.copy(payload = payload)
                noteLinks.value = links
                noteChanged()
                refreshTree()
                message.value = "Verlinkung gesetzt."
            } catch (error: IllegalArgumentException) {
                message.value = error.message
            }
        }
    }

    fun removePlacedNoteLink(id: String) {
        val source = open.value ?: return
        val links = try {
            ch.fasrv.fanotes.desk.removeNoteLink(noteLinks.value, id)
        } catch (error: IllegalArgumentException) {
            message.value = error.message
            return
        }
        val payload = (source.payload.deepCopy() as ch.fasrv.fanotes.json.JsonValue.Obj)
        payload.put("noteLinks", ch.fasrv.fanotes.desk.noteLinksJson(links))
        open.value = source.copy(payload = payload)
        noteLinks.value = links
        noteChanged()
    }

    fun updateWorksheetBox(id: String, text: String) {
        val worksheet = open.value?.worksheets?.firstOrNull() ?: return
        viewModelScope.launch {
            withContext(Dispatchers.IO) {
                val raw = graph.vault.read(".fanotes/worksheets/$worksheet.json")?.decodeToString() ?: return@withContext
                val root = parseJson(raw) as? ch.fasrv.fanotes.json.JsonValue.Obj ?: return@withContext
                val boxes = root.array("textBoxes") ?: ch.fasrv.fanotes.json.JsonValue.Arr()
                val existing = boxes.items.indexOfFirst { (it as? ch.fasrv.fanotes.json.JsonValue.Obj)?.string("id") == id }
                if (existing >= 0) {
                    (boxes.items[existing] as ch.fasrv.fanotes.json.JsonValue.Obj).put("text", ch.fasrv.fanotes.json.jsonString(text))
                } else {
                    boxes.items += ch.fasrv.fanotes.json.jsonObject(
                        "id" to ch.fasrv.fanotes.json.jsonString(id),
                        "page" to ch.fasrv.fanotes.json.jsonNumber(1.0),
                        "x" to ch.fasrv.fanotes.json.jsonNumber(0.12),
                        "y" to ch.fasrv.fanotes.json.jsonNumber(0.12),
                        "width" to ch.fasrv.fanotes.json.jsonNumber(0.5),
                        "text" to ch.fasrv.fanotes.json.jsonString(text),
                        "fontSize" to ch.fasrv.fanotes.json.jsonNumber(18.0),
                    )
                }
                root.put("textBoxes", boxes)
                root.put("updatedAt", ch.fasrv.fanotes.json.jsonString(isoNow()))
                graph.vault.write(".fanotes/worksheets/$worksheet.json", root.stringify().encodeToByteArray())
            }
            refreshOverlays()
            graph.engine.notifyLocalChange()
        }
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

    val destination = MutableStateFlow("notes")
    val openTabs = MutableStateFlow<List<String>>(emptyList())
    val pinnedTabs = MutableStateFlow<Set<String>>(emptySet())
    val noteTrail = MutableStateFlow(NoteTrail())
    val closedTabs = MutableStateFlow<List<String>>(emptyList())
    val searchQuery = MutableStateFlow("")
    val searchHits = MutableStateFlow<List<SearchHit>>(emptyList())
    val homework = MutableStateFlow(HomeworkDocument(emptyList()))
    val calendar = MutableStateFlow(emptyCalendar())
    val books = MutableStateFlow<List<SubjectBook>>(emptyList())
    val folderColors = MutableStateFlow<Map<String, String>>(emptyMap())
    val tagIndex = MutableStateFlow<Map<String, List<String>>>(emptyMap())
    val tagFilter = MutableStateFlow<String?>(null)
    val backlinks = MutableStateFlow<List<Backlink>>(emptyList())
    val noteHistory = MutableStateFlow<List<HistorySnapshot>>(emptyList())
    val historyComparison = MutableStateFlow<Pair<String, String>?>(null)
    val study = MutableStateFlow<StudyPicture?>(null)
    val deskSettings = MutableStateFlow(graph.readDesk())
    val splitPath = MutableStateFlow<String?>(null)
    val splitSession = InkSession(newInkDocument("Spalte", "dots", isoNow()))
    private var splitNote: OpenNote? = null
    private var openedAtMs = 0L
    private var reveal: Pair<String, Double>? = null
    val aiReply = MutableStateFlow("")
    val paletteOpen = MutableStateFlow(false)
    val updateLabel = MutableStateFlow("2026.10.7")

    fun showDestination(id: String) {
        destination.value = id
        when (id) {
            "tasks" -> loadHomework()
            "calendar" -> loadCalendar()
            "overview", "books" -> loadVaultMeta()
            "history" -> refreshNoteHistory()
            "study" -> loadStudy()
        }
    }

    fun rememberTab(path: String) {
        if (path in openTabs.value) return
        var next = openTabs.value + path
        while (next.size > 12) {
            val drop = next.firstOrNull { it !in pinnedTabs.value } ?: next.first()
            next = next.filterNot { it == drop }
            if (drop in pinnedTabs.value) pinnedTabs.value = pinnedTabs.value - drop
        }
        openTabs.value = sortPinnedFirst(next.map { DeskTab(it, it in pinnedTabs.value) }).map { it.path }
    }

    /** Point the trail at the target before opening, so the visit records nothing new. */
    fun navigateHistory(direction: Int) {
        if (direction != -1 && direction != 1) return
        val known = (flatNotes().map { it.path } + openTabs.value).toSet()
        val before = noteTrail.value
        val step = stepNoteHistory(before, direction) { it in known }
        val path = step.path ?: return
        if (path == open.value?.path) return
        noteTrail.value = step.history
        openPath(path, fromHistory = before)
        destination.value = "notes"
    }

    fun closeTab(path: String) {
        closedTabs.value = rememberClosedTab(closedTabs.value, path)
        val current = openTabs.value
        val index = current.indexOf(path)
        val remaining = current.filterNot { it == path }
        openTabs.value = remaining
        pinnedTabs.value = pinnedTabs.value - path
        if (splitPath.value == path) splitPath.value = null
        if (open.value?.path == path) {
            val next = if (remaining.isEmpty()) null else remaining[index.coerceIn(0, remaining.lastIndex)]
            if (next != null) openPath(next)
            else {
                open.value = null
                markdown.value = ""
                session.replace(newInkDocument("Note", "dots", isoNow()))
            }
        }
        persistWorkspace()
    }

    fun closeTabs(scope: String) {
        val anchor = open.value?.path ?: return
        val tabs = openTabs.value.map { DeskTab(it, it in pinnedTabs.value) }
        tabsToClose(tabs, anchor, scope).forEach { closeTab(it) }
    }

    fun reopenClosedTab() {
        val existing = flatNotes().map { it.path }.toSet()
        val stack = closedTabs.value.toMutableList()
        while (stack.isNotEmpty()) {
            val path = stack.removeAt(0)
            if (path in existing && path !in openTabs.value) {
                closedTabs.value = stack
                destination.value = "notes"
                openPath(path)
                return
            }
        }
        closedTabs.value = stack
        message.value = "Kein kürzlich geschlossener Tab."
    }

    fun togglePinTab(path: String? = open.value?.path) {
        if (path == null || path !in openTabs.value) return
        val next = togglePinnedTab(openTabs.value.map { DeskTab(it, it in pinnedTabs.value) }, path)
        openTabs.value = next.map { it.path }
        pinnedTabs.value = next.filter { it.pinned }.map { it.path }.toSet()
        persistWorkspace()
    }

    fun cycleTabs(direction: Int) {
        val tabs = openTabs.value
        if (tabs.size < 2) return
        val index = tabs.indexOf(open.value?.path).coerceAtLeast(0)
        val next = (index + direction + tabs.size) % tabs.size
        openPath(tabs[next])
        destination.value = "notes"
    }

    fun toggleSplitOrientation() {
        val next = if (deskSettings.value["split-orientation"] == "rows") "columns" else "rows"
        updateDesk("split-orientation", next)
    }

    fun rankNotes(query: String, limit: Int = 8): List<SwitcherNote> {
        val recent = noteTrail.value.entries.asReversed()
        return rankSwitcherNotes(flatNotes().map { it.path }, query, recent, limit)
    }

    private fun moveReferences(from: String, to: String) {
        noteTrail.value = remapNoteHistory(noteTrail.value, from, to)
        val pinned = pinnedTabs.value.map { remapPath(it, from, to) ?: it }.toSet()
        val tabs = openTabs.value.map { remapPath(it, from, to) ?: it }
        pinnedTabs.value = pinned
        openTabs.value = sortPinnedFirst(tabs.map { DeskTab(it, it in pinned) }).map { it.path }
        closedTabs.value = closedTabs.value.map { remapPath(it, from, to) ?: it }
        tagIndex.value = tagIndex.value.mapKeys { (path, _) -> remapPath(path, from, to) ?: path }
        deskSettings.value["last-open"]?.let { saved -> remapPath(saved, from, to)?.let { updateDesk("last-open", it) } }
        val current = open.value?.path
        if (current != null) {
            val moved = remapPath(current, from, to)
            if (moved != null) openPath(moved, force = true)
        }
        splitPath.value?.let { split ->
            remapPath(split, from, to)?.let { moved -> if (moved != split) loadSplit(moved) }
        }
        persistWorkspace()
    }

    private fun restoreWorkspace(): Boolean {
        val memory = graph.readWorkspace(graph.vaultId)?.let(::parseWorkspaceMemory) ?: return false
        val exists = flatNotes().map { it.path }.toSet()
        val pruned = pruneWorkspaceMemory(memory, exists::contains)
        if (pruned.tabs.isEmpty()) return false
        pinnedTabs.value = pruned.pinned.toSet()
        openTabs.value = sortPinnedFirst(pruned.tabs.map { DeskTab(it, it in pinnedTabs.value) }).map { it.path }
        noteTrail.value = NoteTrail()
        closedTabs.value = emptyList()
        val active = pruned.active ?: pruned.tabs.first()
        if (pruned.split != null) splitPath.value = pruned.split
        openPath(active, force = true)
        pruned.split?.let { loadSplit(it) }
        return true
    }

    private fun adoptWorkspace() {
        noteTrail.value = NoteTrail()
        closedTabs.value = emptyList()
        open.value = null
        splitPath.value = null
        if (!restoreWorkspace()) {
            openTabs.value = emptyList()
            pinnedTabs.value = emptySet()
            splitPath.value = null
            openRestoredNote()
        }
    }

    private fun openRestoredNote() {
        val paths = collectNotePaths(tree.value)
        val chosen = chooseRestoredNote(deskSettings.value["last-open"], paths, paths.firstOrNull())
        if (chosen != null) openPath(chosen, force = true)
    }

    private fun rememberLastOpen(path: String) {
        if (path.isEmpty() || deskSettings.value["last-open"] == path) return
        updateDesk("last-open", path)
    }

    private fun persistWorkspace() {
        val tabs = openTabs.value
        val active = open.value?.path?.takeIf { it in tabs }
        val memory = WorkspaceMemory(
            tabs = tabs,
            pinned = tabs.filter { it in pinnedTabs.value },
            active = active,
            split = splitPath.value?.takeIf { it in tabs && it != active },
        )
        graph.writeWorkspace(graph.vaultId, workspaceMemoryJson(memory))
    }

    fun openSearchHit(hit: SearchHit) {
        reveal = hit.anchorY?.let { hit.path to it }
        openPath(hit.path)
        destination.value = "notes"
    }

    fun takeReveal(path: String): Double? {
        val pending = reveal ?: return null
        if (pending.first != path) return null
        reveal = null
        return pending.second
    }

    fun snapshotNote() {
        val note = open.value ?: return
        val list = createNoteBackup(parseNoteBackups(note.payload.array("noteBackups")), note.path, stripFamdPayload(markdown.value))
        val payload = (note.payload.deepCopy() as ch.fasrv.fanotes.json.JsonValue.Obj)
        payload.put("noteBackups", noteBackupsJson(list))
        open.value = note.copy(payload = payload)
        noteChanged()
        message.value = "Sicherung angelegt."
    }

    fun restoreNoteBackup(id: String) {
        val note = open.value ?: return
        val content = restoreNoteBackup(parseNoteBackups(note.payload.array("noteBackups")), id, note.path) ?: return
        updateMarkdown(content)
        message.value = "Sicherung wiederhergestellt."
        destination.value = "notes"
    }

    fun searchVaultText(query: String) {
        searchQuery.value = query
        viewModelScope.launch {
            searchHits.value = withContext(Dispatchers.IO) {
                val files = graph.vault.walkFiles().filter { it.path.endsWith(".md") || it.path.endsWith(".markdown") }
                val texts = files.map { it.path to (graph.vault.read(it.path)?.decodeToString().orEmpty()) }
                val transcripts = texts.mapNotNull { (path, _) ->
                    val famdPath = if (path.endsWith(".famd")) path else companionPath(path, ".famd")
                    val ink = ch.fasrv.fanotes.famd.parseFamd(graph.vault.read(famdPath)?.decodeToString().orEmpty()).payload?.obj("ink")
                    val transcript = ink?.string("searchTranscript") ?: return@mapNotNull null
                    path to transcript
                }
                (searchVault(texts, query) + searchTranscriptHits(transcripts, query)).take(200)
            }
        }
    }

    fun loadHomework() {
        viewModelScope.launch {
            homework.value = withContext(Dispatchers.IO) {
                parseHomeworkMarkdown(graph.vault.read(ch.fasrv.fanotes.desk.HOMEWORK_NOTE_PATH)?.decodeToString().orEmpty())
            }
        }
    }

    fun addHomework(title: String, subject: String, due: String, kind: String) {
        val now = isoNow()
        val task = HomeworkTask(java.util.UUID.randomUUID().toString(), title.trim(), subject = subject.trim(), dueDate = due.ifBlank { null }, kind = kind, createdAt = now, updatedAt = now)
        val next = homework.value.copy(tasks = listOf(task) + homework.value.tasks)
        homework.value = next
        persistSpecial(ch.fasrv.fanotes.desk.HOMEWORK_NOTE_PATH, "Hausaufgaben", serializeHomeworkMarkdown(next))
        publishHomeworkCalendar(next)
    }

    fun toggleHomework(id: String) {
        val next = homework.value.copy(tasks = homework.value.tasks.map { if (it.id == id) it.copy(done = !it.done, updatedAt = isoNow()) else it })
        homework.value = next
        persistSpecial(ch.fasrv.fanotes.desk.HOMEWORK_NOTE_PATH, "Hausaufgaben", serializeHomeworkMarkdown(next))
        publishHomeworkCalendar(next)
    }

    fun loadCalendar() {
        viewModelScope.launch {
            val loaded = withContext(Dispatchers.IO) { calendarWithHomework() }
            calendar.value = loaded.second
            if (loaded.first != loaded.second) {
                persistSpecial(ch.fasrv.fanotes.desk.CALENDAR_NOTE_PATH, "Kalender", serializeCalendarMarkdown(loaded.second))
            }
        }
    }

    fun importCalendarIcs(text: String) {
        viewModelScope.launch {
            val current = withContext(Dispatchers.IO) { calendarWithHomework().second }
            val calendarId = current.calendars.firstOrNull()?.id
            if (calendarId.isNullOrBlank()) {
                message.value = "Kein Kalender vorhanden."
                return@launch
            }
            val imported = importIcs(text, calendarId)
            if (imported.isEmpty()) {
                message.value = "Keine Termine in der ICS-Datei."
                return@launch
            }
            val next = current.copy(events = (current.events + imported).take(2_000))
            calendar.value = next
            persistSpecial(ch.fasrv.fanotes.desk.CALENDAR_NOTE_PATH, "Kalender", serializeCalendarMarkdown(next))
            message.value = if (imported.size == 1) "1 Termin importiert." else "${imported.size} Termine importiert."
        }
    }

    fun calendarIcs(): String = exportIcs(calendar.value)

    private suspend fun calendarWithHomework(): Pair<ch.fasrv.fanotes.desk.CalendarDocument, ch.fasrv.fanotes.desk.CalendarDocument> {
        val current = parseCalendarMarkdown(graph.vault.read(ch.fasrv.fanotes.desk.CALENDAR_NOTE_PATH)?.decodeToString().orEmpty())
        val tasks = parseHomeworkMarkdown(graph.vault.read(ch.fasrv.fanotes.desk.HOMEWORK_NOTE_PATH)?.decodeToString().orEmpty())
        return current to applyHomeworkToCalendar(current, tasks)
    }

    private fun publishHomeworkCalendar(tasks: HomeworkDocument) {
        viewModelScope.launch {
            val next = withContext(Dispatchers.IO) {
                applyHomeworkToCalendar(
                    parseCalendarMarkdown(graph.vault.read(ch.fasrv.fanotes.desk.CALENDAR_NOTE_PATH)?.decodeToString().orEmpty()),
                    tasks,
                )
            }
            calendar.value = next
            persistSpecial(ch.fasrv.fanotes.desk.CALENDAR_NOTE_PATH, "Kalender", serializeCalendarMarkdown(next))
        }
    }

    fun insertMath(expression: String) {
        val block = expression.trim()
        if (block.isEmpty()) return
        updateMarkdown(markdown.value.trimEnd() + "\n\n$$\n$block\n$$\n")
    }

    fun generateHomeworkAccess() {
        val channel = newHomeworkChannelId()
        val secret = newHomeworkSecret()
        val next = deskSettings.value + mapOf("homework-channel" to channel, "homework-secret" to secret, "homework-previous" to "")
        deskSettings.value = next
        graph.writeDesk(next)
    }

    fun publishHomework() {
        val channel = deskSettings.value["homework-channel"].orEmpty().trim()
        val secret = deskSettings.value["homework-secret"].orEmpty().trim()
        val previous = deskSettings.value["homework-previous"].orEmpty().trim()
        if (!homeworkChannelIdValid(channel)) {
            message.value = "Die Kanal-ID muss 32 Hex-Zeichen sein."
            return
        }
        if (!homeworkSecretReady(secret)) {
            message.value = "Das Geheimnis braucht mindestens 12 Zeichen."
            return
        }
        val tasks = homework.value.tasks
        val authorization = previous.ifBlank { secret }
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching {
                    val body = homeworkPublishBody(true, secret, previous.ifBlank { null }, tasks)
                    val request = okhttp3.Request.Builder()
                        .url(homeworkPublishUrl(channel))
                        .header("Accept", "application/json")
                        .header("Content-Type", "application/json")
                        .header("X-FaNotes-Homework", "1")
                        .header("Authorization", "Bearer $authorization")
                        .put(body.toByteArray().toRequestBody("application/json".toMediaType()))
                        .build()
                    okhttp3.OkHttpClient().newCall(request).execute().use { response ->
                        if (response.isSuccessful) "Hausaufgaben veröffentlicht." else "Veröffentlichen fehlgeschlagen (${response.code})."
                    }
                }.getOrElse { "Veröffentlichen fehlgeschlagen." }
            }
            message.value = result
            if (result == "Hausaufgaben veröffentlicht.") updateDesk("homework-previous", "")
        }
    }

    fun addCalendarEvent(title: String, day: String, calendarId: String, recurrence: String = "none", time: String = "") {
        val clock = time.trim().takeIf { Regex("""\d{2}:\d{2}""").matches(it) }
        val start = if (clock == null) day else "${day}T$clock"
        val end = if (clock == null) {
            day
        } else {
            val hour = clock.take(2).toInt().coerceIn(0, 23)
            val minute = clock.drop(3)
            val nextHour = (hour + 1).coerceAtMost(23).toString().padStart(2, '0')
            "${day}T$nextHour:$minute"
        }
        val event = CalendarEvent(
            java.util.UUID.randomUUID().toString(),
            calendarId,
            title.trim(),
            start,
            end,
            allDay = clock == null,
            recurrence = if (recurrence in setOf("daily", "weekly", "monthly", "yearly")) recurrence else "none",
        )
        saveCalendar(calendar.value.copy(events = calendar.value.events + event))
    }

    fun deleteCalendarEvent(eventId: String) {
        saveCalendar(ch.fasrv.fanotes.desk.deleteCalendarEvent(calendar.value, eventId))
    }

    fun duplicateCalendarEvent(eventId: String) {
        saveCalendar(ch.fasrv.fanotes.desk.duplicateCalendarEvent(calendar.value, eventId))
    }

    fun shiftCalendarEvent(eventId: String, days: Long) {
        saveCalendar(ch.fasrv.fanotes.desk.shiftCalendarEvent(calendar.value, eventId, days))
    }

    fun skipCalendarOccurrence(eventId: String, day: String) {
        val date = runCatching { java.time.LocalDate.parse(day) }.getOrNull() ?: return
        saveCalendar(ch.fasrv.fanotes.desk.skipCalendarOccurrence(calendar.value, eventId, date))
    }

    fun createCalendarList(name: String) {
        saveCalendar(ch.fasrv.fanotes.desk.createCalendarList(calendar.value, name))
    }

    fun toggleCalendarVisible(id: String) {
        saveCalendar(ch.fasrv.fanotes.desk.toggleCalendarVisible(calendar.value, id))
    }

    fun renameCalendarList(id: String, name: String) {
        saveCalendar(ch.fasrv.fanotes.desk.renameCalendarList(calendar.value, id, name))
    }

    fun deleteCalendarList(id: String) {
        saveCalendar(ch.fasrv.fanotes.desk.deleteCalendarList(calendar.value, id))
    }

    fun saveCalendarOccurrence(key: String?, event: CalendarEvent) {
        saveCalendar(ch.fasrv.fanotes.desk.saveCalendarOccurrence(calendar.value, key, event))
    }

    private fun saveCalendar(next: ch.fasrv.fanotes.desk.CalendarDocument) {
        calendar.value = next
        persistSpecial(ch.fasrv.fanotes.desk.CALENDAR_NOTE_PATH, "Kalender", serializeCalendarMarkdown(next))
    }

    fun loadSplit(path: String) {
        viewModelScope.launch {
            val note = withContext(Dispatchers.IO) { graph.store.readNote(path) }
            splitSession.replace(note.document)
            splitNote = note
            rememberTab(path)
            splitPath.value = path
            persistWorkspace()
        }
    }

    fun splitChanged() {
        val note = splitNote ?: return
        viewModelScope.launch {
            splitNote = withContext(Dispatchers.IO) { graph.store.save(note, splitSession.document, note.markdown) }
            graph.engine.notifyLocalChange()
        }
    }

    fun openDaily() {
        val folder = deskSettings.value["daily-folder"].orEmpty().ifBlank { "Daily Notes" }
        val path = dailyNotePath(folder)
        viewModelScope.launch {
            val exists = withContext(Dispatchers.IO) { graph.vault.exists(path) }
            if (!exists) {
                val created = withContext(Dispatchers.IO) { graph.store.createMarkdown(folder, path.substringAfterLast('/').removeSuffix(".md")) }
                val note = withContext(Dispatchers.IO) { graph.store.readNote(created) }
                withContext(Dispatchers.IO) { graph.store.save(note, note.document, "# ${path.substringAfterLast('/').removeSuffix(".md")}\n") }
            }
            refreshTree()
            openPath(path, force = true)
            destination.value = "notes"
        }
    }

    fun reviewFlashcard(cardId: String, grade: String) {
        val today = java.time.LocalDate.now().toString()
        val next = applyReview(markdown.value, cardId, grade, today)
        updateMarkdown(next)
    }

    fun cardsToday() = cardsFromMarkdown(markdown.value, java.time.LocalDate.now().toString())

    fun loadVaultMeta() {
        viewModelScope.launch {
            val loaded = withContext(Dispatchers.IO) {
                val books = graph.vault.read(".fanotes/subject-books.json")?.decodeToString()?.let(::parseSubjectBooks).orEmpty()
                val colors = graph.vault.read(FOLDER_COLORS_PATH)?.decodeToString()?.let(::parseFolderColors).orEmpty()
                books to colors
            }
            books.value = loaded.first
            folderColors.value = loaded.second
        }
    }

    fun loadStudy() {
        viewModelScope.launch {
            study.value = withContext(Dispatchers.IO) {
                val notes = graph.vault.walkFiles()
                    .filter { it.path.endsWith(".md") || it.path.endsWith(".markdown") }
                    .take(240)
                    .map { entry ->
                        val famdPath = companionPath(entry.path, ".famd")
                        val stats = parsePageStats(
                            ch.fasrv.fanotes.famd.parseFamd(graph.vault.read(famdPath)?.decodeToString().orEmpty()).payload?.obj("pageStats"),
                        )
                        entry.path to stats
                    }
                aggregateStudy(notes)
            }
        }
    }

    fun createFromTemplate(id: String) {
        val template = NOTE_TEMPLATES.find { it.id == id } ?: return
        val folder = open.value?.path?.substringBeforeLast('/', "").orEmpty()
        viewModelScope.launch {
            val path = withContext(Dispatchers.IO) {
                runCatching {
                    val created = graph.store.createMarkdown(folder, template.fileName)
                    val note = graph.store.readNote(created)
                    graph.store.save(note, note.document, template.markdown)
                    created
                }.getOrNull()
            }
            if (path == null) {
                message.value = "Die Vorlage existiert in diesem Ordner schon."
            } else {
                refreshTree()
                openPath(path, force = true)
                destination.value = "notes"
            }
        }
    }

    fun refreshNoteHistory() {
        val note = open.value
        historyComparison.value = null
        if (note == null) {
            noteHistory.value = emptyList()
            return
        }
        viewModelScope.launch {
            noteHistory.value = withContext(Dispatchers.IO) { listNoteHistory(graph.vault, historyPathFor(note)) }
        }
    }

    fun compareHistory(snapshotId: String) {
        val note = open.value ?: return
        val current = markdown.value
        viewModelScope.launch {
            val text = withContext(Dispatchers.IO) {
                runCatching { formatNoteDiff(readNoteHistory(graph.vault, historyPathFor(note), snapshotId).content, current) }
                    .getOrElse { error ->
                        message.value = error.message ?: "Der Vergleich ist fehlgeschlagen."
                        return@withContext null
                    }
            } ?: return@launch
            historyComparison.value = snapshotId to text
        }
    }

    fun restoreHistory(snapshotId: String) {
        val note = open.value ?: return
        viewModelScope.launch {
            val file = withContext(Dispatchers.IO) { readNoteHistory(graph.vault, historyPathFor(note), snapshotId) }
            val payload = runCatching { parseFamd(file.content) }.getOrNull()?.payload
            val ink = payload?.obj("ink")
            if (payload != null && ink != null) {
                session.replace(parseInkDocument(ink, note.title, payload.string("paperStyle") ?: note.document.paperStyle, isoNow()))
                canvasToken.value += 1
            }
            updateMarkdown(stripFamdPayload(file.content))
            message.value = "Ältere Version wiederhergestellt. Speichern sichert sie."
            destination.value = "notes"
        }
    }

    fun cycleFolderColor(path: String) {
        viewModelScope.launch {
            val updated = withContext(Dispatchers.IO) {
                val current = folderColors.value
                val index = FOLDER_COLOR_CHOICES.indexOf(current[path])
                val color = if (index < 0) FOLDER_COLOR_CHOICES.first() else FOLDER_COLOR_CHOICES.getOrNull(index + 1)
                val next = withFolderColor(current, path, color)
                graph.vault.write(FOLDER_COLORS_PATH, serializeFolderColors(next).encodeToByteArray())
                next
            }
            folderColors.value = updated
            graph.engine.notifyLocalChange()
        }
    }

    fun resolveConflict(conflict: SyncConflict, choice: String) {
        viewModelScope.launch {
            val messageText = withContext(Dispatchers.IO) {
                runCatching {
                    val remote = graph.vault.read(conflict.path)?.decodeToString()
                    val local = graph.vault.read(conflict.copyPath)?.decodeToString()
                    when (choice) {
                        "remote" -> graph.vault.delete(conflict.copyPath)
                        "local" -> {
                            if (local != null) graph.vault.write(conflict.path, local.encodeToByteArray())
                            graph.vault.delete(conflict.copyPath)
                        }
                        "both" -> {
                            if (remote != null && local != null && isMarkdownConflictPath(conflict.path)) {
                                graph.vault.write(conflict.path, resolveMarkdownConflict(remote, local, "both").encodeToByteArray())
                                graph.vault.delete(conflict.copyPath)
                            }
                        }
                    }
                    "Konflikt gelöst."
                }.getOrElse { "Der Konflikt konnte nicht gelöst werden." }
            }
            if (messageText == "Konflikt gelöst.") {
                graph.engine.dismissConflict(conflict.copyPath)
                graph.engine.notifyLocalChange()
                refreshTree()
                if (open.value?.path == conflict.path) openPath(conflict.path, force = true)
            }
            message.value = messageText
        }
    }

    private fun historyPathFor(note: OpenNote): String =
        if (note.kind == NoteKind.PDF) companionPath(note.path, ".famd") else note.path

    fun openWikiTarget(target: String) {
        val path = resolveWikiTarget(target, flatNotes().map { it.path }, open.value?.path)
        if (path == null) {
            message.value = "Keine Notiz für [[${target.trim()}]]."
            return
        }
        openPath(path)
        destination.value = "notes"
    }

    private fun refreshBacklinks(path: String) {
        viewModelScope.launch {
            val notes = withContext(Dispatchers.IO) {
                flatNotes().map { node ->
                    node.path to runCatching { graph.store.readNote(node.path).markdown }.getOrDefault("")
                }
            }
            if (open.value?.path != path) return@launch
            backlinks.value = backlinksFor(path, notes)
        }
    }

    fun wordCountNow() = wordCount(markdown.value)
    fun linksNow() = wikiTargets(markdown.value)

    fun applyProfile(profile: String) {
        viewModelScope.launch {
            withContext(Dispatchers.IO) {
                val existing = graph.vault.walkFiles().map { it.path }
                val templates = templatesToSeed(existing, profile)
                var colors = graph.vault.read(FOLDER_COLORS_PATH)?.decodeToString()?.let(::parseFolderColors).orEmpty()
                for (folder in profileFolders(profile)) {
                    runCatching { graph.store.createFolder("", folder.name) }
                    colors = withFolderColor(colors, folder.name, folder.color)
                }
                graph.vault.write(FOLDER_COLORS_PATH, serializeFolderColors(colors).encodeToByteArray())
                if (templates.isNotEmpty()) {
                    runCatching { graph.store.createFolder("", TEMPLATES_FOLDER) }
                    for (template in templates) {
                        val path = runCatching { graph.store.createMarkdown(TEMPLATES_FOLDER, template.fileName) }.getOrNull()
                            ?: templatePath(template)
                        if (!graph.vault.exists(path)) continue
                        val note = graph.store.readNote(path)
                        graph.store.save(note, note.document, template.markdown)
                    }
                }
            }
            updateDesk("profile", profile)
            updateDesk("welcomed", "yes")
            refreshTree()
            message.value = "Profil eingerichtet."
        }
    }

    fun syncDeviceName(): String = graph.deviceName()

    fun setSyncDeviceName(name: String) {
        graph.setDeviceName(name)
    }

    fun syncAutomatic(): Boolean = graph.automatic()

    fun setSyncAutomatic(enabled: Boolean) {
        graph.setAutomatic(enabled)
    }

    fun toggleLocalFolder(path: String) {
        updateDesk("sync-excluded", ch.fasrv.fanotes.sync.toggleSyncPrefix(deskSettings.value["sync-excluded"].orEmpty(), path))
    }

    fun updateDesk(key: String, value: String) {
        val next = deskSettings.value + (key to value)
        deskSettings.value = next
        graph.writeDesk(next)
    }

    fun askAi(prompt: String) {
        val settings = deskSettings.value
        val base = settings["ai-url"].orEmpty().ifBlank { "https://api.openai.com/v1" }.trimEnd('/')
        val key = settings["ai-key"].orEmpty()
        val modelName = settings["ai-model"].orEmpty().ifBlank { "gpt-4o-mini" }
        if (key.isBlank()) {
            aiReply.value = "Kein API-Schlüssel. Trag ihn unter Einstellungen ein. Der Schlüssel bleibt auf diesem Tablet."
            return
        }
        viewModelScope.launch {
            aiReply.value = withContext(Dispatchers.IO) {
                runCatching {
                    val body = """{"model":${ch.fasrv.fanotes.json.escapeJson(modelName)},"messages":[{"role":"user","content":${ch.fasrv.fanotes.json.escapeJson(prompt.take(12000))}}]}"""
                    val request = okhttp3.Request.Builder()
                        .url("$base/chat/completions")
                        .header("Authorization", "Bearer $key")
                        .post(body.toByteArray().toRequestBody("application/json".toMediaType()))
                        .build()
                    okhttp3.OkHttpClient().newCall(request).execute().use { response ->
                        val text = response.body?.string().orEmpty()
                        if (!response.isSuccessful) "Der Anbieter antwortete mit ${response.code}."
                        else Regex(""""content"\s*:\s*"((?:\\.|[^"])*)"""").find(text)?.groupValues?.get(1)
                            ?.replace("\\n", "\n")?.replace("\\\"", "\"")
                            ?: text.take(2000)
                    }
                }.getOrElse { it.message ?: "Die Anfrage ist fehlgeschlagen." }
            }
        }
    }

    fun checkUpdate() {
        viewModelScope.launch {
            updateLabel.value = withContext(Dispatchers.IO) {
                runCatching {
                    val request = okhttp3.Request.Builder().url("https://api.github.com/repos/Nikoheld/FaNotes/releases/latest").header("Accept", "application/vnd.github+json").build()
                    okhttp3.OkHttpClient().newCall(request).execute().use { response ->
                        val tag = Regex(""""tag_name"\s*:\s*"([^"]+)"""").find(response.body?.string().orEmpty())?.groupValues?.get(1)
                        if (tag.isNullOrBlank()) "2026.10.7" else if (tag == "v2026.10.7") "2026.10.7 ist aktuell" else "Neu: $tag"
                    }
                }.getOrDefault("2026.10.7")
            }
        }
    }

    private fun persistSpecial(path: String, title: String, text: String) {
        viewModelScope.launch {
            withContext(Dispatchers.IO) {
                if (!graph.vault.exists(path)) graph.store.createMarkdown("", title)
                val note = graph.store.readNote(path)
                graph.store.save(note, note.document, text)
            }
            graph.engine.notifyLocalChange()
            refreshTree()
        }
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
