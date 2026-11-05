package ch.fasrv.fanotes.companion

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
import ch.fasrv.fanotes.schulnetz.SchoolGrade
import ch.fasrv.fanotes.schulnetz.SchulnetzChange
import ch.fasrv.fanotes.schulnetz.SchulnetzSnapshot
import ch.fasrv.fanotes.schulnetz.changeFromPayload
import ch.fasrv.fanotes.schulnetz.settleGradeNotifications
import ch.fasrv.fanotes.schulnetz.changeIsHidden
import ch.fasrv.fanotes.schulnetz.hiddenGradeBody
import ch.fasrv.fanotes.schulnetz.hiddenGradeTitle
import ch.fasrv.fanotes.schulnetz.newGradeTargetIds
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

object CompanionAlerts {
    const val CHANNEL = "schulnetz-alerts"
    const val EXTRA_CATEGORY = "ch.fasrv.fanotes.companion.NOTIFY_CATEGORY"
    const val EXTRA_TARGET_ID = "ch.fasrv.fanotes.companion.NOTIFY_TARGET_ID"
    const val EXTRA_TARGET_IDS = "ch.fasrv.fanotes.companion.NOTIFY_TARGET_IDS"
    const val EXTRA_COURSE_ID = "ch.fasrv.fanotes.companion.NOTIFY_COURSE_ID"
    const val EXTRA_DATE = "ch.fasrv.fanotes.companion.NOTIFY_DATE"
    const val EXTRA_PAYLOAD = "ch.fasrv.fanotes.companion.NOTIFY_PAYLOAD"
    private const val SEEN = "seen-changes"

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

