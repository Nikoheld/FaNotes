package ch.fasrv.fanotes.companion

import android.content.Context
import ch.fasrv.fanotes.desk.CALENDAR_NOTE_PATH
import ch.fasrv.fanotes.desk.CalendarDef
import ch.fasrv.fanotes.desk.CalendarDocument
import ch.fasrv.fanotes.desk.CalendarEvent
import ch.fasrv.fanotes.desk.HOMEWORK_NOTE_PATH
import ch.fasrv.fanotes.desk.HomeworkDocument
import ch.fasrv.fanotes.desk.HomeworkTask
import ch.fasrv.fanotes.desk.NoteMarkdownLoad
import ch.fasrv.fanotes.desk.emptyCalendar
import ch.fasrv.fanotes.desk.loadCalendarMarkdown
import ch.fasrv.fanotes.desk.loadHomeworkMarkdown
import ch.fasrv.fanotes.desk.parseCalendarMarkdown
import ch.fasrv.fanotes.desk.parseHomeworkMarkdown
import ch.fasrv.fanotes.desk.serializeCalendarMarkdown
import ch.fasrv.fanotes.desk.serializeHomeworkMarkdown
import ch.fasrv.fanotes.famd.isoNow
import ch.fasrv.fanotes.ink.InkDocument
import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.escapeJson
import ch.fasrv.fanotes.json.parseJson
import ch.fasrv.fanotes.schulnetz.AgendaEvent
import ch.fasrv.fanotes.schulnetz.HypotheticalGrade
import ch.fasrv.fanotes.schulnetz.NotifySettings
import ch.fasrv.fanotes.schulnetz.RefreshLease
import ch.fasrv.fanotes.schulnetz.SchulnetzChange
import ch.fasrv.fanotes.schulnetz.SchulnetzSnapshot
import ch.fasrv.fanotes.schulnetz.diffSnapshots
import ch.fasrv.fanotes.schulnetz.localRefreshLease
import ch.fasrv.fanotes.schulnetz.normalizeSchoolBase
import ch.fasrv.fanotes.schulnetz.SessionProblem
import ch.fasrv.fanotes.schulnetz.SchulnetzTokens
import ch.fasrv.fanotes.schulnetz.WebSession
import ch.fasrv.fanotes.schulnetz.parseNormalizedSnapshot
import ch.fasrv.fanotes.schulnetz.parseRawSnapshot
import ch.fasrv.fanotes.schulnetz.schulnetzDeviceId
import ch.fasrv.fanotes.schulnetz.toNormalizedJson
import ch.fasrv.fanotes.schulnetz.usesWebsiteSession
import ch.fasrv.fanotes.sync.SyncApi
import ch.fasrv.fanotes.sync.SyncEngine
import ch.fasrv.fanotes.sync.SyncEngineOptions
import ch.fasrv.fanotes.sync.SyncHost
import ch.fasrv.fanotes.sync.SyncScanEntry
import ch.fasrv.fanotes.vault.DirectoryVault
import ch.fasrv.fanotes.vault.NoteKind
import ch.fasrv.fanotes.vault.NoteStore
import ch.fasrv.fanotes.vault.VaultIo
import ch.fasrv.fanotes.vault.VaultNode
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.File
import java.security.MessageDigest

class CompanionGraph(private val context: Context) {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val prefs = context.getSharedPreferences("fanotes-companion", Context.MODE_PRIVATE)
    private val secrets = VaultSecrets(context)
    val root: File = File(context.filesDir, "vault").apply { mkdirs() }
    val vault: VaultIo = DirectoryVault(root.toPath())
    val store = NoteStore(vault)
    val vaultId: String = fingerprint(root.absolutePath)
    @Volatile var busyPaths: Set<String> = emptySet()
    val snapshot = MutableStateFlow(readCachedSnapshot())
    val link = MutableStateFlow(SchulnetzLinkState())
    val client = SchulnetzClient()
    private val refreshMutex = Mutex()
    private val stateDir = File(context.filesDir, "sync-state").apply { mkdirs() }

