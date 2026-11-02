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
import ch.fasrv.fanotes.schulnetz.DeskPrefs
import ch.fasrv.fanotes.schulnetz.HiddenLesson
import ch.fasrv.fanotes.schulnetz.HypotheticalGrade
import ch.fasrv.fanotes.schulnetz.NotifySettings
import ch.fasrv.fanotes.schulnetz.SchulnetzSnapshot
import ch.fasrv.fanotes.schulnetz.hideOnce
import ch.fasrv.fanotes.schulnetz.hideSeries
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
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import android.webkit.CookieManager
import java.io.File
import java.net.URI
import java.time.LocalDate
import java.util.UUID

enum class PhoneTab { Heute, Plan, Noten, Notizen, Mehr }
enum class PhoneSection { Menu, Hausaufgaben, Kalender, Absenzen, Pruefungen, Termine, Konto, Einstellungen, Editor }

class CompanionModel(val graph: CompanionGraph) : ViewModel() {
    var desk by mutableStateOf(graph.deskPrefs())
    var hidden by mutableStateOf(graph.hiddenLessons())
    var tab by mutableStateOf(startTab(graph.deskPrefs().startTab))
    var section by mutableStateOf(PhoneSection.Menu)
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
    var theme by mutableStateOf(graph.themeId())
    var instant by mutableStateOf(graph.instantPush())
    var baseUrl by mutableStateOf(graph.baseUrl())
    var settings by mutableStateOf(graph.notifySettings())
    var day by mutableStateOf(timetableAnchor(LocalDate.now()))
    var editorPath by mutableStateOf<String?>(null)
    var debugHtml by mutableStateOf("")
    var highlightIds by mutableStateOf<Set<String>>(emptySet())
    var focusCourseId by mutableStateOf("")

    init {
        viewModelScope.launch { graph.snapshot.collect { snapshot = it } }
        viewModelScope.launch { graph.link.collect { link = it } }
        reload()
    }

    fun reload() {
        viewModelScope.launch(Dispatchers.IO) {
            val nextNotes = runCatching {
                graph.logNoteCensus()
                val folder = if (graph.noteFolderExists(noteFolder)) noteFolder else ""
                graph.notes(folder)
            }.getOrDefault(emptyList())
            val nextTasks = runCatching { graph.homework().tasks }.getOrDefault(emptyList())
            val nextCalendar = runCatching { graph.calendar() }.getOrDefault(emptyCalendar())
            val nextGuess = runCatching { graph.hypothetical() }.getOrDefault(emptyList())
            val counted = runCatching { graph.writtenNoteCount() }.getOrDefault(0)
            val nextDesk = runCatching { graph.deskPrefs() }.getOrDefault(desk)
            val nextHidden = runCatching { graph.hiddenLessons() }.getOrDefault(hidden)
            withContext(Dispatchers.Main) {
                if (!graph.noteFolderExists(noteFolder)) noteFolder = ""
                notes = nextNotes
                writtenNotes = counted
                tasks = nextTasks
                calendar = nextCalendar
                hypothetical = nextGuess
                desk = nextDesk
                hidden = nextHidden
            }
        }
    }

