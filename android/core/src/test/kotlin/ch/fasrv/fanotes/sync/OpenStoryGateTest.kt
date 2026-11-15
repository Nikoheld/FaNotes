package ch.fasrv.fanotes.sync

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class OpenStoryGateTest {
    private val scene = "Bücher/Roman.story/scenes/abc123def.json"
    private val manifest = "Bücher/Roman.story/story.json"

    @Test
    fun everythingWaitsUntilTheEditorHasReported() {
        val gate = OpenStoryGate("Bücher/Roman.story")
        assertTrue(gate.isBusy(scene))
        assertTrue(gate.isBusy(manifest))
        gate.report(false)
        assertFalse(gate.isBusy(scene))
        gate.reset()
        assertTrue(gate.isBusy(scene), "a reloaded page has not reported")
    }

    @Test
    fun scenesAndManifestFollowTheEditorAndEverythingElseWaitsUntilClose() {
        val gate = OpenStoryGate("Bücher/Roman.story")
        gate.report(false)
        assertFalse(gate.isBusy(scene))
        assertFalse(gate.isBusy(manifest))
        for (other in listOf("bible/characters/char000001.json", "progress/laptop.json", "snapshots/abc123def/x.json", "scenes/../story.json", "scenes/abc123def.json.bak", "scenes/ab.json", "scenes/sub/abc123def.json", "notes.md")) {
            assertTrue(gate.isBusy("Bücher/Roman.story/$other"), other)
        }
        gate.report(true)
        assertTrue(gate.isBusy(scene), "unsaved or saving text")
        assertTrue(gate.isBusy(manifest))
        gate.report(false)
        assertFalse(gate.isBusy(scene))
    }

    @Test
    fun filesOutsideTheStoryAreNotHeld() {
        val gate = OpenStoryGate("Bücher/Roman.story")
        assertFalse(gate.isBusy("Bücher/Notiz.md"))
        assertFalse(gate.isBusy("Bücher/Roman.story2/scenes/abc123def.json"))
        assertFalse(gate.isBusy("Bücher/Roman.story"))
    }

    @Test
    fun onlyLiveFilesOfTheOpenStoryAreReportedToTheEditor() {
        val gate = OpenStoryGate("Bücher/Roman.story")
        val written = listOf(scene, manifest, scene, "Bücher/Roman.story/progress/x.json", "Bücher/Other.story/scenes/abc123def.json", "Bücher/Notiz.md")
        assertEquals(listOf("scenes/abc123def.json", "story.json"), gate.liveFiles(written))
        assertEquals(emptyList(), gate.liveFiles(listOf("Bücher/Notiz.md")))
    }

    @Test
    fun aNewGateKnowsNothingUntilTheEditorReportsAgain() {
        val first = OpenStoryGate("Bücher/Roman.story")
        first.report(false)
        val second = OpenStoryGate("Bücher/Zweit.story")
        assertTrue(second.isBusy("Bücher/Zweit.story/scenes/abc123def.json"), "busy until the resent report arrives")
        second.report(false)
        assertFalse(second.isBusy("Bücher/Zweit.story/scenes/abc123def.json"))
        assertFalse(first.isBusy("Bücher/Roman.story/scenes/abc123def.json"), "the old gate keeps its own state")
    }
}
