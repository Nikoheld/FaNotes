package ch.fasrv.fanotes.companion

import android.app.Application
import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import ch.fasrv.fanotes.schulnetz.*
import java.time.LocalDate
import java.time.LocalDateTime

/**
 * Renders the Mensa week page to PNG for a design review (German, light and dark, phone size, synthetic menus).
 * Runs only with KANTI_SHOT_DIR set; CI never sets it.
 */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [34], application = Application::class, qualifiers = "w411dp-h891dp-xxhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class MensaWeekShotTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()
    private val out = System.getenv("KANTI_SHOT_DIR").orEmpty()

    @Before fun language() {
        assumeTrue(out.isNotBlank())
        AppLanguage.install(ApplicationProvider.getApplicationContext<Application>())
        AppLanguage.choose("de")
    }

    private fun menu(name: String, description: String, label: String, price: Double) = MensaMenu(name, description, label, price + 3, price)

    /** Wednesday 2026-11-18 is today; next week has a closed Friday. */
    private fun feed(): MensaFeed {
        val dishes = listOf(
            menu("Testgeschnetzeltes", "Mit Rahmsauce, Teigwaren und Saisongemüse", "Daily", 10.5),
            menu("Gemüsecurry", "Basmatireis, Kokosmilch", "Vegi", 9.5),
            menu("Salatteller", "", "Salat", 8.5),
        )
        val days = listOf("2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26")
            .map { MensaDay(LocalDate.parse(it), false, "", dishes) } + MensaDay(LocalDate.parse("2026-11-27"), true, "Testferien", emptyList())
        return MensaFeed("2026-11-18T06:30:00Z", true, days)
    }

    private fun shot(name: String, dark: Boolean) {
        rule.setContent {
            CompanionTheme(themeId = "system", systemDark = dark) {
                Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    MensaWeekContent(feed(), LocalDateTime.parse("2026-11-18T09:00:00"), online = true, refreshing = false, onRefresh = {})
                }
            }
        }
        rule.waitForIdle()
        val bitmap = rule.onRoot().captureToImage().asAndroidBitmap()
        File(out).mkdirs()
        File(out, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Test fun light() = shot("android-mensa-week-light", dark = false)
    @Test fun dark() = shot("android-mensa-week-dark", dark = true)
}
