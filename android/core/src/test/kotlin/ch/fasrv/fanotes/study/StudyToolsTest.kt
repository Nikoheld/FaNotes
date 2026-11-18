package ch.fasrv.fanotes.study

import ch.fasrv.fanotes.desk.LiveKind
import ch.fasrv.fanotes.desk.PdfTextMark
import ch.fasrv.fanotes.desk.applyReview
import ch.fasrv.fanotes.desk.cardsFromMarkdown
import ch.fasrv.fanotes.desk.livePreviewMarks
import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.parseJson
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Compares the Kotlin port with results the desktop code produced (`vectors.json`, see generate-android-study-fixtures.mjs). */
class StudyToolsTest {
    private val vectors: JsonValue.Obj = parseJson(javaClass.getResource("/study/vectors.json")!!.readText()) as JsonValue.Obj

    private fun obj(value: JsonValue?) = value as JsonValue.Obj
    private fun arr(value: JsonValue?) = (value as JsonValue.Arr).items
    private fun str(value: JsonValue?) = (value as JsonValue.Str).value
    private fun dbl(value: JsonValue?) = (value as JsonValue.Num).value
    private fun int(value: JsonValue?) = dbl(value).toInt()

    private fun taskOf(value: JsonValue?): StudyTask {
        val t = obj(value)
        return StudyTask(str(t["id"]), str(t["number"]), str(t["title"]), int(t["minutes"]), int(t["page"]), t.bool("done") == true, int(t["spentSec"]), t.bool("manual") == true)
    }

    private fun pagesOf(value: JsonValue?) = arr(value).map { PageLines(int(obj(it)["page"]), arr(obj(it)["lines"]).map(::str)) }

    // -- tasks ----------------------------------------------------------------------

    @Test
    fun detectionMatchesTheDesktopVectors() {
        val detect = obj(vectors["detect"])
        val expected = arr(detect["tasks"]).map(::taskOf)
        val actual = detectTasks(pagesOf(detect["pages"]))
        assertEquals(expected.size, actual.size)
        assertEquals(expected, actual)
        assertTrue(actual.any { it.id == "auftrag-1" && it.minutes == 45 })
        assertTrue(actual.none { it.title.startsWith("Hormone") }, "prose is not a heading")
    }

    @Test
    fun timeHintsHyphensAndClocksMatchTheDesktop() {
        for (entry in arr(vectors["timeHints"])) {
            val (text, minutes) = arr(entry)
            assertEquals(int(minutes), parseTimeHint(str(text)), "hint ${str(text)}")
        }
        for (entry in arr(vectors["dehyphenate"])) {
            val (input, output) = arr(entry)
            assertEquals(arr(output).map(::str), dehyphenate(arr(input).map(::str)))
        }
        for (entry in arr(vectors["clocks"])) {
            val (seconds, label) = arr(entry)
            assertEquals(str(label), formatClock(int(seconds)))
        }
    }

    @Test
    fun storedListReadsAndWritesTheDesktopText() {
        val note = str(vectors["pdfNote"])
        val stored = readTaskList(note)!!
        val expected = obj(vectors["stored"])
        assertEquals(arr(expected["tasks"]).map(::taskOf), stored.tasks)
        assertEquals(arr(expected["removed"]).map(::str), stored.removed)
        assertEquals("Mit --> im Titel", stored.tasks[0].title, "a closer inside the JSON text is not the end")
        assertEquals("Mein \"Text\"\nzweite Zeile", stored.tasks[1].title)
        assertEquals(note, writeTaskList(note, stored), "Android rewrites the exact text the desktop wrote")
        assertTrue(note.contains("fanotes-pdf-marks-v1") && writeTaskList(note, stored.copy(tasks = emptyList(), removed = emptyList())).let { !it.contains("fanotes-tasks") && it.contains("fanotes-pdf-marks-v1") })
        assertNull(readTaskList("plain"))
        assertNull(readTaskList("<!-- fanotes-tasks-v1\n{broken\n-->"))
    }

