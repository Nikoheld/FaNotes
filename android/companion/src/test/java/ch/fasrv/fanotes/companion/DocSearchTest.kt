package ch.fasrv.fanotes.companion

import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.sql.Connection
import java.sql.DriverManager

/** SQLite through JDBC with the same FTS4 the phone uses. */
class JdbcIndexDb(file: File) : IndexDb {
    private val connection: Connection = DriverManager.getConnection("jdbc:sqlite:" + file.path)
    private var depth = 0
    private fun bind(sql: String, args: Array<out Any?>) = connection.prepareStatement(sql).also { s ->
        args.forEachIndexed { i, v -> s.setObject(i + 1, v) }
    }
    override fun exec(sql: String, vararg args: Any?) { bind(sql, args).use { it.execute() } }
    override fun <T> query(sql: String, vararg args: Any?, row: (IndexRow) -> T): List<T> = bind(sql, args).use { s ->
        s.executeQuery().use { rs ->
            val wrapper = object : IndexRow {
                override fun string(index: Int): String? = rs.getString(index + 1)
                override fun long(index: Int): Long = rs.getLong(index + 1)
                override fun double(index: Int): Double = rs.getDouble(index + 1)
            }
            val out = mutableListOf<T>()
            while (rs.next()) out += row(wrapper)
            out
        }
    }
    override fun <T> transaction(block: () -> T): T {
        if (depth == 0) connection.autoCommit = false
        depth++
        try { val v = block(); depth--; if (depth == 0) { connection.commit(); connection.autoCommit = true }; return v }
        catch (e: Throwable) { depth--; if (depth == 0) { connection.rollback(); connection.autoCommit = true }; throw e }
    }
    override fun close() = connection.close()
}

/** Synthetic documents: each page is plain text, null means an image-only page that needs OCR. */
class FakeDoc(val pages: List<String?>, val ocr: Map<Int, OcrResult> = emptyMap(), val openError: DocExtractionException? = null, val failPage: Int = -1, val extras: List<PageEntry> = emptyList())

class FakeExtractor(val docs: MutableMap<String, FakeDoc>) : DocExtractor {
    var opened = 0
    val read = mutableListOf<Pair<String, Int>>()
    override fun open(source: DocSource): ExtractionSession {
        val doc = docs[source.path] ?: throw DocExtractionException(DocProblem.Unreadable, true)
        doc.openError?.let { throw it }
        opened++
        return object : ExtractionSession {
            override val pageCount = doc.pages.size
            override fun page(index: Int): PageEntry {
                read += source.path to index
                if (index == doc.failPage) throw DocExtractionException(DocProblem.OcrFailed, true)
                val text = doc.pages[index]
                if (text != null && text.trim().length >= PDF_MIN_TEXT) return PageEntry(index + 1, text, PageSource.TextLayer)
                val result = doc.ocr[index] ?: return PageEntry(index + 1, "", PageSource.None, 0.0, DocProblem.OcrEmpty)
                return PageEntry(index + 1, result.text, PageSource.Ocr, result.confidence, if (ocrUsable(result)) DocProblem.None else DocProblem.OcrEmpty)
            }
            override fun extras() = doc.extras
            override fun close() = Unit
        }
    }
}

class DocSearchTest {
    private lateinit var dir: File
    private lateinit var db: JdbcIndexDb
    private lateinit var index: DocIndex
    private var clock = 1_000_000L

    @Before fun open() {
        dir = Files.createTempDirectory("kanti-doc").toFile()
        db = JdbcIndexDb(File(dir, "index.db")); index = DocIndex(db)
    }
    @After fun close() { db.close(); dir.deleteRecursively() }

    private fun source(path: String, fp: String = "1", kind: String = DOC_KIND_PDF, title: String = path.substringAfterLast('/').substringBeforeLast('.')) = DocSource(path, title, kind, fp)
    private fun runner(extractor: DocExtractor, batch: Int = 2) = DocIndexRunner(index, extractor, { clock }, batch)
    private fun hits(q: String) = index.search(parseDocQuery(q))

