package ch.fasrv.fanotes.companion

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.widget.Toast
import androidx.core.content.FileProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import ch.fasrv.fanotes.desk.CalendarDocument
import ch.fasrv.fanotes.desk.HomeworkTask
import ch.fasrv.fanotes.desk.emptyCalendar
import ch.fasrv.fanotes.ink.InkDocument
import ch.fasrv.fanotes.schulnetz.AgendaEvent
import ch.fasrv.fanotes.schulnetz.CollectiveGrade
import ch.fasrv.fanotes.schulnetz.DeskPrefs
import ch.fasrv.fanotes.schulnetz.cleaned
import ch.fasrv.fanotes.schulnetz.normalized
import ch.fasrv.fanotes.schulnetz.GradeAdjustment
import ch.fasrv.fanotes.schulnetz.GradeBook
import ch.fasrv.fanotes.schulnetz.HiddenLesson
import ch.fasrv.fanotes.schulnetz.HypotheticalGrade
import ch.fasrv.fanotes.schulnetz.OwnGrade
import ch.fasrv.fanotes.schulnetz.NotifySettings
import ch.fasrv.fanotes.schulnetz.SchulnetzSnapshot
import ch.fasrv.fanotes.schulnetz.hideOnce
import ch.fasrv.fanotes.schulnetz.hideSeries
import ch.fasrv.fanotes.schulnetz.homeNavId
import ch.fasrv.fanotes.schulnetz.startTabId
import ch.fasrv.fanotes.schulnetz.validateNavBar
import ch.fasrv.fanotes.schulnetz.SCHULNETZ_USER_AGENT
import ch.fasrv.fanotes.schulnetz.SSO_COOKIE_URLS
import ch.fasrv.fanotes.schulnetz.cookieNames
import ch.fasrv.fanotes.schulnetz.extractWebSession
import ch.fasrv.fanotes.schulnetz.normalizeSchoolBase
import ch.fasrv.fanotes.schulnetz.redactSchulnetzSecrets
import ch.fasrv.fanotes.schulnetz.stripPhpSession
import ch.fasrv.fanotes.schulnetz.timetableAnchor
import ch.fasrv.fanotes.schulnetz.usesWebsiteSession
import ch.fasrv.fanotes.schulnetz.webLoginUrl
import ch.fasrv.fanotes.vault.VaultNode
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import android.webkit.CookieManager
import java.io.File
import java.net.URI
import java.time.LocalDate
import java.util.UUID

