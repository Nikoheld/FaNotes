package ch.fasrv.fanotes.study

import ch.fasrv.fanotes.desk.applyReview
import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.parseJson
import java.util.Random
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class StudyEditOpsTest {
    private val random = Random(7)

    @Test
    fun keyTableEditsKeepRowsAndColumnsAligned() {
        var data = defaultKeyData()
        data = keyAddFeature(data, "Blatt")
        assertEquals(3, data.table.features.size)
        assertTrue(data.table.items.all { it.values.size == 3 })
        data = keyAddItem(data, "Art C", random)
        val c = data.table.items.last()
        assertEquals(listOf("", "", ""), c.values)
        data = keySetValue(data, c.id, 2, "gelb")
        data = keyRenameFeature(data, 0, "Farbe")
        data = keyRemoveFeature(data, 1)
        assertEquals(listOf("Farbe", "Blatt"), data.table.features)
        assertEquals(listOf("", "gelb"), data.table.items.last().values)
        data = keyRemoveItem(data, "i1")
        assertEquals(listOf("Art B", "Art C"), data.table.items.map { it.name })
        assertEquals(data, keyEditable(prettyJson(keyDataJson(data))))
    }

    @Test
    fun keyTreeEditsKeepEveryNodeReachable() {
        var tree = emptyKeyTree()
        tree = keyAddBranch(tree, "n1", "vielleicht", "Art C", random)
        assertEquals(4, tree.nodes.size)
        val added = tree.nodes.last()
        assertEquals("Art C", added.text)
        assertEquals(listOf("n1" to 2), keyParentOf(tree, added.id)?.let { listOf(it.first.id to it.second) })
        // a leaf cannot get children; turning a question into a leaf drops its sub-tree
        assertEquals(tree, keyAddBranch(tree, "n2", "x", "y", random))
        tree = keySetNodeLeaf(tree, added.id, false)
        val deeper = keyAddBranch(tree, added.id, "a", "tief", random)
        assertEquals(5, deeper.nodes.size)
        assertEquals(4, keySetNodeLeaf(deeper, added.id, true).nodes.size)
        assertEquals(3, keyRemoveNode(deeper, added.id).nodes.size)
        assertEquals(deeper, keyRemoveNode(deeper, deeper.root), "the root stays")
        assertEquals("nein!", keySetBranchLabel(deeper, "n1", 1, "nein!").nodes.first().branches[1].label)
        assertEquals("Neue Frage?", keySetNodeText(deeper, "n1", "Neue Frage?").nodes.first().text)
    }

    @Test
    fun mapEditsDropArrowsOfDeletedBoxes() {
        var data = defaultMapData()
        data = mapAddNode(data, "Folge", random)
        val third = data.nodes.last().id
        data = mapAddEdge(data, "b", third, "führt zu", random)
        assertEquals(2, data.edges.size)
        assertEquals(data, mapAddEdge(data, "b", third, "führt zu", random), "no repeated arrow")
        assertEquals(data, mapAddEdge(data, "a", "a", "", random), "no self loop")
        assertEquals(data, mapAddEdge(data, "a", "missing", "", random))
        val renamed = mapSetEdgeLabel(data, data.edges.last().id, "bewirkt")
        assertEquals("bewirkt", renamed.edges.last().label)
        val moved = mapSetEdgeEnds(data, data.edges.last().id, "a", third)
        assertEquals(listOf("a" to third), moved.edges.takeLast(1).map { it.from to it.to })
        assertEquals(data, mapSetEdgeEnds(data, data.edges.last().id, third, third))
        val removed = mapRemoveNode(data, "b")
        assertEquals(listOf("a", third), removed.nodes.map { it.id })
        assertTrue(removed.edges.isEmpty())
        assertEquals(removed, mapEditable(prettyJson(mapDataJson(removed))))
        assertEquals(true, mapSetDirection(data, true).leftToRight)
    }

    @Test
    fun plateEditsAndCaps() {
        var data = defaultPlateData()
        data = plateAddItem(data, ".fanotes/worksheets/abcdef12-0000.jpg", "Eiche", random)
        val id = data.items.single().id
        data = plateSetItem(data, id) { it.copy(note = "Quercus") }
        assertEquals("Quercus", data.items.single().note)
        assertEquals(8, plateSetCols(data, 99).cols)
        assertEquals(1, plateSetCols(data, 0).cols)
        repeat(60) { data = plateAddItem(data, "", "x", random) }
        assertEquals(PLATE_MAX_ITEMS, data.items.size)
        assertEquals(data, plateEditable(prettyJson(plateDataJson(data))))
        assertEquals(PLATE_MAX_ITEMS - 1, plateRemoveItem(data, id).items.size)
    }

    @Test
    fun uneditableBlocksAreRefusedNotRewritten() {
        assertNull(keyEditable("{nope"))
        assertNull(mapEditable("""{"title":"${"t".repeat(300)}"}"""))
        assertNotNull(mapEditable(""))
        assertNotNull(plateEditable("{}"))
        // an unreachable node would be dropped by the normaliser
        val orphan = """{"v":1,"title":"k","table":{"features":[],"items":[]},"tree":{"root":"a","nodes":[{"id":"a","kind":"leaf","text":"x","branches":[]},{"id":"b","kind":"leaf","text":"y","branches":[]}]}}"""
        assertNull(keyEditable(orphan))
    }

    @Test
    fun everyKindHasAStarterBlockThatReadsBack() {
        for (kind in StudyKind.entries) {
            val text = insertStudyBlock("Notiz", kind, starterBlockJson(kind))
            val ref = findStudyBlocks(text).single()
            assertEquals(kind, ref.kind)
            assertTrue(studyBlockReadable(ref))
            assertNotNull(buildStudyScene(kind, ref.body, 360.0), kind.id)
        }
    }

    @Test
    fun keyEditsWriteBackWithUnknownFieldsKept() {
        val body = """{"v":1,"title":"k","table":{"features":["a"],"items":[{"id":"i1","name":"A","values":["x"],"extra":1}]},"tree":{"root":"n1","nodes":[{"id":"n1","kind":"leaf","text":"A","branches":[]}]},"compareImage":"","compareLabel":"","mine":true}"""
        val markdown = "```fanotes-key\n$body\n```"
        val ref = findStudyBlocks(markdown).single()
        val data = keyEditable(body)
        assertNotNull(data)
        val written = writeStudyBlockMerged(markdown, ref, keyDataJson(keySetValue(data, "i1", 0, "y")))
        val reread = parseJson(findStudyBlocks(written).single().body) as JsonValue.Obj
        assertEquals(JsonValue.Bool(true), reread["mine"])
        val item = ((reread.obj("table")!!.array("items")!!.items[0]) as JsonValue.Obj)
        assertEquals("y", ((item.array("values")!!.items[0]) as JsonValue.Str).value)
        assertEquals(1.0, item.double("extra"))
    }

    // -- deck-wide flashcards -----------------------------------------------------------

    private val noteA = "# A\n\n## Lernfragen\n\n<details>\n<summary>Was ist 1+1?</summary>\n\n2\n\n</details>\n"
    private val noteB = "# B\n\n```fanotes-term\n{\"v\":1,\"terms\":[{\"id\":\"t1\",\"term\":\"Zelle\",\"definition\":\"Baustein\",\"example\":\"\",\"source\":\"\"}]}\n```\n"

    @Test
    fun deckCollectsCardsOfAllNotesDueFirst() {
        val today = "2026-11-18"
        val cards = deckCardsOf(listOf("Mathe/a.md" to noteA, "Bio/b.md" to noteB, "Eingang/c.md" to "# nichts\n"), today)
        assertEquals(setOf("Mathe/a.md", "Bio/b.md"), cards.map { it.path }.toSet())
        assertEquals(DeckSummary(due = cards.size, total = cards.size, notes = 2), deckSummary(cards, today))
        val later = cards.map { if (it.path == "Bio/b.md") it.copy(card = it.card.copy(due = "2026-12-01")) else it.copy(card = it.card.copy(due = "2026-11-01")) }
        val due = deckDue(later, today)
        assertTrue(due.all { it.path == "Mathe/a.md" })
        assertEquals("a", deckNoteTitle("Mathe/a.md"))
        assertTrue(noteMayHaveCards(noteA) && !noteMayHaveCards("# nichts"))
    }

    @Test
    fun reviewingOneNoteLeavesTheOthersAlone() {
        val today = "2026-11-18"
        val card = deckCardsOf(listOf("a.md" to noteA), today).single().card
        val next = applyReview(noteA, card.id, "good", today)
        val after = deckCardsOf(listOf("a.md" to next, "b.md" to noteB), today)
        assertTrue(after.first { it.path == "a.md" }.card.due > today)
        assertEquals(today, after.first { it.path == "b.md" }.card.due)
        assertEquals(2, after.map { it.key }.toSet().size)
    }
}
