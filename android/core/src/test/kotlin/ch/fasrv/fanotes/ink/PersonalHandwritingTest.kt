package ch.fasrv.fanotes.ink

import ch.fasrv.fanotes.json.*
import ch.fasrv.fanotes.vault.DirectoryVault
import ch.fasrv.fanotes.vault.NoteStore
import java.nio.file.Files
import java.io.File
import kotlin.math.*
import kotlin.test.*

class PersonalHandwritingTest {
    private fun point(x: Double, y: Double, t: Double = 0.0) = StrokePoint(x, y, t, .45, 0.0, 0.0, "pen")
    private fun options(seed: Int = 7, model: PersonalHandwritingModel? = null, connect: Boolean = true, variation: Double = .65) =
        HandwritingSynthesisOptions(42.0, 1.4, variation, connect, "#202333", 3.5, true, seed, model = model)
    private fun realPage(): InkDocument {
        val fixture = parseJson(File("../../fanotes/scripts/fixtures/iam-online-a01-001z-01.json").readText()) as JsonValue.Obj
        val strokes = fixture.array("strokes")!!.items.map { raw ->
            val points = (raw as JsonValue.Arr).items.map { item ->
                val values = (item as JsonValue.Arr).items.map { (it as JsonValue.Num).value }
                point(values[0], values[1], values[2])
            }
            InkStroke(points, 3.2, true, "#202333")
        }
        return newInkDocument("Ordinary note", "dots", "2026-01-01T00:00:00Z").copy(
            sourceWidth = fixture.double("sourceWidth")!!, sourceHeight = fixture.double("sourceHeight")!!, strokes = strokes)
    }
    @Test fun unlabeledRealPagesTeachStyleAndJoiningMotionsWithoutInventingLabels() {
        val contribution = learnWritingPage(realPage(), emptyList())
        assertTrue(contribution.observations.isNotEmpty())
        assertTrue(contribution.joins.isNotEmpty())
        assertTrue(contribution.units.isEmpty())
        val once = updateWritingPage(PersonalHandwritingModel(), "page", contribution)
        assertSame(once, updateWritingPage(once, "page", contribution))
        val copied = updateWritingPage(once, "copy", contribution)
        assertEquals(1, copied.pageCount)
        val recovered = decodePersonalHandwriting(encodePersonalHandwriting(copied))
        assertEquals(copied.observations, recovered.observations)
        assertEquals(copied.joins.size, recovered.joins.size)
        assertEquals(0, updateWritingPage(updateWritingPage(copied, "page", null), "copy", null).pageCount)
    }
    @Test fun generatedInkIsEditableAndCannotFeedBackIntoTrainingAfterSaving() {
        val result = synthesizeHandwriting("Straße äöü ÄÖÜ 123!\nA second line", emptyList(), options(), clockStart = 0.0)
        assertTrue(result.missingCharacters.isEmpty())
        assertTrue(result.normalizedText.contains("Straße"))
        val session = InkSession(newInkDocument("Page", "dots", "2026-01-01T00:00:00Z"))
        assertTrue(session.insertSynthesized(result, "2026-01-01T00:00:01Z"))
        val saved = parseInkDocument(session.document.toJson(), "Page", "dots", "2026-01-01T00:00:02Z")
        assertEquals(result.strokes.size, saved.strokes.size)
        assertTrue(saved.strokes.all { it.extras.obj("synthesis")?.double("engine") == 2.0 })
        assertTrue(learnWritingPage(saved).observations.isEmpty())
        assertTrue(session.undo()); assertTrue(session.document.strokes.isEmpty()); assertTrue(session.redo())
    }
    @Test fun ambiguousLocalRecognitionCannotBecomeATrainingLabel() {
        val generated = synthesizeHandwriting("he sch nr", schoolScript(), options(connect = false, variation = 0.0), clockStart = 0.0)
        val page = newInkDocument("Ordinary page", "dots", "2026-01-01T00:00:00Z").copy(strokes = generated.strokes.map { it.copy(extras = JsonValue.Obj()) })
        val contribution = learnWritingPage(page)
        assertTrue(contribution.units.any { it.label.length > 1 })
        val ambiguous = schoolScript().flatMap { listOf(it, it.copy(id = it.id + "-ambiguous", label = "¤")) }
        assertTrue(learnWritingPage(page, ambiguous).units.isEmpty())
        val model = updateWritingPage(PersonalHandwritingModel(), "ordinary", contribution)
        val unit = contribution.units.first { it.label.length > 1 }
        val reused = synthesizeHandwriting(unit.label, emptyList(), options(model = model, variation = 0.0), clockStart = 0.0)
        assertTrue(unit.id in reused.usedSampleIds)
        assertEquals(unit.label.length, reused.glyphCount)
        assertEquals(unit.strokes.size, reused.strokes.size)
    }
    @Test fun quinticSplicePreservesDirectionAndRejectsInfeasibleJoins() {
        val left = listOf(point(0.0, 0.0), point(3.0, -.3), point(6.0, 0.0))
        val right = listOf(point(14.0, 2.0), point(17.0, 2.3), point(20.0, 2.0))
        val joined = assertNotNull(spliceWritingTrajectories(left, right, 42.0))
        assertEquals(left, joined.take(3)); assertEquals(right, joined.takeLast(3))
        fun angle(a: StrokePoint, b: StrokePoint, c: StrokePoint, d: StrokePoint): Double {
            val ux = b.x - a.x; val uy = b.y - a.y; val vx = d.x - c.x; val vy = d.y - c.y
            return acos(((ux * vx + uy * vy) / hypot(ux, uy) / hypot(vx, vy)).coerceIn(-1.0, 1.0))
        }
        assertTrue(angle(left[1], left[2], joined[2], joined[3]) < .12)
        assertTrue(angle(joined[joined.size - 4], joined[joined.size - 3], right[0], right[1]) < .12)
        assertNull(spliceWritingTrajectories(left.reversed(), right, 42.0))
        assertNull(spliceWritingTrajectories(left, right.map { it.copy(x = it.x + 100) }, 42.0))
        assertNull(spliceWritingTrajectories(left, right.map { it.copy(y = it.y + 100) }, 42.0))
    }
    @Test fun cursiveBodiesBecomeOneContinuousStrokeAndWordsStaySeparate() {
        val sample = decodeGlyphLibrary(File("../../fanotes/scripts/fixtures/cursive-synthesis.json").readText()).single()
        val result = synthesizeHandwriting("eeee eeee\neeee", listOf(sample), options(variation = 0.0), clockStart = 0.0)
        assertEquals(9, result.connectionCount)
        assertEquals(3, result.strokes.size)
        assertEquals(2, result.lineCount)
        var time = -1.0
        result.strokes.flatMap { it.points }.forEach { assertTrue(it.t > time); time = it.t }
        assertEquals(result.strokes.map { it.points }, synthesizeHandwriting("eeee eeee\neeee", listOf(sample), options(variation = 0.0), clockStart = 0.0).strokes.map { it.points })
    }
    @Test fun heldOutGeometryRejectsAWorsePopulationUpdate() {
        val summary = learnWritingPage(realPage(), emptyList()).observations.first()
        val records = (0 until 10).map { i -> (if (i < 2) "00$i" else "01$i") to summary.copy(pressure = if (i < 2) .4 else .8) }
        val fit = fitWritingPopulation(records, summary.copy(pressure = .4))
        assertEquals(false, fit.second?.accepted)
        assertEquals(.4, fit.first?.pressure)
        assertEquals(2, fit.second?.holdoutPages)
    }
    @Test fun legacyInkReferencesAreDiscoveredAndDeletedPagesAreRetracted() {
        val dir = Files.createTempDirectory("writing-legacy")
        val vault = DirectoryVault(dir.resolve("vault"))
        vault.write("Legacy.md", "# Legacy\n<!-- fanotes-ink:old-page -->".toByteArray())
        vault.write(".fanotes/assets/old-page.json", realPage().toJson().stringify().toByteArray())
        val store = WritingLearningStore(dir.resolve("private-model").toFile())
        assertEquals(1, store.scan(vault, emptyList()).pageCount)
        vault.delete("Legacy.md")
        assertEquals(0, store.scan(vault, emptyList()).pageCount)
    }
    @Test fun aCorruptFamdKeepsItsLastGoodContributionAndRetries() {
        val dir = Files.createTempDirectory("writing-corrupt")
        val vault = DirectoryVault(dir.resolve("vault")); val notes = NoteStore(vault)
        val path = notes.createMarkdown("", "Page"); val note = notes.readNote(path)
        notes.save(note, realPage(), note.markdown)
        val store = WritingLearningStore(dir.resolve("model").toFile())
        assertEquals(1, store.scan(vault, emptyList()).pageCount)
        vault.write("Page.famd", "{broken".toByteArray())
        assertEquals(1, store.scan(vault, emptyList()).pageCount)
        notes.save(note, note.document.copy(strokes = emptyList()), note.markdown)
        assertEquals(0, store.scan(vault, emptyList()).pageCount)
    }
    @Test fun largeCollectionsKeepBoundedTrajectoriesAndUseAllPageSummaries() {
        val dir = Files.createTempDirectory("writing-bounded")
        val vault = DirectoryVault(dir.resolve("vault")); val notes = NoteStore(vault); val raw = realPage()
        for (i in 0 until 55) {
            val path = notes.createMarkdown("", "Page-$i"); val note = notes.readNote(path)
            val first = raw.strokes.first()
            val changed = first.copy(points = listOf(first.points.first().copy(pressure = .4 + i * .0001)) + first.points.drop(1))
            notes.save(note, raw.copy(strokes = listOf(changed) + raw.strokes.drop(1)), note.markdown)
        }
        val model = WritingLearningStore(dir.resolve("model").toFile()).scan(vault, emptyList())
        assertEquals(55, model.pageCount)
        assertTrue(model.pages.size <= 48)
        assertNotNull(model.population)
        assertTrue(model.units.sumOf { it.strokes.sumOf { stroke -> stroke.points.size } } <= 48 * 16 * 768)
    }
    @Test fun fallbackPreservesNaturalProportionsAndPunctuationSize() {
        val narrow = synthesizeHandwriting("l", emptyList(), options(), clockStart = 0.0)
        val wide = synthesizeHandwriting("m", emptyList(), options(), clockStart = 0.0)
        val period = synthesizeHandwriting(".", emptyList(), options(), clockStart = 0.0)
        assertTrue(wide.bounds!![2] > narrow.bounds!![2] * 4)
        assertTrue(period.bounds!![3] < 42 * .15)
    }
    @Test fun explicitDirtyPagesBypassCoarseProviderTimestamps() {
        val dir = Files.createTempDirectory("writing-coarse")
        val vault = DirectoryVault(dir.resolve("vault")); val notes = NoteStore(vault)
        val path = notes.createMarkdown("", "Page"); val note = notes.readNote(path)
        val raw = realPage()
        notes.save(note, raw, note.markdown, "2026-01-01T00:00:00Z")
        val coarse = object : ch.fasrv.fanotes.vault.VaultIo by vault {
            override fun walkFiles() = vault.walkFiles().map { it.copy(mtimeMs = 42, size = 123) }
        }
        val store = WritingLearningStore(dir.resolve("model").toFile())
        val before = store.scan(coarse, emptyList())
        val changed = raw.copy(strokes = raw.strokes.map { s -> s.copy(points = s.points.map { it.copy(pressure = .7) }) })
        notes.save(note, changed, note.markdown, "2026-01-01T00:00:00Z")
        val after = store.scan(coarse, emptyList(), forcePages = setOf("Page.famd"))
        assertNotEquals(before.pages.values.first().fingerprint, after.pages.values.first().fingerprint)
        assertEquals(.7, after.population?.pressure)
    }
    @Test fun pageCheckpointsResumeAndReconcileChangesAndDeletions() {
        val dir = Files.createTempDirectory("writing-learning")
        val vault = DirectoryVault(dir.resolve("vault")); val notes = NoteStore(vault)
        val a = notes.createMarkdown("", "First"); val b = notes.createMarkdown("", "Second")
        for (id in listOf(a, b)) { val note = notes.readNote(id); notes.save(note, realPage(), note.markdown) }
        val cache = dir.resolve("private-model").toFile(); val store = WritingLearningStore(cache)
        var visits = 0
        val interrupted = store.scan(vault, emptyList(), cancelled = { visits >= 1 }, onCheckpoint = { visits++ })
        assertEquals(1, interrupted.pages.size)
        val resumedStore = WritingLearningStore(cache)
        val resumed = resumedStore.scan(vault, emptyList())
        assertEquals(2, cache.listFiles()!!.count { it.extension == "json" && it.nameWithoutExtension.length == 64 })
        assertEquals(1, resumed.pageCount, "duplicate page geometry has one vote")
        val snapshots = cache.listFiles()!!.filter { it.extension == "json" }.associate { it.name to it.lastModified() }
        val repeated = resumedStore.scan(vault, emptyList())
        assertEquals(resumed.observations, repeated.observations)
        assertEquals(snapshots, cache.listFiles()!!.filter { it.extension == "json" }.associate { it.name to it.lastModified() })
        val note = notes.readNote(a); notes.save(note, note.document.copy(strokes = emptyList()), note.markdown)
        vault.delete("Second.famd")
        vault.delete("Second.md")
        val deleted = resumedStore.scan(vault, emptyList())
        assertEquals(0, deleted.pageCount)
        assertTrue("Second.famd" !in deleted.pages)
        // An unfinished temp file cannot replace the last good checkpoint.
        File(cache, "broken.json.tmp").writeText("{truncated")
        assertEquals(0, WritingLearningStore(cache).load().pageCount)
    }
}
