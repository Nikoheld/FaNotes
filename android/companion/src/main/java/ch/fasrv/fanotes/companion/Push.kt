package ch.fasrv.fanotes.companion

import ch.fasrv.fanotes.schulnetz.NoticeLedger
import ch.fasrv.fanotes.schulnetz.backgroundFlexMinutes
import ch.fasrv.fanotes.schulnetz.backgroundCheckMinutes
import ch.fasrv.fanotes.schulnetz.BackgroundMode
import ch.fasrv.fanotes.schulnetz.PRIMARY_SLOT
import ch.fasrv.fanotes.schulnetz.SchoolProvider
import ch.fasrv.fanotes.schulnetz.parseConnectionRegistry
import ch.fasrv.fanotes.schulnetz.slotChangeId
import ch.fasrv.fanotes.schulnetz.slotVaultPath
import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.os.Bundle
import android.util.TypedValue
import android.widget.RemoteViews
import androidx.core.app.NotificationCompat
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.escapeJson
import ch.fasrv.fanotes.json.parseJson
import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import ch.fasrv.fanotes.schulnetz.AlertGate
import ch.fasrv.fanotes.schulnetz.DiagnosticTrace
import ch.fasrv.fanotes.schulnetz.changeIsOver
import ch.fasrv.fanotes.schulnetz.NotifyPrefs
import ch.fasrv.fanotes.schulnetz.notifySettingsFromPrefs
import ch.fasrv.fanotes.schulnetz.schoolAlertGate
import ch.fasrv.fanotes.schulnetz.SchoolGrade
import ch.fasrv.fanotes.schulnetz.SchulnetzChange
import ch.fasrv.fanotes.schulnetz.SchulnetzSnapshot
import ch.fasrv.fanotes.schulnetz.hiddenGradePortraitUrl
import ch.fasrv.fanotes.schulnetz.changeFromPayload
import ch.fasrv.fanotes.schulnetz.gradeTargetId
import ch.fasrv.fanotes.schulnetz.settleGradeNotifications
import ch.fasrv.fanotes.schulnetz.changeIsHidden
import ch.fasrv.fanotes.schulnetz.hiddenGradeBody
import ch.fasrv.fanotes.schulnetz.hiddenGradeTitle
import ch.fasrv.fanotes.schulnetz.isNotificationProbe
import ch.fasrv.fanotes.schulnetz.newGradeTargetIds
import ch.fasrv.fanotes.schulnetz.probeLogLine
import ch.fasrv.fanotes.schulnetz.probeLogSummary
import ch.fasrv.fanotes.schulnetz.stampProbeChange
import ch.fasrv.fanotes.schulnetz.notifyPayload
import ch.fasrv.fanotes.schulnetz.parseNormalizedSnapshot
import ch.fasrv.fanotes.schulnetz.prepareGradeNotifications
import ch.fasrv.fanotes.schulnetz.redactGradeChange
import ch.fasrv.fanotes.schulnetz.endsAt
import ch.fasrv.fanotes.schulnetz.isCancelled
import ch.fasrv.fanotes.schulnetz.isSubstitution
import ch.fasrv.fanotes.schulnetz.parseDeskPrefs
import ch.fasrv.fanotes.schulnetz.parseHiddenLessons
import ch.fasrv.fanotes.schulnetz.cleanSchulnetzText
import ch.fasrv.fanotes.schulnetz.displayClock
import ch.fasrv.fanotes.schulnetz.startsAt
import ch.fasrv.fanotes.schulnetz.WidgetSpan
import ch.fasrv.fanotes.schulnetz.upcomingLessons
import ch.fasrv.fanotes.schulnetz.upcomingTimetableUnread
import androidx.work.workDataOf
import java.time.LocalDate
import java.util.concurrent.Executors
import ch.fasrv.fanotes.schulnetz.visibleEvents
import ch.fasrv.fanotes.schulnetz.widgetSizeDp
import ch.fasrv.fanotes.schulnetz.widgetSpan
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import ch.fasrv.fanotes.schulnetz.nextLessonBoundary
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.concurrent.TimeUnit

/**
 * Which school connection a notice belongs to: its storage slot (seen ids, grade ledger, settings,
 * hidden lessons), its id (opening the notice shows that connection) and its name, which is put in
 * front of the title once there is more than one connection.
 */
data class AlertScope(val slot: String = PRIMARY_SLOT, val connectionId: String = "", val label: String = "", val labelled: Boolean = false) {
    companion object {
        val PRIMARY = AlertScope()
    }
}