    @Test
    fun reScanKeepsProgressManualEditsAndRemovals() {
        val detect = obj(vectors["detect"])
        val detected = arr(detect["tasks"]).map(::taskOf)
        val stored = readTaskList(str(vectors["pdfNote"]))!!
        val merged = mergeDetected(stored, detected)
        val expected = obj(vectors["rescan"])
        assertEquals(arr(expected["tasks"]).map(::taskOf), merged.tasks)
        assertEquals(arr(expected["removed"]).map(::str), merged.removed)
        assertTrue(merged.tasks.none { it.id == "auftrag-7" }, "removed stays removed")
        assertTrue(merged.tasks.first { it.id == stored.tasks[0].id }.done)
        val progress = taskProgress(stored.tasks)
        val wanted = obj(vectors["progress"])
        assertEquals(int(wanted["done"]), progress.done)
        assertEquals(int(wanted["plannedMinutes"]), progress.plannedMinutes)
        assertEquals(int(wanted["remainingMinutes"]), progress.remainingMinutes)
    }

    @Test
    fun taskEditsFollowThePanelRules() {
        var list = StudyTaskList(emptyList(), emptyList())
        val manual = newManualTask(list.tasks, 0, now = 1000)
        assertEquals("1", manual.number)
        assertEquals(1, manual.page)
        assertTrue(manual.manual)
        list = list.copy(tasks = listOf(manual, StudyTask("auftrag-4", "4", "Lesen", 20, 2, false, 0, false)))
        assertEquals("5", newManualTask(list.tasks, 3).number)
        list = updateTask(list, "auftrag-4") { it.copy(done = true, spentSec = 90) }
        assertTrue(list.tasks[1].done)
        assertEquals(StudyTaskList(listOf(list.tasks[1]), emptyList()), removeTask(list, manual.id), "removing a manual task leaves no trace")
        assertEquals(listOf("auftrag-4"), removeTask(list, "auftrag-4").removed, "a detected task is remembered as removed")
        assertEquals(1.0, taskProgress(listOf(list.tasks[1])).ratio)
    }

    @Test
    fun pdfTextRunsBecomeLines() {
        val runs = listOf(
            PdfTextRun("Auftrag 3:", 100f, 112f), PdfTextRun("Skizzieren", 100f, 112f),
            PdfTextRun("zweite Zeile", 120f, 132f), PdfTextRun("dritte\nvierte", 140f, 152f),
        )
        assertEquals(listOf("Auftrag 3: Skizzieren", "zweite Zeile", "dritte", "vierte"), linesFromRuns(runs))
        assertEquals(listOf("a", "b"), linesFromRuns(listOf(PdfTextRun("a"), PdfTextRun("b"))), "runs without bounds are lines")
    }

    // -- blocks ---------------------------------------------------------------------

    @Test
    fun blocksParseAndSerialiseLikeTheDesktop() {
        val note = str(vectors["note"])
        val found = findStudyBlocks(note)
        assertEquals(listOf("key", "sort", "map", "plate", "term"), found.map { it.kind.id }, "look-alikes inside other fences are ignored")
        val blocks = obj(vectors["blocks"])
        found.forEach { ref ->
            val expected = str(obj(blocks[ref.kind.id])["expectedBlock"])
            val data = when (ref.kind) {
                StudyKind.KEY -> keyDataJson(parseKeyData(ref.body)!!)
                StudyKind.SORT -> sortDataJson(parseSortData(ref.body)!!)
                StudyKind.MAP -> mapDataJson(parseMapData(ref.body)!!)
                StudyKind.PLATE -> plateDataJson(parsePlateData(ref.body)!!)
                StudyKind.TERM -> termDataJson(parseTermData(ref.body)!!)
                StudyKind.CRYPTO -> ch.fasrv.fanotes.study.crypto.cryptoDataJson(ch.fasrv.fanotes.study.crypto.parseCryptoData(ref.body))
            }
            assertEquals(expected, serializeStudyBlock(ref.kind, data), ref.kind.id)
        }
    }

