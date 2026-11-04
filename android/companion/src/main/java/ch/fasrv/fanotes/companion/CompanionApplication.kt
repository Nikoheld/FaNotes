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
        CompanionAlerts.ensureChannels(this)
        CompanionAlerts.retireLegacyPush(this)
        configurePushDelivery(this)
        graph.scope.launch {
            graph.recordOpenToday()
            graph.engine.start()
            graph.engine.pauseAutomaticSync()
        }
    }
}