object CompanionAlerts {
    const val CHANNEL = "schulnetz-alerts"
    const val EXTRA_CONNECTION = "ch.fasrv.fanotes.companion.NOTIFY_CONNECTION"
    const val EXTRA_CATEGORY = "ch.fasrv.fanotes.companion.NOTIFY_CATEGORY"
    const val EXTRA_TARGET_ID = "ch.fasrv.fanotes.companion.NOTIFY_TARGET_ID"
    const val EXTRA_TARGET_IDS = "ch.fasrv.fanotes.companion.NOTIFY_TARGET_IDS"
    const val EXTRA_COURSE_ID = "ch.fasrv.fanotes.companion.NOTIFY_COURSE_ID"
    const val EXTRA_DATE = "ch.fasrv.fanotes.companion.NOTIFY_DATE"
    const val EXTRA_PAYLOAD = "ch.fasrv.fanotes.companion.NOTIFY_PAYLOAD"
    private const val SEEN = "seen-changes"
    private val SEEN_LOCK = Any()
    private val portraitLoader = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "kanti-portrait").apply { isDaemon = true }
    }

    fun ensureChannels(context: Context) {
        val localized = AppLanguage.wrap(context)
        val manager = context.getSystemService(NotificationManager::class.java)
        fun channel(id: String, nameId: Int, importance: Int) {
            manager.createNotificationChannel(NotificationChannel(id, localized.getString(nameId), importance))
        }
        channel(CHANNEL, R.string.channel_alerts, NotificationManager.IMPORTANCE_HIGH)
        channel("schulnetz-grade", R.string.channel_grade, NotificationManager.IMPORTANCE_HIGH)
        channel("schulnetz-timetable", R.string.channel_timetable, NotificationManager.IMPORTANCE_HIGH)
        channel("schulnetz-exam", R.string.channel_exam, NotificationManager.IMPORTANCE_DEFAULT)
        channel("schulnetz-absence", R.string.channel_absence, NotificationManager.IMPORTANCE_DEFAULT)
        channel("schulnetz-deadline", R.string.channel_deadline, NotificationManager.IMPORTANCE_HIGH)
        channel("schulnetz-event", R.string.channel_event, NotificationManager.IMPORTANCE_DEFAULT)
    }

    fun retireLegacyPush(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.cancel(42)
        manager.deleteNotificationChannel("schulnetz-live")
        val work = WorkManager.getInstance(context)
        work.cancelUniqueWork(SCHOOL_WORK_FAST)
        work.cancelUniqueWork(SCHOOL_WORK)
    }

    fun showReauth(context: Context, scope: AlertScope = AlertScope.PRIMARY) {
        show(scope, context, ch.fasrv.fanotes.schulnetz.linkedChange(
            "schulnetz-login-required",
            "event",
            "Bei Schulnetz neu anmelden",
            "Die Microsoft-Anmeldung ist abgelaufen. In Kanti+ neu anmelden.",
            targetId = "settings",
        ))
    }

    fun showTest(context: Context) {
        show(context, ch.fasrv.fanotes.schulnetz.linkedChange(
            "push-test",
            "settings",
            t(R.string.test_notification),
            t(R.string.test_notification_body),
            targetId = "settings",
        ))
    }

    fun notificationsAllowed(context: Context): Boolean {
        val manager = context.getSystemService(NotificationManager::class.java)
        if (!manager.areNotificationsEnabled()) return false
        if (Build.VERSION.SDK_INT < 33) return true
        return ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
    }

    /** Newest delivery-test lines, for the settings screen. Empty when none have been shown. */
    fun probeSummaries(context: Context, limit: Int = 8): List<String> {
        val file = java.io.File(context.filesDir, PROBE_LOG)
        if (!file.isFile) return emptyList()
        val zone = ZoneId.systemDefault()
        return runCatching {
            file.readLines().filter { it.isNotBlank() }.takeLast(limit).reversed().mapNotNull { line ->
                probeLogSummary(line, zone).ifBlank { null }
            }
        }.getOrDefault(emptyList())
    }

    /** Removes local probe receipts. School cache, sessions and ordinary notification ids stay. */
    fun clearProbeState(context: Context) {
        java.io.File(context.filesDir, PROBE_LOG).delete()
        val prefs = context.getSharedPreferences("fanotes-companion", Context.MODE_PRIVATE)
        val seen = prefs.getStringSet(SEEN, emptySet()).orEmpty()
        val kept = seen.filterNot { it.startsWith("probe:") }.toSet()
        prefs.edit()
            .remove(PROBE_SERVER_AT)
            .remove(PROBE_RECEIVED_AT)
            .putStringSet(SEEN, kept)
            .apply()
    }

    private fun appendProbeLog(context: Context, line: String) {
        val file = java.io.File(context.filesDir, PROBE_LOG)
        val kept = runCatching { if (file.isFile) file.readLines() else emptyList() }.getOrDefault(emptyList())
            .filter { it.isNotBlank() }
        file.writeText((kept + line).takeLast(40).joinToString("\n") + "\n")
    }

    fun showAll(context: Context, changes: List<SchulnetzChange>, gradeKeysSettled: Boolean = false) = showAll(AlertScope.PRIMARY, context, changes, gradeKeysSettled)

    fun showAll(scope: AlertScope, context: Context, changes: List<SchulnetzChange>, gradeKeysSettled: Boolean = false) {
        val prefs = slotPrefs(context, scope)
        val guess = prefs.getBoolean(CompanionGraph.GUESS_GRADES_PREF, false)
        val snapshot = CompanionGraph.snapshotFile(context, scope.slot).takeIf { it.isFile }?.readText()?.let { parseNormalizedSnapshot(it) } ?: SchulnetzSnapshot()
        if (guess) rememberUnrevealed(context, newGradeTargetIds(changes), scope)
        prepareGradeNotifications(changes, guess, snapshot).forEach { show(scope, context, it, gradeKeysSettled) }
    }

    private fun slotPrefs(context: Context, scope: AlertScope) = SlotPrefs(context.getSharedPreferences("fanotes-companion", Context.MODE_PRIVATE), scope.slot)

    /** Forgets a removed connection's shown ids. Its ledger and settings go with its storage. */
    fun forgetAll(scope: AlertScope, context: Context) {
        slotPrefs(context, scope).edit().remove(SEEN).apply()
    }

    /**
     * Drop grades this account has already been told about, and on the first
     * run after this fix record every grade currently on file without telling
     * anyone again. [gradeKeysSettled] on the following [showAll] must be true.
     */
    fun settledChanges(context: Context, changes: List<SchulnetzChange>, grades: List<SchoolGrade>): List<SchulnetzChange> =
        settledChanges(AlertScope.PRIMARY, context, changes, grades)

    fun settledChanges(scope: AlertScope, context: Context, changes: List<SchulnetzChange>, grades: List<SchoolGrade>): List<SchulnetzChange> {
        val ledger = readGradeLedger(context, scope.slot)
        val settled = settleGradeNotifications(changes, grades, ledger)
        writeGradeLedger(context, settled.keys, scope.slot)
        return settled.changes
    }

    fun show(context: Context, change: SchulnetzChange, gradeKeysSettled: Boolean = false) = show(AlertScope.PRIMARY, context, change, gradeKeysSettled)

    fun show(scope: AlertScope, context: Context, change: SchulnetzChange, gradeKeysSettled: Boolean = false) {
        if (change.category != "settings" && slotPrefs(context, scope).getBoolean("school-disconnected", false)) return
        if (change.id.isBlank()) return
        if (!notificationsAllowed(context)) return
        // Also guards pushes from a server that has not been updated yet.
        if (changeIsOver(change)) { DiagnosticTrace.record("push", "stale", 0, "dropped", change.category); return }
        // Preference filter before the notice is posted. A disabled alert is not shown and then cancelled.
        val stored = SlotPrefs(context.getSharedPreferences(NotifyPrefs.FILE, Context.MODE_PRIVATE), scope.slot)
        val gate = schoolAlertGate(
            notifySettingsFromPrefs(present = { stored.contains(it) }, read = { stored.getBoolean(it, false) }),
            change,
            notificationsPermitted = true,
        )
        if (gate != AlertGate.DELIVER) return
        if (!gradeKeysSettled && change.category == "grade" && !isNotificationProbe(change.id)) {
            val keys = change.gradeKeys.filter { it.isNotBlank() }
            if (keys.isNotEmpty()) {
                val known = readGradeLedger(context, scope.slot) ?: emptySet()
                if (keys.all { it in known }) return
                writeGradeLedger(context, known + keys, scope.slot)
            }
        }
        if (!remember(context, change.id, scope)) {
            if (isNotificationProbe(change.id)) {
                DiagnosticTrace.record("push", "duplicate", 0, "dropped", change.correlation.ifBlank { "probe" })
            }
            return
        }
        val hidden = runCatching {
            val file = java.io.File(context.filesDir, "vault/${slotVaultPath(scope.slot, CompanionGraph.HIDDEN_PATH)}")
            if (!file.isFile) emptyList() else parseHiddenLessons(file.readText())
        }.getOrDefault(emptyList())
        if (changeIsHidden(change, hidden)) return
        val prefs = context.getSharedPreferences("fanotes-companion", Context.MODE_PRIVATE)
        val guess = slotPrefs(context, scope).getBoolean(CompanionGraph.GUESS_GRADES_PREF, false)
        val snapshot = CompanionGraph.snapshotFile(context, scope.slot).takeIf { it.isFile }?.readText()?.let { parseNormalizedSnapshot(it) }
        var shown = change
        if (guess && change.category == "grade" && !isNotificationProbe(change.id)) {
            rememberUnrevealed(context, change.linkIds(), scope)
            shown = if (snapshot != null) redactGradeChange(change, snapshot) else change.copy(
                title = hiddenGradeTitle(change, change.courseId.ifBlank { "einem Fach" }),
                body = hiddenGradeBody(change.body.substringAfter(" · ").substringBefore(" · ").ifBlank { "Tippen zum Aufdecken" }),
            )
            if (shown.linkIds().size > 1) {
                shown = shown.copy(title = "${shown.linkIds().size} neue Noten – tippen zum Aufdecken", body = "Tippen zum Aufdecken")
            }
        } else if (guess && change.category == "grade") {
            shown = if (snapshot != null) redactGradeChange(change, snapshot) else change.copy(
                title = hiddenGradeTitle(change, change.body.substringBefore(" · ").ifBlank { "einem Fach" }),
                body = hiddenGradeBody(change.body.substringAfter(" · ").substringBefore(" · ").ifBlank { "Tippen zum Aufdecken" }),
            )
        }
        if (isNotificationProbe(shown.id)) {
            val storedServer = prefs.getString(PROBE_SERVER_AT, "").orEmpty()
            val receivedAt = if (storedServer.isNotBlank() && storedServer == shown.serverAt) prefs.getLong(PROBE_RECEIVED_AT, 0L) else 0L
            val displayedAt = System.currentTimeMillis()
            shown = stampProbeChange(shown, receivedAt, displayedAt, ZoneId.systemDefault())
            appendProbeLog(context, probeLogLine(shown, receivedAt, displayedAt))
            val mark = buildString {
                append(shown.correlation.ifBlank { "probe" })
                if (shown.sequence > 0) append(" #").append(shown.sequence)
            }
            DiagnosticTrace.record("push", "display", 0, "ok", mark)
        }
        val channel = when (shown.category) {
            "grade" -> "schulnetz-grade"
            "timetable" -> "schulnetz-timetable"
            "exam" -> "schulnetz-exam"
            "absence" -> "schulnetz-absence"
            "deadline" -> "schulnetz-deadline"
            "event" -> "schulnetz-event"
            else -> CHANNEL
        }
        // The same change id in two connections is two notices.
        val noticeId = slotChangeId(scope.slot, shown.id).hashCode()
        val open = PendingIntent.getActivity(
            context,
            noticeId,
            notifyIntent(context, shown, scope),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val bare = shownText(shown.title.ifBlank { t(R.string.schulnetz) })
        val title = if (scope.labelled && scope.label.isNotBlank()) "${scope.label} · $bare" else bare
        val body = shownText(shown.body)
        val lock = lockScreenNotice()
        val publicTitle = shownText(lock.publicTitle, fragments = false)
        val publicText = shownText(lock.publicText, fragments = false)
        val publicVersion = NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(publicTitle)
            .setContentText(publicText)
            .build()
        val manager = context.getSystemService(NotificationManager::class.java)
        val id = noticeId
        fun post(picture: android.graphics.Bitmap?) {
            val builder = NotificationCompat.Builder(context, channel)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(title)
                .setContentText(body)
                .setTicker(title)
                .setVisibility(lock.visibility)
                .setPublicVersion(publicVersion)
                .setContentIntent(open)
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
            if (picture == null) {
                builder.setStyle(NotificationCompat.BigTextStyle().bigText(body).setBigContentTitle(title))
            } else {
                builder.setLargeIcon(picture)
                builder.setStyle(NotificationCompat.BigPictureStyle().bigPicture(picture).setBigContentTitle(title).setSummaryText(body))
            }
            manager.notify(id, builder.build())
        }
        post(null)
        val portrait = guessPortraitUrl(guess, shown, snapshot)
        if (portrait != null) {
            portraitLoader.execute {
                val picture = runCatching { fetchCelebrityPortrait(portrait, maxEdge = 360) }.getOrNull() ?: return@execute
                runCatching { post(picture) }
            }
        }
    }

    /** Portrait for a single hidden mark. The notice text never includes this URL or the age. */
    private fun guessPortraitUrl(guess: Boolean, shown: SchulnetzChange, snapshot: SchulnetzSnapshot?): String? {
        if (snapshot == null) return null
        val id = shown.linkIds().singleOrNull()
        val mark = id?.let { target -> snapshot.grades.firstOrNull { gradeTargetId(it) == target }?.mark }
        return hiddenGradePortraitUrl(guess, shown, mark, LocalDate.now(ZoneId.of("Europe/Zurich")))
    }

    fun rememberUnrevealed(context: Context, ids: Collection<String>, scope: AlertScope = AlertScope.PRIMARY) {
        val next = ids.filter { it.isNotBlank() }
        if (next.isEmpty()) return
        val prefs = slotPrefs(context, scope)
        val stored = prefs.getStringSet(CompanionGraph.UNREVEALED_PREF, emptySet()).orEmpty().toMutableSet()
        if (!stored.addAll(next)) return
        prefs.edit().putStringSet(CompanionGraph.UNREVEALED_PREF, stored).apply()
    }

    fun onPushPayload(context: Context, payload: String) {
        val parsed = changeFromPayload(payload)
        if (parsed != null) {
            show(context, parsed)
            return
        }
        val obj = runCatching { parseJson(payload) as? JsonValue.Obj }.getOrNull()
        if (obj?.string("event") == "keepalive" || obj?.string("event") == "open") return
        if (payload.isBlank()) return
        show(context, SchulnetzChange(payload.hashCode().toString(), "event", "Schulnetz", payload.take(180)))
    }

    fun notifyIntent(context: Context, change: SchulnetzChange, scope: AlertScope = AlertScope.PRIMARY): Intent {
        val ids = ArrayList(change.linkIds())
        return Intent(context, MainActivity::class.java)
            .putExtra(EXTRA_CONNECTION, scope.connectionId)
            .setAction(Intent.ACTION_VIEW)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_NEW_TASK)
            .putExtra(EXTRA_CATEGORY, change.category)
            .putExtra(EXTRA_TARGET_ID, ids.joinToString(","))
            .putStringArrayListExtra(EXTRA_TARGET_IDS, ids)
            .putExtra(EXTRA_COURSE_ID, change.courseId)
            .putExtra(EXTRA_DATE, change.date)
            .putExtra(EXTRA_PAYLOAD, notifyPayload(change))
    }

    fun forget(context: Context, id: String) = forget(AlertScope.PRIMARY, context, id)

    fun forget(scope: AlertScope, context: Context, id: String) {
        context.getSystemService(NotificationManager::class.java)?.cancel(slotChangeId(scope.slot, id).hashCode())
        val prefs = slotPrefs(context, scope)
        val seen = prefs.getStringSet(SEEN, emptySet()).orEmpty().toMutableSet()
        if (!seen.remove(id)) return
        prefs.edit().putStringSet(SEEN, seen).apply()
    }

    /**
     * True the first time [id] is shown on this connection. The server push and the app's own read
     * give one school change the same id, so whichever arrives second is dropped. Both can run at
     * once (FCM thread and a foreground refresh), hence the lock around read-modify-write.
     */
    private fun remember(context: Context, id: String, scope: AlertScope): Boolean = synchronized(SEEN_LOCK) {
        val prefs = slotPrefs(context, scope)
        val ledger = NoticeLedger(prefs.getStringSet(SEEN, emptySet()).orEmpty())
        if (!ledger.firstTime(id)) return@synchronized false
        prefs.edit().putStringSet(SEEN, ledger.ids().toSet()).commit()
        true
    }
}

