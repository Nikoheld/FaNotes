package ch.fasrv.fanotes

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/** Keeps the sync engine alive while the tablet is signed in, and retries when the network returns. */
class SyncService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var callback: ConnectivityManager.NetworkCallback? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification = notification()
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(42, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(42, notification)
        }
        val app = application as FaNotesApplication
        val connectivity = getSystemService(ConnectivityManager::class.java)
        if (callback == null) {
            callback = object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    scope.launch { app.graph.engine.syncNow("online") }
                }
            }
            connectivity.registerDefaultNetworkCallback(callback!!)
        }
        scope.launch { app.graph.engine.syncNow("service") }
        return START_STICKY
    }

    override fun onDestroy() {
        callback?.let { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(it) }
        super.onDestroy()
    }

    private fun notification(): Notification {
        val pending = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, FaNotesApplication.SYNC_CHANNEL)
            .setContentTitle("FaNotes sync")
            .setContentText("Notes stay up to date with your other devices")
            .setSmallIcon(R.drawable.ic_stat_pen)
            .setContentIntent(pending)
            .setOngoing(true)
            .build()
    }
}
