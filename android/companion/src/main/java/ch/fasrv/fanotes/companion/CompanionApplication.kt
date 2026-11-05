package ch.fasrv.fanotes.companion

import android.app.Application
import android.content.Context
import kotlinx.coroutines.launch

class CompanionApplication : Application() {
    lateinit var graph: CompanionGraph
        private set

    override fun attachBaseContext(base: Context) {
        super.attachBaseContext(AppLanguage.wrap(base))
    }

    override fun onCreate() {
        super.onCreate()
        AppLanguage.install(this)
        if (android.os.Build.VERSION.SDK_INT >= 28) {
            android.webkit.WebView.setDataDirectorySuffix("schulnetz")
        }
        android.webkit.CookieManager.getInstance().setAcceptCookie(true)
        graph = CompanionGraph(this)
        installCrashLog()
        graph.notePreviousExit()
        CompanionAlerts.ensureChannels(this)
        CompanionAlerts.retireLegacyPush(this)
        prepareFirebase(this)
        graph.scope.launch {
            graph.recordOpenToday()
            graph.boot()
        }
    }

    private fun installCrashLog() {
        val next = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            runCatching {
                graph.schulnetzLog.crash(
                    BuildConfig.VERSION_NAME,
                    BuildConfig.VERSION_CODE,
                    thread.name,
                    error,
                    graph.trail.snapshot(),
                )
            }
            if (next != null) next.uncaughtException(thread, error)
            else android.os.Process.killProcess(android.os.Process.myPid())
        }
    }
}