private const val GRADE_LEDGER = "notified-grades-v1.json"

internal fun gradeLedgerFile(context: Context, slot: String = PRIMARY_SLOT) = slotFile(context, slot, GRADE_LEDGER)

/** Null when this install has never recorded grade identities. That is the migration. */
internal fun readGradeLedger(context: Context, slot: String = PRIMARY_SLOT): Set<String>? {
    val file = gradeLedgerFile(context, slot)
    if (!file.isFile) return null
    val obj = runCatching { parseJson(file.readText()) as? JsonValue.Obj }.getOrNull() ?: return null
    if (obj.double("version") != 1.0) return null
    val keys = obj.array("keys")?.items?.mapNotNull { (it as? JsonValue.Str)?.value } ?: return null
    return keys.toSet()
}

internal fun writeGradeLedger(context: Context, keys: Set<String>, slot: String = PRIMARY_SLOT) {
    val body = buildString {
        append("{\"version\":1,\"keys\":[")
        keys.sorted().forEachIndexed { index, key ->
            if (index > 0) append(',')
            append(escapeJson(key))
        }
        append("]}")
    }
    val file = gradeLedgerFile(context, slot)
    file.parentFile?.mkdirs()
    val temporary = java.io.File(file.parentFile, "${file.name}.${System.nanoTime()}.tmp")
    temporary.writeText(body)
    if (!temporary.renameTo(file)) {
        file.writeText(body)
        temporary.delete()
    }
}