    val engine: SyncEngine = SyncEngine(
        SyncApi(OkHttpSyncTransport()),
        SyncEngineOptions(
            platform = "android-phone",
            deviceName = { prefs.getString("device-name", null)?.ifBlank { null } ?: "FaNotes Companion" },
            automatic = { true },
            isPathBusy = { path -> path in busyPaths },
            onApplied = { _, _ -> scope.launch { /* vault changed remotely */ } },
        ),
    )

    init {
        engine.attach(host())
    }

    fun deviceId(): String {
        val saved = prefs.getString("schulnetz-device", null)
        if (!saved.isNullOrBlank()) return saved
        val created = schulnetzDeviceId()
        prefs.edit().putString("schulnetz-device", created).apply()
        return created
    }

    fun themeId(): String = prefs.getString("theme", "system").orEmpty().ifBlank { "system" }

    fun setTheme(id: String) {
        prefs.edit().putString("theme", id).apply()
    }

    fun instantPush(): Boolean = prefs.getBoolean("instant", true)

    fun setInstant(enabled: Boolean) {
        prefs.edit().putBoolean("instant", enabled).apply()
        if (enabled) NtfyListenService.start(context) else NtfyListenService.stop(context)
    }

    fun baseUrl(): String = normalizeSchoolBase(prefs.getString("schulnetz-base", null) ?: AKSA) ?: AKSA

    fun setBaseUrl(value: String) {
        val normal = normalizeSchoolBase(value) ?: return
        prefs.edit().putString("schulnetz-base", normal).apply()
    }

    fun notifySettings(): NotifySettings = NotifySettings(
        grades = prefs.getBoolean("notify-grades", true),
        timetable = prefs.getBoolean("notify-timetable", true),
        exams = prefs.getBoolean("notify-exams", true),
        absences = prefs.getBoolean("notify-absences", true),
        events = prefs.getBoolean("notify-events", true),
    )

    fun setNotifySettings(settings: NotifySettings) {
        prefs.edit()
            .putBoolean("notify-grades", settings.grades)
            .putBoolean("notify-timetable", settings.timetable)
            .putBoolean("notify-exams", settings.exams)
            .putBoolean("notify-absences", settings.absences)
            .putBoolean("notify-events", settings.events)
            .apply()
        scope.launch {
            val session = engine.currentSession() ?: return@launch
            if (link.value.linked) runCatching { client.saveSettings(session, settings) }
        }
    }

    suspend fun refreshSchulnetz() = refreshMutex.withLock {
        val session = engine.currentSession() ?: return
        val previous = snapshot.value
        val remote = runCatching { client.status(session) }.getOrElse { error ->
            if (error is SchulnetzHttpException && (error.status == 404 || error.status == 503)) {
                SchulnetzLinkState(reachable = false, baseUrl = baseUrl(), lastError = error.message.orEmpty())
            } else {
                link.value.copy(lastError = error.message ?: "Schulnetz nicht erreichbar")
            }
        }
        link.value = remote
        if (usesWebsiteSession(baseUrl())) {
            val scraped = refreshWebsite(previous)
            if (scraped != null) {
                publishSnapshot(previous, scraped, notifySettings())
                runCatching { client.uploadSnapshot(session, scraped) }
            } else if (remote.linked) {
                val body = runCatching { client.snapshot(session) }.getOrNull()
                val next = body?.let { parseNormalizedSnapshot(it) }
                if (next != null) publishSnapshot(previous, next, remote.settings)
            }
            if (remote.topic.isNotBlank()) prefs.edit().putString("push-server", remote.pushServer).putString("push-topic", remote.topic).apply()
            if (instantPush() && remote.topic.isNotBlank()) NtfyListenService.start(context)
            NextLessonWidget.update(context)
            return
        }
        if (remote.linked) {
            deleteLocalToken()
            prefs.edit().putString("push-server", remote.pushServer).putString("push-topic", remote.topic).apply()
            val body = client.snapshot(session)
            val next = parseNormalizedSnapshot(body) ?: previous
            publishSnapshot(previous, next, remote.settings)
            val changes = runCatching { client.changes(session, prefs.getLong("change-cursor", 0L)) }.getOrNull()
            if (changes != null) applyServerChanges(changes)
            if (instantPush() && remote.topic.isNotBlank()) NtfyListenService.start(context)
            NextLessonWidget.update(context)
            return
        }
        refreshLocally(previous)
        NextLessonWidget.update(context)
    }

