package ch.fasrv.fanotes.companion

import android.content.Context
import android.content.Intent
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
import ch.fasrv.fanotes.schulnetz.HypotheticalGrade
import ch.fasrv.fanotes.schulnetz.NotifySettings
import ch.fasrv.fanotes.schulnetz.SchulnetzSnapshot
import ch.fasrv.fanotes.schulnetz.SCHULNETZ_USER_AGENT
import ch.fasrv.fanotes.schulnetz.SSO_COOKIE_URLS
import ch.fasrv.fanotes.schulnetz.extractWebSession
import ch.fasrv.fanotes.schulnetz.normalizeSchoolBase
import ch.fasrv.fanotes.schulnetz.stripPhpSession
import ch.fasrv.fanotes.schulnetz.timetableAnchor
import ch.fasrv.fanotes.schulnetz.usesWebsiteSession
import ch.fasrv.fanotes.schulnetz.webLoginUrl
import ch.fasrv.fanotes.vault.VaultNode
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import android.webkit.CookieManager
import java.net.URI
import java.time.LocalDate
import java.util.UUID

enum class PhoneTab { Heute, Plan, Noten, Notizen, Mehr }
enum class PhoneSection { Menu, Hausaufgaben, Kalender, Absenzen, Pruefungen, Termine, Konto, Einstellungen, Editor }

class CompanionModel(val graph: CompanionGraph) : ViewModel() {
    var tab by mutableStateOf(PhoneTab.Heute)
    var section by mutableStateOf(PhoneSection.Menu)
    var message by mutableStateOf<String?>(null)
    var busy by mutableStateOf(false)
    var email by mutableStateOf("")
    var password by mutableStateOf("")
    var snapshot by mutableStateOf(graph.snapshot.value)
    var link by mutableStateOf(graph.link.value)
    var notes by mutableStateOf<List<VaultNode>>(emptyList())
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

    init {
        viewModelScope.launch { graph.snapshot.collect { snapshot = it } }
        viewModelScope.launch { graph.link.collect { link = it } }
        reload()
    }

    fun reload() {
        viewModelScope.launch(Dispatchers.IO) {
            val nextNotes = runCatching { graph.notes() }.getOrDefault(emptyList())
            val nextTasks = runCatching { graph.homework().tasks }.getOrDefault(emptyList())
            val nextCalendar = runCatching { graph.calendar() }.getOrDefault(emptyCalendar())
            val nextGuess = runCatching { graph.hypothetical() }.getOrDefault(emptyList())
            withContext(Dispatchers.Main) {
                notes = nextNotes
                tasks = nextTasks
                calendar = nextCalendar
                hypothetical = nextGuess
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
                runCatching { graph.refreshSchulnetz() }
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
                graph.refreshSchulnetz()
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

    fun onWebLoginFinished() {
        val html = SchulnetzLoginBridge.landingHtml
        val url = SchulnetzLoginBridge.landingUrl
        SchulnetzLoginBridge.landingHtml = ""
        SchulnetzLoginBridge.landingUrl = ""
        val web = extractWebSession(url, html, baseUrl)
        val php = phpSessionCookie(baseUrl)
        if (web == null || php.isBlank()) {
            message = "Schulnetz-Anmeldung abgebrochen."
            return
        }
        graph.saveWebSession(web.copy(phpSessionId = php))
        busy = true
        viewModelScope.launch {
            try {
                val fanotes = graph.engine.currentSession() ?: error("Zuerst bei FaNotes anmelden.")
                val cookies = exportSsoCookies()
                if (cookies.isEmpty()) {
                    message = "Microsoft-Cookies fehlen. Bitte die Anmeldung wiederholen."
                } else {
                    runCatching {
                        graph.link.value = graph.client.linkWeb(fanotes, baseUrl, graph.deviceId(), SCHULNETZ_USER_AGENT, cookies, "Companion")
                    }
                    message = "Schulnetz ist verbunden. Bei einem IP-Wechsel meldet die App sich neu an."
                }
                graph.refreshSchulnetz()
                debugHtml = graph.debugHtml()
            } catch (error: Exception) {
                message = error.message ?: "Schulnetz-Anmeldung fehlgeschlagen."
            } finally {
                busy = false
            }
        }
    }

    fun shareDebug(context: Context) {
        val text = debugHtml.ifBlank { graph.debugHtml() }
        if (text.isBlank()) {
            message = "Keine Seite zum Teilen."
            return
        }
        val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text.take(100_000))
        context.startActivity(Intent.createChooser(send, "HTML teilen").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
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
        graph.setTheme(id)
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

    fun createNote(title: String) {
        viewModelScope.launch(Dispatchers.IO) {
            val path = graph.store.createUniqueMarkdown("", title.ifBlank { "Notiz" })
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

    fun testPush() {
        viewModelScope.launch {
            val session = graph.engine.currentSession() ?: return@launch
            runCatching { graph.client.testPush(session) }
                .onSuccess { message = "Testbenachrichtigung gesendet." }
                .onFailure { message = it.message }
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

internal fun exportSsoCookies(): Map<String, String> {
    val manager = CookieManager.getInstance()
    return SSO_COOKIE_URLS.mapNotNull { url ->
        val host = runCatching { URI(url).host }.getOrNull() ?: return@mapNotNull null
        val cleaned = stripPhpSession(manager.getCookie(url).orEmpty())
        if (cleaned.isBlank()) null else host to cleaned
    }.toMap()
}

internal fun phpSessionCookie(baseUrl: String): String {
    val raw = CookieManager.getInstance().getCookie(baseUrl).orEmpty()
    return Regex("PHPSESSID=([^;]+)").find(raw)?.groupValues?.get(1).orEmpty()
}