internal const val SCHOOL_WORK = "schulnetz"
internal const val SCHOOL_WORK_FAST = "schulnetz-fast"
internal const val SCHOOL_FALLBACK = "schulnetz-fallback"
internal const val SCHOOL_WATCH = "schulnetz-fcm-watch"
internal const val LAST_PUSH_PREF = "last-push-at"
internal const val PROBE_SERVER_AT = "probe-server-at"
internal const val PROBE_RECEIVED_AT = "probe-received-at"
private const val PROBE_LOG = "notification-probe-log.jsonl"
internal const val SCHOOL_FALLBACK_MS = 6 * 60 * 60_000L
internal const val FCM_HEALTHY_MS = 12 * 60 * 60_000L
internal const val WIDGET_WINDOW_MS = 10 * 60_000L

/** The periodic background check's interval for the chosen mode (see backgroundCheckMinutes). */
fun schoolFallbackIntervalMs(context: Context): Long = backgroundCheckMinutes(backgroundMode(context), pushReady(context)) * 60_000L

internal const val BACKGROUND_MODE_PREF = "background-mode"
private const val ARMED_MINUTES_PREF = "school-check-minutes"
internal const val SCHOOL_PUSH = "schulnetz-push"

fun backgroundMode(context: Context): BackgroundMode =
    BackgroundMode.of(context.getSharedPreferences("fanotes-companion", Context.MODE_PRIVATE).getString(BACKGROUND_MODE_PREF, null))