    suspend fun registerPushEndpoint(endpoint: String) {
        val session = engine.currentSession() ?: return
        if (!link.value.linked) return
        runCatching { client.registerEndpoint(session, endpoint) }
    }

    fun notes(): List<VaultNode> {
        fun walk(nodes: List<VaultNode>): List<VaultNode> = nodes.flatMap { node ->
            val self = if (node.kind == NoteKind.MARKDOWN && node.path.endsWith(".md") && node.path != HOMEWORK_NOTE_PATH && node.path != CALENDAR_NOTE_PATH) {
                listOf(node)
            } else {
                emptyList()
            }
            self + walk(node.children)
        }
        return walk(store.tree())
    }

    fun homework(): HomeworkDocument {
        val text = vault.read(HOMEWORK_NOTE_PATH)?.decodeToString() ?: return HomeworkDocument(emptyList())
        return parseHomeworkMarkdown(text)
    }

    fun setHomeworkDone(id: String, done: Boolean) {
        val existing = vault.read(HOMEWORK_NOTE_PATH)?.decodeToString()
        val loaded = existing?.let(::loadHomeworkMarkdown)
        if (loaded is NoteMarkdownLoad.Unreadable) return
        val document = (loaded as? NoteMarkdownLoad.Ready)?.document ?: HomeworkDocument(emptyList())
        val now = isoNow()
        val tasks = document.tasks.map { task ->
            if (task.id == id) task.copy(done = done, updatedAt = now) else task
        }
        vault.write(HOMEWORK_NOTE_PATH, serializeHomeworkMarkdown(document.copy(tasks = tasks)).encodeToByteArray())
        engine.notifyLocalChange()
    }

    fun importHomework(title: String, subject: String, due: String, notes: String) {
        val existing = vault.read(HOMEWORK_NOTE_PATH)?.decodeToString()
        if (existing != null && loadHomeworkMarkdown(existing) is NoteMarkdownLoad.Unreadable) return
        val document = existing?.let(::parseHomeworkMarkdown) ?: HomeworkDocument(emptyList())
        if (document.tasks.any { it.title == title && it.dueDate == due.ifBlank { null } }) return
        val now = isoNow()
        val task = HomeworkTask(
            id = "schulnetz-${title.hashCode().toUInt().toString(16)}",
            title = title,
            notes = notes,
            subject = subject,
            dueDate = due.ifBlank { null },
            createdAt = now,
            updatedAt = now,
        )
        vault.write(HOMEWORK_NOTE_PATH, serializeHomeworkMarkdown(document.copy(tasks = document.tasks + task)).encodeToByteArray())
        engine.notifyLocalChange()
    }

    fun calendar(): CalendarDocument {
        val text = vault.read(CALENDAR_NOTE_PATH)?.decodeToString() ?: return emptyCalendar()
        return parseCalendarMarkdown(text)
    }

    fun importExam(event: AgendaEvent) {
        val existing = vault.read(CALENDAR_NOTE_PATH)?.decodeToString()
        if (existing != null && loadCalendarMarkdown(existing) is NoteMarkdownLoad.Unreadable) return
        val document = existing?.let(::parseCalendarMarkdown) ?: emptyCalendar()
        val id = "schulnetz-${event.id}"
        if (document.events.any { it.id == id }) return
        val calendars = if (document.calendars.any { it.id == "school" }) document.calendars else document.calendars + CalendarDef("school", "Schule", "#3d8bfd")
        val added = CalendarEvent(
            id = id,
            calendarId = "school",
            title = event.label,
            start = event.start,
            end = event.end.ifBlank { event.start },
            allDay = !event.start.contains('T'),
            location = event.room,
            notes = event.comment,
        )
        vault.write(CALENDAR_NOTE_PATH, serializeCalendarMarkdown(CalendarDocument(calendars, document.events + added)).encodeToByteArray())
        engine.notifyLocalChange()
    }

