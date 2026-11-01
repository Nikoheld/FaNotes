package ch.fasrv.fanotes.companion

import android.Manifest
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

class MainActivity : ComponentActivity() {
    private val notifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) {}
    private val model: CompanionModel by viewModels {
        CompanionModel.factory((application as CompanionApplication).graph)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= 33) notifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        setContent {
            val palette = themePalette(model.theme, isSystemInDarkTheme())
            CompanionTheme(palette) {
                Surface(Modifier.fillMaxSize()) {
                    CompanionRoot(model)
                }
            }
        }
    }
}