    fun login(register: Boolean) {
        if (email.isBlank() || password.isBlank()) {
            message = "E-Mail und Passwort ausfüllen."
            return
        }
        busy = true
        viewModelScope.launch {
            try {
                if (register) graph.engine.register(email.trim(), password) else graph.engine.login(email.trim(), password)
                graph.engine.syncNow("phone")
                runCatching { graph.refreshSchulnetz("fa-notes-login") }
                reload()
                message = null
            } catch (error: Exception) {
                message = error.message ?: "Anmeldung fehlgeschlagen."
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
                message = "Synchronisiert."
            } catch (error: Exception) {
                message = error.message ?: "Sync fehlgeschlagen."
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

    fun schulnetzIntent(context: Context): Intent? {
        val base = normalizeSchoolBase(baseUrl)
        if (base == null) {
            message = "Diese Schulnetz-Adresse ist nicht erlaubt."
            return null
        }
        graph.setBaseUrl(base)
        baseUrl = base
        if (!usesWebsiteSession(base)) {
            message = "Diese Schule nutzt die Web-Anmeldung noch nicht."
            return null
        }
        val host = runCatching { URI(base).host }.getOrNull() ?: return null
        return Intent(context, SchulnetzLoginActivity::class.java)
            .putExtra(SchulnetzLoginActivity.EXTRA_URL, webLoginUrl(base))
            .putExtra(SchulnetzLoginActivity.EXTRA_HOST, host)
            .putExtra(SchulnetzLoginActivity.EXTRA_BASE, base)
    }

    fun requestVisibleLogin(caller: String) {
        viewModelScope.launch {
            graph.runVisibleLogin(caller)
            debugHtml = graph.debugHtml()
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
            message = "Schulnetz-Anmeldung abgebrochen."
            return
        }
        graph.finishVisibleLogin(web.copy(phpSessionId = php))
        message = "Schulnetz ist verbunden. Bei einem IP-Wechsel meldet die App sich neu an."
    }

    fun onWebLoginCancelled() {
        val viewing = graph.viewingSession
        graph.finishVisibleLogin(null)
        if (!viewing) message = "Schulnetz-Anmeldung abgebrochen."
    }

    fun shareDebug(context: Context) {
        val app = context.applicationContext
        viewModelScope.launch(Dispatchers.IO) {
            try {
                val raw = debugHtml.ifBlank { graph.debugHtml() }
                val body = buildString {
                    if (raw.isBlank()) appendLine("Keine Schulnetz-Seite gespeichert.")
                    else append(redactSchulnetzSecrets(raw).take(400_000))
                    appendLine()
                    append(graph.shareMeta())
                }
                val file = File(app.cacheDir, "share").apply { mkdirs() }.resolve("schulnetz-seite.html")
                file.writeText(body)
                withContext(Dispatchers.Main) { shareFile(app, "HTML teilen", file, "text/html", body.take(20_000)) }
            } catch (error: Exception) {
                graph.schulnetzLog.error(error)
                withContext(Dispatchers.Main) {
                    Toast.makeText(app, "Teilen fehlgeschlagen: ${error.message ?: "unbekannt"}", Toast.LENGTH_LONG).show()
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
                withContext(Dispatchers.Main) { shareFile(app, "Logs teilen", file, "application/zip", "Schulnetz-Logs") }
            } catch (error: Exception) {
                graph.schulnetzLog.error(error)
                withContext(Dispatchers.Main) {
                    Toast.makeText(app, "Teilen fehlgeschlagen: ${error.message ?: "unbekannt"}", Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    fun unlink() {
        viewModelScope.launch {
            val session = graph.engine.currentSession()
            if (session != null) runCatching { graph.client.unlink(session) }
            graph.clearLocalLink()
            graph.link.value = SchulnetzLinkState()
            message = "Schulnetz getrennt."
        }
    }

    fun chooseTheme(id: String) {
        theme = id
        updateDesk(desk.copy(theme = id))
    }

    fun updateDesk(next: DeskPrefs) {
        desk = next
        theme = next.theme
        graph.saveDeskPrefs(next)
    }

    fun hideLesson(event: AgendaEvent, series: Boolean) {
        val next = if (series) hideSeries(event, hidden) else hideOnce(event, hidden)
        hidden = next
        graph.saveHiddenLessons(next)
    }

    fun restoreLesson(id: String) {
        val next = hidden.filterNot { it.id == id }
        hidden = next
        graph.saveHiddenLessons(next)
    }

    fun saveTaskNotes(id: String, notes: String) {
        viewModelScope.launch(Dispatchers.IO) {
            graph.setHomeworkNotes(id, notes)
            reload()
        }
    }

    fun renameCourse(key: String, name: String) {
        val aliases = desk.courseAliases.toMutableMap()
        val stored = key.trim().lowercase()
        if (stored.isBlank()) return
        if (name.isBlank()) aliases.remove(stored) else aliases[stored] = name.trim()
        updateDesk(desk.copy(courseAliases = aliases))
    }

    fun chooseInstant(enabled: Boolean) {
        instant = enabled
        graph.setInstant(enabled)
    }

    fun toggleSetting(name: String) {
        val next = when (name) {
            "grades" -> settings.copy(grades = !settings.grades)
            "timetable" -> settings.copy(timetable = !settings.timetable)
            "exams" -> settings.copy(exams = !settings.exams)
            "absences" -> settings.copy(absences = !settings.absences)
            "deadlines" -> settings.copy(deadlines = !settings.deadlines)
            else -> settings.copy(events = !settings.events)
        }
        settings = next
        graph.setNotifySettings(next)
    }

    fun toggleTask(task: HomeworkTask) {
        viewModelScope.launch(Dispatchers.IO) {
            graph.setHomeworkDone(task.id, !task.done)
            reload()
        }
    }

    fun importHomework(title: String, subject: String, due: String, notes: String) {
        viewModelScope.launch(Dispatchers.IO) {
            graph.importHomework(title, subject, due, notes)
            reload()
            withContext(Dispatchers.Main) { message = "In die Hausaufgaben übernommen." }
        }
    }

    fun importExam(event: AgendaEvent) {
        viewModelScope.launch(Dispatchers.IO) {
            graph.importExam(event)
            reload()
            withContext(Dispatchers.Main) { message = "In den Kalender übernommen." }
        }
    }

    var planWeek by mutableStateOf(false)
    var iconChoice by mutableStateOf(graph.iconChoice())
    var colors by mutableStateOf(graph.subjectColors())

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
        graph.setSubjectColor(subject, color)
        colors = graph.subjectColors()
    }

    fun addHypothetical(courseId: String, title: String, mark: Double, weight: Double) {
        val next = hypothetical + HypotheticalGrade(UUID.randomUUID().toString(), courseId, title.ifBlank { "Hypothetisch" }, mark, weight)
        hypothetical = next
        viewModelScope.launch(Dispatchers.IO) { graph.saveHypothetical(next) }
    }

    fun clearHypothetical(courseId: String) {
        val next = hypothetical.filter { it.courseId != courseId }
        hypothetical = next
        viewModelScope.launch(Dispatchers.IO) { graph.saveHypothetical(next) }
    }

    fun removeHypothetical(id: String) {
        val next = hypothetical.filter { it.id != id }
        hypothetical = next
        viewModelScope.launch(Dispatchers.IO) { graph.saveHypothetical(next) }
    }

    fun createNote(title: String) {
        viewModelScope.launch(Dispatchers.IO) {
            val path = graph.store.createUniqueMarkdown(noteFolder, title.ifBlank { "Notiz" })
            graph.engine.notifyLocalChange()
            withContext(Dispatchers.Main) {
                editorPath = path
                section = PhoneSection.Editor
                tab = PhoneTab.Notizen
            }
            reload()
        }
    }

    fun saveNote(path: String, document: InkDocument, markdown: String) {
        viewModelScope.launch(Dispatchers.IO) {
            val open = graph.store.readNote(path)
            graph.store.save(open, document, markdown)
            graph.engine.notifyLocalChange()
            withContext(Dispatchers.Main) { message = "Notiz gespeichert." }
        }
    }

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
        val route = ch.fasrv.fanotes.schulnetz.routeNotify(link, snapshot)
        tab = PhoneTab.entries.firstOrNull { it.name.equals(route.tab, ignoreCase = true) } ?: PhoneTab.Heute
        section = PhoneSection.entries.firstOrNull { it.name.equals(route.section, ignoreCase = true) } ?: PhoneSection.Menu
        focusCourseId = route.courseId
        highlightIds = route.highlightIds.toSet()
        if (route.day.isNotBlank()) {
            runCatching { day = java.time.LocalDate.parse(route.day.take(10)) }
            planWeek = false
        }
        if (route.hint.isNotBlank()) message = route.hint
    }

    fun testPush(context: Context) {
        CompanionAlerts.forget(context, "push-test")
        CompanionAlerts.show(
            context,
            ch.fasrv.fanotes.schulnetz.linkedChange(
                "push-test",
                "settings",
                "Testbenachrichtigung",
                "FaNotes Companion kann Mitteilungen anzeigen.",
                targetId = "settings",
            ),
        )
        viewModelScope.launch {
            val session = graph.engine.currentSession()
            if (session == null) {
                message = if (CompanionAlerts.notificationsAllowed(context)) "Lokale Testmeldung gesendet." else "Mitteilungen sind ausgeschaltet. Unter Android 13+ zuerst die Berechtigung erlauben."
                return@launch
            }
            runCatching { graph.client.testPush(session) }
                .onSuccess { message = "Testbenachrichtigung gesendet." }
                .onFailure { error ->
                    message = "Lokal gesendet. Server: ${error.message}"
                }
        }
    }

    fun enablePush(context: Context) {
        val ok = enableUnifiedPush(context)
        message = if (ok) "UnifiedPush ist verbunden." else "Kein UnifiedPush-Verteiler installiert. Die App nutzt ntfy direkt."
        if (instant) graph.setInstant(true)
    }

    companion object {
        fun factory(graph: CompanionGraph) = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T = CompanionModel(graph) as T
        }
    }
}

internal fun startTab(raw: String): PhoneTab = PhoneTab.entries.firstOrNull { it.name.equals(raw, ignoreCase = true) } ?: PhoneTab.Heute

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
            Toast.makeText(context, "Teilen fehlgeschlagen: ${error.message ?: "unbekannt"}", Toast.LENGTH_LONG).show()
        }
    }
    if (Looper.myLooper() == Looper.getMainLooper()) send.run() else Handler(Looper.getMainLooper()).post(send)
}

internal fun phpSessionCookie(baseUrl: String): String {
    val raw = CookieManager.getInstance().getCookie(baseUrl).orEmpty()
    return Regex("PHPSESSID=([^;]+)").find(raw)?.groupValues?.get(1).orEmpty()
}
