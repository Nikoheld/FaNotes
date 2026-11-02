package ch.fasrv.fanotes.companion

import android.Manifest
import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import ch.fasrv.fanotes.desk.themePalette
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val notifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) {}
    private val model: CompanionModel by viewModels {
        CompanionModel.factory((application as CompanionApplication).graph)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= 33) notifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        model.openNotify(intent)
        setContent {
            val palette = themePalette(model.desk.theme.ifBlank { model.theme }, isSystemInDarkTheme())
            CompanionTheme(palette, accent = model.desk.accent, amoled = model.desk.amoled) {
                Surface(Modifier.fillMaxSize()) {
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
