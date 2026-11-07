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
import ch.fasrv.fanotes.schulnetz.DiagnosticTrace
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
import ch.fasrv.fanotes.schulnetz.presentedNavBar
import ch.fasrv.fanotes.schulnetz.startTabId
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
    var notesAccount by mutableStateOf(graph.engine.state.value.account != null)
    var offerUpload by mutableStateOf(false)
    var pendingSchoolConnect by mutableStateOf(false)
    fun shownBar(): List<String> = presentedNavBar(desk.navBar, notesAccount)
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
        val safe = if (!notesAccount && startTabId(id) == "notes") "today" else id
        val placement = navPlacement(safe)
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
        if ("settings" in shownBar()) selectNav("settings")
        else navigate(Page.Settings)
    }
    fun atNavRoot(): Boolean = isAtNavRoot(route, plannerTasks, desk.startTab, shownBar(), noteFolder, history.isNotEmpty())
    fun back() {
        graph.trail.action("back")
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
        val bar = shownBar()
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
    fun finishWelcome(connectSchool: Boolean, openNotes: Boolean) {
        continueLocally()
        pendingSchoolConnect = connectSchool
        if (openNotes) route = CompanionRoute(page = Page.Auth)
    }
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
                message = error.message?.takeIf { it.isNotBlank() }?.let(::shownText) ?: t(R.string.could_not_save_again)
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
    var diagnosticOn by mutableStateOf(graph.diagnosticMode())
    var diagnosticScenario by mutableStateOf(ch.fasrv.fanotes.schulnetz.DiagnosticScenario.fromId(graph.diagnosticScenario()))
    var diagnosticTick by mutableStateOf(0)
    var diagnosticExport by mutableStateOf<String?>(null)

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
        viewModelScope.launch {
            var previous = ""
            graph.engine.state.collect { state ->
                notesAccount = state.account != null
                val name = state.status.name.lowercase()
                val conflicts = state.conflicts.size
                val key = "$name:$conflicts"
                if (key == previous) return@collect
                previous = key
                val result = when {
                    conflicts > 0 -> "conflict"
                    name == "error" -> "error"
                    name == "offline" -> "offline"
                    name == "paused" -> "paused"
                    name == "syncing" -> "ok"
                    else -> ""
                }
                if (result.isNotEmpty()) DiagnosticTrace.record("sync", "status", 0, result, "conflicts:$conflicts")
            }
        }
        if (graph.plannerHold() && notesAccount) offerUpload = true
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
                        var start = startTabId(data.desk.startTab)
                        if (graph.engine.state.value.account == null && start == "notes") start = "today"
                        val placement = navPlacement(start)
                        plannerTasks = placement.plannerTasks
                        route = placement.route
                    }
                }
                loadError = listOfNotNull(data.tasks.exceptionOrNull()?.message?.let(::shownText), data.calendar.exceptionOrNull()?.message?.let(::shownText)).joinToString("\n").ifBlank { null }
                val paths = flattenNotes(tree).map { it.path }.toSet()
                searchCache.snapshot().keys.filterNot { it in paths }.forEach { searchCache.remove(it) }
                previewCache.snapshot().keys.filterNot { it in paths }.forEach { previewCache.remove(it) }
            } catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
            catch (error: Exception) {
                if (error is kotlinx.coroutines.CancellationException) throw error
                loadError = error.message?.takeIf { it.isNotBlank() }?.let(::shownText) ?: t(R.string.could_not_read_library) }
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
            message = t(R.string.enter_email_password)
            return
        }
        busy = true
        viewModelScope.launch {
            try {
                val offer = withContext(Dispatchers.IO) { graph.armPlannerHold() }
                if (register) graph.engine.register(email.trim(), password) else graph.engine.login(email.trim(), password)
                graph.engine.syncNow("phone")
                runCatching { graph.refreshSchulnetz("fa-notes-login") }
                continueLocally()
                offerUpload = offer
                password = ""
                reload()
                message = null
                if (route.page == Page.Auth) back()
            } catch (error: Exception) {
                if (error is kotlinx.coroutines.CancellationException) throw error
                message = error.message?.takeIf { it.isNotBlank() }?.let(::shownText) ?: t(R.string.sign_in_failed)
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
                message = error.message?.takeIf { it.isNotBlank() }?.let(::shownText) ?: t(R.string.sync_failed_local)
            } finally {
                busy = false
            }
        }
    }

    fun logout() {
        viewModelScope.launch {
            runCatching { graph.detachKeepingSchool() }
            runCatching { graph.engine.logout() }
            runCatching { graph.refreshSchulnetz("fa-notes-logout") }
            if (route.destination == Destination.Notes || route.page == Page.Editor || route.page == Page.Trash || route.page == Page.Profile) {
                history = emptyList()
                route = CompanionRoute(Destination.Today)
            }
            notesAccount = false
            message = null
        }
    }

    fun acceptUpload() {
        offerUpload = false
        graph.releasePlannerHold()
        sync()
    }

    fun declineUpload() { offerUpload = false }

    fun refreshSchool() {
        busy = true
        viewModelScope.launch {
            try {
                graph.refreshSchulnetz("settings")
                message = t(R.string.school_data_refreshed)
            } catch (error: Exception) {
                if (error is kotlinx.coroutines.CancellationException) throw error
                message = error.message?.takeIf { it.isNotBlank() }?.let(::shownText) ?: t(R.string.could_not_refresh_school)
            } finally { busy = false }
        }
    }

    fun deleteKantiData() {
        if (busy || notesAccount) return
        busy = true
        viewModelScope.launch {
            try {
                graph.deleteKantiData()
                snapshot = graph.snapshot.value
                link = graph.link.value
                message = t(R.string.kanti_data_deleted)
            } catch (error: Exception) {
                if (error is kotlinx.coroutines.CancellationException) throw error
                message = error.message?.takeIf { it.isNotBlank() }?.let(::shownText) ?: t(R.string.could_not_delete_kanti)
            } finally { busy = false }
        }
    }

    fun requestVisibleLogin(caller: String) {
        graph.trail.action("connect")
        if (busy) return
        val base = normalizeSchoolBase(baseUrl)
        if (base == null) { message = t(R.string.school_address_unsupported); return }
        if (!usesWebsiteSession(base)) { message = t(R.string.web_signin_unavailable); return }
        graph.setBaseUrl(base)
        baseUrl = base
        busy = true
        viewModelScope.launch {
            try { graph.runVisibleLogin(caller) }
            catch (error: Exception) {
                if (error is kotlinx.coroutines.CancellationException) throw error
                message = t(R.string.could_not_open_signin)
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
            message = t(R.string.signin_cancelled)
            return
        }
        graph.finishVisibleLogin(web.copy(phpSessionId = php))
        message = t(R.string.schulnetz_connected)
    }

    fun onWebLoginCancelled() {
        val viewing = graph.viewingSession
        graph.finishVisibleLogin(null)
        if (!viewing) message = t(R.string.signin_cancelled)
    }

    fun shareDebug(context: Context) {
        val app = context.applicationContext
        viewModelScope.launch(Dispatchers.IO) {
            try {
                val raw = debugHtml.ifBlank { graph.debugHtml() }
                val body = buildString {
                    if (raw.isBlank()) appendLine(t(R.string.no_school_page_saved))
                    else append(redactSchulnetzSecrets(raw).take(400_000))
                    appendLine()
                    append(graph.shareMeta())
                }
                val file = File(app.cacheDir, "share").apply { mkdirs() }.resolve("schulnetz-seite.html")
                file.writeText(body)
                withContext(Dispatchers.Main) { shareFile(app, t(R.string.share_school_page), file, "text/html", body.take(20_000)) }
            } catch (error: Exception) {
                if (error is kotlinx.coroutines.CancellationException) throw error
                graph.schulnetzLog.error(error)
                withContext(Dispatchers.Main) {
                    Toast.makeText(app, t(R.string.could_not_share, error.message?.let(::shownText) ?: t(R.string.unknown)), Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    fun shareLogs(context: Context, includeCaptures: Boolean = false) {
        val app = context.applicationContext
        viewModelScope.launch(Dispatchers.IO) {
            try {
                graph.trail.action("share-logs")
                graph.schulnetzLog.info("share logs ${graph.trail.snapshot()}")
                val file = graph.buildShareZip(includeCaptures)
                withContext(Dispatchers.Main) { shareFile(app, t(R.string.share_diagnostics), file, "application/zip", t(R.string.school_diagnostics)) }
            } catch (error: Exception) {
                if (error is kotlinx.coroutines.CancellationException) throw error
                graph.schulnetzLog.error(error)
                withContext(Dispatchers.Main) {
                    Toast.makeText(app, t(R.string.could_not_share, error.message?.let(::shownText) ?: t(R.string.unknown)), Toast.LENGTH_LONG).show()
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
                    val auth = runCatching { graph.schoolAuth() }.getOrNull()
                    if (auth != null) runCatching { graph.client.unlink(auth) }
                    withContext(Dispatchers.IO) { graph.disconnectSchool() }
                }
                message = t(R.string.schulnetz_disconnected)
            } catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
            catch (error: Exception) { message = error.message?.takeIf { it.isNotBlank() }?.let(::shownText) ?: t(R.string.could_not_disconnect) }
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
                message = error.message?.takeIf { it.isNotBlank() }?.let(::shownText) ?: t(R.string.could_not_save_prefs) }
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
                reload(); onSaved(); message = t(R.string.task_saved)
            } catch (error: Exception) {
                if (error is kotlinx.coroutines.CancellationException) throw error
                onError(error.message?.takeIf { it.isNotBlank() }?.let(::shownText) ?: t(R.string.could_not_save_task)) }
        }
    }
    fun deleteTask(task: HomeworkTask) = perform(t(R.string.task_deleted)) { graph.deleteHomeworkTask(task.id) }
    fun saveEvent(event: ch.fasrv.fanotes.desk.CalendarEvent, onSaved: () -> Unit, onError: (String) -> Unit = { message = it }) {
        viewModelScope.launch {
            try {
                writes.lock()
                try { withContext(Dispatchers.IO) { graph.saveCalendarEvent(event) } } finally { writes.unlock() }
                reload(); onSaved(); message = t(R.string.event_saved)
            } catch (error: Exception) {
                if (error is kotlinx.coroutines.CancellationException) throw error
                onError(error.message?.takeIf { it.isNotBlank() }?.let(::shownText) ?: t(R.string.could_not_save_event)) }
        }
    }
    fun deleteEvent(event: ch.fasrv.fanotes.desk.CalendarEvent) = perform(t(R.string.event_deleted)) { graph.deleteCalendarEvent(event.id) }

    fun importHomework(title: String, subject: String, due: String, notes: String) = perform(t(R.string.added_to_your_tasks)) {
        graph.importHomework(title, subject, due, notes)
    }
    fun importExam(event: AgendaEvent) = perform(t(R.string.added_to_your_calendar)) { graph.importExam(event) }

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
        val next = hypothetical + HypotheticalGrade(UUID.randomUUID().toString(), courseId, title.ifBlank { t(R.string.local_mark) }, mark, weight)
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
                val path = withContext(Dispatchers.IO) { graph.store.createUniqueMarkdown(folder, title.ifBlank { t(R.string.untitled) }).also { graph.engine.notifyLocalChange() } }
                openNote(path); reload()
            } catch (error: Exception) {
                if (error is kotlinx.coroutines.CancellationException) throw error
                message = error.message?.takeIf { it.isNotBlank() }?.let(::shownText) ?: t(R.string.could_not_create_note) }
        }
    }
    fun createFolder(title: String) = perform(t(R.string.folder_created)) { graph.store.createFolder(noteFolder, title); graph.engine.notifyLocalChange() }
    fun renameNote(node: VaultNode, title: String) = perform(t(R.string.renamed)) { graph.store.rename(node.path, title); graph.engine.notifyLocalChange() }
    fun moveNote(node: VaultNode, folder: String) = perform(t(R.string.moved)) { graph.store.moveEntry(node.path, folder); graph.engine.notifyLocalChange() }
    fun duplicateNote(node: VaultNode) = perform(t(R.string.note_duplicated)) { graph.store.duplicateNote(node.path); graph.engine.notifyLocalChange() }
    fun trashNote(node: VaultNode) = perform(t(R.string.moved_to_recently_deleted)) { graph.store.trashEntry(node.path, UUID.randomUUID().toString(), ch.fasrv.fanotes.famd.isoNow()); graph.engine.notifyLocalChange() }
    fun restoreNote(id: String, onRestored: () -> Unit = {}) = perform(t(R.string.note_restored), onRestored) { graph.store.restoreTrash(id); graph.engine.notifyLocalChange() }

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
        val probeRef = link.ids.firstOrNull { it.startsWith("probe") }.orEmpty()
        if (probeRef.isNotEmpty()) DiagnosticTrace.record("push", "tap", 0, "ok", probeRef)
        val route = ch.fasrv.fanotes.schulnetz.routeNotify(link, snapshot)
        history = emptyList()
        this.route = companionRoute(route)
        focusCourseId = route.courseId
        highlightIds = route.highlightIds.toSet()
        if (route.day.isNotBlank()) {
            runCatching { day = java.time.LocalDate.parse(route.day.take(10)) }
            planWeek = false
        }
        if (route.hint.isNotBlank()) message = shownText(route.hint)
        refreshUnrevealed()
        if (link.kind == "grade" && settings.guessGrades) openReveal(route.highlightIds)
    }

    fun testPush(context: Context) {
        CompanionAlerts.forget(context, "push-test")
        CompanionAlerts.showTest(context)
        viewModelScope.launch {
            val auth = runCatching { graph.schoolAuth() }.getOrNull()
            if (auth == null || !link.linked) {
                message = if (CompanionAlerts.notificationsAllowed(context)) t(R.string.local_test_sent) else t(R.string.notifications_off_settings)
                return@launch
            }
            runCatching { graph.client.testPush(auth) }
                .onSuccess { message = t(R.string.test_notification_sent) }
                .onFailure { error ->
                    message = t(R.string.local_notification_server, shownText(error.message))
                }
        }
    }

    fun setDiagnosticMode(enabled: Boolean) {
        graph.setDiagnosticMode(enabled)
        diagnosticOn = enabled
        diagnosticTick += 1
    }

    fun selectDiagnosticScenario(id: String) {
        if (!diagnosticOn) return
        val next = if (diagnosticScenario.id() == id) ch.fasrv.fanotes.schulnetz.DiagnosticScenario.OFF else ch.fasrv.fanotes.schulnetz.DiagnosticScenario.fromId(id)
        diagnosticScenario = next
        graph.setDiagnosticScenario(next.id())
    }

    fun bumpDiagnostics() { diagnosticTick += 1 }

    /** One heap sample. The trace stores a megabyte count, not a dump. */
    fun noteDiagnosticMemory() {
        if (!DiagnosticTrace.enabled) return
        val runtime = Runtime.getRuntime()
        val usedMb = ((runtime.totalMemory() - runtime.freeMemory()) / (1024L * 1024L)).coerceAtLeast(0L)
        DiagnosticTrace.record("memory", "heap", 0, "ok", "usedMb:$usedMb")
        diagnosticTick += 1
    }

    fun prepareDiagnosticExport(): String {
        val state = graph.engine.state.value
        val status = listOf(
            if (link.linked) "Schule: verbunden" else "Schule: getrennt",
            if (graph.fcmToken().isNullOrBlank()) "Push: nicht registriert" else "Push: registriert",
            "Sync: ${diagnosticSyncWord(state.status.name)}",
            "Konflikte: ${state.conflicts.size}",
            "Modus: ${if (diagnosticOn) "an" else "aus"}",
            "Szenario: ${diagnosticScenario.id()}",
        )
        return ch.fasrv.fanotes.schulnetz.diagnosticReport(
            "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})",
            status,
            DiagnosticTrace.recent(),
        )
    }

    fun shareDiagnosticReport(context: Context, report: String) {
        val app = context.applicationContext
        val safe = report.take(12_000)
        val file = java.io.File(app.cacheDir, "share").apply { mkdirs() }.resolve("kanti-diagnose.txt")
        file.writeText(safe)
        shareFile(app, t(R.string.diagnostic_export), file, "text/plain", safe.take(4_000))
    }

    /**
     * Local cleanup first. The server delete is best-effort and never touches
     * the school cache, the session, or ordinary change rows.
     */
    fun resetDiagnostics(context: Context) {
        graph.clearDiagnosticLocal()
        CompanionAlerts.clearProbeState(context)
        diagnosticOn = false
        diagnosticScenario = ch.fasrv.fanotes.schulnetz.DiagnosticScenario.OFF
        diagnosticExport = null
        diagnosticTick += 1
        viewModelScope.launch {
            val auth = runCatching { graph.schoolAuth() }.getOrNull()
            val token = graph.fcmToken()
            if (auth == null || !link.linked || token.isNullOrBlank()) {
                message = t(R.string.diagnostic_reset_local)
                return@launch
            }
            runCatching { graph.client.clearProbe(auth, token) }
                .onSuccess { message = t(R.string.diagnostic_reset_done) }
                .onFailure { message = t(R.string.diagnostic_reset_server_failed) }
        }
    }

    /** Server → Firebase → this device. Does not post a local notification and does not touch school records. */
    fun probeDelivery(context: Context, scenario: String = "standard") {
        if (!diagnosticOn) {
            message = t(R.string.diagnostic_mode_required)
            return
        }
        viewModelScope.launch {
            val auth = runCatching { graph.schoolAuth() }.getOrNull()
            if (auth == null || !link.linked) {
                message = t(R.string.delivery_probe_needs_link)
                return@launch
            }
            val token = graph.fcmToken()
            if (token.isNullOrBlank()) {
                message = t(R.string.delivery_probe_needs_token)
                return@launch
            }
            runCatching { graph.client.probePush(auth, token, scenario) }
                .onSuccess { ack ->
                    val detail = ack.correlation.takeIf { it.matches(Regex("^probe:[0-9]{1,20}$")) }.orEmpty()
                    DiagnosticTrace.record("push", "sent", 0, "ok", detail)
                    diagnosticTick += 1
                    message = t(R.string.delivery_probe_sent)
                }
                .onFailure { error ->
                    DiagnosticTrace.record("push", "sent", 0, "error", error.javaClass.simpleName)
                    diagnosticTick += 1
                    message = shownText(error.message).ifBlank { t(R.string.delivery_probe_failed) }
                }
        }
    }

    companion object {
        fun factory(graph: CompanionGraph) = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T = CompanionModel(graph) as T
        }
    }
}