    fun showReauth(context: Context) {
        show(context, ch.fasrv.fanotes.schulnetz.linkedChange(
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

    fun showAll(context: Context, changes: List<SchulnetzChange>, gradeKeysSettled: Boolean = false) {
        val prefs = context.getSharedPreferences("fanotes-companion", Context.MODE_PRIVATE)
        val guess = prefs.getBoolean(CompanionGraph.GUESS_GRADES_PREF, false)
        val snapshot = CompanionGraph.snapshotFile(context).takeIf { it.isFile }?.readText()?.let { parseNormalizedSnapshot(it) } ?: SchulnetzSnapshot()
        if (guess) rememberUnrevealed(context, newGradeTargetIds(changes))
        prepareGradeNotifications(changes, guess, snapshot).forEach { show(context, it, gradeKeysSettled) }
    }

    /**
     * Drop grades this account has already been told about, and on the first
     * run after this fix record every grade currently on file without telling
     * anyone again. [gradeKeysSettled] on the following [showAll] must be true.
     */
    fun settledChanges(context: Context, changes: List<SchulnetzChange>, grades: List<SchoolGrade>): List<SchulnetzChange> {
        val ledger = readGradeLedger(context)
        val settled = settleGradeNotifications(changes, grades, ledger)
        writeGradeLedger(context, settled.keys)
        return settled.changes
    }

    fun show(context: Context, change: SchulnetzChange, gradeKeysSettled: Boolean = false) {
        if (change.category != "settings" && context.getSharedPreferences("fanotes-companion", Context.MODE_PRIVATE).getBoolean("school-disconnected", false)) return
        if (change.id.isBlank()) return
        if (!notificationsAllowed(context)) return
        if (!gradeKeysSettled && change.category == "grade") {
            val keys = change.gradeKeys.filter { it.isNotBlank() }
            if (keys.isNotEmpty()) {
                val known = readGradeLedger(context) ?: emptySet()
                if (keys.all { it in known }) return
                writeGradeLedger(context, known + keys)
            }
        }
        if (!remember(context, change.id)) return
        val hidden = runCatching {
            val file = java.io.File(context.filesDir, "vault/${CompanionGraph.HIDDEN_PATH}")
            if (!file.isFile) emptyList() else parseHiddenLessons(file.readText())
        }.getOrDefault(emptyList())
        if (changeIsHidden(change, hidden)) return
        val prefs = context.getSharedPreferences("fanotes-companion", Context.MODE_PRIVATE)
        val guess = prefs.getBoolean(CompanionGraph.GUESS_GRADES_PREF, false)
        val snapshot = CompanionGraph.snapshotFile(context).takeIf { it.isFile }?.readText()?.let { parseNormalizedSnapshot(it) }
        var shown = change
        if (guess && change.category == "grade") {
            rememberUnrevealed(context, change.linkIds())
            shown = if (snapshot != null) redactGradeChange(change, snapshot) else change.copy(
                title = hiddenGradeTitle(change, change.courseId.ifBlank { "einem Fach" }),
                body = hiddenGradeBody(change.body.substringAfter(" · ").substringBefore(" · ").ifBlank { "Tippen zum Aufdecken" }),
            )
            if (shown.linkIds().size > 1) {
                shown = shown.copy(title = "${shown.linkIds().size} neue Noten – tippen zum Aufdecken", body = "Tippen zum Aufdecken")
            }
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
        val open = PendingIntent.getActivity(
            context,
            shown.id.hashCode(),
            notifyIntent(context, shown),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val title = shownText(shown.title.ifBlank { t(R.string.schulnetz) })
        val body = shownText(shown.body)
        val lock = lockScreenNotice()
        val publicTitle = shownText(lock.publicTitle, fragments = false)
        val publicText = shownText(lock.publicText, fragments = false)
        val publicVersion = NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(publicTitle)
            .setContentText(publicText)
            .build()
        val notification = NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(title)
            .setContentText(body)
            .setTicker(title)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body).setBigContentTitle(title))
            .setVisibility(lock.visibility)
            .setPublicVersion(publicVersion)
            .setContentIntent(open)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.notify(shown.id.hashCode(), notification)
    }

    fun rememberUnrevealed(context: Context, ids: Collection<String>) {
        val next = ids.filter { it.isNotBlank() }
        if (next.isEmpty()) return
        val prefs = context.getSharedPreferences("fanotes-companion", Context.MODE_PRIVATE)
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

    fun notifyIntent(context: Context, change: SchulnetzChange): Intent {
        val ids = ArrayList(change.linkIds())
        return Intent(context, MainActivity::class.java)
            .setAction(Intent.ACTION_VIEW)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_NEW_TASK)
            .putExtra(EXTRA_CATEGORY, change.category)
            .putExtra(EXTRA_TARGET_ID, ids.joinToString(","))
            .putStringArrayListExtra(EXTRA_TARGET_IDS, ids)
            .putExtra(EXTRA_COURSE_ID, change.courseId)
            .putExtra(EXTRA_DATE, change.date)
            .putExtra(EXTRA_PAYLOAD, notifyPayload(change))
    }

    fun forget(context: Context, id: String) {
        val prefs = context.getSharedPreferences("fanotes-companion", Context.MODE_PRIVATE)
        val seen = prefs.getStringSet(SEEN, emptySet()).orEmpty().toMutableSet()
        if (!seen.remove(id)) return
        prefs.edit().putStringSet(SEEN, seen).apply()
    }

    private fun remember(context: Context, id: String): Boolean {
        val prefs = context.getSharedPreferences("fanotes-companion", Context.MODE_PRIVATE)
        val seen = prefs.getStringSet(SEEN, emptySet()).orEmpty().toMutableSet()
        if (!seen.add(id)) return false
        val stored = if (seen.size > 2000) {
            val kept = LinkedHashSet<String>()
            kept.add(id)
            for (old in seen) {
                if (kept.size >= 2000) break
                kept.add(old)
            }
            kept
        } else {
            seen
        }
        prefs.edit().putStringSet(SEEN, stored).apply()
        return true
    }
}

private const val GRADE_LEDGER = "notified-grades-v1.json"

internal fun gradeLedgerFile(context: Context) = java.io.File(context.filesDir, GRADE_LEDGER)

/** Null when this install has never recorded grade identities. That is the migration. */
internal fun readGradeLedger(context: Context): Set<String>? {
    val file = gradeLedgerFile(context)
    if (!file.isFile) return null
    val obj = runCatching { parseJson(file.readText()) as? JsonValue.Obj }.getOrNull() ?: return null
    if (obj.double("version") != 1.0) return null
    val keys = obj.array("keys")?.items?.mapNotNull { (it as? JsonValue.Str)?.value } ?: return null
    return keys.toSet()
}

internal fun writeGradeLedger(context: Context, keys: Set<String>) {
    val body = buildString {
        append("{\"version\":1,\"keys\":[")
        keys.sorted().forEachIndexed { index, key ->
            if (index > 0) append(',')
            append(escapeJson(key))
        }
        append("]}")
    }
    val file = gradeLedgerFile(context)
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
internal const val SCHOOL_FALLBACK_MS = 6 * 60 * 60_000L
internal const val FCM_HEALTHY_MS = 12 * 60 * 60_000L
internal const val WIDGET_WINDOW_MS = 10 * 60_000L

fun schoolFallbackIntervalMs(): Long = SCHOOL_FALLBACK_MS

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
    if (prefs.getBoolean("school-disconnected", false)) return false
    if (!prefs.getBoolean("school-linked", false) && !prefs.getString("push-topic", null).isNullOrBlank()) {
        prefs.edit().putBoolean("school-linked", true).remove("push-topic").remove("push-server").apply()
    }
    return prefs.getBoolean("school-linked", false)
}

internal data class LockScreenNotice(val visibility: Int, val publicTitle: String, val publicText: String)

internal fun lockScreenNotice(): LockScreenNotice = LockScreenNotice(
    NotificationCompat.VISIBILITY_PRIVATE,
    "Neue Schulnetz-Meldung",
    "Neue Schulnetz-Meldung",
)

/** Periodic fallback only when push is missing. A healthy push cancels it and arms a far-off check. */
private fun armSchoolDelivery(context: Context) {
    val work = WorkManager.getInstance(context)
    if (!linkedForPush(context)) {
        cancelSchoolDelivery(context)
        return
    }
    val prefs = context.getSharedPreferences("fanotes-companion", Context.MODE_PRIVATE)
    val healthy = fcmPushHealthy(prefs.getLong(LAST_PUSH_PREF, 0L), System.currentTimeMillis(), firebaseConfigured(context))
    if (healthy) {
        work.cancelUniqueWork(SCHOOL_FALLBACK)
        val watch = OneTimeWorkRequestBuilder<FcmWatchWorker>()
            .setInitialDelay(12, TimeUnit.HOURS)
            .setConstraints(schoolConstraints())
            .build()
        work.enqueueUniqueWork(SCHOOL_WATCH, ExistingWorkPolicy.REPLACE, watch)
    } else {
        work.cancelUniqueWork(SCHOOL_WATCH)
        val request = PeriodicWorkRequestBuilder<SchulnetzWorker>(6, TimeUnit.HOURS, 1, TimeUnit.HOURS)
            .setConstraints(schoolConstraints())
            .build()
        work.enqueueUniquePeriodicWork(SCHOOL_FALLBACK, ExistingPeriodicWorkPolicy.KEEP, request)
    }
}

fun notePushReceived(context: Context) {
    context.getSharedPreferences("fanotes-companion", Context.MODE_PRIVATE)
        .edit().putLong(LAST_PUSH_PREF, System.currentTimeMillis()).apply()
    armSchoolDelivery(context)
}

class SchulnetzWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val app = applicationContext as? CompanionApplication ?: return Result.success()
        withTimeoutOrNull(8_000) { app.graph.pullChangeDelta() }
        return Result.success()
    }
}

/** Fires only after a long quiet stretch, then starts the slow fallback. */
class FcmWatchWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val prefs = applicationContext.getSharedPreferences("fanotes-companion", Context.MODE_PRIVATE)
        val healthy = fcmPushHealthy(prefs.getLong(LAST_PUSH_PREF, 0L), System.currentTimeMillis(), firebaseConfigured(applicationContext))
        if (healthy) {
            armSchoolDelivery(applicationContext)
            return Result.success()
        }
        WorkManager.getInstance(applicationContext).cancelUniqueWork(SCHOOL_WATCH)
        val request = PeriodicWorkRequestBuilder<SchulnetzWorker>(6, TimeUnit.HOURS, 1, TimeUnit.HOURS)
            .setConstraints(schoolConstraints())
            .build()
        WorkManager.getInstance(applicationContext).enqueueUniquePeriodicWork(SCHOOL_FALLBACK, ExistingPeriodicWorkPolicy.KEEP, request)
        val app = applicationContext as? CompanionApplication
        if (app != null) withTimeoutOrNull(8_000) { app.graph.pullChangeDelta() }
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
        when (message.data["event"].orEmpty()) {
            "sync" -> runBlocking { withTimeoutOrNull(8_000) { app.graph.pullChangeDelta() } }
            "reauth" -> CompanionAlerts.showReauth(applicationContext)
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
            val snapshot = CompanionGraph.snapshotFile(context).takeIf { it.isFile }?.readText()?.let { parseNormalizedSnapshot(it) }
            val hidden = java.io.File(context.filesDir, "vault/${CompanionGraph.HIDDEN_PATH}").takeIf { it.isFile }?.readText()?.let { parseHiddenLessons(it) }.orEmpty()
            val compact = java.io.File(context.filesDir, "vault/${CompanionGraph.DESK_PATH}").takeIf { it.isFile }?.readText()?.let { parseDeskPrefs(it).widgetCompact } == true
            val zone = ZoneId.systemDefault()
            val events = snapshot?.let { visibleEvents(it.events, hidden, zone) }.orEmpty()
            val lessons = upcomingLessons(events, java.time.Instant.now(), zone, 4)
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
                manager.updateAppWidget(id, widgetViews(context, span, lessons, zone))
            }
            scheduleWidgetTick(context, snapshot, hidden, zone)
        }

        private fun widgetViews(context: Context, span: WidgetSpan, lessons: List<ch.fasrv.fanotes.schulnetz.AgendaEvent>, zone: ZoneId): RemoteViews {
            val views = RemoteViews(context.packageName, R.layout.widget_next_lesson)
            val next = lessons.firstOrNull()
            val small = span == WidgetSpan.SMALL
            val pad = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, if (small) 10f else 16f, context.resources.displayMetrics).toInt()
            views.setViewPadding(R.id.widget_root, pad, pad, pad, pad)
            views.setViewVisibility(R.id.widget_kicker, if (small) android.view.View.GONE else android.view.View.VISIBLE)
            views.setTextViewTextSize(R.id.widget_title, TypedValue.COMPLEX_UNIT_SP, if (small) 16f else 18f)
            views.setInt(R.id.widget_title, "setMaxLines", if (small) 1 else 2)
            if (next == null) {
                views.setTextViewText(R.id.widget_title, t(R.string.no_upcoming_lesson))
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