    fun hypothetical(): List<HypotheticalGrade> {
        val text = vault.read(HYPOTHETICAL_PATH)?.decodeToString() ?: return emptyList()
        val obj = runCatching { parseJson(text) as? JsonValue.Obj }.getOrNull() ?: return emptyList()
        return obj.array("grades")?.items.orEmpty().mapNotNull { item ->
            val grade = item as? JsonValue.Obj ?: return@mapNotNull null
            val mark = grade.double("mark") ?: return@mapNotNull null
            HypotheticalGrade(
                id = grade.string("id") ?: return@mapNotNull null,
                courseId = grade.string("courseId").orEmpty(),
                title = grade.string("title").orEmpty(),
                mark = mark,
                weight = grade.double("weight") ?: 1.0,
            )
        }
    }

    fun saveHypothetical(grades: List<HypotheticalGrade>) {
        val body = buildString {
            append("{\"version\":1,\"grades\":[")
            grades.forEachIndexed { index, grade ->
                if (index > 0) append(',')
                append("{\"id\":").append(escapeJson(grade.id))
                append(",\"courseId\":").append(escapeJson(grade.courseId))
                append(",\"title\":").append(escapeJson(grade.title))
                append(",\"mark\":").append(grade.mark)
                append(",\"weight\":").append(grade.weight)
                append('}')
            }
            append("]}")
        }
        vault.write(HYPOTHETICAL_PATH, body.encodeToByteArray())
        engine.notifyLocalChange()
    }

    fun saveWebSession(session: WebSession) {
        prefs.edit().putString("web-session", """{"base":${escapeJson(session.baseUrl)},"php":${escapeJson(session.phpSessionId)},"id":${escapeJson(session.id)},"transid":${escapeJson(session.transid)}}""").apply()
    }

    fun debugHtml(): String = File(context.filesDir, "schulnetz-debug.html").takeIf { it.isFile }?.readText().orEmpty()

    private fun rememberDebug(html: String) {
        if (html.isBlank()) return
        File(context.filesDir, "schulnetz-debug.html").writeText(html.take(150_000))
    }

    private fun readWebSession(): WebSession? {
        val raw = prefs.getString("web-session", null) ?: return null
        val obj = runCatching { parseJson(raw) as? JsonValue.Obj }.getOrNull() ?: return null
        val php = obj.string("php").orEmpty()
        val id = obj.string("id").orEmpty()
        val transid = obj.string("transid").orEmpty()
        if (php.isBlank() || id.isBlank() || transid.isBlank()) return null
        return WebSession(obj.string("base").orEmpty().ifBlank { baseUrl() }, php, id, transid)
    }

    private suspend fun refreshWebsite(previous: SchulnetzSnapshot): SchulnetzSnapshot? {
        var current = readWebSession()
        var bundle = current?.let { runCatching { client.fetchWeb(baseUrl(), it) }.getOrNull() }
        if (bundle == null || bundle.problem != SessionProblem.NONE) {
            val landed = SchulnetzSilentLogin(context).await(baseUrl())
            if (landed == null) {
                link.value = link.value.copy(needsReauth = true, lastError = "Anmeldung nötig")
                return bundle?.snapshot
            }
            val php = phpSessionCookie(baseUrl())
            val extracted = ch.fasrv.fanotes.schulnetz.extractWebSession(landed.first, landed.second, baseUrl())
            if (extracted == null || php.isBlank()) return null
            current = extracted.copy(phpSessionId = php)
            saveWebSession(current)
            bundle = runCatching { client.fetchWeb(baseUrl(), current) }.getOrNull() ?: return null
        } else {
            saveWebSession(bundle.session)
        }
        if (bundle.debugHtml.isNotBlank()) rememberDebug(bundle.debugHtml)
        return bundle.snapshot.copy(revision = previous.revision + 1)
    }

