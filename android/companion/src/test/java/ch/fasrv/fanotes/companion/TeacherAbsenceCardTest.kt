package ch.fasrv.fanotes.companion

import android.app.Application
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import ch.fasrv.fanotes.schulnetz.TeacherAbsenceDay
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.time.LocalDate

/** A busy day lists many teachers: the card cuts the list, says how many there are, and shows them all on a tap. Synthetic names. */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [34], application = Application::class, qualifiers = "w411dp-h891dp-xxhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class TeacherAbsenceCardTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    @Before fun language() {
        AppLanguage.install(ApplicationProvider.getApplicationContext<Application>())
        AppLanguage.choose("en")
    }

    private val today = LocalDate.of(2026, 11, 24)

    private fun show(day: TeacherAbsenceDay) = rule.setContent {
        CompanionTheme(themeId = "system", systemDark = false) {
            Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                androidx.compose.foundation.layout.Box(Modifier.width(360.dp)) { TeacherAbsenceCard(day, today) }
            }
        }
    }

    @Test fun aLongListIsCutWithShowAllAndATapShowsEveryName() {
        val absent = (1..28).map { "Lehrperson Beispiel $it" }
        show(TeacherAbsenceDay(today.toString(), absent, listOf("Exkursion Muster A", "Exkursion Muster B")))
        rule.onNodeWithText("Show all 30").assertExists()
        rule.onNodeWithText("Show all 30").performClick()
        rule.waitForIdle()
        rule.onNodeWithText("Show less").assertExists()
        // Every name, including the last excursion entry, is in the expanded text.
        rule.onNodeWithText("Exkursion Muster B", substring = true).assertExists()
        rule.onNodeWithText("Lehrperson Beispiel 28", substring = true).assertExists()
    }

    @Test fun aShortListHasNoShowAll() {
        show(TeacherAbsenceDay(today.toString(), listOf("Muster"), emptyList()))
        rule.onNodeWithText("Muster").assertExists()
        rule.onNodeWithText("Show all 1").assertDoesNotExist()
    }
}
