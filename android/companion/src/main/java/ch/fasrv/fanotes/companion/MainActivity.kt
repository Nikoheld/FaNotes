package ch.fasrv.fanotes.companion

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.SideEffect
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

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        window.isNavigationBarContrastEnforced = false
        model.openNotify(intent)
        setContent {
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

    override fun onResume() {
        super.onResume()
        val graph = (application as CompanionApplication).graph
        if (System.currentTimeMillis() - graph.lastCheckAt() > 60_000L) {
            graph.scope.launch { runCatching { graph.refreshSchulnetz("resume") } }
        }
    }
}
