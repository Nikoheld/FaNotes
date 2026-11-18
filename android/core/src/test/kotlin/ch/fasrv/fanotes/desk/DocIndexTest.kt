package ch.fasrv.fanotes.desk

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.jsonArray
import ch.fasrv.fanotes.json.jsonObject
import ch.fasrv.fanotes.json.jsonString
import ch.fasrv.fanotes.vault.VaultEntry
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class DocIndexTest {
    private fun file(path: String, size: Long = 10, mtime: Long = 1) = VaultEntry(path, false, size, mtime)

    private fun build(files: List<VaultEntry>, texts: Map<String, String>, pdfs: Map<String, List<String>> = emptyMap(), known: List<DocIndexEntry> = emptyList()): List<DocIndexEntry> {
        val plan = planDocIndex(docSources(files), known)
        val map = known.associateBy { it.key }.toMutableMap()
        plan.drop.forEach { map.remove(it) }
        for (source in plan.todo) {
            if (source.type == DOC_INDEX_PDF) {
                val entry = pdfIndexEntry(source, pdfs[source.path].orEmpty())
                map[entry.key] = entry
            } else {
                noteIndexEntries(source, source.markdownPath?.let { texts[it] }, texts[source.famdPath] ?: "").forEach { map[it.key] = it }
            }
        }
        return map.values.toList()
    }

    @Test
    fun sourcesCoverNotesPdfsAndHandwritingOnlyPagesButNotHiddenFiles() {
        val files = listOf(
            file("a.md"), file("a.famd"), file("Skript.pdf"), file("Skizze.famd"), file(".fanotes/page-text/x.json"),
            file(".hidden/b.md"), file("bild.png"),
        )
        val sources = docSources(files)
        assertEquals(listOf("Skizze.famd", "Skript.pdf", "a.md"), sources.map { it.path })
        assertEquals("a.famd", sources.first { it.path == "a.md" }.famdPath)
        assertEquals(DOC_INDEX_PDF, sources.first { it.path == "Skript.pdf" }.type)
    }

    @Test
    fun onlyChangedFilesAreReadAgainAndDeletedFilesAreDropped() {
        val files = listOf(file("a.md", 5, 1), file("b.md", 5, 1), file("Skript.pdf", 100, 1))
        val first = build(files, mapOf("a.md" to "Photosynthese", "b.md" to "Zellatmung"), mapOf("Skript.pdf" to listOf("Seite eins", "Mitochondrien")))
        assertEquals(3, first.size)
        val unchanged = planDocIndex(docSources(files), first)
        assertTrue(unchanged.todo.isEmpty())
        assertTrue(unchanged.drop.isEmpty())
        val changed = listOf(file("a.md", 6, 2), file("Skript.pdf", 100, 1))
        val plan = planDocIndex(docSources(changed), first)
        assertEquals(listOf("a.md"), plan.todo.map { it.path })
        assertEquals(listOf(docIndexKey("b.md", DOC_INDEX_NOTE)), plan.drop)
    }

    @Test
    fun aSyncedDesktopTextFileMakesTheNextPlanReadThePdfAgain() {
        val before = listOf(file("Skript.pdf", 100, 1))
        val entries = build(before, emptyMap(), mapOf("Skript.pdf" to listOf("")))
        val sidecar = desktopPageTextSidecar("Skript.pdf")
        val after = before + file(sidecar, 900, 5)
        assertEquals(listOf("Skript.pdf"), planDocIndex(docSources(after), entries).todo.map { it.path })
    }

    @Test
    fun searchFindsNotesHandwritingAndPdfPagesWithGermanSharpS() {
        val files = listOf(file("Bio.md"), file("Bio.famd"), file("Skript.pdf"), file("Mathe.md"))
        val payload = jsonObject(
            "ink" to jsonObject("searchTranscript" to jsonString("0.4200\tDie Strasse ist nass")),
            "textFields" to jsonArray(jsonObject("text" to jsonString("Arbeitsblatt Aufgabe 3"))),
        )
        val transcript = famdSearchLines(payload)
        assertEquals("0.4200\tDie Strasse ist nass\nArbeitsblatt Aufgabe 3", transcript)
        val index = build(
            files,
            mapOf("Bio.md" to "# Zelle\nDie Mitochondrien liefern Energie.", "Bio.famd" to transcript, "Mathe.md" to "Brüche kürzen"),
            mapOf("Skript.pdf" to listOf("Einleitung", "Das Ribosom baut Proteine", "Straße der Zellen")),
        )
        val energy = searchDocIndex(index, "energie")
        assertEquals(listOf("Bio.md"), energy.map { it.path })
        assertEquals(2, energy[0].line)
        val ink = searchDocIndex(index, "straße")
        assertEquals(listOf("drawing", "note"), ink.map { it.kind })
        assertEquals(0.42, ink[0].anchorY)
        assertEquals("Skript.pdf", ink[1].path)
        assertEquals(3, ink[1].line)
        assertTrue(ink[1].text.startsWith("S. 3"))
        val field = searchDocIndex(index, "aufgabe 3")
        assertEquals("drawing", field[0].kind)
        val pdf = searchDocIndex(index, "ribosom")
        assertEquals(2, pdf[0].line)
        assertTrue(searchDocIndex(index, "x").isEmpty())
        assertTrue(searchDocIndex(index, "nichtvorhanden").isEmpty())
    }

    @Test
    fun aPdfWithoutTextCanStillBeFoundByName() {
        val index = build(listOf(file("Scan Mathe.pdf")), emptyMap(), mapOf("Scan Mathe.pdf" to listOf("", "")))
        val hits = searchDocIndex(index, "scan")
        assertEquals(1, hits.size)
        assertTrue(hits[0].text.startsWith("PDF"))
    }

    @Test
    fun theJournalKeepsLaterLinesDeletesEntriesAndSurvivesDamagedLines() {
        val source = DocSource("a.md", DOC_INDEX_NOTE, "1:1|-", markdownPath = "a.md")
        val first = noteIndexEntries(source, "Alt\nmit \"Anführungszeichen\" und Zeilen", "")[0]
        val second = noteIndexEntries(source.copy(signature = "2:2|-"), "Neu", "")[0]
        val journal = listOf(docIndexLine(first), "not json", docIndexLine(second), "").joinToString("\n")
        val loaded = parseDocIndex(journal)
        assertEquals(1, loaded.entries.size)
        assertEquals("Neu", loaded.entries[0].text)
        assertEquals(3, loaded.lines)
        val deleted = parseDocIndex(journal + "\n" + docIndexDeleteLine(first.key))
        assertTrue(deleted.entries.isEmpty())
        assertEquals("Alt\nmit \"Anführungszeichen\" und Zeilen", parseDocIndex(docIndexLine(first)).entries[0].text)
        assertTrue(!docIndexNeedsCompaction(100, 10))
        assertTrue(docIndexNeedsCompaction(500, 100))
        assertEquals(1, parseDocIndex(docIndexJournal(listOf(second))).entries.size)
    }

    @Test
    fun cancelledSearchReturnsNothingAndStatusLabelsAreGerman() {
        val index = build(listOf(file("a.md")), mapOf("a.md" to "Hallo Welt"))
        assertTrue(searchDocIndex(index, "welt", cancelled = { true }).isEmpty())
        assertEquals("Suchindex wird aufgebaut · 3 von 10", docIndexStatusLabel(DocIndexStatus(total = 10, indexed = 3, running = true)))
        assertEquals("Suchindex aktuell · 10 Dateien", docIndexStatusLabel(DocIndexStatus(total = 10, indexed = 10)))
        assertEquals("Suchindex unvollständig · 4 offen", docIndexStatusLabel(DocIndexStatus(total = 10, indexed = 6)))
    }

    @Test
    fun aLargeVaultPlansQuicklyAndASecondPlanIsEmpty() {
        val files = (1..5000).map { file("Ordner${it % 20}/Notiz $it.md", 100L + it, it.toLong()) }
        val started = System.nanoTime()
        val sources = docSources(files)
        val entries = sources.map { DocIndexEntry(it.path, DOC_INDEX_NOTE, it.signature, "t", "Text $it") }
        val plan = planDocIndex(sources, entries)
        val millis = (System.nanoTime() - started) / 1_000_000
        assertTrue(plan.todo.isEmpty())
        assertEquals(5000, plan.total)
        assertTrue(millis < 3000, "planning took $millis ms")
        val hits = searchDocIndex(entries, "Notiz 4999")
        assertTrue(hits.isNotEmpty())
    }
}