/** Push can reach this device: Firebase runs and the app holds an FCM token (sent to the server on every refresh). */
fun pushReady(context: Context): Boolean =
    firebaseConfigured(context) && !context.getSharedPreferences("fanotes-companion", Context.MODE_PRIVATE).getString("fcm-token", null).isNullOrBlank()

fun setBackgroundMode(context: Context, mode: BackgroundMode) {
    context.getSharedPreferences("fanotes-companion", Context.MODE_PRIVATE).edit().putString(BACKGROUND_MODE_PREF, mode.wire).apply()
    armSchoolDelivery(context)
}

fun fcmPushHealthy(lastPushAt: Long, now: Long, firebaseReady: Boolean): Boolean =
    firebaseReady && lastPushAt > 0L && now - lastPushAt in 0 until FCM_HEALTHY_MS

fun deliveryModeLabel(firebaseReady: Boolean, lastPushAt: Long, now: Long): String =
    if (fcmPushHealthy(lastPushAt, now, firebaseReady)) "Instant via push" else "Fallback"

fun cancelSchoolDelivery(context: Context) {
    val work = WorkManager.getInstance(context)
    work.cancelUniqueWork(SCHOOL_WORK)
    work.cancelUniqueWork(SCHOOL_WORK_FAST)
    work.cancelUniqueWork(SCHOOL_FALLBACK)
    work.cancelUniqueWork(SCHOOL_WATCH)
    context.getSharedPreferences("fanotes-companion", Context.MODE_PRIVATE).edit().remove(ARMED_MINUTES_PREF).apply()
}

fun firebaseConfigured(context: Context): Boolean =
    context.resources.getIdentifier("google_app_id", "string", context.packageName) != 0

/** Starts Firebase only when the Google Services plugin generated an app id. */
fun prepareFirebase(context: Context): Boolean {
    if (!firebaseConfigured(context)) return false
    return runCatching {
        if (FirebaseApp.getApps(context).isEmpty()) FirebaseApp.initializeApp(context)
        FirebaseApp.getApps(context).isNotEmpty()
    }.getOrDefault(false)
}

fun requestFcmToken(context: Context) {
    if (!prepareFirebase(context)) return
    val app = context.applicationContext as? CompanionApplication ?: return
    runCatching {
        FirebaseMessaging.getInstance().token.addOnSuccessListener { token ->
            if (!token.isNullOrBlank()) app.graph.scope.launch { app.graph.registerFcmToken(token) }
        }
    }
}

fun configurePushDelivery(context: Context) {
    CompanionAlerts.retireLegacyPush(context)
    armSchoolDelivery(context)
    requestFcmToken(context)
}

private fun schoolConstraints() = Constraints.Builder()
    .setRequiredNetworkType(NetworkType.CONNECTED)
    .setRequiresBatteryNotLow(true)
    .build()