private fun diagnosticSyncWord(name: String): String = when (name) {
    "UNAVAILABLE" -> "nicht verfügbar"
    "SIGNED_OUT" -> "abgemeldet"
    "IDLE" -> "bereit"
    "SYNCING" -> "synchronisiert"
    "OFFLINE" -> "offline"
    "ERROR" -> "Fehler"
    "PAUSED" -> "pausiert"
    else -> "unbekannt"
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

internal fun sharePathAllowed(cacheDir: File, file: File): Boolean {
    val root = File(cacheDir, "share").canonicalFile
    val target = runCatching { file.canonicalFile }.getOrNull() ?: return false
    return target.path == root.path || target.path.startsWith(root.path + File.separator)
}

internal fun shareFile(context: Context, title: String, file: File, mime: String, extraText: String?) {
    if (!sharePathAllowed(context.cacheDir, file)) {
        val warn = Runnable { Toast.makeText(context, t(R.string.could_not_share_that_file), Toast.LENGTH_LONG).show() }
        if (Looper.myLooper() == Looper.getMainLooper()) warn.run() else Handler(Looper.getMainLooper()).post(warn)
        return
    }
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
            Toast.makeText(context, t(R.string.could_not_share, error.message?.let(::shownText) ?: t(R.string.unknown)), Toast.LENGTH_LONG).show()
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