    @Test fun germanFoldingMatchesUmlautsSharpSAndCase() {
        assertEquals(foldPlain("STRASSE"), foldPlain("Straße"))
        assertEquals(foldPlain("strasse"), foldPlain("Strasse"))
        assertEquals(foldPlain("Übung"), foldPlain("ubung"))
        assertEquals(foldPlain("Uebung"), foldPlain("Übung"))
        assertEquals(foldPlain("München"), foldPlain("MUENCHEN"))
        assertEquals("integralrechnung", foldPlain("Integral-\nrechnung"))
        assertEquals("trennung", foldPlain("Tren­nung"))
        assertEquals("finden", foldPlain("ﬁnden"))
        assertEquals("a b", foldPlain("a,  b!"))
        assertEquals("e", foldPlain("é"))
    }

    @Test fun snippetHighlightsTheOriginalWordsAndStaysShort() {
        val text = "Einleitung. " + "Füllwort ".repeat(40) + "Die Straßenbahn fährt über die Große Brücke nach Zürich. " + "Ende ".repeat(40)
        val snippet = buildSnippet(text, parseDocQuery("strassenbahn brucke").terms)
        assertTrue(snippet.text.length <= 163)
        val marked = snippet.highlights.map { snippet.text.substring(it.first, it.last + 1) }
        assertTrue(marked.toString(), "Straßenbahn" in marked)
        assertTrue(marked.toString(), "Brücke" in marked)
        val ranges = highlightRanges("Grüße aus der Straße", parseDocQuery("STRASSE").terms)
        assertEquals("Straße", "Grüße aus der Straße".substring(ranges.single()))
    }

    @Test fun queryTermsAreSafeForFtsAndUsePrefixes() {
        assertEquals("integral* rechnung* or*", ftsMatch(parseDocQuery("Integral \"rechnung\" OR -")))
        assertTrue(parseDocQuery("  !!  ").isEmpty)
        assertEquals(8, parseDocQuery((1..20).joinToString(" ") { "wort$it" }).terms.size)
    }

    @Test fun textPdfScansMixedPagesAndOcrFailuresAreIndexedHonestly() = runBlocking {
        val extractor = FakeExtractor(mutableMapOf(
            "Physik/Skript.pdf" to FakeDoc(listOf("Die Interferenz zweier kohärenter Wellen erzeugt ein Muster.", null, "Kapitel drei behandelt die Beugung am Spalt.", null),
                ocr = mapOf(1 to OcrResult("Messprotokoll: Wellenlänge 532 nm, Abstand 2.4 m", 0.82), 3 to OcrResult("~~ #", 0.12))),
        ))
        val result = runner(extractor).run(listOf(source("Physik/Skript.pdf")))
        assertEquals(1, result.indexed)
        val ocrHit = hits("wellenlänge").single()
        assertEquals(2, ocrHit.page)
        assertEquals(PageSource.Ocr, ocrHit.source)
        assertEquals(1, hits("KOHÄRENTER").single().page)
        assertEquals(3, hits("beugung spalt").single().page)
        val record = index.document("Physik/Skript.pdf")!!
        assertEquals("unreadable scan page makes the document partial", DocStatus.Partial, record.status)
        assertEquals(4, record.pages)
        assertEquals(1, record.failedPages)
        assertEquals(DocProblem.OcrEmpty, index.problems().single().second.single().problem)
    }

    @Test fun rankingPrefersTitlesAndTextLayersOverWeakOcr() = runBlocking {
        val extractor = FakeExtractor(mutableMapOf(
            "A.pdf" to FakeDoc(listOf(null), ocr = mapOf(0 to OcrResult("Photosynthese f1ndet im Chloroplasten statt, braucht Licht.", 0.45))),
            "B.pdf" to FakeDoc(listOf("Photosynthese findet im Chloroplasten statt und braucht Licht.")),
            "Photosynthese.pdf" to FakeDoc(listOf("Zusammenfassung: Licht, Wasser und Kohlendioxid werden zu Zucker.")),
        ))
        runner(extractor).run(listOf(source("A.pdf"), source("B.pdf"), source("Photosynthese.pdf")))
        val order = hits("photosynthese").map { it.path }
        assertEquals("Photosynthese.pdf", order.first())
        assertTrue(order.indexOf("B.pdf") < order.indexOf("A.pdf"))
    }