internal fun linkedForPush(context: Context): Boolean {
    val prefs = context.getSharedPreferences("fanotes-companion", Context.MODE_PRIVATE)
    if (!prefs.getBoolean("school-linked", false) && !prefs.getString("push-topic", null).isNullOrBlank()) {
        prefs.edit().putBoolean("school-linked", true).remove("push-topic").remove("push-server").apply()
    }
    // Any server-linked connection keeps push delivery armed.
    val slots = parseConnectionRegistry(prefs.getString(CompanionGraph.CONNECTIONS_PREF, null))?.connections
        ?.filter { it.provider == SchoolProvider.SCHULNETZ }?.map { it.slot } ?: listOf(PRIMARY_SLOT)
    return slots.ifEmpty { listOf(PRIMARY_SLOT) }.any { slot ->
        val scoped = SlotPrefs(prefs, slot)
        scoped.getBoolean("school-linked", false) && !scoped.getBoolean("school-disconnected", false)
    }
}

internal data class LockScreenNotice(val visibility: Int, val publicTitle: String, val publicText: String)

internal fun lockScreenNotice(): LockScreenNotice = LockScreenNotice(
    NotificationCompat.VISIBILITY_PRIVATE,
    "Neue Schulnetz-Meldung",
    "Neue Schulnetz-Meldung",
)

/**
 * One periodic background check, only while a connection is linked. It asks the Kanti+ server for its
 * change feed (never Schulnetz), needs a network and a battery that is not low, and WorkManager may
 * batch it with other jobs (flex) and defer it in Doze. Push is the fast path; this check catches a
 * missed push. KEEP leaves a running schedule alone; UPDATE applies a new interval (mode, push).
 */
internal fun armSchoolDelivery(context: Context) {
    val work = WorkManager.getInstance(context)
    if (!linkedForPush(context)) {
        cancelSchoolDelivery(context)
        return
    }
    // Earlier versions armed a 12-hour watch instead of a steady check.
    work.cancelUniqueWork(SCHOOL_WATCH)
    val prefs = context.getSharedPreferences("fanotes-companion", Context.MODE_PRIVATE)
    val minutes = backgroundCheckMinutes(backgroundMode(context), pushReady(context))
    val request = PeriodicWorkRequestBuilder<SchulnetzWorker>(minutes, TimeUnit.MINUTES, backgroundFlexMinutes(minutes), TimeUnit.MINUTES)
        .setConstraints(schoolConstraints())
        .build()
    val changed = prefs.getLong(ARMED_MINUTES_PREF, 0L) != minutes
    work.enqueueUniquePeriodicWork(SCHOOL_FALLBACK, if (changed) ExistingPeriodicWorkPolicy.UPDATE else ExistingPeriodicWorkPolicy.KEEP, request)
    if (changed) prefs.edit().putLong(ARMED_MINUTES_PREF, minutes).apply()
}

/**
 * The push's own pull did not finish (no network yet, timeout): one more try as soon as the network
 * allows. Expedited on Android 12 and later; older versions would need a foreground service for
 * expedited work, so they get ordinary one-off work. One unique name per connection: a newer push
 * replaces a waiting try instead of adding another.
 */
fun enqueuePushSync(context: Context, route: String?) {
    val builder = OneTimeWorkRequestBuilder<SchoolPushWorker>()
        .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
        .setInputData(workDataOf("route" to route.orEmpty()))
        .setBackoffCriteria(androidx.work.BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
    if (android.os.Build.VERSION.SDK_INT >= 31) builder.setExpedited(androidx.work.OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
    WorkManager.getInstance(context).enqueueUniqueWork(pushWorkName(route), ExistingWorkPolicy.REPLACE, builder.build())
}

internal fun pushWorkName(route: String?): String = if (route.isNullOrBlank()) SCHOOL_PUSH else "$SCHOOL_PUSH-$route"

class SchoolPushWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val app = applicationContext as? CompanionApplication ?: return Result.success()
        val route = inputData.getString("route")?.takeIf { it.isNotBlank() }
        val ok = withTimeoutOrNull(20_000) { app.graph.pullChangeDelta(route) } == true
        return if (ok || runAttemptCount >= 3) Result.success() else Result.retry()
    }
}

fun notePushReceived(context: Context) {
    context.getSharedPreferences("fanotes-companion", Context.MODE_PRIVATE)
        .edit().putLong(LAST_PUSH_PREF, System.currentTimeMillis()).apply()
    armSchoolDelivery(context)
}

/** Sends the authenticated probe after a short wait, including if the app left Recents. */
class ProbeDeliveryWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val app = applicationContext as? CompanionApplication ?: return Result.success()
        if (!app.graph.diagnosticMode()) return Result.success()
        val scenario = inputData.getString("scenario") ?: "standard"
        val auth = runCatching { app.graph.schoolAuth() }.getOrNull() ?: return Result.success()
        val token = app.graph.fcmToken().orEmpty()
        if (token.isBlank()) return Result.success()
        return try {
            val ack = app.graph.client.probePush(auth, token, scenario)
            DiagnosticTrace.record("push", "delayed", 0, "ok", ack.correlation.take(40))
            Result.success()
        } catch (error: Exception) {
            DiagnosticTrace.record("push", "delayed", 0, "error", error.javaClass.simpleName)
            Result.success()
        }
    }
}

fun scheduleDelayedProbe(context: Context, scenario: String) {
    val name = when (scenario) {
        "duplicate", "reorder" -> scenario
        else -> "standard"
    }
    val request = OneTimeWorkRequestBuilder<ProbeDeliveryWorker>()
        .setInitialDelay(25, TimeUnit.SECONDS)
        .setInputData(workDataOf("scenario" to name))
        .build()
    WorkManager.getInstance(context).enqueueUniqueWork("kanti-probe-delay", ExistingWorkPolicy.REPLACE, request)
}

