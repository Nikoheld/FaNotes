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
import ch.fasrv.fanotes.desk.parseFolderColors
import ch.fasrv.fanotes.desk.resolveMarkdownConflict
import ch.fasrv.fanotes.desk.serializeFolderColors
import ch.fasrv.fanotes.desk.withFolderColor
import ch.fasrv.fanotes.desk.parseHomeworkMarkdown
import ch.fasrv.fanotes.desk.parseSubjectBooks
import ch.fasrv.fanotes.desk.parseWorksheetBoxes
import ch.fasrv.fanotes.desk.searchVault
import ch.fasrv.fanotes.desk.serializeCalendarMarkdown
import ch.fasrv.fanotes.desk.serializeHomeworkMarkdown
import ch.fasrv.fanotes.desk.wikiTargets
import ch.fasrv.fanotes.desk.wordCount
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
            val loaded = withContext(Dispatchers.IO) {
                graph.store.tree() to (graph.vault.read(FOLDER_COLORS_PATH)?.decodeToString()?.let(::parseFolderColors).orEmpty())
            }
            tree.value = loaded.first
            folderColors.value = loaded.second
        }
    }

    fun openPath(path: String, force: Boolean = false) {
        viewModelScope.launch {
            if (!force) saveNow()
            val note = withContext(Dispatchers.IO) { graph.store.readNote(path) }
            session.replace(note.document)
            open.value = note
            markdown.value = note.markdown
            rememberTab(path)
            refreshOverlays()
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

    fun refreshOverlays() {
        val note = open.value
        viewModelScope.launch {
            val links = ch.fasrv.fanotes.desk.parseNoteLinkMarks(note?.payload)
            val boxes = withContext(Dispatchers.IO) {
                val worksheet = note?.worksheets?.firstOrNull() ?: return@withContext emptyList()
                graph.vault.read(".fanotes/worksheets/$worksheet.json")?.decodeToString()?.let(::parseWorksheetBoxes).orEmpty()
            }
            noteLinks.value = links
            worksheetBoxes.value = boxes
        }
    }

    fun placeNoteLink(x: Double, y: Double) {
        val source = open.value ?: return
        viewModelScope.launch {
            val created = withContext(Dispatchers.IO) {
                graph.store.createMarkdown("", "${source.title} Notiz")
            }
            val link = ch.fasrv.fanotes.desk.NoteLinkMark(
                id = "nl-${System.currentTimeMillis().toString(36)}",
                sourcePath = source.path,
                targetPath = created,
                x = x.coerceIn(0.0, 1.0),
                y = y.coerceIn(0.0, 1.0),
                label = created.substringAfterLast('/').substringBeforeLast('.'),
            )
            val links = ch.fasrv.fanotes.desk.parseNoteLinkMarks(source.payload) + link
            val payload = (source.payload.deepCopy() as ch.fasrv.fanotes.json.JsonValue.Obj)
            payload.put("noteLinks", ch.fasrv.fanotes.desk.noteLinksJson(links))
            open.value = source.copy(payload = payload)
            noteLinks.value = links
            noteChanged()
            refreshTree()
        }
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
    val searchQuery = MutableStateFlow("")
    val searchHits = MutableStateFlow<List<SearchHit>>(emptyList())
    val homework = MutableStateFlow(HomeworkDocument(emptyList()))
    val calendar = MutableStateFlow(emptyCalendar())
    val books = MutableStateFlow<List<SubjectBook>>(emptyList())
    val folderColors = MutableStateFlow<Map<String, String>>(emptyMap())
    val noteHistory = MutableStateFlow<List<HistorySnapshot>>(emptyList())
    val deskSettings = MutableStateFlow(graph.readDesk())
    val splitPath = MutableStateFlow<String?>(null)
    val splitSession = InkSession(newInkDocument("Spalte", "dots", isoNow()))
    private var splitNote: OpenNote? = null
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
        }
    }

    fun rememberTab(path: String) {
        openTabs.value = (listOf(path) + openTabs.value.filterNot { it == path }).take(12)
    }

    fun searchVaultText(query: String) {
        searchQuery.value = query
        viewModelScope.launch {
            searchHits.value = withContext(Dispatchers.IO) {
                val files = graph.vault.walkFiles().filter { it.path.endsWith(".md") || it.path.endsWith(".markdown") }
                searchVault(files.map { it.path to (graph.vault.read(it.path)?.decodeToString().orEmpty()) }, query)
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
    }

    fun toggleHomework(id: String) {
        val next = homework.value.copy(tasks = homework.value.tasks.map { if (it.id == id) it.copy(done = !it.done, updatedAt = isoNow()) else it })
        homework.value = next
        persistSpecial(ch.fasrv.fanotes.desk.HOMEWORK_NOTE_PATH, "Hausaufgaben", serializeHomeworkMarkdown(next))
    }

    fun loadCalendar() {
        viewModelScope.launch {
            calendar.value = withContext(Dispatchers.IO) {
                parseCalendarMarkdown(graph.vault.read(ch.fasrv.fanotes.desk.CALENDAR_NOTE_PATH)?.decodeToString().orEmpty())
            }
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

    fun addCalendarEvent(title: String, day: String, calendarId: String, recurrence: String = "none") {
        val event = CalendarEvent(
            java.util.UUID.randomUUID().toString(),
            calendarId,
            title.trim(),
            day,
            day,
            recurrence = if (recurrence in setOf("daily", "weekly", "monthly", "yearly")) recurrence else "none",
        )
        val next = calendar.value.copy(events = calendar.value.events + event)
        calendar.value = next
        persistSpecial(ch.fasrv.fanotes.desk.CALENDAR_NOTE_PATH, "Kalender", serializeCalendarMarkdown(next))
    }

    fun loadSplit(path: String) {
        viewModelScope.launch {
            val note = withContext(Dispatchers.IO) { graph.store.readNote(path) }
            splitSession.replace(note.document)
            splitNote = note
            splitPath.value = path
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

    fun refreshNoteHistory() {
        val note = open.value
        if (note == null) {
            noteHistory.value = emptyList()
            return
        }
        viewModelScope.launch {
            noteHistory.value = withContext(Dispatchers.IO) { listNoteHistory(graph.vault, historyPathFor(note)) }
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

    fun backlinks(): List<String> {
        val title = open.value?.title ?: return emptyList()
        return searchHits.value.filter { it.text.contains("[[$title") }.map { it.path }.distinct()
    }

    fun findBacklinks() {
        val title = open.value?.title ?: return
        searchVaultText("[[$title")
    }

    fun wordCountNow() = wordCount(markdown.value)
    fun linksNow() = wikiTargets(markdown.value)

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