    @Test fun duplicateFilesCollapseButRepeatedPagesInOneFileDoNot() = runBlocking {
        val page = "Arbeitsblatt Vektoren: Berechne den Betrag von a und b."
        val extractor = FakeExtractor(mutableMapOf("Kopie 1.pdf" to FakeDoc(listOf(page)), "Kopie 2.pdf" to FakeDoc(listOf(page)), "Heft.pdf" to FakeDoc(listOf("Seite eins mit anderem Inhalt", "Seite zwei mit anderem Inhalt"))))
        runner(extractor).run(listOf(source("Kopie 1.pdf"), source("Kopie 2.pdf"), source("Heft.pdf")))
        val hit = hits("vektoren betrag").single()
        assertEquals(1, hit.duplicates)
        assertEquals(2, hits("anderem inhalt").size)
    }

    @Test fun editsReplaceOldTextAndDeletionsRemoveIt() = runBlocking {
        val docs = mutableMapOf("Notiz.md" to FakeDoc(listOf("Alte Fassung mit dem Wort Zitronensäure.")))
        val extractor = FakeExtractor(docs)
        runner(extractor).run(listOf(source("Notiz.md", "v1", DOC_KIND_NOTE)))
        assertEquals(1, hits("zitronensaure").size)
        docs["Notiz.md"] = FakeDoc(listOf("Neue Fassung mit dem Wort Natronlauge und mehr Text."))
        runner(extractor).run(listOf(source("Notiz.md", "v2", DOC_KIND_NOTE)))
        assertTrue("old text is gone after an edit", hits("zitronensaure").isEmpty())
        assertEquals(1, hits("natronlauge").size)
        runner(extractor).run(emptyList())
        assertTrue("deleted or no longer accessible documents leave the index", hits("natronlauge").isEmpty())
        assertNull(index.document("Notiz.md"))
    }

    @Test fun unchangedDocumentsAreNotReadAgain() = runBlocking {
        val extractor = FakeExtractor(mutableMapOf("X.pdf" to FakeDoc(listOf("Ein ganz normaler Satz mit genug Zeichen."))))
        runner(extractor).run(listOf(source("X.pdf")))
        runner(extractor).run(listOf(source("X.pdf")))
        assertEquals(1, extractor.opened)
    }

    @Test fun cancellationResumesWithoutLosingOrRepeatingPages() = runBlocking {
        val pages = (1..9).map { "Seite $it enthält das Stichwort Abschnitt$it und weiteren Text." }
        val extractor = FakeExtractor(mutableMapOf("Gross.pdf" to FakeDoc(pages)))
        var allowed = 5
        val first = runner(extractor, batch = 2).run(listOf(source("Gross.pdf")), keepGoing = { allowed-- > 0 })
        assertTrue(first.cancelled)
        assertEquals(DocStatus.Pending, index.document("Gross.pdf")!!.status)
        val readBefore = extractor.read.size
        val second = runner(extractor, batch = 2).run(listOf(source("Gross.pdf")))
        assertFalse(second.cancelled)
        val resumedFrom = extractor.read.drop(readBefore).first().second
        assertTrue("resumes after committed pages, not at 0", resumedFrom > 0)
        assertEquals(DocStatus.Indexed, index.document("Gross.pdf")!!.status)
        for (i in 1..9) assertEquals("page $i once", 1, hits("abschnitt$i").size)
    }

