package ch.fasrv.fanotes.companion

import android.app.Application
import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
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
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The grade trend chart, the grades highlights and the change history rows, on synthetic data (German).
 * Assertions always run; PNGs are written only with KANTI_SHOT_DIR set.
 */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [34], application = Application::class, qualifiers = "w411dp-h891dp-xxhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ParityShotTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()
    private val out = System.getenv("KANTI_SHOT_DIR").orEmpty()

    @Before fun language() {
        AppLanguage.install(ApplicationProvider.getApplicationContext<Application>())
        AppLanguage.choose("de")
    }

    private fun mark(value: Double, weight: Double, date: String, title: String, counted: Boolean = true) =
        WeightedMark(value, weight, title, counted = counted, date = date)

    // Newest first, like the school list. The 1.0 is a hidden guess-the-grade mark and must not show.
    private val marks = listOf(
        mark(1.0, 1.0, "2026-11-10", "Geheim", counted = false),
        mark(5.5, 1.0, "2026-10-20", "Test 4"),
        mark(3.5, 2.0, "2026-09-30", "Prüfung 3"),
        mark(4.5, 1.0, "2026-09-02", "Test 2"),
        mark(5.0, 1.0, "2026-08-25", "Test 1"),
    )
    private val changes = listOf(
        SchulnetzChange("a", "grade", "Neue Note in Mathematik – tippen zum Aufdecken", "Test 4", at = "2026-11-10T08:30:00Z"),
        SchulnetzChange("b", "exam", "Neue Prüfung", "Geschichte · 24.11.2026", at = "2026-11-09T14:05:00Z"),
        SchulnetzChange("c", "timetable", "Stundenänderung", "Französisch fällt aus", at = "2026-11-08T07:12:00Z"),
        SchulnetzChange("d", "absence", "Absenz bestätigt", "Biologie", at = "2026-11-07T10:00:00Z"),
    )

    private fun render(name: String, dark: Boolean) {
        val points = trendPoints(marks)
        val highlights = gradeHighlights(listOf(
            CourseSummary("m", "Mathematik", 3.75, 4.0, 0.0, true, 1.0, emptyList()),
            CourseSummary("g", "Geschichte", 5.25, 5.5, 0.0, true, 1.0, emptyList()),
        ))
        rule.setContent {
            CompanionTheme(themeId = "system", systemDark = dark) {
                Surface(Modifier.fillMaxWidth(), color = MaterialTheme.colorScheme.background) {
                    Column(Modifier.padding(16.dp)) {
                        MetricBlock(t(R.string.below_four), "${highlights.belowFour}")
                        MetricBlock(t(R.string.best_subject), uiMark(highlights.best?.average, 2))
                        GradeTrendChart(points, "Mathematik", 2, Modifier.padding(vertical = 12.dp))
                        Group { changes.forEachIndexed { i, c -> GroupItem(i, changes.size) { ChangeRow(c) } } }
                    }
                }
            }
        }
        rule.waitForIdle()
        // 4 counted marks; the hidden one is not part of the description.
        rule.onNode(hasContentDescription("Verlauf der Noten in Mathematik: 4 Noten, aktueller Schnitt 4,4")).assertExists()
        rule.onNodeWithText("Stundenänderung").assertIsDisplayed()
        if (out.isNotBlank()) {
            val bitmap = rule.onRoot().captureToImage().asAndroidBitmap()
            File(out).mkdirs()
            File(out, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        }
    }

    @Test fun light() = render("parity-light", dark = false)
    @Test fun dark() = render("parity-dark", dark = true)
}