/** The periodic background check: the server's change feed for every connection (never Schulnetz). */
class SchulnetzWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val app = applicationContext as? CompanionApplication ?: return Result.success()
        withTimeoutOrNull(20_000) { app.graph.pullChangeDelta() }
        return Result.success()
    }
}

/** Fires only after a long quiet stretch, then starts the slow fallback. */
/** Reads every TAM connection on the device (TAM has no server push). */
class TamRefreshWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val app = applicationContext as? CompanionApplication ?: return Result.success()
        runCatching { app.graph.refreshTamConnections("tam-background") }
        return Result.success()
    }
}

internal const val TAM_REFRESH = "kanti-tam-refresh"
internal const val TAM_REFRESH_HOURS = 3L

/** Keeps the periodic TAM read armed while a TAM connection exists. */
internal fun armTamRefresh(context: Context, any: Boolean) {
    val work = WorkManager.getInstance(context)
    if (!any) {
        work.cancelUniqueWork(TAM_REFRESH)
        return
    }
    val request = androidx.work.PeriodicWorkRequestBuilder<TamRefreshWorker>(TAM_REFRESH_HOURS, java.util.concurrent.TimeUnit.HOURS)
        .setConstraints(schoolConstraints())
        .build()
    work.enqueueUniquePeriodicWork(TAM_REFRESH, androidx.work.ExistingPeriodicWorkPolicy.KEEP, request)
}

/** Armed by versions before beta.22; a queued one now only re-arms the steady check. */
class FcmWatchWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        armSchoolDelivery(applicationContext)
        return Result.success()
    }
}

class CompanionFcmService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        val app = applicationContext as? CompanionApplication ?: return
        app.graph.scope.launch { app.graph.registerFcmToken(token) }
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val app = applicationContext as? CompanionApplication ?: return
        notePushReceived(applicationContext)
        CompanionAlerts.ensureChannels(applicationContext)
        if (message.data["probe"] == "1") {
            val serverAt = message.data["serverAt"].orEmpty()
            if (serverAt.isNotBlank()) {
                applicationContext.getSharedPreferences("fanotes-companion", Context.MODE_PRIVATE)
                    .edit()
                    .putString(PROBE_SERVER_AT, serverAt)
                    .putLong(PROBE_RECEIVED_AT, System.currentTimeMillis())
                    .apply()
            }
            val correlation = message.data["correlation"].orEmpty()
            val detail = if (correlation.matches(Regex("^probe:[0-9]{1,20}$"))) correlation else "probe"
            DiagnosticTrace.record("push", "receipt", 0, "ok", detail)
        }
        when (message.data["event"].orEmpty()) {
            // Data-only message. Foreground and background both reach pullChangeDelta, which filters before display.
            // The push names its connection by route key; pull only that one.
            // The pull runs right here (a high-priority message gives the app a few seconds); when it
            // does not finish, expedited work tries again as soon as the network allows.
            "sync" -> {
                val route = message.data["route"]
                val ok = runBlocking { withTimeoutOrNull(8_000) { app.graph.pullChangeDelta(route) } } == true
                if (!ok) enqueuePushSync(applicationContext, route)
            }
            "reauth" -> CompanionAlerts.showReauth(applicationContext, runBlocking { app.graph.alertScopeForRoute(message.data["route"]) })
            "test" -> CompanionAlerts.showTest(applicationContext)
        }
    }
}

class WidgetTickReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        NextLessonWidget.update(context)
    }
}