    @Test fun unsupportedWaitsForAChangeAndTransientFailuresBackOff() = runBlocking {
        val docs = mutableMapOf(
            "Geheim.pdf" to FakeDoc(emptyList(), openError = DocExtractionException(DocProblem.Encrypted, false)),
            "Wackel.pdf" to FakeDoc(emptyList(), openError = DocExtractionException(DocProblem.Unreadable, true)),
        )
        val extractor = FakeExtractor(docs)
        val sources = listOf(source("Geheim.pdf"), source("Wackel.pdf"))
        runner(extractor).run(sources)
        assertEquals(DocStatus.Unsupported, index.document("Geheim.pdf")!!.status)
        assertEquals(DocProblem.Encrypted, index.document("Geheim.pdf")!!.problem)
        assertEquals(DocStatus.Failed, index.document("Wackel.pdf")!!.status)
        assertEquals("nothing due yet", 0, planIndex(sources, index.documents(), clock + 1).work)
        val due = planIndex(sources, index.documents(), clock + 61_000)
        assertEquals(listOf("Wackel.pdf"), due.read.map { it.path })
        docs["Wackel.pdf"] = FakeDoc(listOf("Jetzt lesbar mit ausreichend vielen Zeichen."))
        clock += 61_000
        runner(extractor).run(sources)
        assertEquals(DocStatus.Indexed, index.document("Wackel.pdf")!!.status)
        assertEquals("changed file is tried again", listOf("Geheim.pdf"), planIndex(listOf(source("Geheim.pdf", "2")), index.documents(), clock).read.map { it.path })
    }

    @Test fun aFailingPageDoesNotStopTheDocument() = runBlocking {
        val extractor = FakeExtractor(mutableMapOf("D.pdf" to FakeDoc(listOf("Seite eins ist ganz normal lesbar.", "x", "Seite drei ist ebenfalls lesbar."), failPage = 1)))
        runner(extractor).run(listOf(source("D.pdf")))
        assertEquals(2, hits("lesbar").size)
        assertEquals(DocProblem.OcrFailed, index.problems().single().second.single().problem)
    }

    @Test fun indexSurvivesRestartAndAStaleSchemaIsRebuilt() = runBlocking {
        runner(FakeExtractor(mutableMapOf("P.pdf" to FakeDoc(listOf("Persistenter Inhalt über Thermodynamik."))))).run(listOf(source("P.pdf")))
        db.close()
        db = JdbcIndexDb(File(dir, "index.db")); index = DocIndex(db)
        assertEquals("offline search after restart", 1, hits("thermodynamik").size)
        db.exec("PRAGMA user_version = 99")
        db.close()
        db = JdbcIndexDb(File(dir, "index.db")); index = DocIndex(db)
        assertTrue("an unknown layout is rebuilt, not trusted", hits("thermodynamik").isEmpty())
        assertTrue(planIndex(listOf(source("P.pdf")), index.documents(), clock).read.isNotEmpty())
    }

    @Test fun extrasCarryWorksheetsAndHandwritingWithLabels() = runBlocking {
        val extractor = FakeExtractor(mutableMapOf("Bio.md" to FakeDoc(listOf("Notiz zur Zellteilung."), extras = listOf(
            PageEntry(1, "Mitose Prophase Metaphase", PageSource.Transcript, 0.9, label = "handwriting"),
            PageEntry(1, "Arbeitsblatt Meiose Rekombination", PageSource.Ocr, 0.7, label = "worksheet:1")))))
        runner(extractor).run(listOf(source("Bio.md", kind = DOC_KIND_NOTE)))
        assertEquals("handwriting", hits("prophase").single().label)
        assertEquals("worksheet:1", hits("rekombination").single().label)
        assertEquals("y coordinates are not searchable", "Wellen\nInterferenz", transcriptText("0.2500\tWellen\n0.5100\tInterferenz"))
    }