    @Test
    fun aDesktopNoteSurvivesAnAndroidRewriteByteForByte() {
        var note = str(vectors["desktopNote"])
        val original = note
        for (index in findStudyBlocks(note).indices) {
            val ref = findStudyBlocks(note)[index]
            val json = when (ref.kind) {
                StudyKind.KEY -> keyDataJson(parseKeyData(ref.body)!!)
                StudyKind.SORT -> sortDataJson(parseSortData(ref.body)!!)
                StudyKind.MAP -> mapDataJson(parseMapData(ref.body)!!)
                StudyKind.PLATE -> plateDataJson(parsePlateData(ref.body)!!)
                StudyKind.TERM -> termDataJson(parseTermData(ref.body)!!)
                StudyKind.CRYPTO -> ch.fasrv.fanotes.study.crypto.cryptoDataJson(ch.fasrv.fanotes.study.crypto.parseCryptoData(ref.body))
            }
            note = replaceStudyBlock(note, ref, json)
        }
        assertEquals(original, note)
    }

    @Test
    fun brokenBlocksAreNotReadable() {
        assertNull(parseKeyData("{broken"))
        assertNull(parseSortData("[1]"))
        assertNull(buildStudyScene(StudyKind.MAP, "garbage", 400.0))
        assertNotNull(buildStudyScene(StudyKind.MAP, "{}", 400.0), "an empty object shows the starter map like the desktop")
        assertEquals(0, findStudyBlocks("```fanotes-map\n{\"v\":1}").size, "unclosed block is not a block")
        assertEquals(1, findStudyBlocks("```fanotes-map\r\n{\"v\":1}\r\n```\r\ntext").size)
        val appended = insertStudyBlock("Hallo", StudyKind.SORT, sortDataJson(defaultSortData()))
        assertTrue(appended.startsWith("Hallo\n\n```fanotes-sort\n{\n \"v\": 1,"))
        assertEquals(StudyKind.SORT, findStudyBlocks(appended).single().kind)
    }

    @Test
    fun layoutsMatchTheDesktopCoordinates() {
        val note = str(vectors["desktopNote"])
        val key = parseKeyData(findStudyBlocks(note).first { it.kind == StudyKind.KEY }.body)!!
        val layout = layoutKeyTree(key.tree)
        val expected = obj(vectors["keyLayout"])
        assertEquals(dbl(expected["width"]), layout.width, 1e-9)
        assertEquals(dbl(expected["height"]), layout.height, 1e-9)
        val nodes = arr(expected["nodes"])
        assertEquals(nodes.size, layout.nodes.size)
        nodes.forEachIndexed { index, raw ->
            val n = obj(raw)
            val actual = layout.nodes[index]
            assertEquals(str(n["id"]), actual.id)
            assertEquals(dbl(n["x"]), actual.x, 1e-9)
            assertEquals(dbl(n["y"]), actual.y, 1e-9)
            assertEquals(dbl(n["w"]), actual.w, 1e-9)
            assertEquals(dbl(n["h"]), actual.h, 1e-9)
            assertEquals(arr(n["lines"]).map(::str), actual.lines)
        }
        arr(expected["edges"]).forEachIndexed { index, raw ->
            val e = obj(raw)
            val actual = layout.edges[index]
            assertEquals(str(e["from"]), actual.from)
            assertEquals(dbl(e["x2"]), actual.x2, 1e-9)
            assertEquals(dbl(e["y1"]), actual.y1, 1e-9)
        }
        assertNoOverlap(layout.nodes.map { listOf(it.x, it.y, it.w, it.h) })

        val map = parseMapData(findStudyBlocks(note).first { it.kind == StudyKind.MAP }.body)!!
        val placed = layoutMap(map)
        val wanted = obj(vectors["mapLayout"])
        assertEquals(arr(vectors["mapLayers"]).map { arr(it).map(::str) }, layerMap(map))
        assertEquals(dbl(wanted["width"]), placed.width, 1e-9)
        assertEquals(dbl(wanted["height"]), placed.height, 1e-9)
        arr(wanted["nodes"]).forEachIndexed { index, raw ->
            val n = obj(raw)
            val actual = placed.nodes[index]
            assertEquals(str(n["id"]), actual.id)
            assertEquals(dbl(n["x"]), actual.x, 1e-9)
            assertEquals(dbl(n["y"]), actual.y, 1e-9)
        }
        arr(wanted["edges"]).forEachIndexed { index, raw ->
            val e = obj(raw)
            val actual = placed.edges[index]
            val path = str(e["path"])
            val numbers = Regex("""-?\d+(?:\.\d+)?""").findAll(path).map { it.value.toDouble() }.toList()
            assertEquals(numbers, listOf(actual.x1, actual.y1, actual.c1x, actual.c1y, actual.c2x, actual.c2y, actual.x2, actual.y2), "edge path $index")
            assertEquals(dbl(e["lx"]), actual.lx, 1e-9)
            assertEquals(dbl(e["ly"]), actual.ly, 1e-9)
        }
        assertNoOverlap(placed.nodes.map { listOf(it.x, it.y, it.w, it.h) })
        assertTrue(placed.edges.size == map.edges.size && placed.edges.any { it.label == "hemmt" })
    }

