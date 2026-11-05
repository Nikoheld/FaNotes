package ch.fasrv.fanotes.companion

import android.content.Intent
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
import ch.fasrv.fanotes.schulnetz.SchulnetzGate
import ch.fasrv.fanotes.schulnetz.SchulnetzSnapshot
import ch.fasrv.fanotes.schulnetz.diffSnapshots
import ch.fasrv.fanotes.schulnetz.newGradeTargetIds
import ch.fasrv.fanotes.schulnetz.localRefreshLease
import ch.fasrv.fanotes.schulnetz.classifySchulnetzPage
import ch.fasrv.fanotes.schulnetz.extractWebSession
import ch.fasrv.fanotes.schulnetz.normalizeSchoolBase
import ch.fasrv.fanotes.schulnetz.pageUrl
import ch.fasrv.fanotes.schulnetz.sessionIdsFromPage
import ch.fasrv.fanotes.schulnetz.redactSchulnetzSecrets
import ch.fasrv.fanotes.schulnetz.SessionProblem
import ch.fasrv.fanotes.schulnetz.SchulnetzTokens
import ch.fasrv.fanotes.schulnetz.WebSession
import ch.fasrv.fanotes.schulnetz.isLoggedInLanding
import ch.fasrv.fanotes.schulnetz.webLoginUrl
import ch.fasrv.fanotes.schulnetz.parseNormalizedSnapshot
import ch.fasrv.fanotes.schulnetz.parseRawSnapshot
import ch.fasrv.fanotes.schulnetz.schulnetzDeviceId
import ch.fasrv.fanotes.schulnetz.toNormalizedJson
import ch.fasrv.fanotes.schulnetz.usesWebsiteSession
import ch.fasrv.fanotes.schulnetz.DeskPrefs
import ch.fasrv.fanotes.schulnetz.GradeBook
import ch.fasrv.fanotes.schulnetz.HiddenLesson
import ch.fasrv.fanotes.schulnetz.changeFromObj
import ch.fasrv.fanotes.schulnetz.changeIsHidden
import ch.fasrv.fanotes.schulnetz.parseDeskPrefs
import ch.fasrv.fanotes.schulnetz.parseGradeBook
import ch.fasrv.fanotes.schulnetz.parseHiddenLessons
import ch.fasrv.fanotes.schulnetz.serializeDeskPrefs
import ch.fasrv.fanotes.schulnetz.serializeGradeBook
import ch.fasrv.fanotes.schulnetz.serializeHiddenLessons
import ch.fasrv.fanotes.sync.SyncApi
import ch.fasrv.fanotes.sync.SyncEngine
import ch.fasrv.fanotes.sync.SyncEngineOptions
import ch.fasrv.fanotes.sync.SyncHost
import ch.fasrv.fanotes.sync.SyncScanEntry
import ch.fasrv.fanotes.vault.DirectoryVault
import ch.fasrv.fanotes.vault.NoteKind
import ch.fasrv.fanotes.vault.NoteStore
import ch.fasrv.fanotes.vault.censusNotes
import ch.fasrv.fanotes.vault.folderChildren
import ch.fasrv.fanotes.vault.folderExists
import ch.fasrv.fanotes.vault.VaultIo
import ch.fasrv.fanotes.vault.VaultNode
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.io.File
import java.security.MessageDigest
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

class CompanionGraph(private val context: Context) {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val prefs = context.getSharedPreferences("fanotes-companion", Context.MODE_PRIVATE)
    private val secrets = VaultSecrets(context)
    val root: File = File(context.filesDir, "vault").apply { mkdirs() }
    val vault: VaultIo = DirectoryVault(root.toPath())
    val store = NoteStore(vault)
    val vaultId: String = fingerprint(root.absolutePath)
    @Volatile var busyPaths: Set<String> = emptySet()
    val snapshot = MutableStateFlow(SchulnetzSnapshot())
    val link = MutableStateFlow(SchulnetzLinkState())
    val client = SchulnetzClient()
    val schulnetzLog = SchulnetzLog(File(context.filesDir, "schulnetz"))
    val browser = SchulnetzBrowser(context, schulnetzLog)
    val gate = SchulnetzGate()
    val loginRequests = MutableSharedFlow<Intent>(extraBufferCapacity = 1)
    val notices = MutableSharedFlow<String>(extraBufferCapacity = 4)
    val vaultChanges = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    fun localAccess(): Boolean = prefs.getBoolean("local-access", false)
    fun setLocalAccess(enabled: Boolean) { prefs.edit().putBoolean("local-access", enabled).apply() }
    private val guestLock = Mutex()
    private val guestFile: File get() = File(context.filesDir, "kanti-guest.json")
    fun plannerHold(): Boolean = prefs.getBoolean(PLANNER_HOLD_PREF, false)
    fun setPlannerHold(hold: Boolean) {
        prefs.edit().putBoolean(PLANNER_HOLD_PREF, hold).apply()
        busyPaths = if (hold) PLANNER_HOLD_PATHS else emptySet()
    }
    /** Keep tasks, calendar and desk settings on this device until the user agrees to upload them. */
    fun armPlannerHold(): Boolean {
        val tasks = runCatching { homework().tasks.any { it.title.isNotBlank() } }.getOrDefault(true)
        val events = runCatching { calendar().events.isNotEmpty() }.getOrDefault(true)
        val deskCustom = vault.exists(DESK_PATH) && runCatching { deskPrefs() != DeskPrefs(theme = themeId()) }.getOrDefault(true)
        val hold = tasks || events || deskCustom
        if (hold) setPlannerHold(true)
        return hold
    }
    fun releasePlannerHold() = setPlannerHold(false)
    @Volatile var signedOut: Boolean = false
    @Volatile var oauthPermitted: Boolean = false
    @Volatile var viewingSession: Boolean = false
    private var oauthConsumed = false
    private var loginResult: CompletableDeferred<Boolean>? = null
    private var lastRefreshAt = 0L
    private var lastSessionShownAt = 0L
    private val stateDir = File(context.filesDir, "sync-state").apply { mkdirs() }