    private suspend fun refreshLocally(previous: SchulnetzSnapshot) {
        val stored = readLocalToken() ?: return
        val lease = readLease()
        val claimed = localRefreshLease(serverLinked = false, lease, deviceId(), System.currentTimeMillis()) ?: return
        writeLease(claimed)
        val access: SchulnetzTokens = try {
            if (stored.accessToken.isNotBlank() && stored.accessExpiresAt > System.currentTimeMillis() + 30_000) {
                SchulnetzTokens(stored.accessToken, stored.refreshToken, null, null)
            } else {
                client.refresh(stored.baseUrl, stored.refreshToken, stored.deviceId)
            }
        } catch (_: Exception) {
            link.value = link.value.copy(needsReauth = true, lastError = "reauth", reachable = false)
            return
        }
        writeLocalToken(stored.copy(refreshToken = access.refreshToken.ifBlank { stored.refreshToken }, accessToken = access.accessToken, accessExpiresAt = System.currentTimeMillis() + ((access.expiresInSeconds ?: 600) - 60) * 1000))
        val raw = client.fetchRaw(stored.baseUrl, access.accessToken)
        val next = parseRawSnapshot(raw, isoNow()).copy(revision = previous.revision + 1)
        publishSnapshot(previous, next, notifySettings())
        vault.write(SNAPSHOT_VAULT_PATH, next.toNormalizedJson().encodeToByteArray())
        engine.notifyLocalChange()
    }

    private fun publishSnapshot(previous: SchulnetzSnapshot?, next: SchulnetzSnapshot, settings: NotifySettings) {
        val changes = diffSnapshots(previous?.takeIf { it.fetchedAt.isNotBlank() || it.grades.isNotEmpty() || it.events.isNotEmpty() }, next, settings)
        snapshot.value = next
        writeCache(next)
        CompanionAlerts.showAll(context, changes)
    }

    private fun applyServerChanges(json: String) {
        val obj = parseJson(json) as? JsonValue.Obj ?: return
        val items = obj.array("changes")?.items.orEmpty().mapNotNull { item ->
            val change = item as? JsonValue.Obj ?: return@mapNotNull null
            val id = change.string("id") ?: return@mapNotNull null
            SchulnetzChange(id, change.string("category").orEmpty(), change.string("title").orEmpty(), change.string("body").orEmpty())
        }
        CompanionAlerts.showAll(context, items)
        val maxRevision = obj.array("changes")?.items.orEmpty().mapNotNull { item ->
            (item as? JsonValue.Obj)?.double("revision")?.toLong()
        }.maxOrNull()
        if (maxRevision != null) prefs.edit().putLong("change-cursor", maxRevision).apply()
    }

    private fun readCachedSnapshot(): SchulnetzSnapshot {
        val file = snapshotFile(context)
        if (!file.isFile) return SchulnetzSnapshot()
        return runCatching { parseNormalizedSnapshot(file.readText()) }.getOrNull() ?: SchulnetzSnapshot()
    }

    private fun writeCache(value: SchulnetzSnapshot) {
        val file = snapshotFile(context)
        file.writeText(value.toNormalizedJson())
    }

    private fun readLocalToken(): LocalToken? {
        val text = vault.read(LOCAL_TOKEN_PATH)?.decodeToString() ?: return null
        val obj = runCatching { parseJson(text) as? JsonValue.Obj }.getOrNull() ?: return null
        val refresh = obj.string("refreshToken").orEmpty()
        if (refresh.isBlank()) return null
        return LocalToken(
            baseUrl = normalizeSchoolBase(obj.string("baseUrl").orEmpty()) ?: return null,
            deviceId = obj.string("deviceId").orEmpty().ifBlank { deviceId() },
            refreshToken = refresh,
            accessToken = obj.string("accessToken").orEmpty(),
            accessExpiresAt = obj.double("accessExpiresAt")?.toLong() ?: 0L,
        )
    }

