package ch.fasrv.fanotes.sync

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.parseJson
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** The desktop's merge fixtures (fanotes/scripts/fixtures/writing-sync/cases.json), merged here in both directions. */
class StorySyncTest {
    private val cases = (parseJson(File("../../fanotes/scripts/fixtures/writing-sync/cases.json").readText()) as JsonValue.Arr).items.map { it as JsonValue.Obj }

    private fun merged(path: String, left: JsonValue, right: JsonValue): JsonValue {
        val outcome = mergeStoryFile(path, jsStringify(left).encodeToByteArray(), jsStringify(right).encodeToByteArray(), 0, 0)
        assertTrue(outcome is StoryMergeOutcome.Merged, path)
        return parseJson(outcome.bytes.decodeToString())
    }

    @Test
    fun everyFixtureMergesLikeTheDesktopFromEitherSide() {
        assertTrue(cases.size >= 7)
        for (case in cases) {
            val path = case.string("path")!!
            val expected = jsStringify(case["expected"]!!)
            assertEquals(expected, jsStringify(merged(path, case["left"]!!, case["right"]!!)), case.string("name"))
            assertEquals(expected, jsStringify(merged(path, case["right"]!!, case["left"]!!)), "${case.string("name")} (swapped)")
        }
    }

    @Test
    fun rolesAndBibleConflictsPickTheNewerEntry() {
        assertEquals(StoryRole.SCENE, storyRoleOf("A/Roman.story/scenes/abc123def.json"))
        assertEquals(StoryRole.MANIFEST, storyRoleOf("Roman.story/story.json"))
        assertEquals(StoryRole.ENTITY, storyRoleOf("Roman.story/bible/characters/char000001.json"))
        assertEquals(StoryRole.SNAPSHOT, storyRoleOf("Roman.story/snapshots/abc123def/20261115T100000Z-ab.json"))
        assertEquals(StoryRole.PROGRESS, storyRoleOf("Roman.story/progress/laptop.json"))
        assertEquals(null, storyRoleOf("Notes/Hello.md"))
        val path = "Roman.story/bible/characters/char000001.json"
        fun entry(at: String) = """{"format":"fanotes-story-bible-v1","kind":"character","id":"char000001","name":"Jörg","fields":[],"updatedAt":"$at"}""".encodeToByteArray()
        val newer = mergeStoryFile(path, entry("2026-11-16T10:00:00Z"), entry("2026-11-15T10:00:00Z"), 0, 0)
        assertTrue(newer is StoryMergeOutcome.Pick && newer.keepLocal)
        val older = mergeStoryFile(path, entry("2026-11-14T10:00:00Z"), entry("2026-11-15T10:00:00Z"), 0, 0)
        assertTrue(older is StoryMergeOutcome.Pick && !older.keepLocal)
        assertTrue(mergeStoryFile("Roman.story/scenes/scene000001.json", "{kaputt".encodeToByteArray(), entry("x"), 0, 0) == null, "a damaged local scene is left to a conflict copy")
    }

    @Test
    fun shrinkVerdictTellsACutFromALostParagraph() {
        val path = "Roman.story/scenes/scene000001.json"
        val case = cases.first()
        val full = jsStringify(case["right"]!!).encodeToByteArray()
        val scene = parseJson(jsStringify(case["right"]!!)) as JsonValue.Obj
        val paragraphs = scene.array("paragraphs")!!
        // Tombstones for everything but the first paragraph: a cut.
        for (item in paragraphs.items.drop(1)) (item as JsonValue.Obj).put("runs", JsonValue.Arr()).put("deleted", JsonValue.Bool(true))
        assertEquals(ShrinkVerdict.Cut, judgeStoryShrink(path, jsStringify(scene).encodeToByteArray(), full))
        // Paragraphs gone without a trace: merged back.
        while (paragraphs.items.size > 1) paragraphs.items.removeAt(1)
        val verdict = judgeStoryShrink(path, jsStringify(scene).encodeToByteArray(), full)
        assertTrue(verdict is ShrinkVerdict.Merge)
        assertEquals(4, (parseJson(verdict.bytes.decodeToString()) as JsonValue.Obj).array("paragraphs")!!.items.size)
    }

    @Test
    fun jsStringifyMatchesJavaScript() {
        assertEquals("\"a\u2028b\"", jsStringify(JsonValue.Str("a\u2028b")))
        assertEquals("\"\\ud800\"", jsStringify(JsonValue.Str("\ud800")))
        assertEquals("[1,10.5,\"Süß\"]", jsStringify(parseJson("[1.0, 10.50, \"Süß\"]")))
    }
}
