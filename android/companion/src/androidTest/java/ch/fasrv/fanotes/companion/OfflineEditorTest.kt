package ch.fasrv.fanotes.companion

import androidx.compose.ui.test.*
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

/** Run on a disposable, signed-out emulator. Exercises the real vault and native drawing view. */
@RunWith(AndroidJUnit4::class)
class OfflineEditorTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @Test fun offlineTextAndInkSurviveModeChangesAndSaveWithUndoRedo() {
        val graph = (compose.activity.application as CompanionApplication).graph
        assertNull("Use a signed-out test device", graph.engine.state.value.account)
        compose.waitForIdle()
        if (compose.onAllNodesWithText("Continue on this device").fetchSemanticsNodes().isNotEmpty()) {
            compose.onNodeWithText("Continue on this device").performClick()
        }
        compose.onNodeWithText("Notes", useUnmergedTree = false).performClick()
        val name = "Editor test ${UUID.randomUUID().toString().take(8)}"
        val path = "$name.md"
        compose.onNodeWithContentDescription("New note").performClick()
        compose.onNodeWithText("Note title").performTextInput(name)
        compose.onNodeWithText("Create", useUnmergedTree = false).performClick()
        compose.waitUntil(10_000) { compose.onAllNodesWithText("Text").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Text").performClick()
        compose.onNode(hasSetTextAction()).performTextInput("\nA real offline draft.\n")
        compose.onNodeWithText("Ink").performClick()
        // The native paper must not paint over the Compose mode controls.
        val pixels = compose.onNodeWithText("Ink").captureToImage().toPixelMap()
        val background = pixels[0, 0]
        assertTrue("Ink mode label was painted over", (0 until pixels.width).any { x ->
            (0 until pixels.height).any { y -> pixels[x, y] != background }
        })
        // This mode transition also regresses the nested-scroll measurement crash.
        compose.onNodeWithContentDescription("Undo stroke").assertIsNotEnabled()
        compose.onRoot().performTouchInput { swipe(center, centerRight, 400) }
        compose.waitUntil(10_000) { runCatching { graph.store.readNote(path).document.strokes.isNotEmpty() }.getOrDefault(false) }
        val written = graph.store.readNote(path)
        assertTrue(written.document.strokes.flatMap { it.points }.all { it.x in 0.0..1.0 && it.y in 0.0..1.0 })
        compose.onNodeWithContentDescription("Undo stroke").performClick()
        compose.waitUntil(10_000) { graph.store.readNote(path).document.strokes.isEmpty() }
        compose.onNodeWithContentDescription("Redo stroke").performClick()
        compose.waitUntil(10_000) { graph.store.readNote(path).document.strokes.isNotEmpty() }
        compose.onNodeWithContentDescription("Save and go back").performClick()
        compose.waitUntil(10_000) { compose.onAllNodesWithContentDescription("New note").fetchSemanticsNodes().isNotEmpty() }
        val saved = graph.store.readNote(path)
        assertTrue(saved.markdown.contains("A real offline draft."))
        assertTrue(saved.document.strokes.isNotEmpty())
    }
}