    private fun assertNoOverlap(boxes: List<List<Double>>) {
        for (i in boxes.indices) for (j in i + 1 until boxes.size) {
            val (ax, ay, aw, ah) = boxes[i]
            val (bx, by, bw, bh) = boxes[j]
            assertTrue(!(ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah), "boxes $i and $j overlap")
        }
    }

    @Test
    fun wrappingMatchesTheDesktop() {
        for (entry in arr(vectors["wrap"])) {
            val (text, max, lines) = arr(entry)
            assertEquals(arr(lines).map(::str), wrapText(str(text), int(max)))
        }
    }

    @Test
    fun sortingPersistsThroughTheBlock() {
        val note = str(vectors["desktopNote"])
        val ref = findStudyBlocks(note).first { it.kind == StudyKind.SORT }
        val board = parseSortData(ref.body)!!
        val moved = moveCard(moveCard(board, "c3", "g1", 0), "c1", null)
        val expected = obj(vectors["sortMoved"])
        assertEquals(str(expected["block"]), serializeStudyBlock(StudyKind.SORT, sortDataJson(moved)))
        assertEquals(arr(expected["unsorted"]).map(::str), unsortedCards(moved).map { it.id })
        val reloaded = parseSortData(findStudyBlocks(replaceStudyBlock(note, ref, sortDataJson(moved))).first { it.kind == StudyKind.SORT }.body)
        assertEquals(moved, reloaded)
        assertEquals(board, moveCard(board, "nope", "g1"))
        val once = moveCard(moved, "c2", "g3")
        assertEquals(1, once.groups.count { "c2" in it.cards }, "a card lives in one group only")
        assertEquals(board.cards.size - 1, removeSortCard(board, "c1").cards.size)
        val duplicated = normaliseSortData(parseJson("""{"cards":[{"id":"a","text":"x"},{"id":"a","text":"y"}]}""") as JsonValue.Obj)
        assertEquals(2, duplicated.cards.map { it.id }.toSet().size, "duplicate card ids get a new id")
    }

    // -- flashcards -----------------------------------------------------------------

    @Test
    fun plateAndTermBlocksFeedTheFlashcards() {
        val note = str(vectors["desktopNote"])
        val sources = studyCardSources(note)
        val expected = arr(vectors["cardSources"]).map { obj(it) }
        assertEquals(expected.map { str(it["id"]) }, sources.map { it.id })
        assertEquals(expected.map { str(it["front"]) }, sources.map { it.front })
        assertEquals(expected.map { str(it["back"]) }, sources.map { it.back })
        assertEquals(expected.map { it["frontImage"]?.let(::str) }, sources.map { it.frontImage })
        val cards = cardsFromMarkdown(note, "2026-11-15")
        assertEquals(3, cards.size)
        val image = cards.first { it.id == "plate:p1" }
        assertEquals(".fanotes/worksheets/0b3e4f5a-1111-4222-8333-444455556666.jpg", image.frontImage)
        assertEquals("Distelfalter\nwandert", image.back)
        val graded = applyReview(note, "plate:p1", "good", "2026-11-15")
        assertTrue(!graded.contains("frontImage"), "the schedule does not copy the picture")
        val again = cardsFromMarkdown(graded, "2026-11-15")
        assertEquals(1, again.first { it.id == "plate:p1" }.reps, "schedule is kept by id")
        assertEquals(image.frontImage, again.first { it.id == "plate:p1" }.frontImage)
        assertEquals(1, cardsFromMarkdown("## Lernfragen\n\n<details><summary>Q?</summary>A</details>", "2026-11-15").size)
        assertTrue(studyImageRefs(note).contains(image.frontImage), "the picture is loaded for the editor")
        assertTrue(studyImageRefs(note).any { it.startsWith("data:image/") }, "old notes with small data URLs still show")
    }

