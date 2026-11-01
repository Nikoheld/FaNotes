package ch.fasrv.fanotes.companion

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.IBinder
import android.widget.RemoteViews
import androidx.core.app.NotificationCompat
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.parseJson
import ch.fasrv.fanotes.schulnetz.SchulnetzChange
import ch.fasrv.fanotes.schulnetz.endsAt
import ch.fasrv.fanotes.schulnetz.nextUp
import ch.fasrv.fanotes.schulnetz.parseNormalizedSnapshot
import ch.fasrv.fanotes.schulnetz.startsAt
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.MessagingReceiver
import org.unifiedpush.android.connector.UnifiedPush
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage
import org.unifiedpush.android.connector.data.ResolvedDistributor
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.concurrent.TimeUnit

object CompanionAlerts {
    const val CHANNEL = "schulnetz-alerts"
    private const val SEEN = "seen-changes"

    fun ensureChannels(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL, context.getString(R.string.channel_alerts), NotificationManager.IMPORTANCE_HIGH))
        manager.createNotificationChannel(NotificationChannel(NtfyListenService.LIVE, context.getString(R.string.channel_live), NotificationManager.IMPORTANCE_LOW))
    }

    fun showAll(context: Context, changes: List<SchulnetzChange>) {
        changes.forEach { show(context, it) }
    }

    fun show(context: Context, change: SchulnetzChange) {
        if (change.id.isBlank() || !remember(context, change.id)) return
        val open = PendingIntent.getActivity(
            context,
            0,
            Intent(context, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(change.title.ifBlank { "Schulnetz" })
            .setContentText(change.body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(change.body))
            .setContentIntent(open)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.notify(change.id.hashCode(), notification)
    }

    fun onPushPayload(context: Context, payload: String) {
        val obj = runCatching { parseJson(payload) as? JsonValue.Obj }.getOrNull()
        if (obj == null) {
            show(context, SchulnetzChange(payload.hashCode().toString(), "event", "Schulnetz", payload.take(180)))
            return
        }
        val nested = obj.string("message")?.let { runCatching { parseJson(it) as? JsonValue.Obj }.getOrNull() }
        val source = nested ?: obj
        val title = source.string("title") ?: obj.string("title") ?: "Schulnetz"
        val body = source.string("body") ?: obj.string("message") ?: obj.string("body") ?: ""
        val id = source.string("id") ?: obj.string("id") ?: "$title|$body"
        if (obj.string("event") == "keepalive" || obj.string("event") == "open") return
        show(context, SchulnetzChange(id, source.string("category") ?: "event", title, body))
    }

    private fun remember(context: Context, id: String): Boolean {
        val prefs = context.getSharedPreferences("fanotes-companion", Context.MODE_PRIVATE)
        val seen = prefs.getStringSet(SEEN, emptySet()).orEmpty().toMutableSet()
        if (!seen.add(id)) return false
        val trimmed = if (seen.size > 200) seen.toList().takeLast(200).toSet() else seen
        prefs.edit().putStringSet(SEEN, trimmed).apply()
        return true
    }
}

class SchulnetzWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = try {
        (applicationContext as CompanionApplication).graph.refreshSchulnetz()
        Result.success()
    } catch (_: Exception) {
        Result.retry()
    }

    companion object {
        fun schedule(context: Context) {
            val request = PeriodicWorkRequestBuilder<SchulnetzWorker>(15, TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork("schulnetz", ExistingPeriodicWorkPolicy.UPDATE, request)
        }
    }
}

class NtfyListenService : Service() {
    private val job = kotlinx.coroutines.SupervisorJob()
    private val scope = kotlinx.coroutines.CoroutineScope(job + kotlinx.coroutines.Dispatchers.IO)
    private val client = OkHttpClient.Builder().readTimeout(0, TimeUnit.MILLISECONDS).connectTimeout(20, TimeUnit.SECONDS).build()

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notice = NotificationCompat.Builder(this, LIVE)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("Schulnetz")
            .setContentText("Änderungen kommen sofort an.")
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
        startForeground(42, notice)
        scope.launch { listen() }
        return START_STICKY
    }

    private suspend fun listen() {
        val prefs = getSharedPreferences("fanotes-companion", MODE_PRIVATE)
        val server = prefs.getString("push-server", null).orEmpty().ifBlank { "https://ntfy.sh" }.trimEnd('/')
        val topic = prefs.getString("push-topic", null).orEmpty()
        if (topic.isBlank()) {
            stopSelf()
            return
        }
        while (job.isActive) {
            try {
                val request = okhttp3.Request.Builder().url("$server/$topic/json").header("Accept", "application/x-ndjson").build()
                client.newCall(request).execute().use { response ->
                    val source = response.body?.source() ?: return@use
                    while (!source.exhausted()) {
                        val line = source.readUtf8Line() ?: break
                        if (line.startsWith("{")) CompanionAlerts.onPushPayload(this@NtfyListenService, line)
                    }
                }
            } catch (_: Exception) {
                kotlinx.coroutines.delay(5_000)
            }
        }
    }

    override fun onDestroy() {
        job.cancel()
        super.onDestroy()
    }

    companion object {
        const val LIVE = "schulnetz-live"
        fun start(context: Context) {
            val intent = Intent(context, NtfyListenService::class.java)
            androidx.core.content.ContextCompat.startForegroundService(context, intent)
        }
        fun stop(context: Context) {
            context.stopService(Intent(context, NtfyListenService::class.java))
        }
    }
}

