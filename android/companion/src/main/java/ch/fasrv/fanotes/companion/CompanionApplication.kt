package ch.fasrv.fanotes.companion

import android.app.Application
import kotlinx.coroutines.launch

class CompanionApplication : Application() {
    lateinit var graph: CompanionGraph
        private set

    override fun onCreate() {
        super.onCreate()
        if (android.os.Build.VERSION.SDK_INT >= 28) {
            android.webkit.WebView.setDataDirectorySuffix("schulnetz")
        }
        android.webkit.CookieManager.getInstance().setAcceptCookie(true)
        graph = CompanionGraph(this)
        graph.recordOpenToday()
        CompanionAlerts.ensureChannels(this)
        SchulnetzWorker.schedule(this)
        graph.scope.launch {
            graph.engine.start()
            runCatching { graph.refreshSchulnetz("process-start") }
            val topic = getSharedPreferences("fanotes-companion", MODE_PRIVATE).getString("push-topic", null)
            if (graph.instantPush() && !topic.isNullOrBlank()) {
                runCatching { NtfyListenService.start(this@CompanionApplication) }
            }
            while (true) {
                kotlinx.coroutines.delay(CompanionGraph.PHONE_FALLBACK_MS)
                runCatching { graph.keepAlive() }
            }
        }
    }
}