    @Test fun desktopOcrSidecarIsReusedOnlyForTheSameFile() {
        assertEquals(".fanotes/pdf-ocr/1ba2c32d2214394416152a16830f6af5.json", desktopPdfOcrSidecar("Physik/Skript Wellen.pdf"))
        val expected = mapOf(0 to "4b95f515", 1 to "184bc83a", 7 to "ddf7f6f1", 4095 to "6c04f744", 4096 to "af8811f1", 10000 to "54cb2ee2", 200003 to "16624a4c")
        for ((n, stamp) in expected) {
            val bytes = ByteArray(n) { ((it * 131 + 17) and 0xff).toByte() }
            assertEquals("stamp for $n bytes matches the desktop", stamp, pdfByteStamp(bytes))
            val file = File(dir, "s$n.pdf").apply { writeBytes(bytes) }
            assertEquals("file stamp for $n bytes", stamp, pdfFileStamp(file))
        }
        val raw = """{"format":"fanotes-pdf-ocr-v1","path":"A.pdf","size":120,"mtimeMs":5,"stamp":"0a0b0c0d","pages":[{"page":2,"text":"Gescannte Seite über Zellatmung"}]}"""
        assertEquals("Gescannte Seite über Zellatmung", desktopPdfOcrPages(raw, "A.pdf", 120, "0a0b0c0d")[2])
        assertTrue("another file", desktopPdfOcrPages(raw, "B.pdf", 120, "0a0b0c0d").isEmpty())
        assertTrue("edited file", desktopPdfOcrPages(raw, "A.pdf", 121, "0a0b0c0d").isEmpty())
        assertTrue("changed content", desktopPdfOcrPages(raw, "A.pdf", 120, "ffffffff").isEmpty())
        assertTrue("wrong format", desktopPdfOcrPages(raw.replace("v1", "v9"), "A.pdf", 120, "0a0b0c0d").isEmpty())
        assertTrue("over the desktop page limit", desktopPdfOcrPages(raw.replace("\"page\":2", "\"page\":2001"), "A.pdf", 120, "0a0b0c0d").isEmpty())
    }

    @Test fun rotatedScansPickTheReadableOrientation() {
        val best = bestOrientation(listOf(0 to OcrResult("lI1 ,. ~", 0.21), 90 to OcrResult("Die Lösung der Gleichung ist x gleich drei.", 0.83), 270 to OcrResult("", 0.0)))
        assertEquals(90, best?.first)
        assertEquals(0, bestOrientation(listOf(0 to OcrResult("Gut lesbarer Text auf der Seite.", 0.8), 180 to OcrResult("Gut lesbarer Text auf der Seite.", 0.8)))?.first)
        assertNull(bestOrientation(listOf(0 to OcrResult(" ", 0.9))))
    }

    @Test fun onlyTheGivenDocumentsAreEverIndexed() = runBlocking {
        val extractor = FakeExtractor(mutableMapOf("Sichtbar.md" to FakeDoc(listOf("Sichtbare Notiz über Algebra.")), ".fanotes/schulnetz/snapshot.json" to FakeDoc(listOf("Note 3.5 in Mathematik"))))
        runner(extractor).run(listOf(source("Sichtbar.md", kind = DOC_KIND_NOTE)))
        assertTrue(hits("mathematik").isEmpty())
        assertEquals(listOf("Sichtbar.md"), index.documents().map { it.path })
    }

    @Test fun searchStaysFastOnALargeLibrary() = runBlocking {
        val words = listOf("Energie", "Impuls", "Gleichung", "Funktion", "Ableitung", "Integral", "Zelle", "Enzym", "Gedicht", "Epoche", "Vokabel", "Grammatik", "Säure", "Base", "Molekül", "Strömung", "Spannung", "Widerstand", "Größe", "Übung")
        val random = java.util.Random(7)
        val docs = (1..200).associate { d ->
            "Ordner/Dokument $d.pdf" to FakeDoc((1..10).map { p -> (1..90).joinToString(" ") { words[random.nextInt(words.size)] } + " Marker$d-$p" })
        }.toMutableMap()
        val started = System.nanoTime()
        runner(FakeExtractor(docs), batch = 8).run(docs.keys.map { source(it) })
        val buildMs = (System.nanoTime() - started) / 1_000_000
        val times = (1..100).map { i ->
            val q = listOf(words[i % words.size], words[(i * 7) % words.size].take(4)).joinToString(" ")
            val t0 = System.nanoTime(); index.search(parseDocQuery(q)); (System.nanoTime() - t0) / 1_000_000.0
        }.sorted()
        val p50 = times[49]; val p95 = times[94]
        println("doc-search perf: 2000 pages indexed in ${buildMs} ms, query p50=${"%.1f".format(p50)} ms p95=${"%.1f".format(p95)} ms max=${"%.1f".format(times.last())} ms")
        assertEquals(1, hits("marker137-4").size)
        assertTrue("p95 $p95 ms", p95 < 500)
    }
}
