package ch.fasrv.fanotes.companion

import android.app.Application
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/**
 * Back must be consumed only while something handles it, so the root screen leaves back to the system
 * (back-to-home preview). The harness uses the same enabled-conditions as the app's handlers.
 */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [34], application = Application::class)
class PredictiveBackTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    private var route by mutableStateOf(CompanionRoute(Destination.Today))
    private var history by mutableStateOf(emptyList<CompanionRoute>())
    private var sheet by mutableStateOf(false)
    private var query by mutableStateOf("")

    private fun enabled() = rule.activity.onBackPressedDispatcher.hasEnabledCallbacks()
    private fun back() = rule.runOnUiThread { rule.activity.onBackPressedDispatcher.onBackPressed() }

    private fun root() = rule.setContent {
        val atRoot = isAtNavRoot(route, false, "today", listOf("today", "planner", "school", "notes"), "", history.isNotEmpty())
        BackHandler(!atRoot) { route = history.last(); history = history.dropLast(1) }
        BackHandler(query.isNotEmpty()) { query = "" }
        BackHandler(sheet) { sheet = false }
    }

    @Test fun `root screen leaves back to the system`() {
        root()
        rule.waitForIdle()
        assertFalse(enabled())
    }

    @Test fun `back from a nested page returns to its parent then frees the root`() {
        root()
        rule.runOnUiThread { history = listOf(route); route = CompanionRoute(Destination.School, Page.Grades) }
        rule.waitForIdle()
        assertTrue(enabled())
        back()
        rule.waitForIdle()
        assertEquals(Destination.Today, route.destination)
        assertFalse(enabled())
    }

    @Test fun `an open sheet or a search closes before the page pops`() {
        root()
        rule.runOnUiThread { history = listOf(route); route = CompanionRoute(Destination.School, Page.Grades); sheet = true; query = "abc" }
        rule.waitForIdle()
        back(); rule.waitForIdle()
        assertFalse(sheet); assertEquals("abc", query); assertEquals(Page.Grades, route.page)
        rule.runOnUiThread { sheet = true }; rule.waitForIdle()
        back(); rule.waitForIdle()
        assertFalse(sheet)
        back(); rule.waitForIdle()
        assertEquals("", query); assertEquals(Page.Grades, route.page)
        back(); rule.waitForIdle()
        assertEquals(Destination.Today, route.destination)
        assertFalse(enabled())
    }

    @Test fun `back on the other-timetables list closes the overlay and never reaches the root`() {
        var overlay by mutableStateOf(true)
        var detail by mutableStateOf(false)
        var rootReached = false
        rule.setContent {
            // Planner is a nav root, so the root handler is disabled here. Same shape as OtherTimetablesScreen.
            BackHandler(false) { rootReached = true }
            if (overlay) BackHandler { if (detail) detail = false else overlay = false }
        }
        rule.waitForIdle()
        assertTrue(enabled())
        rule.runOnUiThread { detail = true }; rule.waitForIdle()
        back(); rule.waitForIdle()
        assertTrue(overlay); assertFalse(detail)
        back(); rule.waitForIdle()
        assertFalse(overlay); assertFalse(rootReached); assertFalse(enabled())
    }
}
