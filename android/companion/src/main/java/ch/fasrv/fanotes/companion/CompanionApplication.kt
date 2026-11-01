package ch.fasrv.fanotes.companion

import android.app.Application
import kotlinx.coroutines.launch

class CompanionApplication : Application() {
    lateinit var graph: CompanionGraph
        private set

    override fun onCreate() {
        super.onCreate()
        graph = CompanionGraph(this)
        CompanionAlerts.ensureChannels(this)
        SchulnetzWorker.schedule(this)
        graph.scope.launch {
            graph.engine.start()
            runCatching { graph.refreshSchulnetz() }
            val topic = getSharedPreferences("fanotes-companion", MODE_PRIVATE).getString("push-topic", null)
            if (graph.instantPush() && !topic.isNullOrBlank()) {
                runCatching { NtfyListenService.start(this@CompanionApplication) }
            }
        }
    }
}