    val engine: SyncEngine = SyncEngine(
        SyncApi(OkHttpSyncTransport()),
        SyncEngineOptions(
            platform = "android-phone",
            deviceName = { prefs.getString("device-name", null)?.ifBlank { null } ?: "Kanti+" },
            automatic = { true },
            isPathBusy = { path -> path in busyPaths },
            onApplied = { _, _ -> vaultChanges.tryEmit(Unit) },
        ),
    )

    init {
        if (plannerHold()) busyPaths = PLANNER_HOLD_PATHS
        engine.attach(host())
        scope.launch {
            val cached = readCachedSnapshot()
            if (cached.fetchedAt.isNotBlank() || cached.grades.isNotEmpty() || cached.events.isNotEmpty()) {
                snapshot.value = cached
            }
        }
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

    fun hasInstantPush(): Boolean = fcmPushHealthy(lastPushAt(), System.currentTimeMillis(), firebaseConfigured(context))

    fun baseUrl(): String = normalizeSchoolBase(prefs.getString("schulnetz-base", null) ?: AKSA) ?: AKSA

    fun setBaseUrl(value: String) {
        val normal = normalizeSchoolBase(value) ?: return
        if (normal != baseUrl()) {
            prefs.edit().remove("web-session").apply()
            signedOut = true
        }
        prefs.edit().putString("schulnetz-base", normal).apply()
    }

    fun notifySettings(): NotifySettings = NotifySettings(
        grades = prefs.getBoolean("notify-grades", true),
        timetable = prefs.getBoolean("notify-timetable", true),
        exams = prefs.getBoolean("notify-exams", true),
        absences = prefs.getBoolean("notify-absences", true),
        events = prefs.getBoolean("notify-events", true),
        deadlines = prefs.getBoolean("notify-deadlines", true),
        guessGrades = prefs.getBoolean(GUESS_GRADES_PREF, false),
    )

    fun setNotifySettings(settings: NotifySettings) {
        prefs.edit()
            .putBoolean("notify-grades", settings.grades)
            .putBoolean("notify-timetable", settings.timetable)
            .putBoolean("notify-exams", settings.exams)
            .putBoolean("notify-absences", settings.absences)
            .putBoolean("notify-events", settings.events)
            .putBoolean("notify-deadlines", settings.deadlines)
            .putBoolean(GUESS_GRADES_PREF, settings.guessGrades)
            .apply()
        scope.launch {
            val auth = runCatching { schoolAuth() }.getOrNull() ?: return@launch
            if (link.value.linked) runCatching { client.saveSettings(auth, settings) }
        }
    }

    fun unrevealedGradeIds(): Set<String> = prefs.getStringSet(UNREVEALED_PREF, emptySet()).orEmpty().toSet()

    fun addUnrevealedGrades(ids: Collection<String>) {
        val next = ids.filter { it.isNotBlank() }
        if (next.isEmpty()) return
        val stored = prefs.getStringSet(UNREVEALED_PREF, emptySet()).orEmpty().toMutableSet()
        if (!stored.addAll(next)) return
        prefs.edit().putStringSet(UNREVEALED_PREF, stored).apply()
    }

    fun revealGrade(id: String) {
        if (id.isBlank()) return
        val stored = prefs.getStringSet(UNREVEALED_PREF, emptySet()).orEmpty().toMutableSet()
        if (!stored.remove(id)) return
        prefs.edit().putStringSet(UNREVEALED_PREF, stored).apply()
    }

    suspend fun refreshSchulnetz(caller: String = "unspecified") {
        if (schoolDisconnected()) return
        schulnetzLog.info("refresh queued caller=$caller lockHeld=${gate.isLocked} holder=${gate.holder.orEmpty()}")
        withContext(Dispatchers.IO) {
            gate.exclusive("refresh:$caller") {
                schulnetzLog.info("refresh running caller=$caller lockHeld=true holder=${gate.holder.orEmpty()}")
                refreshLocked(caller)
                lastRefreshAt = System.currentTimeMillis()
                prefs.edit().putLong("last-check", lastRefreshAt).apply()
            }
        }
    }

    private suspend fun refreshLocked(caller: String) {
        val session = runCatching { schoolAuth() }.getOrElse { error ->
            prefs.edit().putString("last-check-error", error.message ?: "Schulnetz nicht erreichbar").apply()
            schulnetzLog.error(error)
            return
        }
        val previous = snapshot.value
        prefs.edit().putLong("last-check", System.currentTimeMillis()).putString("last-check-error", "").apply()
        val remote = runCatching { client.status(session) }.getOrElse { error ->
            if (error is SchulnetzHttpException && (error.status == 404 || error.status == 503)) {
                SchulnetzLinkState(reachable = false, baseUrl = baseUrl(), lastError = error.message.orEmpty())
            } else {
                prefs.edit().putString("last-check-error", error.message ?: "Schulnetz nicht erreichbar").apply()
                link.value.copy(lastError = error.message ?: "Schulnetz nicht erreichbar")
            }
        }
        link.value = remote.copy(needsReauth = false)
        if (usesWebsiteSession(baseUrl())) {
            val scraped = refreshWebsite(previous)
            if (scraped != null) {
                link.value = link.value.copy(needsReauth = false, lastError = "")
                publishSnapshot(previous, scraped, notifySettings())
                runCatching { client.uploadSnapshot(session, scraped) }
                    .onFailure { schulnetzLog.error(it) }
            } else if (remote.linked && !link.value.needsReauth) {
                val body = runCatching { client.snapshot(session) }.getOrNull()
                val next = body?.let { parseNormalizedSnapshot(it) }
                if (next != null) publishSnapshot(previous, next, remote.settings)
            }
            if (remote.linked) prefs.edit().putBoolean("school-linked", true).remove("push-topic").remove("push-server").apply()
            configurePushDelivery(context)
            NextLessonWidget.update(context)
            return
        }
        if (remote.linked) {
            deleteLocalToken()
            prefs.edit().putBoolean("school-linked", true).remove("push-topic").remove("push-server").apply()
            val body = client.snapshot(session)
            val next = parseNormalizedSnapshot(body) ?: previous
            publishSnapshot(previous, next, remote.settings)
            val changes = runCatching { client.changes(session, prefs.getLong("change-cursor", 0L)) }.getOrNull()
            if (changes != null) applyServerChanges(changes)
            configurePushDelivery(context)
            NextLessonWidget.update(context)
            return
        }
        refreshLocally(previous)
        configurePushDelivery(context)
        NextLessonWidget.update(context)
    }

    fun noteFolderExists(folder: String): Boolean = folderExists(store.tree(), folder)

    fun notes(folder: String = ""): List<VaultNode> {
        val skip = setOf(HOMEWORK_NOTE_PATH, CALENDAR_NOTE_PATH)
        return folderChildren(store.tree(), folder).filter { node ->
            node.kind == NoteKind.FOLDER || node.path !in skip
        }
    }

    fun writtenNoteCount(): Int = censusNotes(store.tree(), setOf(HOMEWORK_NOTE_PATH, CALENDAR_NOTE_PATH)).notes

    fun logNoteCensus() {
        val census = censusNotes(store.tree(), setOf(HOMEWORK_NOTE_PATH, CALENDAR_NOTE_PATH))
        val detail = census.perFolder.entries.joinToString(",") { (folder, count) -> "$folder:$count" }
        schulnetzLog.info("notes fetched=${census.notes} folders=${census.folders} perFolder=$detail")
    }

    fun homework(): HomeworkDocument {
        val text = vault.read(HOMEWORK_NOTE_PATH)?.decodeToString() ?: return HomeworkDocument(emptyList())
        return (loadHomeworkMarkdown(text) as? NoteMarkdownLoad.Ready)?.document
            ?: throw IllegalStateException("${t(R.string.task_file_unreadable)}")
    }

    fun setHomeworkDone(id: String, done: Boolean) {
        patchHomework(id) { it.copy(done = done) }
    }

    fun setHomeworkNotes(id: String, notes: String) {
        patchHomework(id) { it.copy(notes = notes.take(4000)) }
    }

    private fun patchHomework(id: String, edit: (HomeworkTask) -> HomeworkTask) {
        val existing = vault.read(HOMEWORK_NOTE_PATH)?.decodeToString()
        val loaded = existing?.let(::loadHomeworkMarkdown)
        if (loaded is NoteMarkdownLoad.Unreadable) error("${t(R.string.task_file_unreadable)}")
        val document = (loaded as? NoteMarkdownLoad.Ready)?.document ?: HomeworkDocument(emptyList())
        val now = isoNow()
        val tasks = document.tasks.map { task ->
            if (task.id == id) edit(task).copy(updatedAt = now) else task
        }
        vault.write(HOMEWORK_NOTE_PATH, serializeHomeworkMarkdown(document.copy(tasks = tasks)).encodeToByteArray())
        engine.notifyLocalChange()
    }

    fun importHomework(title: String, subject: String, due: String, notes: String) {
        val existing = vault.read(HOMEWORK_NOTE_PATH)?.decodeToString()
        if (existing != null && loadHomeworkMarkdown(existing) is NoteMarkdownLoad.Unreadable) error("${t(R.string.task_file_unreadable)}")
        val document = existing?.let(::parseHomeworkMarkdown) ?: HomeworkDocument(emptyList())
        val dueDate = parseDisplayDate(due)?.toString()
        if (document.tasks.any { it.title == title && it.subject == subject && it.dueDate == dueDate }) return
        val now = isoNow()
        val task = HomeworkTask(
            id = "schulnetz-${java.util.UUID.randomUUID()}",
            title = title,
            notes = notes,
            subject = subject,
            dueDate = dueDate,
            createdAt = now,
            updatedAt = now,
        )
        vault.write(HOMEWORK_NOTE_PATH, serializeHomeworkMarkdown(document.copy(tasks = document.tasks + task)).encodeToByteArray())
        engine.notifyLocalChange()
    }

    fun calendar(): CalendarDocument {
        val text = vault.read(CALENDAR_NOTE_PATH)?.decodeToString() ?: return emptyCalendar()
        return (loadCalendarMarkdown(text) as? NoteMarkdownLoad.Ready)?.document
            ?: throw IllegalStateException("${t(R.string.calendar_file_unreadable)}")
    }

    fun importExam(event: AgendaEvent) {
        val existing = vault.read(CALENDAR_NOTE_PATH)?.decodeToString()
        if (existing != null && loadCalendarMarkdown(existing) is NoteMarkdownLoad.Unreadable) error("${t(R.string.calendar_file_unreadable)}")
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

    fun saveHomeworkTask(task: HomeworkTask) {
        val current = homework()
        val now = isoNow()
        val next = task.copy(updatedAt = now, createdAt = task.createdAt.ifBlank { now })
        val tasks = if (current.tasks.any { it.id == task.id }) current.tasks.map { if (it.id == task.id) next else it } else current.tasks + next
        vault.write(HOMEWORK_NOTE_PATH, serializeHomeworkMarkdown(current.copy(tasks = tasks)).encodeToByteArray())
        engine.notifyLocalChange()
    }
    fun deleteHomeworkTask(id: String) {
        val current = homework()
        vault.write(HOMEWORK_NOTE_PATH, serializeHomeworkMarkdown(current.copy(tasks = current.tasks.filterNot { it.id == id })).encodeToByteArray())
        engine.notifyLocalChange()
    }
    fun saveCalendarEvent(event: CalendarEvent) {
        val current = calendar()
        val events = if (current.events.any { it.id == event.id }) current.events.map { if (it.id == event.id) event else it } else current.events + event
        vault.write(CALENDAR_NOTE_PATH, serializeCalendarMarkdown(current.copy(events = events)).encodeToByteArray())
        engine.notifyLocalChange()
    }
    fun deleteCalendarEvent(id: String) {
        val current = calendar()
        vault.write(CALENDAR_NOTE_PATH, serializeCalendarMarkdown(current.copy(events = current.events.filterNot { it.id == id })).encodeToByteArray())
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

    fun gradeBook(): GradeBook {
        val text = vault.read(GRADE_BOOK_PATH)?.decodeToString() ?: return GradeBook()
        return parseGradeBook(text)
    }

    fun saveGradeBook(book: GradeBook) {
        vault.write(GRADE_BOOK_PATH, serializeGradeBook(book).encodeToByteArray())
        engine.notifyLocalChange()
    }

    fun subjectColors(): Map<String, String> {
        val text = vault.read(COLORS_PATH)?.decodeToString() ?: return emptyMap()
        val obj = runCatching { parseJson(text) as? JsonValue.Obj }.getOrNull() ?: return emptyMap()
        return obj.fields.mapNotNull { (key, value) ->
            val color = (value as? JsonValue.Str)?.value ?: return@mapNotNull null
            key to color
        }.toMap()
    }

    fun deskPrefs(): DeskPrefs {
        val text = vault.read(DESK_PATH)?.decodeToString() ?: return DeskPrefs(theme = themeId())
        return parseDeskPrefs(text).let { if (it.theme.isBlank()) it.copy(theme = themeId()) else it }
    }

    fun saveDeskPrefs(prefs: DeskPrefs) {
        vault.write(DESK_PATH, serializeDeskPrefs(prefs).encodeToByteArray())
        setTheme(prefs.theme)
        engine.notifyLocalChange()
        NextLessonWidget.update(context)
    }

    fun hiddenLessons(): List<HiddenLesson> {
        val text = vault.read(HIDDEN_PATH)?.decodeToString() ?: return emptyList()
        return parseHiddenLessons(text)
    }

    fun saveHiddenLessons(rules: List<HiddenLesson>) {
        vault.write(HIDDEN_PATH, serializeHiddenLessons(rules).encodeToByteArray())
        engine.notifyLocalChange()
        NextLessonWidget.update(context)
    }

    fun lastCheckAt(): Long = prefs.getLong("last-check", 0L)

    fun lastPushAt(): Long = prefs.getLong(LAST_PUSH_PREF, 0L)

    fun lastCheckError(): String = prefs.getString("last-check-error", "").orEmpty()

    fun nextCheckAt(): Long {
        val last = lastCheckAt()
        if (last <= 0L) return 0L
        return last + schoolFallbackIntervalMs()
    }

    /**
     * One short read of new school changes. Used from FCM and the rare fallback.
     * Does not scrape Schulnetz and does not sync notes.
     */
    suspend fun pullChangeDelta() {
        if (schoolDisconnected()) return
        withContext(Dispatchers.IO) {
            withTimeoutOrNull(8_000) {
                val session = runCatching { schoolAuth() }.getOrNull() ?: return@withTimeoutOrNull
                val changes = runCatching { client.changes(session, prefs.getLong("change-cursor", 0L), quick = true) }.getOrNull()
                    ?: return@withTimeoutOrNull
                applyServerChanges(changes)
                prefs.edit().putLong("last-check", System.currentTimeMillis()).putString("last-check-error", "").apply()
            }
        }
    }

    suspend fun registerFcmToken(token: String) {
        if (token.isBlank()) return
        prefs.edit().putString("fcm-token", token).apply()
        if (schoolDisconnected()) return
        val session = runCatching { schoolAuth() }.getOrNull() ?: return
        if (!prefs.getBoolean("school-linked", false) && prefs.getString("push-topic", null).isNullOrBlank() && !link.value.linked) return
        if (link.value.linked || !prefs.getString("push-topic", null).isNullOrBlank()) {
            prefs.edit().putBoolean("school-linked", true).remove("push-topic").remove("push-server").apply()
        }
        runCatching { client.registerFcmToken(session, token) }
            .onFailure { schulnetzLog.error(it) }
    }

    fun setSubjectColor(subject: String, color: String) {
        val keys = ch.fasrv.fanotes.schulnetz.colorKeys(subject)
        if (keys.isEmpty()) return
        val next = subjectColors().toMutableMap()
        if (color.isBlank()) keys.forEach { next.remove(it) } else keys.forEach { next[it] = color }
        val body = buildString {
            append('{')
            next.entries.forEachIndexed { index, (name, value) ->
                if (index > 0) append(',')
                append(escapeJson(name)).append(':').append(escapeJson(value))
            }
            append('}')
        }
        vault.write(COLORS_PATH, body.encodeToByteArray())
        engine.notifyLocalChange()
    }

    fun iconChoice(): String = prefs.getString("launcher-icon", "standard").orEmpty().ifBlank { "standard" }

    fun setIconChoice(id: String) {
        prefs.edit().putString("launcher-icon", id).apply()
    }

    fun recordOpenToday() {
        val today = java.time.LocalDate.now().toString()
        val kept = prefs.getStringSet("open-days", emptySet()).orEmpty().filter { it >= java.time.LocalDate.now().minusDays(40).toString() }.toMutableSet()
        kept += today
        prefs.edit().putStringSet("open-days", kept).apply()
    }

    fun streakDays(): Int = ch.fasrv.fanotes.schulnetz.openingStreak(prefs.getStringSet("open-days", emptySet()).orEmpty(), java.time.LocalDate.now())

    fun saveWebSession(session: WebSession) {
        prefs.edit().putString("web-session", """{"base":${escapeJson(session.baseUrl)},"php":${escapeJson(session.phpSessionId)},"id":${escapeJson(session.id)},"transid":${escapeJson(session.transid)}}""").apply()
    }

    fun debugHtml(): String = File(context.filesDir, "schulnetz-debug.html").takeIf { it.isFile }?.readText().orEmpty()

    private fun rememberDebug(html: String) {
        if (html.isBlank()) return
        File(context.filesDir, "schulnetz-debug.html").writeText(html.take(150_000))
    }

    private fun keepDebug(html: String) {
        rememberDebug(html)
        if (html.isNotBlank()) schulnetzLog.rememberPage("last", "", html)
    }

    fun shareMeta(): String {
        val info = runCatching { context.packageManager.getPackageInfo(context.packageName, 0) }.getOrNull()
        val version = info?.versionName ?: "?"
        val code = info?.longVersionCode?.toString() ?: "?"
        return buildString {
            appendLine("app=$version ($code)")
            appendLine("package=${context.packageName}")
            appendLine("device=${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL}")
            appendLine("android=${android.os.Build.VERSION.RELEASE} sdk=${android.os.Build.VERSION.SDK_INT}")
            appendLine("family=${SchulnetzBrowser.localAddressFamily()}")
        }
    }

    fun buildShareZip(includeCaptures: Boolean = false): File {
        val dir = File(context.cacheDir, "share").apply { mkdirs() }
        val zip = File(dir, "schulnetz-logs.zip")
        ZipOutputStream(zip.outputStream()).use { out ->
            fun put(name: String, text: String) {
                if (!diagnosticEntryAllowed(name, includeCaptures)) return
                out.putNextEntry(ZipEntry(name))
                out.write(text.toByteArray())
                out.closeEntry()
            }
            put("device.txt", shareMeta())
            put("schulnetz.log", schulnetzLog.text().ifBlank { "(leer)\n" })
            if (includeCaptures) {
                schulnetzLog.captureFiles().forEach { file -> put("captures/${file.name}", file.readText()) }
                val debug = redactSchulnetzSecrets(debugHtml())
                if (debug.isNotBlank()) put("last-page.html", debug)
            }
        }
        return zip
    }

    private fun readWebSession(): WebSession? {
        val raw = prefs.getString("web-session", null) ?: return null
        val obj = runCatching { parseJson(raw) as? JsonValue.Obj }.getOrNull() ?: return null
        val id = obj.string("id").orEmpty()
        val transid = obj.string("transid").orEmpty()
        if (id.isBlank() || transid.isBlank()) return null
        return WebSession(obj.string("base").orEmpty().ifBlank { baseUrl() }, obj.string("php").orEmpty(), id, transid)
    }

    private suspend fun refreshWebsite(previous: SchulnetzSnapshot): SchulnetzSnapshot? {
        schulnetzLog.info("refresh pages family=${SchulnetzBrowser.localAddressFamily()} signedOut=$signedOut lockHeld=${gate.isLocked} holder=${gate.holder.orEmpty()} microsoftCookies=${microsoftCookieNames()}")
        var current = readWebSession() ?: WebSession(baseUrl(), phpSessionCookie(baseUrl()), "", "")
        var bundle = runCatching { client.fetchWeb(baseUrl(), current, browser::load, signedOut, schulnetzLog::info, previous) }.onFailure { schulnetzLog.error(it) }.getOrNull()
        storeCaptures(bundle)
        if (bundle != null && bundle.oauthPage != null && bundle.okPages > 0) {
            val kept = recoverOauth(previous, bundle)
            signedOut = false
            link.value = link.value.copy(needsReauth = false, lastError = "")
            return kept
        }
        if (bundle?.problem == SessionProblem.INTERACTIVE) {
            schulnetzLog.info("interactive login required lockHeld=true holder=${gate.holder.orEmpty()}")
            keepDebug(bundle.debugHtml)
            markLoginRequired()
            return null
        }
        if (bundle == null || bundle.problem != SessionProblem.NONE) {
            schulnetzLog.info("session problem=${bundle?.problem ?: "load-failed"} lockHeld=true holder=${gate.holder.orEmpty()}")
            keepDebug(bundle?.debugHtml.orEmpty())
            val silent = silentLogin("session-problem")
            if (silent == null) {
                markLoginRequired()
                return null
            }
            current = silent
            bundle = runCatching { client.fetchWeb(baseUrl(), current, browser::load, signedOut = false, trace = schulnetzLog::info, previous = previous) }.onFailure { schulnetzLog.error(it) }.getOrNull()
            storeCaptures(bundle)
            if (bundle != null && bundle.oauthPage != null && bundle.okPages > 0) {
                signedOut = false
                link.value = link.value.copy(needsReauth = false, lastError = "")
                return keepLoaded(previous, bundle.snapshot)
            }
            if (bundle == null || bundle.problem != SessionProblem.NONE) {
                keepDebug(bundle?.debugHtml.orEmpty())
                markLoginRequired()
                return null
            }
        }
        if (bundle.session.id.isNotBlank()) saveWebSession(bundle.session.copy(phpSessionId = phpSessionCookie(baseUrl())))
        keepDebug(bundle.debugHtml)
        if (bundle.okPages > 0 && bundle.problem != SessionProblem.LOGIN_WALL && bundle.problem != SessionProblem.INTERACTIVE) {
            signedOut = false
            link.value = link.value.copy(needsReauth = false, lastError = "")
            schulnetzLog.info("login required cleared okPages=${bundle.okPages} lockHeld=true")
        }
        return keepLoaded(previous, bundle.snapshot).copy(readErrors = bundle.snapshot.readErrors.filter { it != "Bei Schulnetz neu anmelden" })
    }

    private fun storeCaptures(bundle: WebBundle?) {
        bundle?.captures?.forEach { (name, html) -> schulnetzLog.rememberPage(name, "", html) }
    }

    private suspend fun recoverOauth(previous: SchulnetzSnapshot, bundle: WebBundle): SchulnetzSnapshot {
        schulnetzLog.info("oauth handshake page=${bundle.oauthPage} okPages=${bundle.okPages} lockHeld=${gate.isLocked} holder=${gate.holder.orEmpty()}")
        keepDebug(bundle.debugHtml)
        val partial = keepLoaded(previous, bundle.snapshot)
        delay(2_000)
        val fresh = silentLogin("oauth-retry") ?: return partial
        val pageId = bundle.oauthPage ?: return partial
        if (pageId == "1" || pageId == "scheduler" || pageId == "ical") return partial
        val html = debugHtml()
        val retryUrl = ch.fasrv.fanotes.schulnetz.linkedPageUrl(html, pageId, baseUrl(), fresh.id)
            ?: pageUrl(baseUrl(), pageId, fresh.id, fresh.transid)
        schulnetzLog.info("oauth retry page=$pageId lockHeld=true holder=${gate.holder.orEmpty()} url=${redactSchulnetzSecrets(retryUrl)}")
        val page = runCatching { browser.load(retryUrl) }.onFailure { schulnetzLog.error(it) }.getOrNull() ?: return partial
        val classified = classifySchulnetzPage(page.finalUrl, page.body)
        schulnetzLog.info("oauth retry result rule=${classified.rule} class=${classified.problem} bytes=${page.body.length} lockHeld=true")
        if (classified.problem != SessionProblem.NONE) return partial
        sessionIdsFromPage(page.finalUrl, page.body)?.let { ids ->
            saveWebSession(fresh.copy(id = ids.id, transid = ids.transid))
        }
        return keepLoaded(previous, client.mergePage(partial, pageId, page.body))
    }

    private suspend fun silentLogin(caller: String): WebSession? {
        if (!silentLoginAllowed()) {
            schulnetzLog.info("silent login suppressed caller=$caller lockHeld=${gate.isLocked} holder=${gate.holder.orEmpty()} reason=backoff")
            return null
        }
        if (!hasMicrosoftCookies()) {
            schulnetzLog.info("silent login skipped caller=$caller lockHeld=${gate.isLocked} holder=${gate.holder.orEmpty()} reason=no-microsoft-cookies")
            return null
        }
        prefs.edit().putLong(SILENT_AT, System.currentTimeMillis()).apply()
        schulnetzLog.info("silent login attempt caller=$caller lockHeld=${gate.isLocked} holder=${gate.holder.orEmpty()} url=${webLoginUrl(baseUrl())}")
        val landed = runCatching { browser.load(webLoginUrl(baseUrl())) }.onFailure { schulnetzLog.error(it) }.getOrNull()
        val html = landed?.body.orEmpty()
        val url = landed?.finalUrl.orEmpty()
        val classified = classifySchulnetzPage(url, html)
        schulnetzLog.info("silent login finished caller=$caller rule=${classified.rule} lockHeld=${gate.isLocked} holder=${gate.holder.orEmpty()} final=${redactSchulnetzSecrets(url)}")
        keepDebug(html)
        if (landed == null || classified.problem == SessionProblem.INTERACTIVE || classified.problem == SessionProblem.OAUTH_FAILED || !isLoggedInLanding(url, html)) {
            return null
        }
        val ids = sessionIdsFromPage(url, html) ?: extractWebSession(url, html, baseUrl())?.let {
            ch.fasrv.fanotes.schulnetz.PageSessionIds(it.id, it.transid, "extract")
        } ?: return null
        val previousId = readWebSession()?.id.orEmpty()
        val fresh = WebSession(baseUrl(), phpSessionCookie(baseUrl()), ids.id, ids.transid)
        saveWebSession(fresh)
        signedOut = false
        schulnetzLog.info("discarded previous session previousId=$previousId newId=${ids.id} source=${ids.source} caller=$caller")
        return fresh
    }

    suspend fun runVisibleLogin(caller: String) {
        schulnetzLog.info("visible login queued caller=$caller lockHeld=${gate.isLocked} holder=${gate.holder.orEmpty()}")
        gate.exclusive("visible-login:$caller") {
            prefs.edit().putBoolean("school-disconnected", false).apply()
            schulnetzLog.info("visible login acquired caller=$caller lockHeld=true holder=${gate.holder.orEmpty()}")
            var openOauth = signedOut || readWebSession() == null
            if (!openOauth) {
                if (System.currentTimeMillis() - lastRefreshAt >= 15_000) {
                    schulnetzLog.info("visible login redirected caller=$caller lockHeld=true reason=session-id-present")
                    withContext(Dispatchers.IO) { refreshLocked("button:$caller") }
                }
                val session = readWebSession()
                if (session != null && !signedOut) {
                    showExistingSession(caller, session)
                } else {
                    openOauth = true
                }
            }
            val intent = if (openOauth) loginIntent() else null
            if (intent != null) {
                oauthPermitted = true
                oauthConsumed = false
                val done = CompletableDeferred<Boolean>()
                loginResult = done
                schulnetzLog.info("visible login start caller=$caller lockHeld=true holder=${gate.holder.orEmpty()} url=${webLoginUrl(baseUrl())}")
                try {
                    if (!loginRequests.tryEmit(intent)) {
                        schulnetzLog.info("visible login not shown caller=$caller reason=no-subscriber")
                    } else if (withTimeoutOrNull(300_000) { done.await() } == true) {
                        withContext(Dispatchers.IO) {
                            val auth = runCatching { schoolAuth() }.getOrNull()
                            if (auth != null) {
                                runCatching { client.linkWeb(auth, baseUrl(), deviceId(), ch.fasrv.fanotes.schulnetz.SCHULNETZ_USER_AGENT, exportSsoCookies(), "Kanti+") }
                                    .onSuccess { link.value = it }
                                    .onFailure { schulnetzLog.error(it) }
                            }
                            refreshLocked("after-visible-login")
                        }
                    } else {
                        schulnetzLog.info("visible login cancelled caller=$caller lockHeld=true")
                    }
                } finally {
                    oauthPermitted = false
                    loginResult = null
                }
            }
        }
    }

    private suspend fun showExistingSession(caller: String, session: WebSession) {
        notices.tryEmit(t(R.string.already_signed_in_schulnetz))
        link.value = link.value.copy(needsReauth = false, lastError = "")
        schulnetzLog.info("visible login shows session caller=$caller lockHeld=true")
        if (System.currentTimeMillis() - lastSessionShownAt < 30_000) return
        lastSessionShownAt = System.currentTimeMillis()
        val intent = sessionViewIntent(session) ?: return
        val done = CompletableDeferred<Boolean>()
        loginResult = done
        viewingSession = true
        try {
            if (!loginRequests.tryEmit(intent)) {
                schulnetzLog.info("visible session not shown caller=$caller reason=no-subscriber")
            } else {
                withTimeoutOrNull(300_000) { done.await() }
            }
        } finally {
            viewingSession = false
            loginResult = null
        }
    }

    private fun sessionViewIntent(session: WebSession): Intent? {
        val host = runCatching { java.net.URI(session.baseUrl.ifBlank { baseUrl() }).host }.getOrNull() ?: return null
        val url = pageUrl(session.baseUrl.ifBlank { baseUrl() }, "1", session.id, session.transid)
        return Intent(context, SchulnetzLoginActivity::class.java)
            .putExtra(SchulnetzLoginActivity.EXTRA_URL, url)
            .putExtra(SchulnetzLoginActivity.EXTRA_HOST, host)
            .putExtra(SchulnetzLoginActivity.EXTRA_BASE, session.baseUrl.ifBlank { baseUrl() })
            .putExtra(SchulnetzLoginActivity.EXTRA_VIEW, true)
    }

    fun consumeOauthPermit(): Boolean {
        if (!oauthPermitted || oauthConsumed) return false
        oauthConsumed = true
        return true
    }

    fun finishVisibleLogin(session: WebSession?) {
        if (session == null) {
            schulnetzLog.info("visible login finished caller=activity lockHeld=${gate.isLocked} holder=${gate.holder.orEmpty()} result=cancelled")
            loginResult?.complete(false)
            return
        }
        val previousId = readWebSession()?.id.orEmpty()
        saveWebSession(session)
        signedOut = false
        schulnetzLog.info("visible login finished caller=activity lockHeld=${gate.isLocked} holder=${gate.holder.orEmpty()} previousId=$previousId newId=${session.id}")
        loginResult?.complete(true)
    }

    private fun loginIntent(): Intent? {
        val base = baseUrl()
        val host = runCatching { java.net.URI(base).host }.getOrNull() ?: return null
        return Intent(context, SchulnetzLoginActivity::class.java)
            .putExtra(SchulnetzLoginActivity.EXTRA_URL, webLoginUrl(base))
            .putExtra(SchulnetzLoginActivity.EXTRA_HOST, host)
            .putExtra(SchulnetzLoginActivity.EXTRA_BASE, base)
    }

    private fun keepLoaded(previous: SchulnetzSnapshot, next: SchulnetzSnapshot): SchulnetzSnapshot = next.copy(
        grades = next.grades.ifEmpty { previous.grades },
        absences = next.absences.ifEmpty { previous.absences },
        events = next.events.ifEmpty { previous.events },
        exams = next.exams.ifEmpty { previous.exams },
        homework = next.homework.ifEmpty { previous.homework },
        messages = next.messages.ifEmpty { previous.messages },
        vacations = next.vacations.ifEmpty { previous.vacations },
        konto = next.konto.ifEmpty { previous.konto },
        startMessages = next.startMessages.ifEmpty { previous.startMessages },
        weekFetched = next.weekFetched.ifEmpty { previous.weekFetched },
        weekSpanStart = next.weekSpanStart.ifBlank { previous.weekSpanStart },
        weekSpanEnd = next.weekSpanEnd.ifBlank { previous.weekSpanEnd },
        icalFetchedAt = next.icalFetchedAt.ifBlank { previous.icalFetchedAt },
        revision = previous.revision + 1,
    )

    private fun silentLoginAllowed(): Boolean {
        val last = prefs.getLong(SILENT_AT, 0L)
        return System.currentTimeMillis() - last >= SILENT_GAP_MS
    }

    fun clearLoginPrompt() {
        CompanionAlerts.forget(context, "schulnetz-login-required")
        link.value = link.value.copy(needsReauth = false, lastError = "")
    }

    private fun markLoginRequired() {
        val already = link.value.needsReauth
        link.value = link.value.copy(needsReauth = true, lastError = "Bei Schulnetz neu anmelden")
        signedOut = true
        schulnetzLog.info("login required shown lockHeld=${gate.isLocked} holder=${gate.holder.orEmpty()}")
        if (!already) {
            CompanionAlerts.show(
                context,
                ch.fasrv.fanotes.schulnetz.linkedChange(
                    "schulnetz-login-required",
                    "event",
                    "Bei Schulnetz neu anmelden",
                    "Die Microsoft-Anmeldung ist abgelaufen.",
                    targetId = "home",
                ),
            )
        }
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
        val raw = client.fetchRaw(stored.baseUrl, access.accessToken, previous)
        val parsed = parseRawSnapshot(raw, isoNow())
        val events = if (raw.eventsFetched && raw.eventMin.isNotBlank() && raw.eventMax.isNotBlank()) {
            ch.fasrv.fanotes.schulnetz.applyEventWindow(previous.events, parsed.events, raw.eventMin, raw.eventMax)
        } else {
            previous.events.ifEmpty { parsed.events }
        }
        val weekFetched = if (raw.eventsFetched && raw.eventMin.isNotBlank() && raw.eventMax.isNotBlank()) {
            ch.fasrv.fanotes.schulnetz.stampWeeks(previous.weekFetched, raw.eventMin, raw.eventMax, parsed.fetchedAt)
        } else {
            previous.weekFetched
        }
        val next = parsed.copy(
            revision = previous.revision + 1,
            events = events,
            weekFetched = weekFetched,
            weekSpanStart = raw.weekSpanStart.ifBlank { previous.weekSpanStart },
            weekSpanEnd = raw.weekSpanEnd.ifBlank { previous.weekSpanEnd },
            icalFetchedAt = previous.icalFetchedAt,
        )
        publishSnapshot(previous, next, notifySettings())
        vault.write(SNAPSHOT_VAULT_PATH, next.toNormalizedJson().encodeToByteArray())
        engine.notifyLocalChange()
    }

    private fun publishSnapshot(previous: SchulnetzSnapshot?, next: SchulnetzSnapshot, settings: NotifySettings) {
        val hidden = hiddenLessons()
        val local = notifySettings()
        val effective = settings.copy(guessGrades = local.guessGrades)
        val prior = previous?.takeIf { it.fetchedAt.isNotBlank() || it.grades.isNotEmpty() || it.events.isNotEmpty() }
        val raw = diffSnapshots(prior, next, effective).filterNot { changeIsHidden(it, hidden) }
        val changes = CompanionAlerts.settledChanges(context, raw, prior?.grades.orEmpty() + next.grades)
        if (effective.guessGrades) addUnrevealedGrades(newGradeTargetIds(changes))
        snapshot.value = next
        writeCache(next)
        CompanionAlerts.showAll(context, changes, gradeKeysSettled = true)
    }

    private fun applyServerChanges(json: String) {
        val obj = parseJson(json) as? JsonValue.Obj ?: return
        val items = obj.array("changes")?.items.orEmpty().mapNotNull { item ->
            val change = item as? JsonValue.Obj ?: return@mapNotNull null
            changeFromObj(change)
        }
        val guess = notifySettings().guessGrades
        val visible = CompanionAlerts.settledChanges(
            context,
            items.filterNot { changeIsHidden(it, hiddenLessons()) },
            snapshot.value.grades,
        )
        if (guess) addUnrevealedGrades(newGradeTargetIds(visible))
        CompanionAlerts.showAll(context, visible, gradeKeysSettled = true)
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

    private fun rememberRevision(revision: Long) {
        if (revision <= 0L) return
        val current = prefs.getLong("change-cursor", 0L)
        if (revision > current) prefs.edit().putLong("change-cursor", revision).apply()
    }

    private fun readGuestFile(): SchoolAuth? {
        if (!guestFile.isFile) return null
        val obj = runCatching { parseJson(guestFile.readText()) as? JsonValue.Obj }.getOrNull() ?: return null
        val id = obj.string("accountId").orEmpty()
        val token = obj.string("token").orEmpty()
        if (!id.matches(Regex("^[a-f0-9]{32}$")) || !token.matches(Regex("^[A-Za-z0-9_-]{40,80}$"))) return null
        return SchoolAuth(id, token, guest = true)
    }

    private fun writeGuestFile(auth: SchoolAuth) {
        guestFile.writeText("{\"accountId\":${escapeJson(auth.accountId)},\"token\":${escapeJson(auth.token)}}")
    }

    suspend fun ensureGuest(): SchoolAuth = guestLock.withLock {
        readGuestFile()?.let { return@withLock it }
        val created = client.createGuest()
        writeGuestFile(created)
        created
    }

    private suspend fun adoptGuest(session: ch.fasrv.fanotes.sync.SyncSession) {
        if (readGuestFile() == null) return
        guestLock.withLock {
            val guest = readGuestFile() ?: return@withLock
            runCatching { client.adopt(SchoolAuth(session.accountId, session.token, false), guest.accountId, guest.token) }
                .onSuccess { revision ->
                    guestFile.delete()
                    rememberRevision(revision)
                }
                .onFailure { schulnetzLog.error(it) }
        }
    }

    /** FaNotes session when signed in, otherwise the anonymous device identity. */
    suspend fun schoolAuth(): SchoolAuth {
        val session = engine.currentSession()
        if (session != null) {
            adoptGuest(session)
            return SchoolAuth(session.accountId, session.token, false)
        }
        return ensureGuest()
    }

    /** Copy school data onto a guest identity and move this device's push token before sign-out. */
    suspend fun detachKeepingSchool() {
        val session = engine.currentSession() ?: return
        val guest = ensureGuest()
        runCatching {
            client.detach(
                SchoolAuth(session.accountId, session.token, false),
                guest.accountId,
                guest.token,
                prefs.getString("fcm-token", null),
            )
        }.onSuccess { rememberRevision(it) }.onFailure { schulnetzLog.error(it) }
    }

    /** Remove the anonymous identity's server data and this device's school cache. Tasks and calendar stay. */
    suspend fun deleteKantiData() {
        val auth = readGuestFile() ?: ensureGuest()
        if (auth.guest) client.deleteGuest(auth)
        guestFile.delete()
        clearSchoolCache()
        ensureGuest()
    }

    private fun clearSchoolCache() {
        prefs.edit()
            .putBoolean("school-disconnected", false)
            .remove("web-session")
            .remove("push-topic")
            .remove("push-server")
            .remove("school-linked")
            .remove("change-cursor")
            .apply()
        signedOut = false
        snapshotFile(context).delete()
        gradeLedgerFile(context).delete()
        listOf(LOCAL_TOKEN_PATH, LEASE_PATH, SNAPSHOT_VAULT_PATH).forEach { path ->
            if (vault.exists(path)) vault.delete(path)
        }
        snapshot.value = SchulnetzSnapshot()
        link.value = SchulnetzLinkState(baseUrl = baseUrl())
        CompanionAlerts.retireLegacyPush(context)
        cancelSchoolDelivery(context)
    }

    fun schoolDisconnected(): Boolean = prefs.getBoolean("school-disconnected", false)

    fun disconnectSchool() {
        prefs.edit().putBoolean("school-disconnected", true).remove("web-session").remove("push-topic").remove("push-server").remove("school-linked").apply()
        signedOut = true
        clearLocalLink()
        CompanionAlerts.retireLegacyPush(context)
        cancelSchoolDelivery(context)
        CompanionAlerts.forget(context, "schulnetz-login-required")
        link.value = SchulnetzLinkState(baseUrl = baseUrl())
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
        const val GRADE_BOOK_PATH = ".fanotes/schulnetz/grade-book.json"
        const val COLORS_PATH = ".fanotes/schulnetz/colors.json"
        const val DESK_PATH = ".fanotes/schulnetz/desk.json"
        const val HIDDEN_PATH = ".fanotes/schulnetz/hidden-lessons.json"
        const val SNAPSHOT_VAULT_PATH = ".fanotes/schulnetz/snapshot.json"
        const val GUESS_GRADES_PREF = "notify-guess-grades"
        const val UNREVEALED_PREF = "unrevealed-grades"
        const val PLANNER_HOLD_PREF = "hold-planner-upload"
        val PLANNER_HOLD_PATHS = setOf(HOMEWORK_NOTE_PATH, CALENDAR_NOTE_PATH, DESK_PATH)
        const val SERVER_POLL_MS = 60_000L
        private const val SILENT_AT = "schulnetz-silent-at"
        private const val SILENT_GAP_MS = 3 * 60 * 1000L
        fun snapshotFile(context: Context) = File(context.filesDir, "schulnetz-snapshot.json")
    }
}

internal fun diagnosticEntryAllowed(name: String, includeCaptures: Boolean): Boolean {
    if (name == "device.txt" || name == "schulnetz.log") return true
    if (!includeCaptures) return false
    return name == "last-page.html" || name.startsWith("captures/")
}

private fun fingerprint(value: String): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(value.toByteArray())
    return digest.joinToString("") { "%02x".format(it) }.take(32)
}
