package ch.fasrv.fanotes.companion

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
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
import ch.fasrv.fanotes.desk.themePalette
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val model: CompanionModel by viewModels {
        CompanionModel.factory((application as CompanionApplication).graph)
    }
    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (!granted) return@registerForActivityResult
        val graph = (application as CompanionApplication).graph
        graph.scope.launch { graph.pullChangeDelta() }
    }

    private fun askForNotifications() {
        if (Build.VERSION.SDK_INT < 33) return
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    override fun attachBaseContext(newBase: Context) {
        super.attachBaseContext(AppLanguage.wrap(newBase))
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        askForNotifications()
        enableEdgeToEdge()
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
            val palette = themePalette(model.desk.theme.ifBlank { model.theme }, isSystemInDarkTheme())
            CompanionTheme(palette, accent = model.desk.accent, amoled = model.desk.amoled) {
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
        super.onStop()
    }
}