class CompanionPushReceiver : MessagingReceiver() {
    override fun onNewEndpoint(context: Context, endpoint: PushEndpoint, instance: String) {
        val app = context.applicationContext as? CompanionApplication ?: return
        app.graph.scope.launch { app.graph.registerPushEndpoint(endpoint.url) }
    }

    override fun onRegistrationFailed(context: Context, reason: FailedReason, instance: String) = Unit

    override fun onUnregistered(context: Context, instance: String) = Unit

    override fun onMessage(context: Context, message: PushMessage, instance: String) {
        CompanionAlerts.onPushPayload(context, message.content.toString(Charsets.UTF_8))
    }
}

fun enableUnifiedPush(context: Context): Boolean = when (val resolved = UnifiedPush.resolveDefaultDistributor(context)) {
    is ResolvedDistributor.Found -> {
        UnifiedPush.saveDistributor(context, resolved.packageName)
        UnifiedPush.register(context, "schulnetz", "FaNotes Companion")
        true
    }
    else -> false
}

class NextLessonWidget : android.appwidget.AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        update(context, manager, ids)
    }

    companion object {
        fun update(context: Context) {
            val manager = AppWidgetManager.getInstance(context)
            val ids = manager.getAppWidgetIds(ComponentName(context, NextLessonWidget::class.java))
            update(context, manager, ids)
        }

        fun update(context: Context, manager: AppWidgetManager, ids: IntArray) {
            val views = RemoteViews(context.packageName, R.layout.widget_next_lesson)
            val snapshot = CompanionGraph.snapshotFile(context).takeIf { it.isFile }?.readText()?.let { parseNormalizedSnapshot(it) }
            val zone = ZoneId.systemDefault()
            val next = snapshot?.let { nextUp(it.events, java.time.Instant.now(), zone) }
            if (next == null) {
                views.setTextViewText(R.id.widget_title, "Keine Lektion")
                views.setTextViewText(R.id.widget_detail, "Schulnetz öffnen")
            } else {
                val start = next.startsAt(zone)?.atZone(zone)?.toLocalTime()?.format(CLOCK).orEmpty()
                val end = next.endsAt(zone)?.atZone(zone)?.toLocalTime()?.format(CLOCK).orEmpty()
                val time = if (end.isBlank() || end == start) start else "$start–$end"
                val room = if (next.room.isBlank()) "" else "Raum ${next.room}"
                views.setTextViewText(R.id.widget_title, next.label)
                views.setTextViewText(R.id.widget_detail, listOf(time, room).filter { it.isNotBlank() }.joinToString(" · "))
            }
            val open = PendingIntent.getActivity(context, 1, Intent(context, MainActivity::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            views.setOnClickPendingIntent(R.id.widget_root, open)
            ids.forEach { manager.updateAppWidget(it, views) }
        }

        private val CLOCK: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm")
    }
}