    // -- rendering ------------------------------------------------------------------

    @Test
    fun everyBlockKindDrawsInsideTheColumn() {
        val note = str(vectors["desktopNote"])
        for (width in listOf(320.0, 560.0, 900.0)) {
            for (ref in findStudyBlocks(note)) {
                val scene = assertNotNull(buildStudyScene(ref.kind, ref.body, width), ref.kind.id)
                assertTrue(scene.height > 20, "${ref.kind.id} has height")
                assertTrue(scene.ops.isNotEmpty())
                for (op in scene.ops) {
                    when (op) {
                        is BoxOp -> assertTrue(op.x >= -0.5 && op.x + op.w <= width + 1, "${ref.kind.id} box inside $width")
                        is ImageOp -> assertTrue(op.x >= -0.5 && op.x + op.w <= width + 1)
                        else -> Unit
                    }
                }
            }
        }
        val map = buildStudyScene(StudyKind.MAP, findStudyBlocks(note).first { it.kind == StudyKind.MAP }.body, 400.0)!!
        assertTrue(map.ops.any { it is CurveOp && it.arrow }, "arrows")
        val key = buildStudyScene(StudyKind.KEY, findStudyBlocks(note).first { it.kind == StudyKind.KEY }.body, 600.0)!!
        assertTrue(key.ops.any { it is LineOp } && key.ops.any { it is ImageOp }, "tree edges and the comparison picture")
        val plate = buildStudyScene(StudyKind.PLATE, findStudyBlocks(note).first { it.kind == StudyKind.PLATE }.body, 600.0)!!
        assertEquals(2, plate.ops.count { it is ImageOp }, "the vault picture and the old data URL; the remote one was dropped")
    }

    @Test
    fun theEditorShowsTheBlockOnlyWhileTheCaretIsOutside() {
        val note = "Vorher\n\n```fanotes-sort\n{\"v\":1,\"title\":\"S\",\"cards\":[],\"groups\":[]}\n```\n\nNachher\n"
        val outside = livePreviewMarks(note, 0, 0)
        val card = outside.single { it.kind == LiveKind.STUDY_BLOCK }
        assertEquals("sort", card.label)
        assertEquals(note.indexOf("```fanotes-sort"), card.start)
        assertTrue(outside.none { it.kind == LiveKind.CODE_FENCE }, "not drawn as code as well")
        assertTrue(outside.any { it.kind == LiveKind.HIDE && it.start == note.indexOf("{\"v\"") })
        val inside = livePreviewMarks(note, note.indexOf("cards"), note.indexOf("cards"))
        assertTrue(inside.none { it.kind == LiveKind.STUDY_BLOCK })
        val broken = "```fanotes-map\n{oops\n```\n"
        assertTrue(livePreviewMarks(broken, broken.length, broken.length).none { it.kind == LiveKind.STUDY_BLOCK })
        assertTrue(livePreviewMarks(broken.replace("```fanotes-map", "```js"), 0, 0).none { it.kind == LiveKind.STUDY_BLOCK })
        assertTrue(livePreviewMarks("```fanotes-map\n{oops\n```\nx", 100, 100).any { it.kind == LiveKind.CODE_FENCE }, "a broken block stays raw code")
    }

    // -- highlights -----------------------------------------------------------------

    @Test
    fun highlightsAreGroupedByPage() {
        val sample = listOf(
            PdfTextMark("m2", 5, "Zweite Stelle", "highlight"),
            PdfTextMark("m1", 2, "Erste Stelle", "underline"),
            PdfTextMark("m3", 5, "Dritte Stelle", "highlight"),
        )
        assertEquals(listOf(2 to 1, 5 to 2), groupMarksByPage(sample).map { it.page to it.marks.size })
        val markdown = marksToMarkdown("Gliederfüsser.pdf", sample)
        assertTrue(markdown.startsWith("# Markierungen: Gliederfüsser.pdf\n\n## Seite 2\n\n- __Erste Stelle__ (S. 2)"))
        assertTrue(markdown.contains("## Seite 5\n\n- ==Zweite Stelle== (S. 5)\n- ==Dritte Stelle== (S. 5)"))
    }
}
