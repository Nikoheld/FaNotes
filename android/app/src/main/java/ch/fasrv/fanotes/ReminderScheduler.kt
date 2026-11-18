package ch.fasrv.fanotes

import android.Manifest
import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import ch.fasrv.fanotes.desk.AlarmMode
import ch.fasrv.fanotes.desk.CALENDAR_NOTE_PATH
import ch.fasrv.fanotes.desk.HOMEWORK_NOTE_PATH
import ch.fasrv.fanotes.desk.NoteMarkdownLoad
import ch.fasrv.fanotes.desk.NotificationAccess
import ch.fasrv.fanotes.desk.PlannedReminder
import ch.fasrv.fanotes.desk.ReminderKind
import ch.fasrv.fanotes.desk.ReminderReadiness
import ch.fasrv.fanotes.desk.ReminderSettings
import ch.fasrv.fanotes.desk.alarmMode
import ch.fasrv.fanotes.desk.emptyCalendar
import ch.fasrv.fanotes.desk.loadCalendarMarkdown
import ch.fasrv.fanotes.desk.loadHomeworkMarkdown
import ch.fasrv.fanotes.desk.notificationAccess
import ch.fasrv.fanotes.desk.planReminders
import ch.fasrv.fanotes.desk.reminderReadiness
import ch.fasrv.fanotes.desk.reminderRequestCode
import ch.fasrv.fanotes.desk.staleReminderIds
import kotlinx.coroutines.flow.MutableStateFlow
import java.time.ZonedDateTime
import java.util.concurrent.TimeUnit

/**
 * System reminders for calendar events and homework (`desk/ReminderPlan.kt` decides what is due).
 *
 * - Each planned reminder is an `AlarmManager` alarm (exact when the device allows it, else inexact) whose
 *   receiver posts the notification, so it arrives with the app closed and in Doze (`AllowWhileIdle`).
 * - A WorkManager job re-plans every few hours and shortly after the calendar or homework file changed, after a
 *   reboot, a clock or time zone change, and when the exact-alarm access changes. Alarms do not survive a reboot.
 * - The plan covers the next 7 days, so a missed re-plan never leaves more than a week of silence.
 */
class ReminderScheduler(private val context: Context, private val graph: AppGraph) {
    private val prefs = context.getSharedPreferences("fanotes-reminders", Context.MODE_PRIVATE)
    private val alarms get() = context.getSystemService(AlarmManager::class.java)

    val settings = MutableStateFlow(readSettings())
    val upcoming = MutableStateFlow<List<PlannedReminder>>(emptyList())

    private fun readSettings() = ReminderSettings(
        enabled = prefs.getBoolean("enabled", false),
        calendarLeadMinutes = prefs.getInt("lead", 15),
        homework = prefs.getBoolean("homework", true),
        homeworkLeadMinutes = prefs.getInt("homework-lead", 60),
        homeworkEveningHour = prefs.getInt("evening", 18),
    ).sanitized()

    fun update(change: (ReminderSettings) -> ReminderSettings) {
        val next = change(settings.value).sanitized()
        prefs.edit()
            .putBoolean("enabled", next.enabled)
            .putInt("lead", next.calendarLeadMinutes)
            .putBoolean("homework", next.homework)
            .putInt("homework-lead", next.homeworkLeadMinutes)
            .putInt("evening", next.homeworkEveningHour)
            .apply()
        settings.value = next
        if (next.enabled) {
            ensureChannel()
            schedulePeriodic()
        } else {
            WorkManager.getInstance(context).cancelUniqueWork(PERIODIC)
        }
        requestReplan(0)
    }

    // ---- what the device allows ----

    fun canScheduleExact(): Boolean = Build.VERSION.SDK_INT < 31 || alarms.canScheduleExactAlarms()

    fun notificationGranted(): Boolean =
        if (Build.VERSION.SDK_INT >= 33) {
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        } else {
            NotificationManagerCompat.from(context).areNotificationsEnabled()
        }

    fun markPermissionAsked() {
        prefs.edit().putBoolean("asked", true).apply()
    }

