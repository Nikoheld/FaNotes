package ch.fasrv.fanotes

import android.app.Application
import android.graphics.Bitmap
import android.graphics.BitmapFactory
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
import ch.fasrv.fanotes.desk.homeworkTasksFromApiJson
import ch.fasrv.fanotes.desk.mergeHomeworkFromRemote
import ch.fasrv.fanotes.desk.rememberPublishedHomeworkIds
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
import ch.fasrv.fanotes.desk.detachSubjectBook
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
import ch.fasrv.fanotes.desk.NOTE_DOWNLOAD_MISSING
import ch.fasrv.fanotes.desk.NOTE_DOWNLOAD_REFUSED
import ch.fasrv.fanotes.desk.NOTE_DOWNLOAD_SAVED
import ch.fasrv.fanotes.desk.PDF_EXPORT_FAILED
import ch.fasrv.fanotes.desk.PDF_EXPORT_NEEDS_NOTE
import ch.fasrv.fanotes.desk.PDF_EXPORT_SAVED
import ch.fasrv.fanotes.desk.markdownWithFolds
import ch.fasrv.fanotes.desk.remapFolderColors
import ch.fasrv.fanotes.desk.remapPath
import ch.fasrv.fanotes.desk.sortPinnedFirst
import ch.fasrv.fanotes.desk.stepNoteHistory
import ch.fasrv.fanotes.desk.tabsToClose
import ch.fasrv.fanotes.desk.togglePinnedTab
import ch.fasrv.fanotes.desk.canDropEntry
import ch.fasrv.fanotes.desk.expandedFoldersJson
import ch.fasrv.fanotes.desk.moveTab
import ch.fasrv.fanotes.desk.parseExpandedFolders
import ch.fasrv.fanotes.desk.remapExpandedFolders
import ch.fasrv.fanotes.desk.revealExpandedFolders
import ch.fasrv.fanotes.desk.toggleExpandedFolder
import ch.fasrv.fanotes.desk.parentFolderOf
import ch.fasrv.fanotes.desk.splitPanePath
import ch.fasrv.fanotes.desk.swappedSplit
import ch.fasrv.fanotes.desk.visitNote
import ch.fasrv.fanotes.desk.wikiTargets
import ch.fasrv.fanotes.desk.workspaceMemoryJson
import ch.fasrv.fanotes.famd.companionPath
import ch.fasrv.fanotes.famd.parseFamd
import ch.fasrv.fanotes.famd.stripFamdPayload
import ch.fasrv.fanotes.famd.isoNow
import ch.fasrv.fanotes.ink.InkSession
import ch.fasrv.fanotes.ink.keepMarkOnPage
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
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
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
    val needsPassword: Boolean = false,
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
    val outlineJump = MutableStateFlow<Int?>(null)
    val gotoLineInput = MutableStateFlow<String?>(null)
    val foldedHeadings = MutableStateFlow<Set<Int>>(emptySet())
    val confirmRequest = MutableStateFlow<ch.fasrv.fanotes.desk.PendingConfirm?>(null)
    private var confirmAction: (() -> Unit)? = null
    private val bugLog = ch.fasrv.fanotes.desk.BugReportLog()
    val bugReportOpen = MutableStateFlow(false)
    val bugReportMessage = MutableStateFlow<String?>(null)
    private var paperViews: Map<String, ch.fasrv.fanotes.desk.PaperViewMemoryEntry> =
        ch.fasrv.fanotes.desk.parsePaperViewMemory(graph.readPaperViews())
    val showList = MutableStateFlow(true)
    val sidebarOpen = MutableStateFlow(true)
    val inspectorOpen = MutableStateFlow(false)
    val message = MutableStateFlow<String?>(null)
    val backdrop = MutableStateFlow<List<BackdropSlice>>(emptyList())
    val paperImages = MutableStateFlow<Map<String, Bitmap>>(emptyMap())
    private var paperImageTicket = 0
    val sync = graph.engine.state.stateIn(viewModelScope, SharingStarted.Eagerly, graph.engine.state.value)
    private val _vaultLabel = MutableStateFlow(graph.initialVaultLabel)
    val vaultLabel = _vaultLabel.asStateFlow()
    val canvasToken = MutableStateFlow(0)
    private var saveJob: Job? = null
    private var editRevision = 0
    private var dirty = false
    private val saveMutex = Mutex()

    init {
        val pen = ch.fasrv.fanotes.desk.penSettings(graph.readDesk())
        style.value = style.value.copy(
            baseWidth = pen.width,
            pressureEnabled = pen.pressure,
            color = pen.color,
            colorEffect = ch.fasrv.fanotes.ink.normalizeInkEffect(graph.readDesk()["ink-effect"]),
        )
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
        viewModelScope.launch {
            combine(open, markdown) { note, text -> note?.path.orEmpty() to text }
                .distinctUntilChanged()
                .collect { reloadPaperImages() }
        }
    }

    private fun reloadPaperImages() {
        val ticket = ++paperImageTicket
        val path = open.value?.path.orEmpty()
        val text = markdown.value
        viewModelScope.launch {
            val next = withContext(Dispatchers.IO) {
                ch.fasrv.fanotes.text.paperLines(text)
                    .filter { it.kind == ch.fasrv.fanotes.text.PaperKind.IMAGE }
                    .map { ch.fasrv.fanotes.text.paperImageSource(it.text) }
                    .distinct()
                    .mapNotNull { source ->
                        val bytes = ch.fasrv.fanotes.text.resolvePaperImagePaths(path, source)
                            .firstNotNullOfOrNull { candidate -> runCatching { graph.vault.read(candidate) }.getOrNull() }
                        val bitmap = bytes?.let { decodePaperImage(it) } ?: return@mapNotNull null
                        source to bitmap
                    }
                    .toMap()
            }
            if (ticket != paperImageTicket) {
                next.values.forEach { if (!it.isRecycled) it.recycle() }
                return@launch
            }
            val previous = paperImages.value
            paperImages.value = next
            previous.values.forEach { bitmap ->
                if (bitmap !in next.values && !bitmap.isRecycled) bitmap.recycle()
            }
        }
    }

    private fun decodePaperImage(bytes: ByteArray): Bitmap? {
        if (bytes.isEmpty() || bytes.size > 32 * 1024 * 1024) return null
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        var sample = 1
        while (bounds.outWidth / sample > 1600 || bounds.outHeight / sample > 1600) sample *= 2
        val options = BitmapFactory.Options().apply { inSampleSize = sample }
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
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

    fun openPath(path: String, force: Boolean = false, fromHistory: NoteTrail? = null, headingAnchor: String? = null) {
        val generation = ++openGeneration
        viewModelScope.launch {
            try {
                if (swappedSplit(open.value?.path, splitPath.value)?.first == path) {
                    swapSplitNow()
                    jumpToHeading(markdown.value, headingAnchor)
                    return@launch
                }
                if (!force) saveNow()
                val note = withContext(Dispatchers.IO) { graph.store.readNote(path) }
                if (generation != openGeneration) return@launch
                session.replace(note.document)
                open.value = noteOpened(note)
                markdown.value = note.markdown
                foldedHeadings.value = foldsForSections(note.markdown, note.document)
                jumpToHeading(note.markdown, headingAnchor)
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
                revealFolders(path)
                dirty = false
                unsaved.value = false
                savePhase.value = "saved"
                persistWorkspace()
                recordBug("note", path)
            } catch (error: Exception) {
                if (generation == openGeneration && fromHistory != null) noteTrail.value = fromHistory
                message.value = error.message ?: "Die Notiz konnte nicht geöffnet werden."
            }
        }
    }

    fun pageGrew(prevWidth: Double, prevHeight: Double, nextWidth: Double, nextHeight: Double, padX: Double, padY: Double) {
        if (prevWidth == nextWidth && prevHeight == nextHeight && padX == 0.0 && padY == 0.0) return
        if (backdrop.value.isEmpty()) {
            val source = open.value
            val links = noteLinks.value
            if (source != null && links.isNotEmpty()) {
                val moved = links.map { link ->
                    link.copy(
                        x = keepMarkOnPage(link.x, prevWidth, nextWidth, padX),
                        y = keepMarkOnPage(link.y, prevHeight, nextHeight, padY),
                    )
                }
                val payload = (source.payload.deepCopy() as ch.fasrv.fanotes.json.JsonValue.Obj)
                payload.put("noteLinks", ch.fasrv.fanotes.desk.noteLinksJson(moved))
                open.value = source.copy(payload = payload)
                noteLinks.value = moved
            }
        }
        noteChanged()
    }

    fun noteChanged() {
        dirty = true
        unsaved.value = true
        editRevision += 1
        canvasToken.value += 1
        publishBusy()
        saveJob?.cancel()
        saveJob = viewModelScope.launch {
            kotlinx.coroutines.delay(ch.fasrv.fanotes.desk.editorMetrics(deskSettings.value).autosaveMs)
            try {
                saveNow()
            } catch (error: Exception) {
                message.value = error.message ?: "Speichern fehlgeschlagen."
            }
        }
    }

    private fun writeMovedBoxes(worksheetId: String, boxes: List<ch.fasrv.fanotes.desk.WorksheetBox>) {
        val path = ".fanotes/worksheets/$worksheetId.json"
        val raw = graph.vault.read(path)?.decodeToString() ?: return
        val root = ch.fasrv.fanotes.json.parseJson(raw) as? ch.fasrv.fanotes.json.JsonValue.Obj ?: return
        val stored = root.array("textBoxes") ?: return
        val byId = boxes.associateBy { it.id }
        for (item in stored.items) {
            val obj = item as? ch.fasrv.fanotes.json.JsonValue.Obj ?: continue
            val box = byId[obj.string("id")] ?: continue
            obj.put("x", ch.fasrv.fanotes.json.jsonNumber(box.x))
            obj.put("y", ch.fasrv.fanotes.json.jsonNumber(box.y))
        }
        root.put("updatedAt", ch.fasrv.fanotes.json.jsonString(isoNow()))
        graph.vault.write(path, root.stringify().encodeToByteArray())
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
        lastTypedAtMs = null
        lastStrokeEndedAtMs = null
        pdfSearchJob?.cancel()
        pdfSearchQuery.value = ""
        pdfSearchHits.value = emptyList()
        pdfSearchIndex.value = 0
        pdfSearchBusy.value = false
        pdfTextCache = null
        clearPdfThumbs()
        pdfPassword = ""
        pdfNeedsPassword.value = false
        pdfPasswordRejected.value = false
        noteSearchQuery.value = ""
        noteSearchHits.value = emptyList()
        noteSearchIndex.value = 0
        noteSearchSelection = null
        noteSearchCaseSensitive.value = false
        noteSearchRegexp.value = false
        noteSearchWholeWord.value = false
        gotoLineInput.value = null
        showGotoLine.value = false
        val stats = openPageStats(parsePageStats(note.payload.obj("pageStats"), now), now)
        val payload = (note.payload.deepCopy() as ch.fasrv.fanotes.json.JsonValue.Obj)
        payload.put("pageStats", mergePageStats(note.payload.obj("pageStats"), stats))
        return note.copy(payload = payload)
    }

    val pdfSearchQuery = MutableStateFlow("")
    val pdfSearchHits = MutableStateFlow<List<ch.fasrv.fanotes.desk.PdfSearchHit>>(emptyList())
    val pdfSearchIndex = MutableStateFlow(0)
    val pdfSearchBusy = MutableStateFlow(false)
    val pdfNeedsPassword = MutableStateFlow(false)
    val pdfPasswordRejected = MutableStateFlow(false)
    private var pdfPassword: String = ""
    val bookPasswordRejected = MutableStateFlow(false)
    private val bookPasswords = mutableMapOf<String, String>()
    private var pdfSearchJob: kotlinx.coroutines.Job? = null
    private var pdfTextCache: Pair<String, List<String>>? = null

    /** Desktop PDF find: German case fold, excerpts, at most 400 hits, then jump to the page. */
    fun updatePdfSearch(query: String) {
        pdfSearchQuery.value = query
        pdfSearchJob?.cancel()
        if (query.trim().isEmpty()) {
            pdfSearchHits.value = emptyList()
            pdfSearchIndex.value = 0
            pdfSearchBusy.value = false
            return
        }
        val note = open.value
        if (note == null || note.kind != NoteKind.PDF) return
        if (android.os.Build.VERSION.SDK_INT < 35) {
            message.value = "Die PDF-Suche braucht Android 15."
            return
        }
        pdfSearchJob = viewModelScope.launch {
            pdfSearchBusy.value = true
            kotlinx.coroutines.delay(180)
            val pages = withContext(Dispatchers.IO) { readPdfTexts(note.path) }
            if (pdfSearchQuery.value.trim() != query.trim()) return@launch
            val hits = ch.fasrv.fanotes.desk.searchPdfPages(pages, query)
            pdfSearchHits.value = hits
            pdfSearchIndex.value = 0
            pdfSearchBusy.value = false
            hits.firstOrNull()?.let { revealPdfPage(it.page) }
        }
    }

    fun stepPdfSearch(direction: Int) {
        val hits = pdfSearchHits.value
        if (hits.isEmpty() || (direction != 1 && direction != -1)) return
        val next = (pdfSearchIndex.value + direction).mod(hits.size)
        showPdfSearchHit(next)
    }

    fun showPdfSearchHit(index: Int) {
        val hit = pdfSearchHits.value.getOrNull(index) ?: return
        pdfSearchIndex.value = index
        revealPdfPage(hit.page)
    }

    private fun revealPdfPage(page: Int) {
        val note = open.value ?: return
        val slice = backdrop.value.getOrNull(page - 1) ?: return
        val height = session.document.sourceHeight
        if (height <= 0.0) return
        reveal = note.path to (slice.topPagePx.toDouble() / height).coerceIn(0.0, 1.0)
        canvasToken.value += 1
    }

    @androidx.annotation.RequiresApi(35)
    private fun readPdfTexts(path: String): List<String> {
        val cached = pdfTextCache
        if (cached != null && cached.first == path) return cached.second
        val bytes = graph.vault.read(path) ?: return emptyList()
        val file = java.io.File.createTempFile("fanotes-pdf-text", ".pdf")
        return try {
            file.writeBytes(bytes)
            val pages = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY).use { descriptor ->
                openNotePdf(descriptor).use { renderer ->
                    val count = renderer.pageCount.coerceAtMost(ch.fasrv.fanotes.desk.PDF_NOTE_PAGE_CAP)
                    (0 until count).map { index ->
                        try {
                            renderer.openPage(index).use { page ->
                                page.textContents.joinToString(" ") { it.text }
                            }
                        } catch (_: Exception) {
                            ""
                        }
                    }
                }
            }
            pdfTextCache = path to pages
            pages
        } catch (_: Exception) {
            emptyList()
        } finally {
            file.delete()
        }
    }

    val pdfThumbs = MutableStateFlow<List<Bitmap>>(emptyList())
    val pdfThumbOpen = MutableStateFlow(false)
    val pdfThumbPage = MutableStateFlow(1)
    val pdfPageCount = MutableStateFlow(0)
    private var pdfThumbJob: kotlinx.coroutines.Job? = null

    fun togglePdfThumbs() {
        val next = !pdfThumbOpen.value
        pdfThumbOpen.value = next
        if (next && pdfThumbs.value.isEmpty()) loadPdfThumbs()
    }

    fun notePdfPage(page: Int) {
        if (page >= 1 && page != pdfThumbPage.value) pdfThumbPage.value = page
    }

    fun showPdfThumb(page: Int) {
        goToPdfPage(page)
    }

    val pdfZoom = MutableStateFlow(1.0)
    val pdfZoomMode = MutableStateFlow("custom")
    val pdfCameraCommand = MutableStateFlow<Pair<Int, String>?>(null)

    fun requestPdfCamera(command: String) {
        val token = (pdfCameraCommand.value?.first ?: 0) + 1
        pdfCameraCommand.value = token to command
    }

    fun notePdfZoom(zoom: Float, mode: String) {
        if (pdfZoom.value != zoom.toDouble()) pdfZoom.value = zoom.toDouble()
        if (pdfZoomMode.value != mode) pdfZoomMode.value = mode
    }

    fun goToPdfPage(page: Int) {
        val count = backdrop.value.count { it.bitmap != null && it.worksheetId.isEmpty() }
        if (count <= 0) return
        val target = ch.fasrv.fanotes.desk.pdfPageTarget(page.toDouble(), count)
        pdfThumbPage.value = target
        revealPdfPage(target)
    }

    private fun clearPdfThumbs() {
        pdfThumbJob?.cancel()
        pdfThumbOpen.value = false
        pdfThumbPage.value = 1
        pdfPageCount.value = 0
        val old = pdfThumbs.value
        pdfThumbs.value = emptyList()
        old.forEach { if (!it.isRecycled) it.recycle() }
    }

    private fun loadPdfThumbs() {
        val note = open.value ?: return
        if (note.kind != NoteKind.PDF) return
        pdfThumbJob?.cancel()
        pdfThumbJob = viewModelScope.launch {
            val rendered = withContext(Dispatchers.IO) { renderPdfThumbs(note.path) }
            if (open.value?.path != note.path) {
                rendered.bitmaps.forEach { if (!it.isRecycled) it.recycle() }
                return@launch
            }
            val old = pdfThumbs.value
            pdfPageCount.value = rendered.pageCount
            pdfThumbs.value = rendered.bitmaps
            old.forEach { if (!it.isRecycled) it.recycle() }
        }
    }

    private data class ThumbBatch(val pageCount: Int, val bitmaps: List<Bitmap>)

    private fun renderPdfThumbs(path: String): ThumbBatch {
        val bytes = graph.vault.read(path) ?: return ThumbBatch(0, emptyList())
        val file = java.io.File.createTempFile("fanotes-pdf-thumb", ".pdf")
        val built = ArrayList<Bitmap>()
        return try {
            file.writeBytes(bytes)
            ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY).use { descriptor ->
                openNotePdf(descriptor).use { renderer ->
                    val shown = ch.fasrv.fanotes.desk.pdfThumbPages(
                        renderer.pageCount,
                        minOf(renderer.pageCount, ch.fasrv.fanotes.desk.PDF_NOTE_PAGE_CAP),
                    )
                    for (index in 0 until shown) {
                        renderer.openPage(index).use { page ->
                            val height = ch.fasrv.fanotes.desk.pdfThumbHeight(page.width, page.height)
                            val bitmap = Bitmap.createBitmap(
                                ch.fasrv.fanotes.desk.PDF_THUMB_WIDTH * 2,
                                height * 2,
                                Bitmap.Config.ARGB_8888,
                            )
                            built += bitmap
                            android.graphics.Canvas(bitmap).drawColor(android.graphics.Color.WHITE)
                            page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                        }
                    }
                    ThumbBatch(renderer.pageCount, built)
                }
            }
        } catch (_: Exception) {
            built.forEach { if (!it.isRecycled) it.recycle() }
            ThumbBatch(0, emptyList())
        } finally {
            file.delete()
        }
    }

    val noteSearchQuery = MutableStateFlow("")
    val noteSearchHits = MutableStateFlow<List<ch.fasrv.fanotes.desk.NoteSearchHit>>(emptyList())
    val noteSearchIndex = MutableStateFlow(0)
    val noteSearchCaseSensitive = MutableStateFlow(false)
    val noteSearchRegexp = MutableStateFlow(false)
    val noteSearchWholeWord = MutableStateFlow(false)
    val noteSearchFocus = MutableStateFlow(0)
    val showGotoLine = MutableStateFlow(false)
    private var noteSearchSelection: Pair<Int, Int>? = null

    private fun noteSearchOptions() = ch.fasrv.fanotes.desk.NoteSearchOptions(
        caseSensitive = noteSearchCaseSensitive.value,
        wholeWord = noteSearchWholeWord.value,
        regexp = noteSearchRegexp.value,
    )

    /** Finds in the whole note, including a folded heading body, and selects the first hit. */
    fun updateNoteSearch(query: String) {
        noteSearchQuery.value = query
        if (query.trim().isEmpty()) {
            noteSearchHits.value = emptyList()
            noteSearchIndex.value = 0
            return
        }
        val hits = ch.fasrv.fanotes.desk.searchNoteText(markdown.value, query, options = noteSearchOptions())
        noteSearchHits.value = hits
        noteSearchIndex.value = 0
        if (hits.isNotEmpty()) revealNoteSearch(0) else canvasToken.value += 1
    }

    fun setNoteSearchCaseSensitive(enabled: Boolean) {
        if (noteSearchCaseSensitive.value == enabled) return
        noteSearchCaseSensitive.value = enabled
        updateNoteSearch(noteSearchQuery.value)
    }

    fun setNoteSearchRegexp(enabled: Boolean) {
        if (noteSearchRegexp.value == enabled) return
        noteSearchRegexp.value = enabled
        updateNoteSearch(noteSearchQuery.value)
    }

    fun setNoteSearchWholeWord(enabled: Boolean) {
        if (noteSearchWholeWord.value == enabled) return
        noteSearchWholeWord.value = enabled
        updateNoteSearch(noteSearchQuery.value)
    }

    fun openGotoLine() {
        showGotoLine.value = true
    }

    fun closeGotoLine() {
        showGotoLine.value = false
    }

    /** Ctrl-F: focus the search field, using a short selection as the query. */
    fun openNoteSearch(selected: String) {
        val next = ch.fasrv.fanotes.desk.searchQueryFromSelection(noteSearchQuery.value, selected)
        if (next != noteSearchQuery.value) updateNoteSearch(next)
        showText.value = true
        noteSearchFocus.value += 1
    }

    /** Ctrl-G and F3. An empty query opens the search field instead. */
    fun findInNote(forward: Boolean, visibleOffset: Int, selected: String) {
        if (noteSearchQuery.value.trim().isEmpty()) {
            openNoteSearch(selected)
            return
        }
        val hits = noteSearchHits.value
        if (hits.isEmpty()) return
        val source = ch.fasrv.fanotes.desk.sourceOffsetForVisible(markdown.value, foldedHeadings.value, visibleOffset)
        val index = ch.fasrv.fanotes.desk.nextSearchHitIndex(hits, source, forward)
        if (index >= 0) revealNoteSearch(index)
    }

    fun stepNoteSearch(direction: Int) {
        val hits = noteSearchHits.value
        if (hits.isEmpty() || (direction != 1 && direction != -1)) return
        revealNoteSearch((noteSearchIndex.value + direction).mod(hits.size))
    }

    fun showNoteSearchHit(index: Int) {
        revealNoteSearch(index)
    }

    fun takeNoteSearchSelection(): Pair<Int, Int>? {
        val pending = noteSearchSelection ?: return null
        noteSearchSelection = null
        return pending
    }

    private fun revealNoteSearch(index: Int) {
        val hit = noteSearchHits.value.getOrNull(index) ?: return
        noteSearchIndex.value = index
        showText.value = true
        noteSearchSelection = hit.start to hit.end
        canvasToken.value += 1
    }

    /** Replaces the selected hit in the whole note, including a folded heading body. */
    fun replaceCurrentNoteSearch(replacement: String) {
        if (noteSearchQuery.value.trim().isEmpty()) return
        val full = markdown.value
        val hit = noteSearchHits.value.getOrNull(noteSearchIndex.value) ?: return
        val options = noteSearchOptions()
        val next = ch.fasrv.fanotes.desk.replaceNoteMatch(full, hit, replacement, options.regexp)
        if (next == full) return
        foldedHeadings.value = ch.fasrv.fanotes.desk.shiftFoldedLines(full, next, foldedHeadings.value)
        updateMarkdown(next)
        updateNoteSearch(noteSearchQuery.value)
    }

    /** Replaces every hit in the whole note, including folded heading bodies. */
    fun replaceAllNoteSearch(replacement: String) {
        val query = noteSearchQuery.value
        if (query.trim().isEmpty()) return
        val full = markdown.value
        val next = ch.fasrv.fanotes.desk.replaceAllNoteMatches(full, query, replacement, noteSearchOptions())
        if (next == full) return
        foldedHeadings.value = ch.fasrv.fanotes.desk.shiftFoldedLines(full, next, foldedHeadings.value)
        updateMarkdown(next)
        updateNoteSearch(query)
    }

    fun jumpToOutline(line: Int) {
        showText.value = true
        outlineJump.value = line
    }

    fun consumeOutlineJump() {
        outlineJump.value = null
    }

    /** Asks the open editor to run CodeMirror's go-to-line field. */
    fun requestGotoLine(input: String) {
        showText.value = true
        gotoLineInput.value = input
    }

    fun consumeGotoLine() {
        gotoLineInput.value = null
    }

    fun updateMarkdown(value: String) {
        val now = System.currentTimeMillis()
        rememberActivity { ch.fasrv.fanotes.desk.recordKeystroke(it, now, lastTypedAtMs) }
        lastTypedAtMs = now
        markdown.value = value
        open.value?.path?.let { rememberTags(it, value) }
        noteChanged()
    }

    fun recordFinishedStroke(stroke: ch.fasrv.fanotes.ink.InkStroke) {
        val now = System.currentTimeMillis()
        val document = session.document
        val length = ch.fasrv.fanotes.desk.strokeLengthMm(stroke, document.sourceWidth, document.sourceHeight)
        val first = stroke.points.firstOrNull()?.t
        val last = stroke.points.lastOrNull()?.t
        val duration = if (first != null && last != null) (last - first).coerceAtLeast(0.0).toLong() else 0L
        rememberActivity { ch.fasrv.fanotes.desk.recordInkActivity(it, stroke.points.size, length, duration, now, lastStrokeEndedAtMs) }
        lastStrokeEndedAtMs = now
        noteChanged()
    }

    fun recordErasedStrokes(removed: Int) {
        if (removed <= 0) return
        rememberActivity { ch.fasrv.fanotes.desk.recordInkErased(it, removed, System.currentTimeMillis()) }
        noteChanged()
    }

    private fun rememberActivity(transform: (ch.fasrv.fanotes.desk.PageStats) -> ch.fasrv.fanotes.desk.PageStats) {
        val note = open.value ?: return
        val now = System.currentTimeMillis()
        val stats = transform(ch.fasrv.fanotes.desk.parsePageStats(note.payload.obj("pageStats"), now))
        val payload = (note.payload.deepCopy() as ch.fasrv.fanotes.json.JsonValue.Obj)
        payload.put("pageStats", ch.fasrv.fanotes.desk.mergePageStats(note.payload.obj("pageStats"), stats))
        open.value = note.copy(payload = payload)
    }

    /** An edit of the text the user can see, with folded heading bodies still in the note. */
    fun updateVisibleMarkdown(previousVisible: String, nextVisible: String) {
        if (foldedHeadings.value.isEmpty()) {
            updateMarkdown(nextVisible)
            return
        }
        val full = ch.fasrv.fanotes.desk.applyFoldedEdit(markdown.value, foldedHeadings.value, previousVisible, nextVisible)
        foldedHeadings.value = ch.fasrv.fanotes.desk.shiftFoldedLines(markdown.value, full, foldedHeadings.value)
        updateMarkdown(full)
    }

    private fun foldsForSections(markdown: String, document: ch.fasrv.fanotes.ink.InkDocument): Set<Int> {
        val sorted = ch.fasrv.fanotes.ink.sectionsOf(document).sortedBy { it.top }
        return sorted.mapIndexedNotNull { index, section ->
            if (!section.collapsed) null else ch.fasrv.fanotes.desk.headingLineForSection(markdown, index)
        }.toSet()
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

    fun setPenWidth(width: Double) {
        val next = width.coerceIn(1.0, 18.0)
        updateDesk("pen-width", next.toString())
        style.value = style.value.copy(baseWidth = next)
    }

    fun setPenPressure(enabled: Boolean) {
        updateDesk("pressure", if (enabled) "on" else "off")
        style.value = style.value.copy(pressureEnabled = enabled)
    }

    fun setPenColor(color: String) {
        val hex = color.trim().lowercase()
        if (!Regex("#[0-9a-f]{6}").matches(hex)) return
        updateDesk("pen-color", hex)
        style.value = style.value.copy(color = hex)
    }

    fun setArtSymbolSize(value: Double) {
        updateDesk("symbol-size", ch.fasrv.fanotes.ink.snapArtSymbolSize(value).toInt().toString())
    }

    fun setArtSymbolRotation(value: Double) {
        updateDesk("symbol-rotation", ch.fasrv.fanotes.ink.snapArtSymbolRotation(value).toInt().toString())
    }

    fun setArtSymbolOpacity(value: Double) {
        updateDesk("symbol-opacity", ch.fasrv.fanotes.ink.snapArtSymbolOpacity(value).toString())
    }

    fun setArtSymbolCategory(value: String) {
        updateDesk("symbol-category", ch.fasrv.fanotes.ink.artSymbolCategorySetting(value))
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
                savePhase.value = "saving"
                val revision = editRevision
                val document = session.document
                val text = markdown.value
                val boxes = if (boxesNeedSave) worksheetBoxes.value else emptyList()
                boxesNeedSave = false
                try {
                    val saved = withContext(Dispatchers.IO) {
                        boxes.groupBy { it.worksheetId }.forEach { (id, group) ->
                            if (id.isNotEmpty() && group.isNotEmpty()) writeMovedBoxes(id, group.map { it.box })
                        }
                        val written = graph.store.save(note, document, text)
                        written to listNoteHistory(graph.vault, historyPathFor(written))
                    }
                    if (revision != editRevision) continue
                    open.value = saved.first
                    noteHistory.value = saved.second
                    dirty = false
                    unsaved.value = false
                    savePhase.value = "saved"
                    graph.busyPaths = emptySet()
                    graph.engine.notifyLocalChange()
                    refreshTree()
                    return
                } catch (error: Exception) {
                    savePhase.value = "error"
                    throw error
                }
            }
        }
    }

    fun currentFolder(): String = parentFolderOf(open.value?.path.orEmpty())

    fun createNote(title: String, parent: String = "") {
        viewModelScope.launch {
            val path = try {
                val paper = ch.fasrv.fanotes.desk.penSettings(deskSettings.value).paper
                withContext(Dispatchers.IO) { graph.store.createMarkdown(parent.trim('/'), title, paper = paper) }
            } catch (_: Exception) {
                message.value = "Eine Notiz mit diesem Namen gibt es schon."
                return@launch
            }
            refreshTree()
            openPath(path, force = true)
        }
    }

    fun createNoteIn(parent: String) {
        viewModelScope.launch {
            val folder = parent.trim('/')
            val path = try {
                val paper = ch.fasrv.fanotes.desk.penSettings(deskSettings.value).paper
                withContext(Dispatchers.IO) { graph.store.createUniqueMarkdown(folder, paper = paper) }
            } catch (error: Exception) {
                message.value = error.message ?: "Die Notiz konnte nicht erstellt werden."
                return@launch
            }
            openCreatedFolder(folder)
            refreshTree()
            openPath(path, force = true)
            message.value = "Neue Markdown-Notiz erstellt."
        }
    }

    fun createFolderIn(parent: String) {
        viewModelScope.launch {
            val folder = parent.trim('/')
            try {
                withContext(Dispatchers.IO) { graph.store.createUniqueFolder(folder) }
            } catch (error: Exception) {
                message.value = error.message ?: "Der Ordner konnte nicht erstellt werden."
                return@launch
            }
            openCreatedFolder(folder)
            refreshTree()
            message.value = if (folder.isEmpty()) {
                "Neuer Ordner erstellt."
            } else {
                "Unterordner in „${folder.substringAfterLast('/')}“ erstellt."
            }
        }
    }

    private fun openCreatedFolder(folder: String) {
        if (folder.isEmpty()) return
        val opened = toggleExpandedFolder(expandedFolders.value, folder, forceOpen = true)
        if (opened == expandedFolders.value) return
        expandedFolders.value = opened
        persistExpandedFolders()
    }

    fun createFolder(title: String, parent: String = "") {
        viewModelScope.launch {
            try {
                withContext(Dispatchers.IO) { graph.store.createFolder(parent.trim('/'), title) }
            } catch (_: Exception) {
                message.value = "Ein Ordner mit diesem Namen gibt es schon."
                return@launch
            }
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

    fun refuseNoteDownload() {
        message.value = NOTE_DOWNLOAD_REFUSED
    }

    fun saveNoteCopy(path: String, uri: Uri) {
        if (!ch.fasrv.fanotes.desk.noteCanDownload(path)) {
            message.value = NOTE_DOWNLOAD_REFUSED
            return
        }
        viewModelScope.launch {
            message.value = withContext(Dispatchers.IO) {
                runCatching {
                    val bytes = graph.vault.read(path) ?: error(NOTE_DOWNLOAD_MISSING)
                    val stream = getApplication<Application>().contentResolver.openOutputStream(uri)
                        ?: error(NOTE_DOWNLOAD_MISSING)
                    stream.use { it.write(bytes) }
                    NOTE_DOWNLOAD_SAVED
                }.getOrElse { error ->
                    if (error.message == NOTE_DOWNLOAD_MISSING) NOTE_DOWNLOAD_MISSING else NOTE_DOWNLOAD_REFUSED
                }
            }
        }
    }

    fun exportOpenNotePdf(uri: Uri) {
        val note = open.value
        if (note == null) {
            message.value = PDF_EXPORT_NEEDS_NOTE
            return
        }
        val visible = markdownWithFolds(markdown.value, foldedHeadings.value)
        val document = session.document
        val pages = backdrop.value
        val boxes = worksheetBoxes.value
        val marks = worksheetHighlights.value
        val links = noteLinks.value
        viewModelScope.launch {
            message.value = withContext(Dispatchers.IO) {
                runCatching {
                    val stream = getApplication<Application>().contentResolver.openOutputStream(uri)
                        ?: error(PDF_EXPORT_FAILED)
                    val metrics = ch.fasrv.fanotes.desk.editorMetrics(effectiveDesk())
                    stream.use {
                        writeNotePdf(
                            it, visible, document, pages, boxes, marks, links,
                            fontSizePx = metrics.fontSizePx.toFloat(),
                            lineHeight = metrics.lineHeight.toFloat(),
                            contentWidthPx = ch.fasrv.fanotes.desk.effectiveContentWidth(
                                metrics.contentWidthPx,
                                document.sourceWidth.toFloat(),
                                metrics.readableLineLength,
                            ),
                            smoothing = ch.fasrv.fanotes.desk.penSettings(deskSettings.value).smoothing.toFloat(),
                            editorTypeface = loadEditorTypeface(getApplication(), metrics.editorFontId),
                            showLineNumbers = metrics.showLineNumbers,
                        )
                    }
                    PDF_EXPORT_SAVED
                }.getOrElse { PDF_EXPORT_FAILED }
            }
        }
    }

    fun dropTreeEntry(path: String, sourceIsFolder: Boolean, destFolder: String) {
        if (!canDropEntry(path, sourceIsFolder, destFolder)) return
        if (destFolder.isNotEmpty()) {
            val opened = toggleExpandedFolder(expandedFolders.value, destFolder, forceOpen = true)
            if (opened != expandedFolders.value) {
                expandedFolders.value = opened
                persistExpandedFolders()
            }
        }
        moveEntry(path, destFolder)
    }

    fun moveEntry(path: String, destFolder: String) {
        viewModelScope.launch {
            if (open.value?.path?.let { isSelfOrInside(it, path) } == true) saveNow()
            val next = try {
                withContext(Dispatchers.IO) { graph.store.moveEntry(path, destFolder) }
            } catch (error: Exception) {
                message.value = error.message ?: "Verschieben ist fehlgeschlagen."
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
                foldedHeadings.value = emptySet()
                session.replace(newInkDocument("Note", "dots", isoNow()))
                openTabs.value.firstOrNull()?.let { openPath(it, force = true) }
            }
            withContext(Dispatchers.IO) {
                val parent = path.substringBeforeLast('/', "")
                val folder = graph.vault.list(parent).any { it.directory && it.path.trim('/') == path.trim('/') }
                if (folder) graph.vault.delete(path) else graph.store.delete(path)
            }
            forgetPaperCamerasUnder(path)
            loadTree()
            graph.engine.notifyLocalChange()
            persistWorkspace()
        }
    }

    fun importBytes(name: String, bytes: ByteArray, pdf: Boolean, mime: String = "") {
        viewModelScope.launch {
            val note = open.value
            if (!pdf) {
                if (note == null) {
                    message.value = "Öffne zuerst eine Notiz, dann Bild einfügen."
                    return@launch
                }
                if (note.kind != NoteKind.MARKDOWN) {
                    message.value = "Arbeitsblätter gehören in Markdown-Notizen. Eine PDF-Notiz ist bereits das Dokument selbst."
                    return@launch
                }
                val imageMime = mime.ifBlank { if (name.endsWith(".png", true)) "image/png" else "image/jpeg" }
                val stored = try {
                    withContext(Dispatchers.IO) { graph.store.storeImageWorksheet(name, bytes, imageMime) }
                } catch (error: Exception) {
                    message.value = error.message ?: "Bild konnte nicht eingefügt werden."
                    return@launch
                }
                val next = ch.fasrv.fanotes.famd.attachWorksheet(markdown.value, stored.id)
                markdown.value = next
                val updated = note.copy(markdown = next, worksheets = ch.fasrv.fanotes.famd.worksheetIdsFromMarkdown(next))
                open.value = updated
                loadBackdrop(updated)
                refreshOverlays()
                noteChanged()
                message.value = "„${stored.title}“ liegt auf dem Blatt."
                graph.engine.notifyLocalChange()
                return@launch
            }
            importPdfNote(null, name, bytes)
        }
    }

    /** Desktop PDF import: the file becomes a note in the chosen folder, or the default folder. */
    fun importPdfNote(parent: String?, name: String, bytes: ByteArray) {
        viewModelScope.launch {
            val folder = ch.fasrv.fanotes.desk.pdfNoteImportParent(parent, defaultCreateFolder())
            val path = try {
                withContext(Dispatchers.IO) { graph.store.importUniquePdf(folder, name, bytes) }
            } catch (error: Exception) {
                message.value = error.message ?: "Das PDF konnte nicht als Notiz importiert werden."
                return@launch
            }
            openCreatedFolder(folder)
            refreshTree()
            openPath(path, force = true)
            message.value = ch.fasrv.fanotes.desk.pdfNoteImportMessage(path)
            graph.engine.notifyLocalChange()
        }
    }

    /**
     * Desktop „Arbeitsblatt importieren“: a PDF or image, either on the open
     * Markdown note or as a new note in the default folder.
     */
    fun importWorksheetFile(name: String, bytes: ByteArray, mime: String, intoCurrent: Boolean) {
        viewModelScope.launch {
            if (intoCurrent) {
                val note = open.value
                if (note == null) {
                    message.value = "Öffne zuerst eine Notiz oder wähle „Neue Notiz“."
                    return@launch
                }
                if (note.kind != NoteKind.MARKDOWN) {
                    message.value = "Arbeitsblätter gehören in Markdown-Notizen. Eine PDF-Notiz ist bereits das Dokument selbst."
                    return@launch
                }
                val stored = try {
                    withContext(Dispatchers.IO) { graph.store.storeWorksheet(name, bytes, mime) }
                } catch (error: Exception) {
                    message.value = error.message ?: "Das Arbeitsblatt konnte nicht importiert werden."
                    return@launch
                }
                val next = ch.fasrv.fanotes.famd.attachWorksheet(markdown.value, stored.id)
                markdown.value = next
                val updated = note.copy(markdown = next, worksheets = ch.fasrv.fanotes.famd.worksheetIdsFromMarkdown(next))
                open.value = updated
                loadBackdrop(updated)
                refreshOverlays()
                noteChanged()
                message.value = "Arbeitsblatt „${stored.title}“ wurde in die Notiz eingefügt."
                graph.engine.notifyLocalChange()
                return@launch
            }
            val path = try {
                val paper = ch.fasrv.fanotes.desk.penSettings(deskSettings.value).paper
                withContext(Dispatchers.IO) {
                    graph.store.importWorksheetNote(defaultCreateFolder(), name, bytes, mime, paper)
                }
            } catch (error: IllegalStateException) {
                message.value = "Eine Notiz mit diesem Namen gibt es schon."
                return@launch
            } catch (error: Exception) {
                message.value = error.message ?: "Das Arbeitsblatt konnte nicht importiert werden."
                return@launch
            }
            refreshTree()
            openPath(path, force = true)
            val title = path.substringAfterLast('/').substringBeforeLast('.')
            message.value = "Arbeitsblatt „$title“ wurde als neue Notiz angelegt."
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

    fun setPlacingSection(active: Boolean) {
        if (placingSection.value != active) placingSection.value = active
    }

    fun insertSection(y: Double): String {
        val before = session.document
        val next = ch.fasrv.fanotes.ink.insertSection(before, y)
        val notice = ch.fasrv.fanotes.ink.sectionInsertNotice(before, next)
        if (notice == ch.fasrv.fanotes.ink.SECTION_PLACE_DONE) {
            session.replace(next)
            noteChanged()
        }
        placingSection.value = false
        return notice
    }

    fun toggleInkSection(id: String) {
        val index = ch.fasrv.fanotes.ink.sectionsOf(session.document).sortedBy { it.top }.indexOfFirst { it.id == id }
        session.replace(ch.fasrv.fanotes.ink.toggleSection(session.document, id))
        val collapsed = ch.fasrv.fanotes.ink.sectionsOf(session.document).find { it.id == id }?.collapsed == true
        val line = if (index >= 0) ch.fasrv.fanotes.desk.headingLineForSection(markdown.value, index) else null
        if (line != null) {
            foldedHeadings.value = if (collapsed) foldedHeadings.value + line else foldedHeadings.value - line
        }
        noteChanged()
    }

    /** Fold gutter: hide or show the body under this source heading, and the matching ink section. */
    fun toggleHeadingFold(line: Int) {
        if (ch.fasrv.fanotes.desk.headingFoldRange(markdown.value, line) == null && line !in foldedHeadings.value) return
        val collapse = line !in foldedHeadings.value
        foldedHeadings.value = if (collapse) foldedHeadings.value + line else foldedHeadings.value - line
        syncHeadingSection(session, markdown.value, line, collapse)
        noteChanged()
    }

    fun toggleHeadingAtVisibleLine(visibleLine: Int) {
        val line = ch.fasrv.fanotes.desk.headingLineForFoldMarker(markdown.value, foldedHeadings.value, visibleLine) ?: return
        toggleHeadingFold(line)
    }

    /** Ctrl-Shift-[, Ctrl-Shift-], Ctrl-Alt-[, and Ctrl-Alt-] from the desktop fold keymap. */
    fun foldEditorCommand(command: String, visibleOffset: Int) {
        val next = ch.fasrv.fanotes.desk.headingFoldCommand(markdown.value, foldedHeadings.value, command, visibleOffset) ?: return
        replaceHeadingFolds(next)
    }

    private fun replaceHeadingFolds(next: Set<Int>) {
        val previous = foldedHeadings.value
        if (next == previous) return
        foldedHeadings.value = next
        for (line in next - previous) syncHeadingSection(session, markdown.value, line, true)
        for (line in previous - next) syncHeadingSection(session, markdown.value, line, false)
        noteChanged()
    }

    /** Opens a folded heading so a jump into its body can land on the line. */
    fun unfoldHeading(line: Int) {
        if (line !in foldedHeadings.value) return
        foldedHeadings.value = foldedHeadings.value - line
        val index = ch.fasrv.fanotes.desk.sectionIndexForHeading(markdown.value, line)
        if (index < 0) return
        val section = ch.fasrv.fanotes.ink.sectionsOf(session.document).sortedBy { it.top }.getOrNull(index) ?: return
        if (!section.collapsed) return
        session.replace(ch.fasrv.fanotes.ink.toggleSection(session.document, section.id))
        noteChanged()
    }

    val noteLinks = MutableStateFlow<List<ch.fasrv.fanotes.desk.NoteLinkMark>>(emptyList())
    val worksheetBoxes = MutableStateFlow<List<ch.fasrv.fanotes.desk.AnchoredBox>>(emptyList())
    val worksheetHighlights = MutableStateFlow<List<ch.fasrv.fanotes.desk.AnchoredHighlight>>(emptyList())
    val bookPane = MutableStateFlow<BookPaneState?>(null)
    val bookOpen = MutableStateFlow(false)

    fun refreshOverlays() {
        val note = open.value
        viewModelScope.launch {
            val links = ch.fasrv.fanotes.desk.parseNoteLinkMarks(note?.payload)
            val overlay = withContext(Dispatchers.IO) {
                val boxes = mutableListOf<ch.fasrv.fanotes.desk.AnchoredBox>()
                val marks = mutableListOf<ch.fasrv.fanotes.desk.AnchoredHighlight>()
                for (worksheet in note?.worksheets.orEmpty()) {
                    val raw = graph.vault.read(".fanotes/worksheets/$worksheet.json")?.decodeToString() ?: continue
                    parseWorksheetBoxes(raw).forEach { boxes += ch.fasrv.fanotes.desk.AnchoredBox(worksheet, it) }
                    parseWorksheetHighlights(raw).forEach { marks += ch.fasrv.fanotes.desk.AnchoredHighlight(worksheet, it) }
                }
                boxes to marks
            }
            noteLinks.value = links
            worksheetBoxes.value = overlay.first
            worksheetHighlights.value = overlay.second
        }
    }

    fun addWorksheetHighlight(worksheetId: String, mark: WorksheetHighlight) {
        if (open.value?.worksheets?.contains(worksheetId) != true) return
        viewModelScope.launch {
            withContext(Dispatchers.IO) { mutateHighlights(worksheetId) { it + mark } }
            refreshOverlays()
            graph.engine.notifyLocalChange()
        }
    }

    fun removeWorksheetHighlight(id: String) {
        val sheets = open.value?.worksheets.orEmpty()
        viewModelScope.launch {
            withContext(Dispatchers.IO) {
                for (worksheet in sheets) {
                    val raw = graph.vault.read(".fanotes/worksheets/$worksheet.json")?.decodeToString() ?: continue
                    if (parseWorksheetHighlights(raw).none { it.id == id }) continue
                    mutateHighlights(worksheet) { marks -> marks.filter { it.id != id } }
                }
            }
            refreshOverlays()
            graph.engine.notifyLocalChange()
        }
    }

    fun removeWorksheet(id: String) {
        val note = open.value ?: return
        if (id !in note.worksheets) return
        val label = backdrop.value.firstOrNull { it.worksheetId == id }?.label?.ifBlank { null } ?: "Arbeitsblatt"
        askConfirm(
            ch.fasrv.fanotes.desk.PendingConfirm(
                "Arbeitsblatt entfernen",
                "„$label“ wirklich aus dieser Notiz entfernen? Die PDF-/Bilddatei wird aus dem Vault gelöscht.",
                "Entfernen",
            ),
        ) {
            viewModelScope.launch {
                val current = open.value ?: return@launch
                val next = ch.fasrv.fanotes.famd.detachWorksheet(markdown.value, id)
                markdown.value = next
                val updated = current.copy(markdown = next, worksheets = ch.fasrv.fanotes.famd.worksheetIdsFromMarkdown(next))
                open.value = updated
                withContext(Dispatchers.IO) { graph.store.deleteWorksheet(id) }
                loadBackdrop(updated)
                refreshOverlays()
                noteChanged()
                message.value = "„$label“ wurde aus der Notiz entfernt."
                graph.engine.notifyLocalChange()
            }
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

    fun importSubjectBook(folder: String, name: String, bytes: ByteArray) {
        viewModelScope.launch {
            val subject = folder.trim('/')
            if (subject.isEmpty()) {
                message.value = "Das Fach wurde nicht gefunden."
                return@launch
            }
            val path = try {
                withContext(Dispatchers.IO) { graph.store.importUniquePdf(subject, name, bytes) }
            } catch (error: Exception) {
                message.value = error.message ?: "Das Buch konnte nicht hinzugefügt werden."
                return@launch
            }
            val next = withContext(Dispatchers.IO) {
                val current = graph.vault.read(SUBJECT_BOOKS_PATH)?.decodeToString()?.let(::parseSubjectBooks).orEmpty()
                val updated = attachSubjectBook(current, subject, path, 1)
                graph.vault.write(SUBJECT_BOOKS_PATH, serializeSubjectBooks(updated).encodeToByteArray())
                updated
            }
            books.value = next
            openCreatedFolder(subject)
            refreshTree()
            open.value?.let { refreshBook(it) }
            message.value = "Buch zum Fach hinzugefügt. Oben blendest du die Ansicht ein."
            graph.engine.notifyLocalChange()
        }
    }

    fun detachSubjectBook(folder: String) {
        viewModelScope.launch {
            val subject = folder.trim('/')
            val next = withContext(Dispatchers.IO) {
                val current = graph.vault.read(SUBJECT_BOOKS_PATH)?.decodeToString()?.let(::parseSubjectBooks).orEmpty()
                val updated = detachSubjectBook(current, subject)
                graph.vault.write(SUBJECT_BOOKS_PATH, serializeSubjectBooks(updated).encodeToByteArray())
                updated
            }
            books.value = next
            val pane = bookPane.value
            if (pane?.subjectPath == subject) {
                bookPane.value = null
                pane.bitmap?.recycle()
            }
            message.value = "Buch vom Fach entfernt. Die PDF-Datei bleibt im Ordner."
            graph.engine.notifyLocalChange()
        }
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

    fun toggleBookView() {
        val note = open.value
        val hasBook = note != null && ch.fasrv.fanotes.desk.subjectBookForNote(books.value, note.path) != null
        if (!hasBook) {
            message.value = "Öffne eine Notiz in einem Fach, um ein Buch hinzuzufügen."
            return
        }
        val placement = deskSettings.value["book-placement"].orEmpty().ifBlank { "rechts" }
        val next = ch.fasrv.fanotes.desk.toggleSubjectBookView(bookOpen.value, placement)
        bookOpen.value = next.open
        if (next.open) refreshBook(note)
    }

    fun turnBook(delta: Int) {
        val current = bookPane.value ?: return
        if (current.needsPassword || current.pageCount <= 0) return
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
            bookPasswordRejected.value = next?.needsPassword == true && bookPasswords[next.bookPath].orEmpty().isNotEmpty()
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
            bookPasswordRejected.value = next?.needsPassword == true && bookPasswords[next.bookPath].orEmpty().isNotEmpty()
            if (old != null && old !== next?.bitmap) old.recycle()
        }
    }

    fun submitBookPassword(value: String) {
        val current = bookPane.value ?: return
        bookPasswords[current.bookPath] = value
        bookPasswordRejected.value = false
        val record = books.value.find { it.subjectPath == current.subjectPath } ?: return
        viewModelScope.launch {
            val next = withContext(Dispatchers.IO) { renderBookPage(record) }
            val old = bookPane.value?.bitmap
            bookPane.value = next
            bookPasswordRejected.value = next?.needsPassword == true && value.isNotEmpty()
            if (old != null && old !== next?.bitmap) old.recycle()
        }
    }

    private fun renderBookPage(record: SubjectBook): BookPaneState? {
        val bytes = graph.vault.read(record.bookPath) ?: return null
        val file = java.io.File.createTempFile("fanotes-book", ".pdf")
        return try {
            file.writeBytes(bytes)
            android.os.ParcelFileDescriptor.open(file, android.os.ParcelFileDescriptor.MODE_READ_ONLY).use { descriptor ->
                try {
                openBookPdf(descriptor, record.bookPath).use { renderer ->
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
                } catch (error: Exception) {
                    if (!ch.fasrv.fanotes.desk.pdfNeedsPassword(error.javaClass.simpleName, error.message.orEmpty())) throw error
                    BookPaneState(record.bookPath, record.subjectPath, record.lastPage.coerceAtLeast(1), 0, null, record.bookPath.substringAfterLast('/'), needsPassword = true)
                }
            }
        } finally {
            file.delete()
        }
    }

    private fun openBookPdf(descriptor: android.os.ParcelFileDescriptor, path: String): android.graphics.pdf.PdfRenderer {
        val password = bookPasswords[path].orEmpty()
        if (password.isNotEmpty() && android.os.Build.VERSION.SDK_INT >= 35) {
            val params = android.graphics.pdf.LoadParams.Builder().setPassword(password).build()
            return android.graphics.pdf.PdfRenderer(descriptor, params)
        }
        return android.graphics.pdf.PdfRenderer(descriptor)
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

    fun askConfirm(request: ch.fasrv.fanotes.desk.PendingConfirm, action: () -> Unit) {
        confirmAction = action
        confirmRequest.value = request
    }

    fun acceptConfirm() {
        val action = confirmAction
        dismissConfirm()
        action?.invoke()
    }

    fun recordPenSample(x: Double, y: Double) {
        val now = System.currentTimeMillis()
        bugLog.recordPen(
            ch.fasrv.fanotes.desk.BugReportEvent(
                at = now,
                kind = "pen",
                noteId = open.value?.path,
                x = ch.fasrv.fanotes.desk.compactCoord(x),
                y = ch.fasrv.fanotes.desk.compactCoord(y),
                pointerType = "pen",
                tool = tool.value.name.lowercase(),
                version = "2026.10.7",
                platform = "android",
            ),
            now,
        )
    }

    fun recordBugTool(name: String) {
        recordBug("tool", open.value?.path, name)
    }

    fun openBugReport() {
        bugReportOpen.value = true
        bugReportMessage.value = null
    }

    fun closeBugReport() {
        bugReportOpen.value = false
    }

    fun sendBugReport(description: String) {
        val now = System.currentTimeMillis()
        val request = ch.fasrv.fanotes.desk.buildBugReportRequest(
            description = description,
            events = bugLog.snapshot(now),
            version = "2026.10.7",
            platform = "android",
            now = now,
        )
        if (request.body.description.isBlank() || request.body.events.isEmpty()) {
            bugReportMessage.value = "Bitte beschreibe den Fehler kurz. Die letzten fünf Minuten müssen am Bericht hängen."
            return
        }
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching {
                    val call = okhttp3.Request.Builder()
                        .url(request.url)
                        .header("Accept", "application/json")
                        .header("Content-Type", "application/json")
                        .post(request.json.toByteArray().toRequestBody("application/json".toMediaType()))
                        .build()
                    okhttp3.OkHttpClient().newCall(call).execute().use { response ->
                        when {
                            response.isSuccessful -> "Bericht gesendet."
                            response.code == 400 -> "Bitte beschreibe den Fehler kurz. Die letzten fünf Minuten müssen am Bericht hängen."
                            else -> "Der Bericht konnte nicht gesendet werden. Prüfe die Verbindung zu fanotes.fasrv.ch."
                        }
                    }
                }.getOrElse { "Der Bericht konnte nicht gesendet werden. Prüfe die Verbindung zu fanotes.fasrv.ch." }
            }
            bugReportMessage.value = result
            message.value = result
            if (result == "Bericht gesendet.") bugReportOpen.value = false
        }
    }

    private fun recordBug(kind: String, noteId: String?, tool: String? = null) {
        val now = System.currentTimeMillis()
        bugLog.record(
            ch.fasrv.fanotes.desk.BugReportEvent(
                at = now,
                kind = kind,
                noteId = noteId,
                tool = tool,
                version = "2026.10.7",
                platform = "android",
            ),
            now,
        )
    }

    fun dismissConfirm() {
        confirmRequest.value = null
        confirmAction = null
    }

    fun rememberPaperCamera(
        path: String,
        zoom: Double,
        rotation: Double,
        centreX: Double,
        centreY: Double,
        pageWidth: Double,
        pageHeight: Double,
        anchor: ch.fasrv.fanotes.desk.PaperTextAnchor?,
    ) {
        val key = ch.fasrv.fanotes.desk.paperViewMemoryKey(path)
        if (key.isEmpty()) return
        paperViews = ch.fasrv.fanotes.desk.rememberPaperView(
            paperViews,
            key,
            zoom = zoom,
            rotation = rotation,
            centreX = centreX,
            centreY = centreY,
            pageWidth = pageWidth,
            pageHeight = pageHeight,
            anchor = anchor,
        )
        graph.writePaperViews(ch.fasrv.fanotes.desk.serializePaperViewMemory(paperViews))
    }

    fun recallPaperCamera(path: String): ch.fasrv.fanotes.desk.PaperViewMemoryEntry? =
        ch.fasrv.fanotes.desk.recallPaperView(paperViews, ch.fasrv.fanotes.desk.paperViewMemoryKey(path))

    private fun forgetPaperCamerasUnder(path: String) {
        val prefix = path.trim('/')
        if (prefix.isEmpty()) return
        val next = paperViews.filterKeys { it != prefix && !it.startsWith("$prefix/") }
        if (next.size == paperViews.size) return
        paperViews = next
        graph.writePaperViews(ch.fasrv.fanotes.desk.serializePaperViewMemory(paperViews))
    }

    private fun remapPaperCameras(from: String, to: String) {
        val next = paperViews.mapKeys { (key, _) -> remapPath(key, from, to) ?: key }
        if (next == paperViews) return
        paperViews = next
        graph.writePaperViews(ch.fasrv.fanotes.desk.serializePaperViewMemory(paperViews))
    }

    fun askDelete(path: String, folder: Boolean, name: String) {
        askConfirm(
            ch.fasrv.fanotes.desk.PendingConfirm("Löschen", ch.fasrv.fanotes.desk.vaultDeleteMessage(folder, name), "Löschen"),
        ) { delete(path) }
    }

    fun restylePlacedNoteLink(id: String, style: String) {
        val source = open.value ?: return
        val current = noteLinks.value.find { it.id == id } ?: return
        val next = try {
            ch.fasrv.fanotes.desk.restyleNoteLink(current, style)
        } catch (error: IllegalArgumentException) {
            message.value = error.message
            return
        }
        val links = noteLinks.value.map { if (it.id == id) next else it }
        val payload = (source.payload.deepCopy() as ch.fasrv.fanotes.json.JsonValue.Obj)
        payload.put("noteLinks", ch.fasrv.fanotes.desk.noteLinksJson(links))
        open.value = source.copy(payload = payload)
        noteLinks.value = links
        noteChanged()
    }

    fun askRemoveNoteLink(id: String) {
        askConfirm(
            ch.fasrv.fanotes.desk.PendingConfirm("Verlinkung entfernen", ch.fasrv.fanotes.desk.noteLinkRemoveMessage(), "Entfernen"),
        ) { removePlacedNoteLink(id) }
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

    fun placeWorksheetBox(worksheetId: String, page: Int, localX: Double, localY: Double, onPlaced: (String) -> Unit) {
        if (open.value?.worksheets?.contains(worksheetId) != true) return
        val id = java.util.UUID.randomUUID().toString()
        val box = ch.fasrv.fanotes.desk.placeWorksheetTextBox(page, localX, localY, id)
        viewModelScope.launch {
            val error = withContext(Dispatchers.IO) { insertWorksheetBox(worksheetId, box) }
            if (error != null) {
                message.value = error
                return@launch
            }
            worksheetBoxes.value = worksheetBoxes.value + ch.fasrv.fanotes.desk.AnchoredBox(worksheetId, box)
            refreshOverlays()
            graph.engine.notifyLocalChange()
            onPlaced(id)
        }
    }

    fun removeWorksheetBox(id: String) {
        val worksheet = worksheetBoxes.value.firstOrNull { it.box.id == id }?.worksheetId ?: return
        viewModelScope.launch {
            withContext(Dispatchers.IO) { deleteWorksheetBox(worksheet, id) }
            worksheetBoxes.value = worksheetBoxes.value.filterNot { it.box.id == id }
            refreshOverlays()
            graph.engine.notifyLocalChange()
        }
    }

    fun updateWorksheetBox(id: String, text: String) {
        val invalid = ch.fasrv.fanotes.desk.worksheetBoxTextError(text)
        if (invalid != null) {
            message.value = invalid
            return
        }
        val worksheet = worksheetBoxes.value.firstOrNull { it.box.id == id }?.worksheetId
            ?: open.value?.worksheets?.firstOrNull() ?: return
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

    private fun insertWorksheetBox(worksheetId: String, box: ch.fasrv.fanotes.desk.WorksheetBox): String? {
        val path = ".fanotes/worksheets/$worksheetId.json"
        val raw = graph.vault.read(path)?.decodeToString() ?: return "Das Arbeitsblatt wurde nicht gefunden."
        val root = parseJson(raw) as? ch.fasrv.fanotes.json.JsonValue.Obj ?: return "Die Arbeitsblattdaten sind beschädigt."
        val boxes = root.array("textBoxes") ?: ch.fasrv.fanotes.json.JsonValue.Arr()
        if (boxes.items.size >= 2000) return "Das Arbeitsblatt enthält zu viele Textfelder."
        boxes.items += ch.fasrv.fanotes.json.jsonObject(
            "id" to ch.fasrv.fanotes.json.jsonString(box.id),
            "page" to ch.fasrv.fanotes.json.jsonNumber(box.page.toDouble()),
            "x" to ch.fasrv.fanotes.json.jsonNumber(box.x),
            "y" to ch.fasrv.fanotes.json.jsonNumber(box.y),
            "width" to ch.fasrv.fanotes.json.jsonNumber(box.width),
            "text" to ch.fasrv.fanotes.json.jsonString(box.text),
            "fontSize" to ch.fasrv.fanotes.json.jsonNumber(box.fontSize),
        )
        root.put("textBoxes", boxes)
        root.put("updatedAt", ch.fasrv.fanotes.json.jsonString(isoNow()))
        graph.vault.write(path, root.stringify().encodeToByteArray())
        return null
    }

    private fun deleteWorksheetBox(worksheetId: String, id: String) {
        val path = ".fanotes/worksheets/$worksheetId.json"
        val raw = graph.vault.read(path)?.decodeToString() ?: return
        val root = parseJson(raw) as? ch.fasrv.fanotes.json.JsonValue.Obj ?: return
        val boxes = root.array("textBoxes") ?: return
        boxes.items.removeAll { (it as? ch.fasrv.fanotes.json.JsonValue.Obj)?.string("id") == id }
        root.put("textBoxes", boxes)
        root.put("updatedAt", ch.fasrv.fanotes.json.jsonString(isoNow()))
        graph.vault.write(path, root.stringify().encodeToByteArray())
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

    fun submitPdfPassword(value: String) {
        pdfPassword = value
        pdfPasswordRejected.value = false
        val note = open.value ?: return
        if (note.kind != NoteKind.PDF) return
        viewModelScope.launch { loadBackdrop(note) }
    }

    private fun openNotePdf(descriptor: ParcelFileDescriptor): PdfRenderer {
        val password = pdfPassword
        if (password.isNotEmpty() && android.os.Build.VERSION.SDK_INT >= 35) {
            val params = android.graphics.pdf.LoadParams.Builder().setPassword(password).build()
            return PdfRenderer(descriptor, params)
        }
        return PdfRenderer(descriptor)
    }

    private fun renderPdf(note: OpenNote): List<BackdropSlice> {
        val bytes = graph.vault.read(note.path) ?: return emptyList()
        val file = File.createTempFile("fanotes-pdf", ".pdf")
        return try {
        file.writeBytes(bytes)
        ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY).use { descriptor ->
            try {
            openNotePdf(descriptor).use { renderer ->
                pdfNeedsPassword.value = false
                pdfPasswordRejected.value = false
                val aspects = (0 until renderer.pageCount.coerceAtMost(ch.fasrv.fanotes.desk.PDF_NOTE_PAGE_CAP)).map { index ->
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
            } catch (error: Exception) {
                if (!ch.fasrv.fanotes.desk.pdfNeedsPassword(error.javaClass.simpleName, error.message.orEmpty())) throw error
                pdfNeedsPassword.value = true
                pdfPasswordRejected.value = pdfPassword.isNotEmpty()
                emptyList()
            }
        }
        } finally {
            file.delete()
        }
    }

    private fun renderWorksheet(note: OpenNote): List<BackdropSlice> {
        val slices = ArrayList<BackdropSlice>()
        for (id in note.worksheets) {
            val record = graph.vault.read(".fanotes/worksheets/$id.json")?.decodeToString() ?: continue
            val json = parseJson(record) as? JsonValue.Obj ?: continue
            val source = json.string("sourceRelativePath") ?: continue
            val bytes = graph.vault.read(source) ?: continue
            val title = json.string("title").orEmpty().ifBlank { "Arbeitsblatt" }
            val kind = json.string("kind").orEmpty()
            if (kind == "pdf" || source.endsWith(".pdf", true)) {
                slices += renderWorksheetPdf(id, title, bytes)
            } else {
                val bitmap = android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: continue
                slices += BackdropSlice(
                    topPagePx = 0f,
                    heightPagePx = bitmap.height.toFloat(),
                    widthPagePx = bitmap.width.toFloat(),
                    bitmap = bitmap,
                    worksheetId = id,
                    label = title,
                    page = 1,
                )
            }
        }
        return slices
    }

    /** One card per PDF page, capped like the note PDF renderer. */
    private fun renderWorksheetPdf(id: String, title: String, bytes: ByteArray): List<BackdropSlice> {
        val file = java.io.File.createTempFile("fanotes-worksheet", ".pdf")
        val built = ArrayList<BackdropSlice>()
        return try {
            file.writeBytes(bytes)
            ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY).use { descriptor ->
                PdfRenderer(descriptor).use { renderer ->
                    val count = renderer.pageCount.coerceAtMost(ch.fasrv.fanotes.desk.PDF_NOTE_PAGE_CAP)
                    for (index in 0 until count) {
                        val page = renderer.openPage(index)
                        try {
                            val width = 1200
                            val height = (width * (page.height.toFloat() / page.width.toFloat().coerceAtLeast(1f))).toInt().coerceAtLeast(1)
                            val bitmap = android.graphics.Bitmap.createBitmap(width, height, android.graphics.Bitmap.Config.ARGB_8888)
                            page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                            built += BackdropSlice(
                                topPagePx = 0f,
                                heightPagePx = height.toFloat(),
                                widthPagePx = width.toFloat(),
                                bitmap = bitmap,
                                worksheetId = id,
                                label = if (index == 0) title else "",
                                page = index + 1,
                            )
                        } finally {
                            page.close()
                        }
                    }
                }
            }
            built
        } catch (_: Exception) {
            built.forEach { it.bitmap?.recycle() }
            emptyList()
        } finally {
            file.delete()
        }
    }

    val destination = MutableStateFlow("notes")
    val openTabs = MutableStateFlow<List<String>>(emptyList())
    val expandedFolders = MutableStateFlow(parseExpandedFolders(graph.readExpandedFolders(graph.vaultId)))
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
    val customCss = MutableStateFlow(graph.readCustomCss())
    val splitPath = MutableStateFlow<String?>(null)
    val unsaved = MutableStateFlow(false)
    val savePhase = MutableStateFlow("saved")
    val splitUnsaved = MutableStateFlow(false)
    val splitMarkdown = MutableStateFlow("")
    val splitFolded = MutableStateFlow<Set<Int>>(emptySet())
    val splitSession = InkSession(newInkDocument("Spalte", "dots", isoNow()))
    private var splitNote: OpenNote? = null
    private var splitSaveJob: kotlinx.coroutines.Job? = null
    private var splitSaveGeneration = 0
    private var splitGeneration = 0
    private var openedAtMs = 0L
    private var lastTypedAtMs: Long? = null
    private var lastStrokeEndedAtMs: Long? = null
    private var reveal: Pair<String, Double>? = null
    private var boxesNeedSave = false
    val aiReply = MutableStateFlow("")
    val aiPreview = MutableStateFlow<String?>(null)
    val aiStatus = MutableStateFlow("")
    val aiModels = MutableStateFlow<List<ch.fasrv.fanotes.desk.AiListedModel>>(emptyList())
    val paletteOpen = MutableStateFlow(false)
    val paletteNotes = MutableStateFlow(false)

    fun showPalette(notes: Boolean) {
        paletteNotes.value = notes
        paletteOpen.value = true
    }
    val linkPlacing = MutableStateFlow(false)
    val placingSection = MutableStateFlow(false)
    val linkSelected = MutableStateFlow(false)
    val clearLinkRequest = MutableStateFlow(0)
    val placeLinkRequest = MutableStateFlow(0)
    val updateLabel = MutableStateFlow("2026.10.7")

    fun reportLinkChrome(placing: Boolean, selected: Boolean) {
        if (linkPlacing.value != placing) linkPlacing.value = placing
        if (linkSelected.value != selected) linkSelected.value = selected
    }

    fun requestPlaceLink() {
        if (open.value == null) {
            message.value = "Öffne zuerst eine Notiz, um eine Verlinkung zu setzen."
            return
        }
        destination.value = "notes"
        linkPlacing.value = !linkPlacing.value
        placeLinkRequest.value += 1
    }

    fun requestClearLink() {
        linkPlacing.value = false
        linkSelected.value = false
        clearLinkRequest.value += 1
    }

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
                foldedHeadings.value = emptySet()
                session.replace(newInkDocument("Note", "dots", isoNow()))
            }
        }
        persistWorkspace()
    }

    fun closeTabs(scope: String, anchor: String? = open.value?.path) {
        val path = anchor ?: return
        if (path !in openTabs.value) return
        val tabs = openTabs.value.map { DeskTab(it, it in pinnedTabs.value) }
        tabsToClose(tabs, path, scope).forEach { closeTab(it) }
    }

    fun moveOpenTab(from: String, to: String?, side: String) {
        val current = openTabs.value.map { DeskTab(it, it in pinnedTabs.value) }
        val next = moveTab(current, from, to, side)
        if (next.map { it.path } == openTabs.value) return
        openTabs.value = next.map { it.path }
        pinnedTabs.value = next.filter { it.pinned }.map { it.path }.toSet()
        persistWorkspace()
    }

    fun selectedFolderVault(): Boolean = graph.vault is SafVault

    fun revealInFolder(path: String): android.net.Uri? = (graph.vault as? SafVault)?.documentUri(path)

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

    fun closeCurrentTab() {
        val path = open.value?.path ?: return
        if (path in pinnedTabs.value) {
            message.value = "Diese Notiz ist angeheftet. Löse sie zuerst über das Tab-Menü."
            return
        }
        closeTab(path)
    }

    fun openTabByDigit(digit: Int) {
        if (digit !in 1..9) return
        val path = openTabs.value.getOrNull(digit - 1) ?: return
        openPath(path)
        destination.value = "notes"
    }

    fun saveFromShortcut() {
        viewModelScope.launch {
            try {
                saveNow()
            } catch (error: Exception) {
                message.value = error.message ?: "Speichern fehlgeschlagen."
            }
        }
    }

    fun togglePen() {
        showText.value = !showText.value
    }

    fun toggleFocusMode() {
        val on = deskSettings.value["focus"] == "on"
        updateDesk("focus", if (on) "off" else "on")
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

    fun setSplitRatio(ratio: Double) {
        updateDesk("split-ratio", ch.fasrv.fanotes.desk.clampSplitRatio(ratio).toString())
    }

    fun closeSplit() {
        splitGeneration += 1
        flushSplit()
        splitPath.value = null
        splitNote = null
        splitMarkdown.value = ""
        splitFolded.value = emptySet()
        splitUnsaved.value = false
        persistWorkspace()
    }

    /** The split note becomes the only open note. The previous main note stays in the tabs. */
    fun promoteSplit() {
        val path = splitPath.value ?: return
        flushSplit()
        splitPath.value = null
        splitNote = null
        splitMarkdown.value = ""
        splitFolded.value = emptySet()
        splitUnsaved.value = false
        openPath(path, force = true)
    }

    private fun flushSplit() {
        val note = splitNote ?: return
        val text = splitMarkdown.value
        val document = splitSession.document
        splitSaveJob?.cancel()
        viewModelScope.launch {
            withContext(Dispatchers.IO) { graph.store.save(note.copy(markdown = text), document, text) }
            graph.engine.notifyLocalChange()
        }
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
        val folders = remapExpandedFolders(expandedFolders.value, from, to)
        if (folders != expandedFolders.value) {
            expandedFolders.value = folders
            persistExpandedFolders()
        }
        tagIndex.value = tagIndex.value.mapKeys { (path, _) -> remapPath(path, from, to) ?: path }
        remapPaperCameras(from, to)
        deskSettings.value["last-open"]?.let { saved -> remapPath(saved, from, to)?.let { updateDesk("last-open", it) } }
        val current = open.value?.path
        if (current != null) {
            val moved = remapPath(current, from, to)
            if (moved != null) openPath(moved, force = true)
        }
        splitPath.value?.let { split ->
            remapPath(split, from, to)?.let { moved -> if (moved != split) loadSplit(moved) }
        }
        val colors = remapFolderColors(folderColors.value, from, to)
        if (colors != folderColors.value) {
            folderColors.value = colors
            viewModelScope.launch {
                withContext(Dispatchers.IO) {
                    graph.vault.write(FOLDER_COLORS_PATH, serializeFolderColors(colors).encodeToByteArray())
                }
                graph.engine.notifyLocalChange()
            }
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
        expandedFolders.value = parseExpandedFolders(graph.readExpandedFolders(graph.vaultId))
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

    fun setSidebarOpen(open: Boolean) {
        sidebarOpen.value = open
        showList.value = open
    }

    fun toggleInspector() {
        val next = !inspectorOpen.value
        inspectorOpen.value = next
        if (next && deskSettings.value["outline"] == "off") updateDesk("outline", "on")
    }

    fun toggleFolder(path: String) {
        val next = toggleExpandedFolder(expandedFolders.value, path)
        if (next == expandedFolders.value) return
        expandedFolders.value = next
        persistExpandedFolders()
    }

    fun setFolderExpanded(path: String, open: Boolean) {
        val next = toggleExpandedFolder(expandedFolders.value, path, forceOpen = open)
        if (next == expandedFolders.value) return
        expandedFolders.value = next
        persistExpandedFolders()
    }

    private fun revealFolders(path: String) {
        val next = revealExpandedFolders(expandedFolders.value, path)
        if (next == expandedFolders.value) return
        expandedFolders.value = next
        persistExpandedFolders()
    }

    private fun persistExpandedFolders() {
        graph.writeExpandedFolders(graph.vaultId, expandedFoldersJson(expandedFolders.value))
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
                val files = graph.vault.walkFiles().filter {
                    val path = it.path
                    path.endsWith(".md", true) || path.endsWith(".markdown", true) ||
                        (path.endsWith(".pdf", true) && !path.startsWith("."))
                }
                val texts = files.map { file ->
                    val path = file.path
                    if (path.endsWith(".pdf", true)) path to ""
                    else path to (graph.vault.read(path)?.decodeToString().orEmpty())
                }
                val transcripts = texts.mapNotNull { (path, _) ->
                    val famdPath = if (path.endsWith(".famd")) path else companionPath(path, ".famd")
                    val ink = ch.fasrv.fanotes.famd.parseFamd(graph.vault.read(famdPath)?.decodeToString().orEmpty()).payload?.obj("ink")
                    val transcript = ink?.string("searchTranscript") ?: return@mapNotNull null
                    path to transcript
                }
                (searchVault(texts, query) + searchTranscriptHits(transcripts, query)).take(250)
            }
        }
    }

    fun openHomeworkNote() {
        viewModelScope.launch {
            val text = serializeHomeworkMarkdown(homework.value)
            withContext(Dispatchers.IO) {
                val path = ch.fasrv.fanotes.desk.HOMEWORK_NOTE_PATH
                if (!graph.vault.exists(path)) graph.store.createMarkdown("", "Hausaufgaben")
                val note = graph.store.readNote(path)
                graph.store.save(note, note.document, text)
            }
            graph.engine.notifyLocalChange()
            refreshTree()
            openPath(ch.fasrv.fanotes.desk.HOMEWORK_NOTE_PATH)
            showDestination("notes")
        }
    }

    fun loadHomework() {
        viewModelScope.launch {
            homework.value = withContext(Dispatchers.IO) {
                parseHomeworkMarkdown(graph.vault.read(ch.fasrv.fanotes.desk.HOMEWORK_NOTE_PATH)?.decodeToString().orEmpty())
            }
        }
    }

    fun addHomework(
        title: String,
        subject: String,
        due: String,
        kind: String,
        dueTime: String = "",
        notes: String = "",
        priority: String = "normal",
    ) {
        val draft = ch.fasrv.fanotes.desk.prepareHomeworkDraft(title, notes, subject, due, dueTime, kind, priority) ?: return
        val now = isoNow()
        val task = HomeworkTask(
            java.util.UUID.randomUUID().toString(),
            draft.title,
            notes = draft.notes,
            subject = draft.subject,
            dueDate = draft.dueDate,
            dueTime = draft.dueTime,
            kind = draft.kind,
            priority = draft.priority,
            createdAt = now,
            updatedAt = now,
        )
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

    fun removeHomework(id: String) {
        val next = homework.value.copy(tasks = ch.fasrv.fanotes.desk.removeHomeworkTask(homework.value.tasks, id))
        if (next.tasks.size == homework.value.tasks.size) return
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
        val authorization = previous.ifBlank { secret }
        val snapshot = homework.value
        viewModelScope.launch {
            val remote = withContext(Dispatchers.IO) { fetchHomeworkTasks(channel, secret) }
            val source = if (remote != null && homework.value == snapshot) {
                mergeHomeworkFromRemote(snapshot, remote)
            } else {
                homework.value
            }
            if (source != homework.value) {
                homework.value = source
                persistSpecial(ch.fasrv.fanotes.desk.HOMEWORK_NOTE_PATH, "Hausaufgaben", serializeHomeworkMarkdown(source))
            }
            val result = withContext(Dispatchers.IO) {
                runCatching {
                    val body = homeworkPublishBody(true, secret, previous.ifBlank { null }, source.tasks)
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
            if (result == "Hausaufgaben veröffentlicht.") {
                val remembered = rememberPublishedHomeworkIds(source, source.tasks.map { it.id })
                if (homework.value.tasks == source.tasks && remembered.publishedIds != homework.value.publishedIds) {
                    homework.value = remembered
                    persistSpecial(ch.fasrv.fanotes.desk.HOMEWORK_NOTE_PATH, "Hausaufgaben", serializeHomeworkMarkdown(remembered))
                }
                updateDesk("homework-previous", "")
            }
        }
    }

    private fun fetchHomeworkTasks(channel: String, secret: String): List<HomeworkTask>? = runCatching {
        val request = okhttp3.Request.Builder()
            .url(homeworkPublishUrl(channel))
            .header("Accept", "application/json")
            .header("X-FaNotes-Homework", "1")
            .header("Authorization", "Bearer $secret")
            .get()
            .build()
        okhttp3.OkHttpClient().newCall(request).execute().use { response ->
            if (!response.isSuccessful) return null
            homeworkTasksFromApiJson(response.body?.string().orEmpty())
        }
    }.getOrNull()

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

    fun moveCalendarOccurrence(key: String, start: java.time.LocalDateTime) {
        saveCalendar(ch.fasrv.fanotes.desk.moveCalendarOccurrence(calendar.value, key, start))
    }

    fun resizeCalendarOccurrence(key: String, end: java.time.LocalDateTime) {
        saveCalendar(ch.fasrv.fanotes.desk.resizeCalendarOccurrence(calendar.value, key, end))
    }

    private fun saveCalendar(next: ch.fasrv.fanotes.desk.CalendarDocument) {
        calendar.value = next
        persistSpecial(ch.fasrv.fanotes.desk.CALENDAR_NOTE_PATH, "Kalender", serializeCalendarMarkdown(next))
    }

    fun swapSplit() {
        val target = swappedSplit(open.value?.path, splitPath.value)?.first ?: return
        openPath(target, force = true)
    }

    private suspend fun swapSplitNow() {
        val split = splitNote ?: return
        val main = open.value ?: return
        if (swappedSplit(main.path, split.path) == null) return
        saveNow()
        val savedSplit = withContext(Dispatchers.IO) {
            graph.store.save(split, splitSession.document, split.markdown)
        }
        val mainDocument = session.document
        val mainMarkdown = markdown.value
        val mainNote = open.value ?: main
        session.replace(savedSplit.document)
        splitSession.replace(mainDocument)
        splitNote = mainNote.copy(markdown = mainMarkdown, document = mainDocument)
        splitMarkdown.value = mainMarkdown
        splitFolded.value = foldsForSections(mainMarkdown, mainDocument)
        splitPath.value = mainNote.path
        open.value = noteOpened(savedSplit)
        markdown.value = savedSplit.markdown
        foldedHeadings.value = foldsForSections(savedSplit.markdown, savedSplit.document)
        rememberTab(savedSplit.path)
        rememberTags(savedSplit.path, savedSplit.markdown)
        refreshBacklinks(savedSplit.path)
        refreshOverlays()
        loadBackdrop(savedSplit)
        refreshBook(savedSplit)
        noteTrail.value = visitNote(noteTrail.value, savedSplit.path)
        rememberLastOpen(savedSplit.path)
        unsaved.value = false
        savePhase.value = "saved"
        splitUnsaved.value = false
        canvasToken.value += 1
        persistWorkspace()
    }

    /** Puts [path] in the second pane. The open note stays in the main pane. */
    fun openInSplit(path: String) {
        val target = splitPanePath(path, open.value?.path, openTabs.value, noteTrail.value.entries)
        if (target == null) {
            message.value = "Öffne zuerst eine zweite Notiz für die geteilte Ansicht."
            return
        }
        if (target == splitPath.value) return
        flushSplit()
        loadSplit(target)
    }

    /** Ctrl+\ on the desktop: open the second pane, or close it when it is already open. */
    fun toggleSplit() {
        if (splitPath.value != null) {
            closeSplit()
            return
        }
        val active = open.value?.path ?: return
        openInSplit(active)
    }

    fun loadSplit(path: String) {
        if (path.isBlank() || path == splitPath.value) return
        splitUnsaved.value = false
        splitFolded.value = emptySet()
        val generation = ++splitGeneration
        viewModelScope.launch {
            val note = try {
                withContext(Dispatchers.IO) { graph.store.readNote(path) }
            } catch (error: Exception) {
                if (generation == splitGeneration) message.value = error.message ?: "Die Notiz konnte nicht geöffnet werden."
                return@launch
            }
            if (generation != splitGeneration) return@launch
            splitSession.replace(note.document)
            splitNote = note
            splitMarkdown.value = note.markdown
            splitFolded.value = foldsForSections(note.markdown, note.document)
            rememberTab(path)
            rememberTags(path, note.markdown)
            splitPath.value = path
            splitUnsaved.value = false
            persistWorkspace()
        }
    }

    fun toggleSplitSection(id: String) {
        val sorted = ch.fasrv.fanotes.ink.sectionsOf(splitSession.document).sortedBy { it.top }
        val index = sorted.indexOfFirst { it.id == id }
        splitSession.replace(ch.fasrv.fanotes.ink.toggleSection(splitSession.document, id))
        val collapsed = ch.fasrv.fanotes.ink.sectionsOf(splitSession.document).find { it.id == id }?.collapsed == true
        val line = if (index >= 0) ch.fasrv.fanotes.desk.headingLineForSection(splitMarkdown.value, index) else null
        if (line != null) {
            splitFolded.value = if (collapsed) splitFolded.value + line else splitFolded.value - line
        }
        splitChanged()
    }

    fun toggleSplitHeading(line: Int) {
        if (ch.fasrv.fanotes.desk.headingFoldRange(splitMarkdown.value, line) == null && line !in splitFolded.value) return
        val collapse = line !in splitFolded.value
        splitFolded.value = if (collapse) splitFolded.value + line else splitFolded.value - line
        syncHeadingSection(splitSession, splitMarkdown.value, line, collapse)
        splitChanged()
    }

    fun toggleSplitHeadingAtVisibleLine(visibleLine: Int) {
        val line = ch.fasrv.fanotes.desk.headingLineForFoldMarker(splitMarkdown.value, splitFolded.value, visibleLine) ?: return
        toggleSplitHeading(line)
    }

    fun foldSplitCommand(command: String, visibleOffset: Int) {
        val next = ch.fasrv.fanotes.desk.headingFoldCommand(splitMarkdown.value, splitFolded.value, command, visibleOffset) ?: return
        val previous = splitFolded.value
        if (next == previous) return
        splitFolded.value = next
        for (line in next - previous) syncHeadingSection(splitSession, splitMarkdown.value, line, true)
        for (line in previous - next) syncHeadingSection(splitSession, splitMarkdown.value, line, false)
        splitChanged()
    }

    private fun syncHeadingSection(target: ch.fasrv.fanotes.ink.InkSession, markdown: String, line: Int, collapse: Boolean) {
        val index = ch.fasrv.fanotes.desk.sectionIndexForHeading(markdown, line)
        if (index < 0) return
        val section = ch.fasrv.fanotes.ink.sectionsOf(target.document).sortedBy { it.top }.getOrNull(index) ?: return
        if (section.collapsed == collapse) return
        target.replace(ch.fasrv.fanotes.ink.toggleSection(target.document, section.id))
    }

    /** An edit of the text visible in the split, leaving folded heading bodies in the note. */
    fun updateSplitVisible(previousVisible: String, nextVisible: String) {
        if (previousVisible == nextVisible) return
        if (splitFolded.value.isEmpty()) {
            updateSplitMarkdown(nextVisible)
            return
        }
        val full = ch.fasrv.fanotes.desk.applyFoldedEdit(splitMarkdown.value, splitFolded.value, previousVisible, nextVisible)
        splitFolded.value = ch.fasrv.fanotes.desk.shiftFoldedLines(splitMarkdown.value, full, splitFolded.value)
        updateSplitMarkdown(full)
    }

    fun updateSplitMarkdown(value: String) {
        val note = splitNote ?: return
        if (value == splitMarkdown.value) return
        splitNote = note.copy(markdown = value)
        splitMarkdown.value = value
        rememberTags(note.path, value)
        scheduleSplitSave()
    }

    fun splitChanged() {
        if (splitNote == null) return
        scheduleSplitSave()
    }

    private fun scheduleSplitSave() {
        splitUnsaved.value = true
        val generation = ++splitSaveGeneration
        splitSaveJob?.cancel()
        splitSaveJob = viewModelScope.launch {
            kotlinx.coroutines.delay(ch.fasrv.fanotes.desk.editorMetrics(deskSettings.value).autosaveMs)
            val note = splitNote ?: return@launch
            val text = splitMarkdown.value
            val document = splitSession.document
            splitNote = withContext(Dispatchers.IO) { graph.store.save(note.copy(markdown = text), document, text) }
            graph.engine.notifyLocalChange()
            if (generation == splitSaveGeneration) splitUnsaved.value = false
        }
    }

    fun defaultCreateFolder(): String {
        val folders = mutableSetOf<String>()
        fun walk(nodes: List<VaultNode>) {
            for (node in nodes) {
                if (node.kind == NoteKind.FOLDER) {
                    folders += node.path
                    walk(node.children)
                }
            }
        }
        walk(tree.value)
        return ch.fasrv.fanotes.desk.defaultNoteParent(deskSettings.value["default-folder"], folders)
    }

    fun openDaily(day: java.time.LocalDate = java.time.LocalDate.now()) {
        val folder = deskSettings.value["daily-folder"].orEmpty().ifBlank { "Tagesnotizen" }
        val pattern = deskSettings.value["date-format"].orEmpty().ifBlank { "YYYY-MM-DD" }
        val path = dailyNotePath(folder, day, pattern)
        val title = path.substringAfterLast('/').removeSuffix(".md")
        viewModelScope.launch {
            val exists = withContext(Dispatchers.IO) { graph.vault.exists(path) }
            if (!exists) {
                val created = withContext(Dispatchers.IO) { graph.store.createMarkdown(folder, title, paper = ch.fasrv.fanotes.desk.penSettings(deskSettings.value).paper) }
                val note = withContext(Dispatchers.IO) { graph.store.readNote(created) }
                withContext(Dispatchers.IO) { graph.store.save(note, note.document, "# $title\n") }
            }
            refreshTree()
            openPath(path, force = true)
            destination.value = "notes"
            message.value = ch.fasrv.fanotes.desk.dailyNoteStatus(!exists, title)
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
            val restored = stripFamdPayload(file.content)
            updateMarkdown(restored)
            foldedHeadings.value = foldsForSections(restored, session.document)
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

    fun openWikiTarget(target: String, anchor: String? = null) {
        val file = target.substringBefore('#').trim()
        val hash = anchor?.trim()?.removePrefix("#")?.takeIf { it.isNotEmpty() }
            ?: target.substringAfter('#', "").trim().takeIf { it.isNotEmpty() }
        if (file.isEmpty()) return
        val path = resolveWikiTarget(file, flatNotes().map { it.path }, open.value?.path)
        if (path == null) {
            message.value = "Keine Notiz für [[${file}]]."
            return
        }
        if (open.value?.path == path) jumpToHeading(markdown.value, hash)
        else openPath(path, headingAnchor = hash)
        destination.value = "notes"
    }

    private fun jumpToHeading(markdown: String, anchor: String?) {
        val line = anchor?.let { ch.fasrv.fanotes.desk.headingAnchorLine(markdown, it) } ?: return
        showText.value = true
        outlineJump.value = line
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

    fun wordCountNow() = ch.fasrv.fanotes.desk.statusWordCount(markdown.value)
    fun linksNow() = wikiTargets(markdown.value)

    fun applyProfile(profile: String, names: Set<String>? = null) {
        viewModelScope.launch {
            withContext(Dispatchers.IO) {
                val existing = graph.vault.walkFiles().map { it.path }
                val templates = templatesToSeed(existing, profile)
                var colors = graph.vault.read(FOLDER_COLORS_PATH)?.decodeToString()?.let(::parseFolderColors).orEmpty()
                for (folder in profileFolders(profile)) {
                    if (names != null && folder.name !in names) continue
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

    fun updateCustomCss(value: String) {
        val stored = value.take(ch.fasrv.fanotes.desk.CUSTOM_CSS_MAX)
        customCss.value = stored
        graph.writeCustomCss(stored)
    }

    fun effectiveDesk(): Map<String, String> = ch.fasrv.fanotes.desk.deskWithCustomCss(deskSettings.value, customCss.value)

    fun updateDesk(key: String, value: String) {
        val next = deskSettings.value + (key to value)
        deskSettings.value = next
        graph.writeDesk(next)
    }

    fun runAi(
        provider: String,
        baseUrl: String,
        modelName: String,
        apiKey: String,
        username: String,
        actions: List<String>,
        instruction: String,
    ) {
        val note = open.value
        if (note == null) {
            aiStatus.value = "Öffne zuerst eine Notiz."
            return
        }
        val notes = flatNotes().filter { it.path != note.path }.map { it.name to it.path }
        val source = markdown.value
        viewModelScope.launch {
            aiStatus.value = "Die Notiz wird bearbeitet…"
            val outcome = withContext(Dispatchers.IO) {
                runCatching {
                    val job = ch.fasrv.fanotes.desk.prepareAiJob(
                        provider, baseUrl, modelName, actions, instruction, note.title, note.path, source, notes,
                    )
                    if (job.provider == "opencode") openCodeTransform(job, apiKey, username, note.title)
                    else {
                        val call = ch.fasrv.fanotes.desk.aiTransformCall(job, apiKey, username)
                        ch.fasrv.fanotes.desk.aiReplyText(job.provider, executeAi(call))
                    }
                }
            }
            outcome.onSuccess { text ->
                aiPreview.value = text
                aiStatus.value = "Vorschau bereit."
            }.onFailure { error ->
                aiStatus.value = error.message ?: "Die Anfrage ist fehlgeschlagen."
            }
        }
    }

    fun loadAiModels(provider: String, baseUrl: String, apiKey: String, username: String) {
        viewModelScope.launch {
            aiStatus.value = "Modelle werden geladen…"
            val outcome = withContext(Dispatchers.IO) {
                runCatching {
                    val local = ch.fasrv.fanotes.desk.AI_PROVIDERS.firstOrNull { it.id == provider }?.local == true
                    val origin = if (local) {
                        ch.fasrv.fanotes.desk.localAiOrigin(baseUrl.ifBlank { ch.fasrv.fanotes.desk.defaultAiBaseUrl(provider) }, provider)
                    } else {
                        ""
                    }
                    val request = ch.fasrv.fanotes.desk.aiModelsGet(provider, origin, apiKey, username)
                    ch.fasrv.fanotes.desk.parseAiModels(provider, executeAiGet(request))
                }
            }
            outcome.onSuccess { models ->
                aiModels.value = models
                aiStatus.value = if (models.isEmpty()) "Keine Modelle gefunden." else "${models.size} Modelle."
            }.onFailure { error ->
                aiModels.value = emptyList()
                aiStatus.value = error.message ?: "Die Modellliste ist fehlgeschlagen."
            }
        }
    }

    fun applyAiPreview() {
        val text = aiPreview.value ?: return
        updateMarkdown(text)
        aiPreview.value = null
        aiStatus.value = "Die Notiz wurde übernommen."
    }

    private fun executeAiGet(request: ch.fasrv.fanotes.desk.AiGet): String {
        val builder = okhttp3.Request.Builder().url(request.url).get()
        request.headers.forEach { (name, value) -> builder.header(name, value) }
        val client = okhttp3.OkHttpClient.Builder()
            .connectTimeout(10, java.util.concurrent.TimeUnit.SECONDS)
            .readTimeout(20, java.util.concurrent.TimeUnit.SECONDS)
            .build()
        return client.newCall(builder.build()).execute().use { response ->
            val text = response.body?.string().orEmpty()
            if (!response.isSuccessful) throw IllegalArgumentException("Der Anbieter antwortete mit HTTP ${response.code}.")
            text
        }
    }

    private fun executeAi(call: ch.fasrv.fanotes.desk.AiCall): String {
        val builder = okhttp3.Request.Builder().url(call.url)
        call.headers.forEach { (name, value) -> builder.header(name, value) }
        builder.post(call.body.toByteArray().toRequestBody("application/json".toMediaType()))
        return aiHttp().newCall(builder.build()).execute().use { response ->
            val text = response.body?.string().orEmpty()
            if (!response.isSuccessful) throw IllegalArgumentException("Der Anbieter antwortete mit HTTP ${response.code}.")
            text
        }
    }

    private fun openCodeTransform(job: ch.fasrv.fanotes.desk.AiJob, apiKey: String, username: String, title: String): String {
        val headers = ch.fasrv.fanotes.desk.authHeaders("opencode", apiKey, username)
        val session = executeAi(ch.fasrv.fanotes.desk.AiCall("${job.origin}/session", headers, ch.fasrv.fanotes.desk.openCodeSessionBody(title)))
        val id = (ch.fasrv.fanotes.json.parseJson(session) as? ch.fasrv.fanotes.json.JsonValue.Obj)?.string("id")
            ?: throw IllegalArgumentException("OpenCode konnte keine kurzlebige Sitzung erstellen.")
        val encoded = java.net.URLEncoder.encode(id, Charsets.UTF_8)
        return try {
            val message = executeAi(
                ch.fasrv.fanotes.desk.AiCall(
                    "${job.origin}/session/$encoded/message",
                    headers,
                    ch.fasrv.fanotes.desk.openCodeMessageBody(job.model, job.prompt),
                ),
            )
            ch.fasrv.fanotes.desk.aiReplyText("opencode", message)
        } finally {
            runCatching {
                val delete = okhttp3.Request.Builder().url("${job.origin}/session/$encoded").delete()
                headers.forEach { (name, value) -> delete.header(name, value) }
                aiHttp().newCall(delete.build()).execute().close()
            }
        }
    }

    private fun aiHttp(): okhttp3.OkHttpClient = okhttp3.OkHttpClient.Builder()
        .connectTimeout(20, java.util.concurrent.TimeUnit.SECONDS)
        .readTimeout(600, java.util.concurrent.TimeUnit.SECONDS)
        .writeTimeout(60, java.util.concurrent.TimeUnit.SECONDS)
        .build()

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