class NextLessonWidget : android.appwidget.AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        update(context, manager, ids)
    }

    override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, newOptions: Bundle) {
        update(context, manager, intArrayOf(id))
    }

    override fun onDisabled(context: Context) {
        context.getSystemService(AlarmManager::class.java)?.cancel(widgetTickIntent(context))
    }

    companion object {
        fun update(context: Context) {
            val manager = AppWidgetManager.getInstance(context)
            val ids = manager.getAppWidgetIds(ComponentName(context, NextLessonWidget::class.java))
            update(context, manager, ids)
        }

        fun update(context: Context, manager: AppWidgetManager, ids: IntArray) {
            val demo = context.getSharedPreferences("fanotes-companion", Context.MODE_PRIVATE).getBoolean(CompanionGraph.DEMO_PREF, false)
            // Demo mode never writes the cache; the widget builds the same invented week itself.
            // The widget shows the connection the app shows, from that connection's own cache.
            val slot = context.getSharedPreferences("fanotes-companion", Context.MODE_PRIVATE).getString(CompanionGraph.ACTIVE_SLOT_PREF, PRIMARY_SLOT).orEmpty()
            val snapshot = if (demo) ch.fasrv.fanotes.schulnetz.demoSnapshot(java.time.LocalDate.now(ch.fasrv.fanotes.schulnetz.SCHOOL_ZONE))
                else CompanionGraph.snapshotFile(context, slot).takeIf { it.isFile }?.readText()?.let { parseNormalizedSnapshot(it) }
            val hidden = java.io.File(context.filesDir, "vault/${slotVaultPath(slot, CompanionGraph.HIDDEN_PATH)}").takeIf { it.isFile }?.readText()?.let { parseHiddenLessons(it) }.orEmpty()
            val compact = java.io.File(context.filesDir, "vault/${CompanionGraph.DESK_PATH}").takeIf { it.isFile }?.readText()?.let { parseDeskPrefs(it).widgetCompact } == true
            val zone = ZoneId.systemDefault()
            val events = snapshot?.let { visibleEvents(it.events, hidden, zone) }.orEmpty()
            val lessons = upcomingLessons(events, java.time.Instant.now(), zone, 4)
            val unread = snapshot != null && lessons.isEmpty() && upcomingTimetableUnread(snapshot, java.time.LocalDate.now(zone))
            val portrait = context.resources.configuration.orientation != Configuration.ORIENTATION_LANDSCAPE
            ids.forEach { id ->
                val options = runCatching { manager.getAppWidgetOptions(id) }.getOrNull()
                val (width, height) = if (options == null) 180 to 110 else widgetSizeDp(
                    options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 0),
                    options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH, 0),
                    options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 0),
                    options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 0),
                    portrait,
                )
                val span = if (compact) WidgetSpan.SMALL else widgetSpan(width, height)
                manager.updateAppWidget(id, widgetViews(context, span, lessons, zone, unread))
            }
            scheduleWidgetTick(context, snapshot, hidden, zone)
        }

        private fun widgetViews(context: Context, span: WidgetSpan, lessons: List<ch.fasrv.fanotes.schulnetz.AgendaEvent>, zone: ZoneId, unread: Boolean = false): RemoteViews {
            val views = RemoteViews(context.packageName, R.layout.widget_next_lesson)
            val next = lessons.firstOrNull()
            val small = span == WidgetSpan.SMALL
            val pad = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, if (small) 10f else 16f, context.resources.displayMetrics).toInt()
            views.setViewPadding(R.id.widget_root, pad, pad, pad, pad)
            views.setViewVisibility(R.id.widget_kicker, if (small) android.view.View.GONE else android.view.View.VISIBLE)
            views.setTextViewTextSize(R.id.widget_title, TypedValue.COMPLEX_UNIT_SP, if (small) 16f else 18f)
            views.setInt(R.id.widget_title, "setMaxLines", if (small) 1 else 2)
            if (next == null) {
                views.setTextViewText(R.id.widget_title, t(if (unread) R.string.timetable_not_loaded else R.string.no_upcoming_lesson))
                views.setTextViewText(R.id.widget_detail, t(R.string.open_kanti))
                views.setViewVisibility(R.id.widget_more, android.view.View.GONE)
            } else {
                val time = lessonClock(next, zone)
                val roomText = cleanSchulnetzText(next.room)
                val room = if (roomText.isBlank()) "" else t(R.string.room_named, roomText)
                val state = if (next.isCancelled()) t(R.string.cancelled) else if (next.isSubstitution()) t(R.string.substitution) else ""
                views.setTextViewText(R.id.widget_title, next.label)
                views.setTextViewText(R.id.widget_detail, if (small) time else listOf(time, room, state).filter { it.isNotBlank() }.joinToString(" · "))
                val extra = if (span == WidgetSpan.LARGE) lessons.drop(1).joinToString("\n") { lesson ->
                    listOf(lessonClock(lesson, zone), lesson.label, cleanSchulnetzText(lesson.room)).filter { it.isNotBlank() }.joinToString(" · ")
                } else ""
                views.setViewVisibility(R.id.widget_more, if (extra.isBlank()) android.view.View.GONE else android.view.View.VISIBLE)
                views.setTextViewText(R.id.widget_more, extra)
            }
            val target = if (next == null) Intent(context, MainActivity::class.java) else CompanionAlerts.notifyIntent(context,
                ch.fasrv.fanotes.schulnetz.linkedChange("widget-next", "timetable", "", "", ch.fasrv.fanotes.schulnetz.lessonTargetId(next), date = ch.fasrv.fanotes.schulnetz.eventDay(next)))
            val open = PendingIntent.getActivity(context, 1, target, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            views.setOnClickPendingIntent(R.id.widget_root, open)
            return views
        }

        private fun lessonClock(event: ch.fasrv.fanotes.schulnetz.AgendaEvent, zone: ZoneId): String {
            val zoned = event.start.contains('Z') || Regex("""[+-]\d{2}:\d{2}$""").containsMatchIn(event.start)
            if (!zoned) return displayClock(event.start, event.end)
            val start = event.startsAt(zone)?.atZone(zone)?.toLocalTime()?.format(CLOCK).orEmpty()
            val end = event.endsAt(zone)?.atZone(zone)?.toLocalTime()?.format(CLOCK).orEmpty()
            if (start.isBlank() || (start == "00:00" && (end.isBlank() || end == "00:00"))) return ""
            return if (end.isBlank() || end == start) start else "$start–$end"
        }

        private fun scheduleWidgetTick(context: Context, snapshot: SchulnetzSnapshot?, hidden: List<ch.fasrv.fanotes.schulnetz.HiddenLesson>, zone: ZoneId) {
            val alarm = context.getSystemService(AlarmManager::class.java) ?: return
            val pending = widgetTickIntent(context)
            val ids = AppWidgetManager.getInstance(context).getAppWidgetIds(ComponentName(context, NextLessonWidget::class.java))
            if (ids.isEmpty()) {
                alarm.cancel(pending)
                return
            }
            val boundary = snapshot?.let { nextLessonBoundary(visibleEvents(it.events, hidden, zone), java.time.Instant.now(), zone) }
            if (boundary == null) {
                alarm.cancel(pending)
                return
            }
            try {
                alarm.setWindow(AlarmManager.RTC, boundary.toEpochMilli(), WIDGET_WINDOW_MS, pending)
            } catch (_: Exception) {
                alarm.cancel(pending)
            }
        }

        private val CLOCK: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm")
    }
}

private fun widgetTickIntent(context: Context): PendingIntent =
    PendingIntent.getBroadcast(
        context,
        7,
        Intent(context, WidgetTickReceiver::class.java),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
