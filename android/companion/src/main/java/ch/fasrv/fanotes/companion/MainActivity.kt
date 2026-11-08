package ch.fasrv.fanotes.companion

import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.graphics.luminance
import androidx.core.view.WindowCompat
import androidx.activity.viewModels
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import kotlinx.coroutines.launch

/** True when the user removed animations or set the animator scale to zero. */
fun systemReducesMotion(resolver: android.content.ContentResolver): Boolean {
    val scale = runCatching { android.provider.Settings.Global.getFloat(resolver, android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, 1f) }.getOrDefault(1f)
    return scale == 0f || !android.animation.ValueAnimator.areAnimatorsEnabled()
}

class MainActivity : ComponentActivity() {
    private val model: CompanionModel by viewModels {
        CompanionModel.factory((application as CompanionApplication).graph)
    }
    /** Mirrors the system "remove animations" / animator scale. Read by every transition. */
    private val reducedMotion = mutableStateOf(false)
    private val online = mutableStateOf(true)
    private val motionObserver = object : android.database.ContentObserver(android.os.Handler(android.os.Looper.getMainLooper())) {
        override fun onChange(selfChange: Boolean) { reducedMotion.value = systemReducesMotion(contentResolver) }
    }
    private val networkCallback = object : android.net.ConnectivityManager.NetworkCallback() {
        override fun onCapabilitiesChanged(network: android.net.Network, caps: android.net.NetworkCapabilities) {
            // Validation is not required: some school networks block the connectivity check.
            val now = caps.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET)
            runOnUiThread { online.value = now }
        }
        override fun onLost(network: android.net.Network) { runOnUiThread { online.value = false } }
    }

    override fun attachBaseContext(newBase: Context) {
        super.attachBaseContext(AppLanguage.wrap(newBase))
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Notification permission is asked in context: onboarding, Heute or Mitteilungen settings.
        enableEdgeToEdge()
        reducedMotion.value = systemReducesMotion(contentResolver)
        listOf(android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, android.provider.Settings.Global.TRANSITION_ANIMATION_SCALE).forEach {
            contentResolver.registerContentObserver(android.provider.Settings.Global.getUriFor(it), false, motionObserver)
        }
        getSystemService(android.net.ConnectivityManager::class.java)?.let { manager ->
            online.value = manager.getNetworkCapabilities(manager.activeNetwork)?.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
            runCatching { manager.registerDefaultNetworkCallback(networkCallback) }
        }
        window.isNavigationBarContrastEnforced = false
        model.openNotify(intent)
        setContent {
            var startupNoted by remember { mutableStateOf(false) }
            SideEffect {
                if (!startupNoted) {
                    startupNoted = true
                    val elapsed = android.os.SystemClock.elapsedRealtime() - android.os.Process.getStartElapsedRealtime()
                    ch.fasrv.fanotes.schulnetz.DiagnosticTrace.noteStartup(elapsed)
                }
            }
            val diagnosticOn = model.diagnosticOn
            DisposableEffect(diagnosticOn) {
                if (!diagnosticOn) return@DisposableEffect onDispose { }
                val choreographer = android.view.Choreographer.getInstance()
                var lastFrame = 0L
                var lastRecord = 0L
                val callback = object : android.view.Choreographer.FrameCallback {
                    override fun doFrame(frameTimeNanos: Long) {
                        if (!ch.fasrv.fanotes.schulnetz.DiagnosticTrace.enabled) return
                        if (lastFrame != 0L) {
                            val frameMs = (frameTimeNanos - lastFrame) / 1_000_000L
                            val nowMs = android.os.SystemClock.elapsedRealtime()
                            if (frameMs >= 100L && nowMs - lastRecord >= 2_000L) {
                                ch.fasrv.fanotes.schulnetz.DiagnosticTrace.record("frame", "main", frameMs, "slow")
                                model.noteDiagnosticMemory()
                                lastRecord = nowMs
                                model.bumpDiagnostics()
                            }
                        }
                        lastFrame = frameTimeNanos
                        choreographer.postFrameCallback(this)
                    }
                }
                choreographer.postFrameCallback(callback)
                onDispose { choreographer.removeFrameCallback(callback) }
            }
            CompanionTheme(
                themeId = model.desk.theme.ifBlank { model.theme },
                systemDark = isSystemInDarkTheme(),
                accent = model.desk.accent,
                amoled = model.desk.amoled,
                reducedMotion = reducedMotion.value,
                online = online.value,
            ) {
                val dark = MaterialTheme.colorScheme.background.luminance() < 0.5f
                SideEffect {
                    WindowCompat.getInsetsController(window, window.decorView).apply {
                        isAppearanceLightStatusBars = !dark
                        isAppearanceLightNavigationBars = !dark
                    }
                }
                Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    CompanionRoot(model)
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        model.openNotify(intent)
    }

    override fun onStart() {
        super.onStart()
        model.graph.engine.resumeAutomaticSync()
        if (model.notesAccount) model.graph.docSearch.request()
    }

    override fun onResume() {
        super.onResume()
        val graph = (application as CompanionApplication).graph
        if (System.currentTimeMillis() - graph.lastCheckAt() > 60_000L) {
            graph.scope.launch { runCatching { graph.refreshSchulnetz("resume") } }
        }
    }

    override fun onStop() {
        model.graph.engine.pauseAutomaticSync()
        // Long OCR continues in WorkManager, within Android's background limits.
        model.graph.docSearch.handOff()
        super.onStop()
    }

    override fun onDestroy() {
        contentResolver.unregisterContentObserver(motionObserver)
        runCatching { getSystemService(android.net.ConnectivityManager::class.java)?.unregisterNetworkCallback(networkCallback) }
        super.onDestroy()
    }
}