class CompanionModel(val graph: CompanionGraph) : ViewModel() {
    var desk by mutableStateOf(ch.fasrv.fanotes.schulnetz.DeskPrefs(theme = graph.themeId()))
    var hidden by mutableStateOf(emptyList<ch.fasrv.fanotes.schulnetz.HiddenLesson>())
    var route by mutableStateOf(CompanionRoute())
        private set
    private var startTabApplied = false
    private var history = emptyList<CompanionRoute>()
    var localAccess by mutableStateOf(graph.localAccess())
    var plannerTasks by mutableStateOf(false)
    var taskSource by mutableStateOf("open")
    var tree by mutableStateOf<List<VaultNode>>(emptyList())
    var loading by mutableStateOf(true)
    var loadError by mutableStateOf<String?>(null)
    var editor by mutableStateOf<NoteEditorController?>(null)
        private set
    private val writes = kotlinx.coroutines.sync.Mutex()
    private var reloadJob: kotlinx.coroutines.Job? = null
    private var deskGeneration = 0L
    private var deskPending = 0
    private val searchCache = object : android.util.LruCache<String, Pair<Long, String>>(8 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Pair<Long, String>) = value.second.length.coerceAtMost(Int.MAX_VALUE / 2) * 2
    }
    private val previewCache = object : android.util.LruCache<String, Pair<Long, NotePreview>>(24) {}

    fun select(destination: Destination) {
        selectNav(when (destination) {
            Destination.Today -> "today"
            Destination.Planner -> "planner"
            Destination.Notes -> "notes"
            Destination.School -> "school"
        })
    }
    fun selectNav(id: String) {
        val placement = navPlacement(id)
        history = emptyList()
        plannerTasks = placement.plannerTasks
        route = placement.route
        highlightIds = emptySet()
        focusCourseId = ""
    }
    fun navigate(page: Page) {
        history = history + route
        route = route.copy(page = page)
    }
    fun openSettings() {
        if ("settings" in validateNavBar(desk.navBar)) selectNav("settings")
        else navigate(Page.Settings)
    }
    fun atNavRoot(): Boolean = isAtNavRoot(route, plannerTasks, desk.startTab, desk.navBar, noteFolder, history.isNotEmpty())
    fun back() {
        if (history.isNotEmpty()) {
            route = history.last()
            history = history.dropLast(1)
            return
        }
        if (route.page == Page.Course) {
            route = route.copy(page = Page.Grades)
            return
        }
        if (route.destination == Destination.Notes && noteFolder.isNotBlank()) {
            openFolder(noteFolder.substringBeforeLast('/', ""))
            return
        }
        val bar = validateNavBar(desk.navBar)
        val chrome = navChromeId(route, plannerTasks, bar)
        val home = homeNavId(desk.startTab, bar)
        if (chrome != null && chrome in bar) {
            if (chrome != home) selectNav(home)
            return
        }
        if (route.page != null) {
            route = route.copy(page = null)
            return
        }
        if (chrome != home) selectNav(home)
    }
    fun continueLocally() { localAccess = true; graph.setLocalAccess(true); message = null }
    fun openPlanner(tasks: Boolean = false, date: LocalDate = LocalDate.now()) {
        selectNav(if (tasks) "tasks" else "planner"); day = date
    }
    fun openFolder(path: String) { noteFolder = path; reload() }
    fun openNote(path: String) {
        editorPath = path
        editor = NoteEditorController(graph, viewModelScope, path)
        navigate(Page.Editor)
    }
    fun closeEditor() {
        val current = editor ?: return
        viewModelScope.launch {
            if (current.close()) { editor = null; editorPath = null; back(); reload() }
        }
    }
    fun perform(success: String? = null, onSuccess: () -> Unit = {}, action: () -> Unit) {
        viewModelScope.launch {
            try {
                writes.lock()
                try { withContext(Dispatchers.IO) { action() } } finally { writes.unlock() }
                onSuccess()
                reload()
                if (success != null) message = success
            } catch (error: Exception) {
                if (error is kotlinx.coroutines.CancellationException) throw error
                reload()
                message = error.message ?: "Could not save. Please try again."
            }
        }
    }
    var message by mutableStateOf<String?>(null)
    var busy by mutableStateOf(false)
    var email by mutableStateOf("")
    var password by mutableStateOf("")
    var snapshot by mutableStateOf(graph.snapshot.value)
    var link by mutableStateOf(graph.link.value)
    var notes by mutableStateOf<List<VaultNode>>(emptyList())
    var noteFolder by mutableStateOf("")
    var writtenNotes by mutableStateOf(0)
    var tasks by mutableStateOf<List<HomeworkTask>>(emptyList())
    var calendar by mutableStateOf<CalendarDocument>(emptyCalendar())
    var hypothetical by mutableStateOf<List<HypotheticalGrade>>(emptyList())
    var gradeBook by mutableStateOf(GradeBook())
    var theme by mutableStateOf(graph.themeId())
    var baseUrl by mutableStateOf(graph.baseUrl())
    var settings by mutableStateOf(graph.notifySettings())
    var day by mutableStateOf(LocalDate.now())
    var editorPath by mutableStateOf<String?>(null)
    var debugHtml by mutableStateOf("")
    var highlightIds by mutableStateOf<Set<String>>(emptySet())
    var focusCourseId by mutableStateOf("")
    var unrevealedIds by mutableStateOf(graph.unrevealedGradeIds())
    var revealQueue by mutableStateOf<List<String>>(emptyList())

    fun hiddenGradeIds(): Set<String> = if (settings.guessGrades) unrevealedIds else emptySet()
    fun isUnrevealed(targetId: String): Boolean = targetId.isNotBlank() && targetId in hiddenGradeIds()
    fun refreshUnrevealed() { unrevealedIds = graph.unrevealedGradeIds() }
    fun openReveal(ids: Collection<String>) {
        val next = ids.filter { isUnrevealed(it) }.distinct()
        if (next.isNotEmpty()) revealQueue = next
    }
    fun revealGrade(targetId: String) {
        graph.revealGrade(targetId)
        unrevealedIds = graph.unrevealedGradeIds()
    }
    fun finishReveal() {
        revealQueue = revealQueue.drop(1)
    }
    fun dismissReveal() { revealQueue = emptyList() }

    init {
        viewModelScope.launch { graph.snapshot.collect { snapshot = it; refreshUnrevealed() } }
        viewModelScope.launch { graph.link.collect { link = it } }
        viewModelScope.launch { graph.vaultChanges.collectLatest { kotlinx.coroutines.delay(200); reload() } }
        reload()
    }

    fun reload() {
        val generation = deskGeneration
        reloadJob?.cancel()
        reloadJob = viewModelScope.launch {
            try {
                val data = withContext(Dispatchers.IO) {
                    val nextTree = graph.store.tree()
                    val folder = if (ch.fasrv.fanotes.vault.folderExists(nextTree, noteFolder)) noteFolder else ""
                    Reloaded(nextTree, folder, ch.fasrv.fanotes.vault.folderChildren(nextTree, folder).filter { it.path !in setOf(ch.fasrv.fanotes.desk.HOMEWORK_NOTE_PATH, ch.fasrv.fanotes.desk.CALENDAR_NOTE_PATH) },
                        runCatching { graph.homework().tasks }, runCatching { graph.calendar() }, graph.hypothetical(), graph.gradeBook(), graph.writtenNoteCount(), graph.deskPrefs(), graph.hiddenLessons(), graph.subjectColors())
                }
                tree = data.tree; noteFolder = data.folder; notes = data.notes
                data.tasks.getOrNull()?.let { tasks = it }; data.calendar.getOrNull()?.let { calendar = it }
                hypothetical = data.guesses; gradeBook = data.book; writtenNotes = data.count; hidden = data.hidden; colors = data.colors
                if (generation == deskGeneration && deskPending == 0) {
                    desk = data.desk
                    if (!startTabApplied && history.isEmpty() && highlightIds.isEmpty() && route.page == null && route.destination == Destination.Today) {
                        startTabApplied = true
                        val placement = navPlacement(startTabId(data.desk.startTab))
                        plannerTasks = placement.plannerTasks
                        route = placement.route
                    }
                }
                loadError = listOfNotNull(data.tasks.exceptionOrNull()?.message, data.calendar.exceptionOrNull()?.message).joinToString("\n").ifBlank { null }
                val paths = flattenNotes(tree).map { it.path }.toSet()
                searchCache.snapshot().keys.filterNot { it in paths }.forEach { searchCache.remove(it) }
                previewCache.snapshot().keys.filterNot { it in paths }.forEach { previewCache.remove(it) }
            } catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
            catch (error: Exception) {
                if (error is kotlinx.coroutines.CancellationException) throw error
                loadError = error.message ?: "Could not read your local library." }
            finally { loading = false }
        }
    }

    private data class Reloaded(val tree: List<VaultNode>, val folder: String, val notes: List<VaultNode>, val tasks: Result<List<HomeworkTask>>,
        val calendar: Result<CalendarDocument>, val guesses: List<HypotheticalGrade>, val book: GradeBook, val count: Int, val desk: DeskPrefs, val hidden: List<HiddenLesson>, val colors: Map<String, String>)

    suspend fun loadPreview(node: VaultNode): NotePreview = withContext(Dispatchers.IO) {
        val hit = previewCache.get(node.path)
        if (hit != null && hit.first == node.modifiedAt) return@withContext hit.second
        val note = graph.store.readNote(node.path)
        NotePreview(noteExcerpt(note.markdown, note.title), note.document).also { previewCache.put(node.path, node.modifiedAt to it) }
    }
    suspend fun findNotes(query: String): List<NoteResult> = withContext(Dispatchers.IO) {
        flattenNotes(tree).mapNotNull { node ->
            kotlinx.coroutines.currentCoroutineContext().ensureActive()
            val cached = searchCache.get(node.path)
            val body = if (cached?.first == node.modifiedAt) cached.second else {
                val note = graph.store.readNote(node.path)
                searchableNoteText(note.markdown, note.document.extras.string("searchTranscript").orEmpty()).also { searchCache.put(node.path, node.modifiedAt to it) }
            }
            if (node.name.contains(query, true) || body.contains(query, true)) {
                val index = body.indexOf(query, ignoreCase = true).coerceAtLeast(0)
                NoteResult(node, plainPreview(body.substring((index - 30).coerceAtLeast(0))))
            } else null
        }.take(200)
    }

    fun login(register: Boolean) {
        if (email.isBlank() || password.isBlank()) {
            message = "Enter your email and password."
            return
        }
        busy = true
        viewModelScope.launch {
            try {
                if (register) graph.engine.register(email.trim(), password) else graph.engine.login(email.trim(), password)
                graph.engine.syncNow("phone")
                runCatching { graph.refreshSchulnetz("fa-notes-login") }
                continueLocally()
                password = ""
                reload()
                message = null
                if (route.page == Page.Auth) back()
            } catch (error: Exception) {
                if (error is kotlinx.coroutines.CancellationException) throw error
                message = error.message ?: "Sign in failed."
            } finally {
                busy = false
            }
        }
    }

    fun sync() {
        busy = true
        viewModelScope.launch {
            try {
                graph.engine.syncNow("phone")
                graph.refreshSchulnetz("sync-button")
                reload()
                message = syncDescription(graph.engine.state.value.status)
            } catch (error: Exception) {
                if (error is kotlinx.coroutines.CancellationException) throw error
                message = error.message ?: "Sync failed. Your local data is available."
            } finally {
                busy = false
            }
        }
    }

    fun logout() {
        viewModelScope.launch {
            runCatching { graph.engine.logout() }
            message = null
        }
    }

    fun requestVisibleLogin(caller: String) {
        if (busy) return
        val base = normalizeSchoolBase(baseUrl)
        if (base == null) { message = "This school address is not supported."; return }
        if (!usesWebsiteSession(base)) { message = "Web sign-in is not available for this school."; return }
        graph.setBaseUrl(base)
        baseUrl = base
        busy = true
        viewModelScope.launch {
            try { graph.runVisibleLogin(caller) }
            catch (error: Exception) {
                if (error is kotlinx.coroutines.CancellationException) throw error
                message = "Could not open school sign-in. Please try again."
            } finally { busy = false }
        }
    }

    fun onWebLoginFinished() {
        val html = SchulnetzLoginBridge.landingHtml
        val url = SchulnetzLoginBridge.landingUrl
        SchulnetzLoginBridge.landingHtml = ""
        SchulnetzLoginBridge.landingUrl = ""
        val web = extractWebSession(url, html, baseUrl)
        val php = phpSessionCookie(baseUrl)
        if (web == null) {
            graph.schulnetzLog.info("visible login bridge empty url=${redactSchulnetzSecrets(url)} cookieNames=${cookieNames(CookieManager.getInstance().getCookie(baseUrl).orEmpty()).joinToString("|")}")
            graph.finishVisibleLogin(null)
            message = "School sign-in cancelled."
            return
        }
        graph.finishVisibleLogin(web.copy(phpSessionId = php))
        message = "Schulnetz connected."
    }

    fun onWebLoginCancelled() {
        val viewing = graph.viewingSession
        graph.finishVisibleLogin(null)
        if (!viewing) message = "School sign-in cancelled."
    }

    fun shareDebug(context: Context) {
        val app = context.applicationContext
        viewModelScope.launch(Dispatchers.IO) {
            try {
                val raw = debugHtml.ifBlank { graph.debugHtml() }
                val body = buildString {
                    if (raw.isBlank()) appendLine("No school page has been saved.")
                    else append(redactSchulnetzSecrets(raw).take(400_000))
                    appendLine()
                    append(graph.shareMeta())
                }
                val file = File(app.cacheDir, "share").apply { mkdirs() }.resolve("schulnetz-seite.html")
                file.writeText(body)
                withContext(Dispatchers.Main) { shareFile(app, "Share school page", file, "text/html", body.take(20_000)) }
            } catch (error: Exception) {
                if (error is kotlinx.coroutines.CancellationException) throw error
                graph.schulnetzLog.error(error)
                withContext(Dispatchers.Main) {
                    Toast.makeText(app, "Could not share: ${error.message ?: "unknown"}", Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    fun shareLogs(context: Context) {
        val app = context.applicationContext
        viewModelScope.launch(Dispatchers.IO) {
            try {
                graph.schulnetzLog.info("share logs")
                val file = graph.buildShareZip()
                withContext(Dispatchers.Main) { shareFile(app, "Share diagnostics", file, "application/zip", "School diagnostics") }
            } catch (error: Exception) {
                if (error is kotlinx.coroutines.CancellationException) throw error
                graph.schulnetzLog.error(error)
                withContext(Dispatchers.Main) {
                    Toast.makeText(app, "Could not share: ${error.message ?: "unknown"}", Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    fun unlink() {
        if (busy) return
        busy = true
        viewModelScope.launch {
            try {
                graph.gate.exclusive("disconnect") {
                    val session = graph.engine.currentSession()
                    if (session != null) runCatching { graph.client.unlink(session) }
                    withContext(Dispatchers.IO) { graph.disconnectSchool() }
                }
                message = "Schulnetz disconnected."
            } catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
            catch (error: Exception) { message = error.message ?: "Could not disconnect school." }
            finally { busy = false }
        }
    }

    fun chooseTheme(id: String) {
        theme = id
        updateDesk(desk.copy(theme = id))
    }

    fun updateDesk(next: DeskPrefs) {
        desk = next
        theme = next.theme
        deskGeneration++
        deskPending++
        viewModelScope.launch {
            try {
                writes.lock()
                try { withContext(Dispatchers.IO) { graph.saveDeskPrefs(next) } } finally { writes.unlock() }
            } catch (error: Exception) {
                if (error is kotlinx.coroutines.CancellationException) throw error
                message = error.message ?: "Could not save your preferences." }
            finally { deskPending--; if (deskPending == 0) reload() }
        }
    }

    fun hideLesson(event: AgendaEvent, series: Boolean) {
        val next = if (series) hideSeries(event, hidden) else hideOnce(event, hidden)
        hidden = next
        perform { graph.saveHiddenLessons(next) }
    }

    fun restoreLesson(id: String) {
        val next = hidden.filterNot { it.id == id }
        hidden = next
        perform { graph.saveHiddenLessons(next) }
    }

    fun renameCourse(key: String, name: String) {
        val aliases = desk.courseAliases.toMutableMap()
        val stored = key.trim().lowercase()
        if (stored.isBlank()) return
        if (name.isBlank()) aliases.remove(stored) else aliases[stored] = name.trim()
        updateDesk(desk.copy(courseAliases = aliases))
    }

    fun toggleSetting(name: String) {
        val next = when (name) {
            "grades" -> settings.copy(grades = !settings.grades)
            "timetable" -> settings.copy(timetable = !settings.timetable)
            "exams" -> settings.copy(exams = !settings.exams)
            "absences" -> settings.copy(absences = !settings.absences)
            "deadlines" -> settings.copy(deadlines = !settings.deadlines)
            "guessGrades" -> settings.copy(guessGrades = !settings.guessGrades)
            else -> settings.copy(events = !settings.events)
        }
        settings = next
        graph.setNotifySettings(next)
        if (next.guessGrades) refreshUnrevealed() else revealQueue = emptyList()
    }

    fun toggleTask(task: HomeworkTask) {
        tasks = tasks.map { if (it.id == task.id) it.copy(done = !it.done) else it }
        perform { graph.setHomeworkDone(task.id, !task.done) }
    }
    fun saveTask(task: HomeworkTask, onSaved: () -> Unit, onError: (String) -> Unit = { message = it }) {
        viewModelScope.launch {
            try {
                writes.lock()
                try { withContext(Dispatchers.IO) { graph.saveHomeworkTask(task) } } finally { writes.unlock() }
                reload(); onSaved(); message = "Task saved"
            } catch (error: Exception) {
                if (error is kotlinx.coroutines.CancellationException) throw error
                onError(error.message ?: "Could not save task") }
        }
    }
    fun deleteTask(task: HomeworkTask) = perform("Task deleted") { graph.deleteHomeworkTask(task.id) }
    fun saveEvent(event: ch.fasrv.fanotes.desk.CalendarEvent, onSaved: () -> Unit, onError: (String) -> Unit = { message = it }) {
        viewModelScope.launch {
            try {
                writes.lock()
                try { withContext(Dispatchers.IO) { graph.saveCalendarEvent(event) } } finally { writes.unlock() }
                reload(); onSaved(); message = "Event saved"
            } catch (error: Exception) {
                if (error is kotlinx.coroutines.CancellationException) throw error
                onError(error.message ?: "Could not save event") }
        }
    }
    fun deleteEvent(event: ch.fasrv.fanotes.desk.CalendarEvent) = perform("Event deleted") { graph.deleteCalendarEvent(event.id) }

    fun importHomework(title: String, subject: String, due: String, notes: String) = perform("Added to your tasks") {
        graph.importHomework(title, subject, due, notes)
    }
    fun importExam(event: AgendaEvent) = perform("Added to your calendar") { graph.importExam(event) }

    var planWeek by mutableStateOf(false)
    var iconChoice by mutableStateOf(graph.iconChoice())
    var colors by mutableStateOf<Map<String, String>>(emptyMap())

    fun chooseIcon(context: Context, id: String) {
        val choice = if (id == "schule" || id == "notiz") id else "standard"
        iconChoice = choice
        graph.setIconChoice(choice)
        val packageName = context.packageName
        val manager = context.packageManager
        listOf("standard" to "LauncherDefault", "schule" to "LauncherSchule", "notiz" to "LauncherNotiz").forEach { (key, alias) ->
            val enabled = if (choice == key) android.content.pm.PackageManager.COMPONENT_ENABLED_STATE_ENABLED else android.content.pm.PackageManager.COMPONENT_ENABLED_STATE_DISABLED
            manager.setComponentEnabledSetting(
                android.content.ComponentName(packageName, "$packageName.$alias"),
                enabled,
                android.content.pm.PackageManager.DONT_KILL_APP,
            )
        }
    }

    fun paintSubject(subject: String, color: String) {
        colors = colors + ch.fasrv.fanotes.schulnetz.colorKeys(subject).associateWith { color }
        perform { graph.setSubjectColor(subject, color) }
    }

    fun addHypothetical(courseId: String, title: String, mark: Double, weight: Double) {
        val next = hypothetical + HypotheticalGrade(UUID.randomUUID().toString(), courseId, title.ifBlank { "Local mark" }, mark, weight)
        hypothetical = next
        perform { graph.saveHypothetical(next) }
    }

    fun clearHypothetical(courseId: String) {
        val next = hypothetical.filter { it.courseId != courseId }
        hypothetical = next
        perform { graph.saveHypothetical(next) }
    }

    fun removeHypothetical(id: String) {
        val next = hypothetical.filter { it.id != id }
        hypothetical = next
        perform { graph.saveHypothetical(next) }
    }

    fun saveOwnGrade(grade: OwnGrade) {
        val clean = GradeBook(own = listOf(grade)).normalized().own.singleOrNull() ?: return
        saveGradeBook(gradeBook.copy(own = gradeBook.own.filterNot { it.id == clean.id } + clean))
    }

    fun deleteOwnGrade(id: String) = saveGradeBook(gradeBook.copy(own = gradeBook.own.filterNot { it.id == id }))

    fun saveCollectiveGrade(grade: CollectiveGrade) {
        val clean = GradeBook(collective = listOf(grade)).normalized().collective.singleOrNull() ?: return
        saveGradeBook(gradeBook.copy(collective = gradeBook.collective.filterNot { it.id == clean.id } + clean))
    }

    fun deleteCollectiveGrade(id: String) = saveGradeBook(gradeBook.copy(collective = gradeBook.collective.filterNot { it.id == id }))

    fun saveGradeAdjustment(adjustment: GradeAdjustment) {
        val clean = adjustment.cleaned()
        if (clean == null) restoreGradeAdjustment(adjustment.targetId) else {
            saveGradeBook(gradeBook.copy(adjustments = gradeBook.adjustments.filterNot { it.targetId == clean.targetId } + clean))
        }
    }

    fun restoreGradeAdjustment(targetId: String) {
        saveGradeBook(gradeBook.copy(adjustments = gradeBook.adjustments.filterNot { it.targetId == targetId }))
    }

    fun archiveCourse(courseId: String) {
        if (courseId.isBlank()) return
        saveGradeBook(gradeBook.copy(archivedCourseIds = (gradeBook.archivedCourseIds + courseId).distinct()))
    }

    fun restoreCourse(courseId: String) {
        saveGradeBook(gradeBook.copy(archivedCourseIds = gradeBook.archivedCourseIds.filterNot { it == courseId }))
    }

    private fun saveGradeBook(next: GradeBook) {
        val clean = next.normalized()
        gradeBook = clean
        perform { graph.saveGradeBook(clean) }
    }

    fun createNote(title: String) {
        viewModelScope.launch {
            try {
                val folder = if (route.destination == Destination.Notes) noteFolder else ""
                val path = withContext(Dispatchers.IO) { graph.store.createUniqueMarkdown(folder, title.ifBlank { "Untitled" }).also { graph.engine.notifyLocalChange() } }
                openNote(path); reload()
            } catch (error: Exception) {
                if (error is kotlinx.coroutines.CancellationException) throw error
                message = error.message ?: "Could not create note" }
        }
    }
    fun createFolder(title: String) = perform("Folder created") { graph.store.createFolder(noteFolder, title); graph.engine.notifyLocalChange() }
    fun renameNote(node: VaultNode, title: String) = perform("Renamed") { graph.store.rename(node.path, title); graph.engine.notifyLocalChange() }
    fun moveNote(node: VaultNode, folder: String) = perform("Moved") { graph.store.moveEntry(node.path, folder); graph.engine.notifyLocalChange() }
    fun duplicateNote(node: VaultNode) = perform("Note duplicated") { graph.store.duplicateNote(node.path); graph.engine.notifyLocalChange() }
    fun trashNote(node: VaultNode) = perform("Moved to recently deleted") { graph.store.trashEntry(node.path, UUID.randomUUID().toString(), ch.fasrv.fanotes.famd.isoNow()); graph.engine.notifyLocalChange() }
    fun restoreNote(id: String, onRestored: () -> Unit = {}) = perform("Note restored", onRestored) { graph.store.restoreTrash(id); graph.engine.notifyLocalChange() }

    fun openNotify(intent: Intent?) {
        if (intent == null) return
        val payload = intent.getStringExtra(CompanionAlerts.EXTRA_PAYLOAD).orEmpty()
        val fromPayload = payload.takeIf { it.isNotBlank() }?.let { ch.fasrv.fanotes.schulnetz.changeFromPayload(it) }
        val category = intent.getStringExtra(CompanionAlerts.EXTRA_CATEGORY).orEmpty()
        val targetId = intent.getStringExtra(CompanionAlerts.EXTRA_TARGET_ID).orEmpty()
        val extrasIds = intent.getStringArrayListExtra(CompanionAlerts.EXTRA_TARGET_IDS).orEmpty()
        if (fromPayload == null && category.isBlank() && targetId.isBlank() && extrasIds.isEmpty()) return
        val change = fromPayload ?: ch.fasrv.fanotes.schulnetz.SchulnetzChange(
            id = targetId.ifBlank { "notify" },
            category = category.ifBlank { "event" },
            title = "",
            body = "",
            targetId = targetId,
            courseId = intent.getStringExtra(CompanionAlerts.EXTRA_COURSE_ID).orEmpty(),
            date = intent.getStringExtra(CompanionAlerts.EXTRA_DATE).orEmpty(),
            targetIds = extrasIds.ifEmpty { targetId.split(',').map { it.trim() }.filter { it.isNotBlank() } },
        )
        applyNotify(ch.fasrv.fanotes.schulnetz.notifyLinkOf(change))
    }

    fun applyNotify(link: ch.fasrv.fanotes.schulnetz.NotifyLink) {
        val current = editor
        if (current == null) applyNotificationRoute(link)
        else viewModelScope.launch {
            if (current.close()) { editor = null; editorPath = null; applyNotificationRoute(link) }
        }
    }
    private fun applyNotificationRoute(link: ch.fasrv.fanotes.schulnetz.NotifyLink) {
        val route = ch.fasrv.fanotes.schulnetz.routeNotify(link, snapshot)
        history = emptyList()
        this.route = companionRoute(route)
        focusCourseId = route.courseId
        highlightIds = route.highlightIds.toSet()
        if (route.day.isNotBlank()) {
            runCatching { day = java.time.LocalDate.parse(route.day.take(10)) }
            planWeek = false
        }
        if (route.hint.isNotBlank()) message = route.hint
        refreshUnrevealed()
        if (link.kind == "grade" && settings.guessGrades) openReveal(route.highlightIds)
    }

    fun testPush(context: Context) {
        CompanionAlerts.forget(context, "push-test")
        CompanionAlerts.show(
            context,
            ch.fasrv.fanotes.schulnetz.linkedChange(
                "push-test",
                "settings",
                "Test notification",
                "FaNotes Companion can display notifications.",
                targetId = "settings",
            ),
        )
        viewModelScope.launch {
            val session = graph.engine.currentSession()
            if (session == null) {
                message = if (CompanionAlerts.notificationsAllowed(context)) "Local test notification sent." else "Notifications are off. Allow them in Notification settings."
                return@launch
            }
            runCatching { graph.client.testPush(session) }
                .onSuccess { message = "Test notification sent." }
                .onFailure { error ->
                    message = "Local notification sent. Server: ${error.message}"
                }
        }
    }

    fun enablePush(context: Context) {
        configurePushDelivery(context)
        val ok = hasUnifiedPushDistributor(context)
        message = if (ok) "UnifiedPush connected. Instant school updates use that distributor." else "No UnifiedPush distributor installed. School updates are checked about every 15 minutes until ntfy or another distributor is available."
    }

    companion object {
        fun factory(graph: CompanionGraph) = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T = CompanionModel(graph) as T
        }
    }
}

internal fun exportSsoCookies(): Map<String, String> {
    val manager = CookieManager.getInstance()
    return SSO_COOKIE_URLS.mapNotNull { url ->
        val host = runCatching { URI(url).host }.getOrNull() ?: return@mapNotNull null
        val cleaned = stripPhpSession(manager.getCookie(url).orEmpty())
        if (cleaned.isBlank()) null else host to cleaned
    }.toMap()
}

internal fun hasMicrosoftCookies(): Boolean = microsoftCookieNames().isNotBlank()

internal fun microsoftCookieNames(): String =
    SSO_COOKIE_URLS.mapNotNull { url ->
        val names = cookieNames(CookieManager.getInstance().getCookie(url).orEmpty())
        val host = runCatching { URI(url).host }.getOrNull() ?: return@mapNotNull null
        if (names.isEmpty()) null else "$host=${names.joinToString("|")}"
    }.joinToString(",")

internal fun shareFile(context: Context, title: String, file: File, mime: String, extraText: String?) {
    val send = Runnable {
        try {
            val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file)
            val intent = Intent(Intent.ACTION_SEND)
                .setType(mime)
                .putExtra(Intent.EXTRA_STREAM, uri)
                .putExtra(Intent.EXTRA_SUBJECT, title)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            if (!extraText.isNullOrBlank()) intent.putExtra(Intent.EXTRA_TEXT, extraText)
            intent.clipData = ClipData.newRawUri(title, uri)
            val chooser = Intent.createChooser(intent, title)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
            context.startActivity(chooser)
        } catch (error: Exception) {
                if (error is kotlinx.coroutines.CancellationException) throw error
            Toast.makeText(context, "Could not share: ${error.message ?: "unknown"}", Toast.LENGTH_LONG).show()
        }
    }
    if (Looper.myLooper() == Looper.getMainLooper()) send.run() else Handler(Looper.getMainLooper()).post(send)
}

internal fun phpSessionCookie(baseUrl: String): String {
    val raw = CookieManager.getInstance().getCookie(baseUrl).orEmpty()
    return Regex("PHPSESSID=([^;]+)").find(raw)?.groupValues?.get(1).orEmpty()
}

data class NotePreview(val text: String, val ink: InkDocument)
data class NoteResult(val node: VaultNode, val excerpt: String)