    fun writeLocalToken(token: LocalToken) {
        val body = buildString {
            append("{\"baseUrl\":").append(escapeJson(token.baseUrl))
            append(",\"deviceId\":").append(escapeJson(token.deviceId))
            append(",\"refreshToken\":").append(escapeJson(token.refreshToken))
            append(",\"accessToken\":").append(escapeJson(token.accessToken))
            append(",\"accessExpiresAt\":").append(token.accessExpiresAt)
            append('}')
        }
        vault.write(LOCAL_TOKEN_PATH, body.encodeToByteArray())
    }

    fun clearLocalLink() {
        if (vault.exists(LOCAL_TOKEN_PATH)) vault.delete(LOCAL_TOKEN_PATH)
        if (vault.exists(LEASE_PATH)) vault.delete(LEASE_PATH)
        engine.notifyLocalChange()
    }

    private fun deleteLocalToken() {
        if (vault.exists(LOCAL_TOKEN_PATH)) vault.delete(LOCAL_TOKEN_PATH)
    }

    private fun readLease(): RefreshLease? {
        val text = vault.read(LEASE_PATH)?.decodeToString() ?: return null
        val obj = runCatching { parseJson(text) as? JsonValue.Obj }.getOrNull() ?: return null
        val holder = obj.string("holderId").orEmpty()
        if (holder.isBlank()) return null
        return RefreshLease(holder, obj.double("untilEpochMs")?.toLong() ?: 0L)
    }

    private fun writeLease(lease: RefreshLease) {
        vault.write(LEASE_PATH, """{"holderId":${escapeJson(lease.holderId)},"untilEpochMs":${lease.untilEpochMs}}""".encodeToByteArray())
    }

    private fun host() = object : SyncHost {
        override suspend fun vaultId(): String = vaultId
        override suspend fun scan(): List<SyncScanEntry> = vault.walkFiles().map { SyncScanEntry(it.path, it.size, it.mtimeMs) }
        override suspend fun read(path: String): ByteArray = vault.read(path) ?: throw NoSuchElementException(path)
        override suspend fun write(path: String, bytes: ByteArray, mtimeMs: Long): SyncScanEntry {
            vault.write(path, bytes)
            return SyncScanEntry(path, bytes.size.toLong(), vault.mtime(path).takeIf { it > 0 } ?: mtimeMs)
        }
        override suspend fun remove(path: String) { vault.delete(path) }
        override suspend fun readState(vaultId: String): String? = File(stateDir, fingerprint(vaultId) + ".json").takeIf { it.isFile }?.readText()
        override suspend fun writeState(vaultId: String, json: String?) {
            val file = File(stateDir, fingerprint(vaultId) + ".json")
            if (json == null) file.delete() else file.writeText(json)
        }
        override suspend fun readSecrets(): String? = secrets.read()
        override suspend fun writeSecrets(json: String?) { secrets.write(json) }
    }

    data class LocalToken(
        val baseUrl: String,
        val deviceId: String,
        val refreshToken: String,
        val accessToken: String,
        val accessExpiresAt: Long,
    )

    companion object {
        const val AKSA = "https://www.schulnetz-ag.ch/aksa"
        const val LOCAL_TOKEN_PATH = ".fanotes/schulnetz/link.json"
        const val LEASE_PATH = ".fanotes/schulnetz/lease.json"
        const val HYPOTHETICAL_PATH = ".fanotes/schulnetz/hypothetical.json"
        const val SNAPSHOT_VAULT_PATH = ".fanotes/schulnetz/snapshot.json"
        fun snapshotFile(context: Context) = File(context.filesDir, "schulnetz-snapshot.json")
    }
}

private fun fingerprint(value: String): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(value.toByteArray())
    return digest.joinToString("") { "%02x".format(it) }.take(32)
}
