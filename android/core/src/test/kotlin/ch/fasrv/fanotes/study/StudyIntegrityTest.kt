package ch.fasrv.fanotes.study

import ch.fasrv.fanotes.desk.markdownWithFolds
import ch.fasrv.fanotes.desk.sourceOffsetForVisible
import ch.fasrv.fanotes.famd.NoteSyncKind
import ch.fasrv.fanotes.famd.emptyFamdPayload
import ch.fasrv.fanotes.famd.noteSyncKind
import ch.fasrv.fanotes.famd.serializeFamd
import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.parseJson
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class StudyIntegrityTest {
    private fun sortBlock(title: String) =
        "```fanotes-sort\n{\"v\":1,\"title\":\"$title\",\"mode\":\"groups\",\"cards\":[{\"id\":\"c1\",\"text\":\"A\"}],\"groups\":[{\"id\":\"g1\",\"title\":\"x\",\"cards\":[]}]}\n```"

    @Test
    fun aFoldedSectionDoesNotRedirectAnEditToAHiddenBlock() {
        val note = "# Eins\n\n${sortBlock("versteckt")}\n\n# Zwei\n\n${sortBlock("sichtbar")}\n"
        val folded = setOf(1)
        val visible = markdownWithFolds(note, folded)
        assertTrue(!visible.contains("versteckt"), "the first section is folded away")
        val tapped = findStudyBlocks(visible).single()
        val full = sourceOffsetForVisible(note, folded, tapped.from)
        val hash = studyBodyHash(tapped.body)
        val ref = locateStudyBlock(note, StudyKind.SORT, full, hash)!!
        assertTrue(ref.body.contains("sichtbar"), "the edit lands on the block that was tapped")
        assertEquals(note.lastIndexOf("```fanotes-sort"), ref.from)
    }

    @Test
    fun anEditIsRefusedWhenTheBlockChangedMeanwhile() {
        val note = "Text\n\n${sortBlock("alt")}\n"
        val ref = findStudyBlocks(note).single()
        val hash = studyBodyHash(ref.body)
        val changed = note.replace("\"alt\"", "\"neu\"")
        assertNull(locateStudyBlock(changed, StudyKind.SORT, ref.from, hash))
        val moved = "Neue Zeile oben\n\n$note"
        assertEquals(findStudyBlocks(moved).single().from, locateStudyBlock(moved, StudyKind.SORT, ref.from, hash)!!.from, "a block that only moved is found again")
    }

    @Test
    fun twinBlocksPickTheOneNearestToTheTap() {
        val note = "${sortBlock("gleich")}\n\n${sortBlock("gleich")}\n"
        val second = findStudyBlocks(note)[1]
        assertEquals(second.from, locateStudyBlock(note, StudyKind.SORT, second.from, studyBodyHash(second.body))!!.from)
    }

    @Test
    fun brokenOrOversizedBlocksAreNotEditable() {
        assertNull(sortEditable("{oops"))
        assertNull(termEditable("[1]"))
        val long = "x".repeat(201)
        assertNull(sortEditable("""{"cards":[{"id":"a","text":"$long"}],"groups":[]}"""), "no silent truncation")
        assertNull(sortEditable("""{"cards":[{"id":"a","text":""}],"groups":[]}"""), "no silent dropping of a card")
        assertNull(termEditable("""{"terms":[{"id":"t","term":"a","definition":"${"d".repeat(2001)}"}]}"""))
        assertNotNull(sortEditable("""{"cards":[{"id":"a","text":"ok"}],"groups":[{"id":"g","cards":["a"]}]}"""))
        assertNotNull(sortEditable("{}"))
    }

    @Test
    fun unknownFieldsSurviveAnEdit() {
        val body = """{"v":1,"title":"S","extra":{"keep":true},"mode":"groups","cards":[{"id":"c1","text":"A","color":"red"}],"groups":[{"id":"g1","title":"x","note":"n","cards":[]}]}"""
        val note = "```fanotes-sort\n$body\n```"
        val ref = findStudyBlocks(note).single()
        val data = moveCard(sortEditable(body)!!, "c1", "g1")
        val written = writeStudyBlockMerged(note, ref, sortDataJson(data))
        val json = parseJson(findStudyBlocks(written).single().body) as JsonValue.Obj
        assertNotNull(json.obj("extra"))
        assertEquals("red", ((json.array("cards")!!.items[0]) as JsonValue.Obj).string("color"))
        assertEquals("n", ((json.array("groups")!!.items[0]) as JsonValue.Obj).string("note"))
        assertEquals("c1", ((json.array("groups")!!.items[0] as JsonValue.Obj).array("cards")!!.items[0] as JsonValue.Str).value)
    }

    private val list = StudyTaskList(listOf(StudyTask("auftrag-1", "1", "Lesen", 10, 1, true, 5, false)), emptyList())

    @Test
    fun aBrokenTasksCommentIsKeptAsBrokenAndNeverDuplicated() {
        val note = "Notiz\n<!-- fanotes-tasks-v1\n{\"tasks\": [oops\n-->\n"
        assertNull(readTaskList(note))
        val once = writeTaskList(note, list)
        val twice = writeTaskList(once, list.copy(tasks = list.tasks.map { it.copy(spentSec = 60) }))
        assertEquals(1, Regex("<!-- fanotes-tasks-v1\\s").findAll(twice).count(), "one live comment")
        assertTrue(twice.contains("<!-- fanotes-tasks-v1-broken\n{\"tasks\": [oops"), "the damaged text is preserved")
        assertEquals(60, readTaskList(twice)!!.tasks.single().spentSec)
        assertEquals(1, Regex("fanotes-tasks-v1-broken").findAll(twice).count())
    }

    @Test
    fun theFirstParseableTasksCommentWins() {
        val good = writeTaskList("", list)
        val note = "<!-- fanotes-tasks-v1\n{broken\n-->\n$good"
        assertEquals("auftrag-1", readTaskList(note)!!.tasks.single().id)
        val duplicates = good + good.replace("auftrag-1", "auftrag-9")
        assertEquals("auftrag-1", readTaskList(duplicates)!!.tasks.single().id)
        val rewritten = writeTaskList(duplicates, list)
        assertEquals(1, Regex("<!-- fanotes-tasks-v1\\s").findAll(rewritten).count(), "duplicates collapse to one")
    }

    @Test
    fun removingTheListOnlyTouchesTheBlankLinesAroundIt() {
        val note = "Eins\n\n\n\nZwei\n" + writeTaskList("", list)
        val cleared = writeTaskList(note, StudyTaskList(emptyList(), emptyList()))
        assertTrue(cleared.startsWith("Eins\n\n\n\nZwei"), "the user's own blank lines stay")
        assertTrue(!cleared.contains("fanotes-tasks"))
    }

    @Test
    fun aWordBankAloneIsNotABlankNote() {
        val payload = emptyFamdPayload("2026-11-06T00:00:00Z")
        payload.put("annotations", parseJson("""[{"kind":"terms","id":"terms","list":["Mimikry"]}]"""))
        val bytes = serializeFamd("", payload, "v2").encodeToByteArray()
        assertNotEquals(NoteSyncKind.BLANK, noteSyncKind("Notes/a.famd", bytes))
        val empty = emptyFamdPayload("2026-11-06T00:00:00Z")
        empty.put("annotations", parseJson("""[{"kind":"terms","id":"terms","list":[]}]"""))
        assertEquals(NoteSyncKind.BLANK, noteSyncKind("Notes/b.famd", serializeFamd("", empty, "v2").encodeToByteArray()))
    }

    @Test
    fun anAnnotationWithoutAValidIdKeepsTheSameIdOnEveryLoad() {
        val raw = parseJson("""[{"kind":"stamp","id":"bad id!","page":1,"x":0.2,"y":0.3,"stamp":"event"},{"kind":"stamp","page":2,"x":0.5,"y":0.5,"stamp":"event"}]""")
        val first = parseStudyAnnotations(raw).map { it.id }
        val second = parseStudyAnnotations(raw).map { it.id }
        assertEquals(2, first.size)
        assertEquals(first, second)
        assertEquals(2, first.toSet().size)
    }

    @Test
    fun stableIdsFollowTheDesktopRule() {
        // Computed by the desktop code of #1219 (`stableAnnotationId('stamp', 2, 1, 0.1, 0.2, 'gain')`).
        assertEquals("an-vvszon", stableAnnotationId("stamp", 2, 1, 0.1, 0.2, "gain"))
        val raw = parseJson("""[{"kind":"stamp","id":"x","page":1,"x":0,"y":0,"stamp":"event"},{"kind":"stamp","id":"x2","page":1,"x":0,"y":0,"stamp":"event"},{"kind":"stamp","id":"bad id","page":1,"x":0.1,"y":0.2,"stamp":"gain"}]""")
        assertEquals("an-vvszon", parseStudyAnnotations(raw)[2].id, "the index is the position in the stored array")
    }
}
