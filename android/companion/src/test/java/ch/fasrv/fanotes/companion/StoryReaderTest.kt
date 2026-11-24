package ch.fasrv.fanotes.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class StoryReaderTest {
    private val manifest = """
        {"format":"fanotes-story-v1","id":"story00001","title":"Testgeschichte","subtitle":"Ein Anfang","author":"Test","binder":[
          {"id":"part000001","kind":"part","title":"Teil Eins","children":[
            {"id":"chap000001","kind":"chapter","title":"Kapitel A","children":[
              {"id":"scene00001","kind":"scene","title":"Morgen"},
              {"id":"scene00002","kind":"scene","title":"Verworfen","exclude":true},
              {"id":"scene00003","kind":"scene","title":""}
            ]}
          ]},
          {"id":"chap000002","kind":"chapter","title":"Kapitel B","children":[
            {"id":"scene00004","kind":"scene","title":"Abend"}
          ]},
          {"id":"trashbin","kind":"folder","title":"Papierkorb","exclude":true,"children":[
            {"id":"scene00005","kind":"scene","title":"Im Papierkorb"}
          ]}
        ]}
    """.trimIndent()

    private fun scene(id: String, vararg paragraphs: String) =
        """{"format":"fanotes-story-scene-v1","id":"$id","paragraphs":[${paragraphs.joinToString(",")}]}"""

    private fun paragraph(id: String, key: String, text: String, style: String = "body", deleted: Boolean = false) =
        """{"id":"$id","key":"$key","v":{},"style":"$style","runs":[{"text":"${text.substringBefore('|')}"},{"text":"${text.substringAfter('|', "")}","m":{"b":true}}]${if (deleted) ",\"deleted\":true" else ""}}"""

    private val files = mapOf(
        "story.json" to manifest,
        // Stored out of order on purpose: the order key decides.
        "scenes/scene00001.json" to scene("scene00001",
            paragraph("p000002", "a1", "Zweiter Absatz."), paragraph("p000001", "a0", "Erster Absatz|, fett."),
            paragraph("p000003", "a2", "Weg", deleted = true), paragraph("p000004", "a3", "Ein Zitat", "quote")),
        "scenes/scene00002.json" to scene("scene00002", paragraph("p000010", "a0", "Ausgeschlossen")),
        "scenes/scene00003.json" to scene("scene00003", paragraph("p000020", "a0", "Szene ohne Titel")),
        "scenes/scene00004.json" to scene("scene00004", paragraph("p000030", "a0", "Am Abend.")),
        "scenes/scene00005.json" to scene("scene00005", paragraph("p000040", "a0", "Papierkorbtext")),
    )

    @Test
    fun readsInManuscriptOrderAndSkipsExcludedNodesAndDeletedParagraphs() {
        val story = readStoryText { files[it] }!!
        assertEquals("Testgeschichte", story.title)
        assertEquals("Ein Anfang", story.subtitle)
        val shown = story.blocks.map { it.kind to it.text }
        assertEquals(listOf(
            StoryBlockKind.PART to "Teil Eins",
            StoryBlockKind.CHAPTER to "Kapitel A",
            StoryBlockKind.SCENE to "Morgen",
            StoryBlockKind.PARAGRAPH to "Erster Absatz, fett.",
            StoryBlockKind.PARAGRAPH to "Zweiter Absatz.",
            StoryBlockKind.PARAGRAPH to "Ein Zitat",
            StoryBlockKind.PARAGRAPH to "Szene ohne Titel",
            StoryBlockKind.CHAPTER to "Kapitel B",
            StoryBlockKind.SCENE to "Abend",
            StoryBlockKind.PARAGRAPH to "Am Abend.",
        ), shown)
        assertEquals("quote", story.blocks.first { it.text == "Ein Zitat" }.style)
        assertTrue(story.blocks.none { it.text.contains("Papierkorb") || it.text.contains("Ausgeschlossen") })
    }

    @Test
    fun aMissingSceneFileGivesJustItsHeading() {
        val story = readStoryText { if (it.startsWith("scenes/")) null else files[it] }!!
        assertTrue(story.blocks.any { it.kind == StoryBlockKind.SCENE && it.text == "Morgen" })
        assertTrue(story.blocks.none { it.kind == StoryBlockKind.PARAGRAPH })
    }

    @Test
    fun noManifestOrAForeignFormatIsNoStory() {
        assertNull(readStoryText { null })
        assertNull(readStoryText { if (it == "story.json") "{\"format\":\"other\"}" else null })
        assertNull(readStoryText { if (it == "story.json") "not json" else null })
    }
}
