package ch.fasrv.fanotes.companion

import android.content.Context
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Run on a disposable, signed-out emulator with synthetic data only. It resets the
 * first-run flags of the installed debug app, then walks onboarding, restarts and replays it.
 */
@RunWith(AndroidJUnit4::class)
class OnboardingPersistenceTest {
    @get:Rule val compose = createEmptyComposeRule()

    private val prefs get() = ApplicationProvider.getApplicationContext<Context>().getSharedPreferences("fanotes-companion", Context.MODE_PRIVATE)

    @Test fun firstRunIsSkippableRemembersCompletionAndCanBeReplayed() {
        val graph = (ApplicationProvider.getApplicationContext<Context>() as CompanionApplication).graph
        if (graph.engine.state.value.account != null) return // Only meaningful on a signed-out test device.
        prefs.edit().remove(ONBOARDING_PREF).remove("local-access").commit()

        ActivityScenario.launch(MainActivity::class.java).use {
            compose.waitUntil(10_000) { compose.onAllNodesWithText(t(R.string.onboarding_day_title)).fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithText(t(R.string.onboarding_next)).performClick()
            compose.waitUntil(5_000) { compose.onAllNodesWithText(t(R.string.onboarding_school_title)).fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithText(t(R.string.onboarding_skip)).performClick()
            compose.waitUntil(10_000) { compose.onAllNodesWithContentDescription(t(R.string.settings)).fetchSemanticsNodes().isNotEmpty() }
        }
        assertEquals(ONBOARDING_VERSION, prefs.getInt(ONBOARDING_PREF, 0))
        assertTrue("skipping keeps the app usable without an account", prefs.getBoolean("local-access", false))

        ActivityScenario.launch(MainActivity::class.java).use {
            compose.waitUntil(10_000) { compose.onAllNodesWithContentDescription(t(R.string.settings)).fetchSemanticsNodes().isNotEmpty() }
            assertTrue("a restart must not show onboarding again", compose.onAllNodesWithText(t(R.string.onboarding_day_title)).fetchSemanticsNodes().isEmpty())
            compose.onNodeWithContentDescription(t(R.string.settings)).performClick()
            compose.onNodeWithText(t(R.string.replay_onboarding)).performScrollTo().performClick()
            compose.waitUntil(5_000) { compose.onAllNodesWithText(t(R.string.onboarding_day_title)).fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithText(t(R.string.close)).performClick()
            compose.waitUntil(5_000) { compose.onAllNodesWithText(t(R.string.replay_onboarding)).fetchSemanticsNodes().isNotEmpty() }
        }
        assertTrue(prefs.getBoolean("local-access", false))
    }
}