    fun readiness(shouldShowRationale: Boolean): ReminderReadiness {
        val access = notificationAccess(Build.VERSION.SDK_INT, notificationGranted(), prefs.getBoolean("asked", false), shouldShowRationale)
        val channelOn = Build.VERSION.SDK_INT < 26 ||
            context.getSystemService(NotificationManager::class.java).getNotificationChannel(CHANNEL)?.importance != NotificationManager.IMPORTANCE_NONE
        return reminderReadiness(Build.VERSION.SDK_INT, access, canScheduleExact(), channelOn)
    }

    fun ensureChannel() {
        if (Build.VERSION.SDK_INT < 26) return
        val manager = context.getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(CHANNEL) != null) return
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL, "Erinnerungen", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Termine und Hausaufgaben"
            },
        )
    }

    // ---- planning ----

    /** Runs on a background thread (the worker, or a caller that is not the main thread). */
    fun replan() {
        val config = settings.value
        if (!config.enabled) {
            cancelAll()
            upcoming.value = emptyList()
            return
        }
        val vault = graph.vault
        val calendar = when (val loaded = vault.read(CALENDAR_NOTE_PATH)?.decodeToString()?.let(::loadCalendarMarkdown)) {
            null -> emptyCalendar()
            is NoteMarkdownLoad.Ready -> loaded.document
            NoteMarkdownLoad.Unreadable -> return
        }
        val homework = when (val loaded = vault.read(HOMEWORK_NOTE_PATH)?.decodeToString()?.let(::loadHomeworkMarkdown)) {
            null -> ch.fasrv.fanotes.desk.HomeworkDocument(emptyList())
            is NoteMarkdownLoad.Ready -> loaded.document
            NoteMarkdownLoad.Unreadable -> return
        }
        val plan = planReminders(calendar, homework, ZonedDateTime.now(), config)
        val fired = firedIds()
        val wanted = plan.filter { it.id !in fired }
        for (stale in staleReminderIds(scheduledIds(), wanted)) cancel(stale)
        val exact = alarmMode(Build.VERSION.SDK_INT, canScheduleExact()) == AlarmMode.EXACT
        for (reminder in wanted) schedule(reminder, exact)
        prefs.edit().putStringSet("scheduled", wanted.map { it.id }.toSet()).apply()
        upcoming.value = wanted
    }

    /** Re-plans in the background after [delaySeconds]. Many calls in a row run once. */
    fun requestReplan(delaySeconds: Long = 3) {
        WorkManager.getInstance(context).enqueueUniqueWork(
            ONCE,
            ExistingWorkPolicy.REPLACE,
            OneTimeWorkRequestBuilder<ReminderWorker>().setInitialDelay(delaySeconds, TimeUnit.SECONDS).build(),
        )
    }

    fun schedulePeriodic() {
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            PERIODIC,
            ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<ReminderWorker>(3, TimeUnit.HOURS).build(),
        )
    }

    /** Boot, time zone, clock, package update and exact-alarm changes. Cheap when reminders are off. */
    fun onSystemChange() {
        if (settings.value.enabled) {
            schedulePeriodic()
            requestReplan(5)
        }
    }

    private fun scheduledIds(): Set<String> = prefs.getStringSet("scheduled", emptySet()).orEmpty()

    private fun firedIds(): Set<String> {
        val cutoff = System.currentTimeMillis() - TimeUnit.DAYS.toMillis(2)
        val kept = prefs.getStringSet("fired", emptySet()).orEmpty().filter { (it.substringAfterLast('\t').toLongOrNull() ?: 0) > cutoff }
        return kept.map { it.substringBeforeLast('\t') }.toSet()
    }

    fun markFired(id: String) {
        val cutoff = System.currentTimeMillis() - TimeUnit.DAYS.toMillis(2)
        val next = prefs.getStringSet("fired", emptySet()).orEmpty()
            .filter { (it.substringAfterLast('\t').toLongOrNull() ?: 0) > cutoff && it.substringBeforeLast('\t') != id }
            .toMutableSet()
        next += "$id\t${System.currentTimeMillis()}"
        prefs.edit().putStringSet("fired", next).apply()
    }

    private fun pendingIntent(id: String, reminder: PlannedReminder?, create: Boolean): PendingIntent? {
        val intent = Intent(context, ReminderReceiver::class.java).setData(Uri.parse("fanotes-reminder://" + Uri.encode(id)))
        if (reminder != null) {
            intent.putExtra(EXTRA_ID, reminder.id)
                .putExtra(EXTRA_TITLE, reminder.title)
                .putExtra(EXTRA_TEXT, reminder.text)
                .putExtra(EXTRA_KIND, reminder.kind.name)
        }
        val flags = PendingIntent.FLAG_IMMUTABLE or if (create) PendingIntent.FLAG_UPDATE_CURRENT else PendingIntent.FLAG_NO_CREATE
        return PendingIntent.getBroadcast(context, reminderRequestCode(id), intent, flags)
    }

    private fun schedule(reminder: PlannedReminder, exact: Boolean) {
        val pending = pendingIntent(reminder.id, reminder, create = true) ?: return
        try {
            if (exact) {
                alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, reminder.triggerAtMs, pending)
            } else {
                alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, reminder.triggerAtMs, pending)
            }
        } catch (_: SecurityException) {
            // The exact-alarm access was withdrawn between the check and the call: fall back to an inexact alarm.
            alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, reminder.triggerAtMs, pending)
        }
    }

    private fun cancel(id: String) {
        pendingIntent(id, null, create = false)?.let {
            alarms.cancel(it)
            it.cancel()
        }
    }

    fun cancelAll() {
        for (id in scheduledIds()) cancel(id)
        prefs.edit().remove("scheduled").apply()
    }

    // ---- notification ----

    fun notify(id: String, title: String, text: String, kind: ReminderKind) {
        ensureChannel()
        if (!notificationGranted()) return
        val open = Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(EXTRA_DESTINATION, if (kind == ReminderKind.HOMEWORK) "tasks" else "calendar")
        val content = PendingIntent.getActivity(context, reminderRequestCode("open:$id"), open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val notification = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_pen)
            .setContentTitle(title)
            .setContentText(text)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(content)
            .build()
        try {
            NotificationManagerCompat.from(context).notify(reminderRequestCode(id), notification)
        } catch (_: SecurityException) {
            // The permission was withdrawn just now.
        }
    }

    fun sendTest() {
        notify("test:${System.currentTimeMillis()}", "Testerinnerung", "So sehen Erinnerungen von FaNotes aus.", ReminderKind.CALENDAR)
    }

    companion object {
        const val CHANNEL = "fanotes-reminders"
        const val ONCE = "fanotes-reminders-once"
        const val PERIODIC = "fanotes-reminders-periodic"
        const val EXTRA_ID = "fanotes.reminder.id"
        const val EXTRA_TITLE = "fanotes.reminder.title"
        const val EXTRA_TEXT = "fanotes.reminder.text"
        const val EXTRA_KIND = "fanotes.reminder.kind"
        const val EXTRA_DESTINATION = "fanotes.destination"
    }
}

/** An alarm went off: post the notification and remember it, so a re-plan does not fire it again. */
class ReminderReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val scheduler = (context.applicationContext as FaNotesApplication).graph.reminders
        val id = intent.getStringExtra(ReminderScheduler.EXTRA_ID) ?: return
        val kind = runCatching { ReminderKind.valueOf(intent.getStringExtra(ReminderScheduler.EXTRA_KIND).orEmpty()) }.getOrDefault(ReminderKind.CALENDAR)
        scheduler.notify(id, intent.getStringExtra(ReminderScheduler.EXTRA_TITLE).orEmpty(), intent.getStringExtra(ReminderScheduler.EXTRA_TEXT).orEmpty(), kind)
        scheduler.markFired(id)
    }
}

/** Alarms are gone after a reboot, and wall-clock times move with the clock and the zone. */
class ReminderSystemReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        (context.applicationContext as FaNotesApplication).graph.reminders.onSystemChange()
    }
}

class ReminderWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result {
        val graph = (applicationContext as FaNotesApplication).graph
        return try {
            kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { graph.reminders.replan() }
            Result.success()
        } catch (_: Exception) {
            Result.retry()
        }
    }
}
