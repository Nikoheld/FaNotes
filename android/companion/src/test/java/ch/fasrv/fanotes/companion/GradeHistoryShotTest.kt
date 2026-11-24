package ch.fasrv.fanotes.companion

import android.app.Application
import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import ch.fasrv.fanotes.schulnetz.*
import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The grade history on a course page (history icon, version list, removed grades), on synthetic data in
 * German. Assertions always run; PNGs are written only with KANTI_SHOT_DIR set.
 */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [34], application = Application::class, qualifiers = "w411dp-h891dp-xxhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class GradeHistoryShotTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()
    private val out = System.getenv("KANTI_SHOT_DIR").orEmpty()

    @Before fun language() {
        AppLanguage.install(ApplicationProvider.getApplicationContext<Application>())
        AppLanguage.choose("de")
    }

    private fun version(mark: Double, seenAt: String, title: String = "Prüfung Geometrie", weight: Double = 1.0) =
        GradeVersion(mark, weight, title, "2026-10-12", seenAt)

    private val corrected = GradeTrack(
        "g1", "m2", "M-K26A", "Mathematik", "Prüfung Geometrie", "2026-10-12", "2026-10-14T08:00:00Z",
        listOf(version(4.0, "2026-10-14T08:00:00Z"), version(4.5, "2026-10-21T16:30:00Z")),
    )
    private val removed = GradeTrack(
        "g2", "m3", "M-K26A", "Mathematik", "Test Funktionen", "2026-09-30", "2026-10-01T09:00:00Z",
        listOf(version(3.0, "2026-10-01T09:00:00Z", "Test Funktionen")), removedAt = "2026-11-02T07:00:00Z",
    )
    private val removedHidden = removed.copy(id = "g3", gradeId = "m4", title = "Geheime Prüfung", versions = listOf(version(2.5, "2026-10-01T09:00:00Z", "Geheime Prüfung")))

    private fun render(name: String, dark: Boolean) {
        val mark = WeightedMark(4.5, 1.0, "Prüfung Geometrie", targetId = corrected.targetId(), date = "2026-10-12")
        rule.setContent {
            CompanionTheme(themeId = "system", systemDark = dark) {
                Surface(Modifier.fillMaxWidth(), color = MaterialTheme.colorScheme.background) {
                    Column(Modifier.padding(16.dp)) {
                        Group { SchoolMarkRow(mark, 2, hidden = false, highlighted = false, longPressReveal = false, onReveal = {}, onAdjust = {}, onRestore = {}, onHistory = {}) }
                        Text("Versionsverlauf", Modifier.padding(top = 16.dp, bottom = 8.dp), style = MaterialTheme.typography.titleMedium)
                        GradeVersionList(corrected, 2, hidden = false)
                        Text("Verdeckte Note", Modifier.padding(top = 16.dp, bottom = 8.dp), style = MaterialTheme.typography.titleMedium)
                        GradeVersionList(corrected, 2, hidden = true)
                        Column(Modifier.padding(top = 16.dp)) { RemovedGradesBlock(listOf(removed, removedHidden), 2, hiddenIds = removedHidden.targetIds(), onOpen = {}, startOpen = true) }
                    }
                }
            }
        }
        rule.waitForIdle()
        rule.onNode(hasContentDescription("Versionsverlauf von Prüfung Geometrie")).assertExists()
        rule.onNodeWithText("Entfernte Noten").assertIsDisplayed()
        rule.onNodeWithText("Test Funktionen").assertIsDisplayed()
        rule.onNodeWithText("Geheime Prüfung").assertIsDisplayed()
        // Both marks of the changed grade show when it is revealed; the hidden removed one shows a "?".
        assertTrue(rule.onAllNodes(androidx.compose.ui.test.hasText(uiMark(4.0, 2))).fetchSemanticsNodes().isNotEmpty())
        assertTrue(rule.onAllNodes(androidx.compose.ui.test.hasText(uiMark(2.5, 2))).fetchSemanticsNodes().isEmpty())
        assertTrue(rule.onAllNodes(androidx.compose.ui.test.hasText(uiMark(3.0, 2))).fetchSemanticsNodes().isNotEmpty())
        if (out.isNotBlank()) {
            val bitmap = rule.onRoot().captureToImage().asAndroidBitmap()
            File(out).mkdirs()
            File(out, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        }
    }

    @Test fun light() = render("grade-history-light", dark = false)
    @Test fun dark() = render("grade-history-dark", dark = true)
}
