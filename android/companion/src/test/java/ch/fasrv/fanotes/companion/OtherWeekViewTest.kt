package ch.fasrv.fanotes.companion

import android.app.Application
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import ch.fasrv.fanotes.schulnetz.TimetableCell
import androidx.test.core.app.ApplicationProvider
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** The week of another class or a room is drawn by the same rail rows as the own timetable (synthetic data). */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [34], application = Application::class, qualifiers = "w411dp-h891dp-xxhdpi")
class OtherWeekViewTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    @Before fun english() {
        AppLanguage.install(ApplicationProvider.getApplicationContext<Application>())
    }

    private val cells = listOf(
        TimetableCell(1, "07:45", "08:30", "Mathematik", "TstAa", "T01"),
        TimetableCell(1, "10:30", "11:15", "Deutsch", "TstBb", "T02"),
    )

    @Test fun aClassWeekShowsSubjectTeacherAndRoomCells() {
        rule.setContent { CompanionTheme(null, false) { OtherWeekView(cells, emptyMap(), emptyMap(), compact = false, placeIsClass = false) } }
        rule.onNodeWithText("Mathematik").assertIsDisplayed()
        rule.onNodeWithText("Room T01  ·  TstAa").assertIsDisplayed()
        rule.onNodeWithText("Deutsch").assertIsDisplayed()
        rule.onNodeWithText("07:45").assertIsDisplayed()
        rule.onNodeWithText("08:30").assertIsDisplayed()
        // 08:30 to 10:30 is a free period between the lessons, as in the own timetable.
        rule.onNodeWithText("Free · 120 min").assertIsDisplayed()
    }

    @Test fun aRoomWeekShowsTheClassInThePlace() {
        val room = listOf(TimetableCell(1, "07:45", "08:30", "Physik", "TstAa", "G26A, G26B"))
        rule.setContent { CompanionTheme(null, false) { OtherWeekView(room, emptyMap(), emptyMap(), compact = false, placeIsClass = true) } }
        rule.onNodeWithText("G26A, G26B  ·  TstAa").assertIsDisplayed()
    }
}
