package ch.fasrv.fanotes.recognition

import ch.fasrv.fanotes.ink.InkStroke
import ch.fasrv.fanotes.ink.NormalizedRect
import ch.fasrv.fanotes.ink.StrokePoint
import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.parseJson
import ch.fasrv.fanotes.json.stringify
import java.io.File
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class RecognitionCoreTest {
    private val hostResults = parseJson(File("src/test/resources/recognition/host-results.json").readText()) as JsonValue.Obj

    private fun recorded(name: String): String = hostResults.obj(name)!!.stringify()

    private fun stroke(vararg points: Pair<Double, Double>, purpose: String? = "handwriting") = InkStroke(
        points = points.mapIndexed { index, (x, y) -> StrokePoint(x, y, index * 8.0, 0.5, 0.0, 0.0, "pen") },
        baseWidth = 2.6,
        pressureEnabled = false,
        color = "#202333",
        purpose = purpose,
    )

    @Test
    fun floatsCrossTheBridgeAsLittleEndianBase64LikeCodecTs() {
        // Buffer.from(new Float32Array([1, -2.5, 0.1, 3.4028234663852886e38]).buffer).toString('base64')
        val reference = "AACAPwAAIMDNzMw9//9/fw=="
        val values = floatArrayOf(1f, -2.5f, 0.1f, Float.MAX_VALUE)
        assertEquals(reference, RecognitionCodec.floatsToBase64(values))
        assertContentEquals(values, RecognitionCodec.base64ToFloats(reference))
        assertFailsWith<IllegalArgumentException> { RecognitionCodec.base64ToFloats("AAA=") }
    }

    @Test
    fun strokesBecomeTheDesktopStrokeShapeWithoutArtOrBrokenSamples() {
        val art = stroke(0.1 to 0.1, 0.2 to 0.2, purpose = "art")
        val broken = stroke(0.1 to Double.NaN)
        val kept = stroke(0.25 to 0.5, 0.3 to 0.5)
        val usable = handwritingStrokes(listOf(art, broken, kept))
        assertEquals(listOf(kept), usable)
        val parsed = parseJson(strokesJson(usable)) as JsonValue.Arr
        val first = parsed.items.single() as JsonValue.Obj
        assertEquals(2.6, first.double("baseWidth"))
        assertEquals(false, first.bool("pressureEnabled"))
        val point = first.array("points")!!.items[1] as JsonValue.Obj
        assertEquals(0.3, point.double("x"))
        assertEquals("pen", point.string("pointerType"))
        val payload = parseJson(pagePayload(RecognitionPage(listOf(art, kept), 900.0, 1273.0, "de", true), mapOf("mode" to "auto"))) as JsonValue.Obj
        assertEquals(1, payload.array("strokes")!!.items.size)
        assertEquals("auto", payload.string("mode"))
        assertEquals(true, payload.bool("neural"))
    }

    @Test
    fun pinnedManifestIsTheDesktopManifest() {
        val desktop = File("../../fanotes/public/ocr/fanotes-ink/manifest.json").readText()
        val pinned = File("../app/src/main/assets/recognition/fanotes-ink-manifest.json").readText()
        assertEquals(desktop, pinned, "Update INK_MODEL_COMMIT and the manifest asset together with the desktop model.")
        val manifest = parseInkModelManifest(pinned)
        assertEquals("ink.onnx", manifest.model.file)
        assertEquals(listOf("de.fnlm", "en.fnlm"), manifest.languageModels.map { it.file })
        assertTrue(manifest.totalBytes in 40_000_000L..64_000_000L)
        assertTrue(INK_MODEL_BASE_URL.startsWith("https://raw.githubusercontent.com/Nikoheld/FaNotes/$INK_MODEL_COMMIT/"))
    }

    @Test
    fun manifestCheckRejectsWhatIsInkManifestRejects() {
        val good = parseJson(File("../app/src/main/assets/recognition/fanotes-ink-manifest.json").readText()) as JsonValue.Obj
        fun mutated(edit: (JsonValue.Obj) -> Unit): String = (parseJson(good.stringify()) as JsonValue.Obj).also(edit).stringify()
        assertFailsWith<InkManifestException> { parseInkModelManifest(mutated { it.put("format", ch.fasrv.fanotes.json.jsonString("other")) }) }
        assertFailsWith<InkManifestException> { parseInkModelManifest(mutated { it.put("classes", ch.fasrv.fanotes.json.jsonNumber(12.0)) }) }
        assertFailsWith<InkManifestException> { parseInkModelManifest(mutated { it.obj("models")!!.obj("desktop")!!.put("file", ch.fasrv.fanotes.json.jsonString("../ink.onnx")) }) }
        assertFailsWith<InkManifestException> { parseInkModelManifest(mutated { it.obj("languageModels")!!.obj("de")!!.put("sha256", ch.fasrv.fanotes.json.jsonString("abc")) }) }
        assertFailsWith<InkManifestException> { parseInkModelManifest("not json") }
    }

    @Test
    fun modelFileCountsOnlyWithMatchingSizeAndDigest() {
        val dir = Files.createTempDirectory("ink-model").toFile()
        try {
            val bytes = "fanotes".toByteArray()
            File(dir, "de.fnlm").writeBytes(bytes)
            val digest = bytes.inputStream().use(::sha256Of)
            assertEquals(64, digest.length)
            assertTrue(inkModelFileValid(dir, InkModelFile("de", "de.fnlm", bytes.size.toLong(), digest)))
            assertFalse(inkModelFileValid(dir, InkModelFile("de", "de.fnlm", bytes.size.toLong(), "0".repeat(64))))
            assertFalse(inkModelFileValid(dir, InkModelFile("de", "de.fnlm", 99, digest)))
            assertFalse(inkModelFileValid(dir, InkModelFile("en", "en.fnlm", bytes.size.toLong(), digest)))
            assertEquals(42, InkModelState.Downloading(21, 50).percent)
            assertEquals("38.4 MB", megabytes(40_257_814))
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun recordedHostAnswersParse() {
        // Recorded from the built host in Chromium with the desktop ink.onnx (see the PR).
        val text = parseConversion(hostValue(recorded("recognizeText")))
        assertEquals("text", text.mode)
        assertEquals("By Trevor Williams. A move", text.value)
        assertEquals("fanotes-ink", text.engine)
        assertTrue(text.confidence in 1..100)
        val glyph = parseConversion(hostValue(recorded("recognizeGlyphOnly")))
        assertEquals("glyphenwerk", glyph.engine)
        val transcript = parseTranscript(hostValue(recorded("transcribe")))
        assertEquals(listOf(TranscriptEntry(0.178571, "By Trevor Williams. A move", "text")), transcript)
        val solved = parseSolverResult(hostValue(recorded("solveLinear")))
        assertEquals(listOf("2*x=4", "x=2"), solved.steps.map { it.expression })
        assertEquals(listOf("intermediate", "result"), solved.steps.map { it.kind })
        assertEquals("x", solved.variable)
        assertEquals("5*x", parseSolverResult(hostValue(recorded("solveSimplify"))).steps.last().expression)
        val checked = parseCheckResult(hostValue(recorded("verifyLines")))
        assertEquals("incorrect", checked.status)
        assertEquals(2, checked.errorLineIndex)
        assertEquals(listOf("start", "correct", "incorrect"), checked.lines.map { it.status })
        assertEquals("Unbekannte Anfrage: nope", assertFailsWith<RecognitionHostException> { hostValue(recorded("unknown")) }.message)
        assertEquals(
            "Im gewählten Bereich wurden nicht mindestens zwei getrennte Rechenzeilen gefunden.",
            assertFailsWith<RecognitionHostException> { hostValue(recorded("checkOneLine")) }.message,
        )
        assertFailsWith<RecognitionHostException> { hostValue("<html>") }
    }

    @Test
    fun checkOutcomeAndVerifyPayloadRoundTrip() {
        val line = MathStepReading("2x=4", "2x=4", 88, recognitionRisk = true, confirmed = false, rect = NormalizedRect(0.1, 0.2, 0.3, 0.05))
        val payload = parseJson(verifyPayload(listOf(line))) as JsonValue.Obj
        val outcome = parseCheckOutcome(
            ch.fasrv.fanotes.json.jsonObject(
                "lines" to payload.array("lines"),
                "result" to hostValue(recorded("verifyLines")),
            ),
        )
        assertEquals(listOf(line), outcome.lines)
        assertEquals("incorrect", outcome.result.status)
        assertEquals("{\"input\":\"x^2=4\",\"action\":\"solve\",\"variable\":\"x\"}", solvePayload("x^2=4", "solve", "x"))
        assertEquals("{\"input\":\"6/8\",\"action\":\"simplify\"}", solvePayload("6/8", "simplify", null))
    }

    @Test
    fun mathInputMatchesCheckMathSolver() {
        // fanotes/scripts/check-math-solver.mjs
        assertEquals("sqrt(x+2)=3", normalizeMathInput("√(x + 2) = 3"))
        assertTrue(assertFailsWith<MathInputException> { normalizeMathInput("x=2=3") }.message!!.contains("einzelne Gleichung"))
        assertTrue(assertFailsWith<MathInputException> { normalizeMathInput("import(x)") }.message!!.contains("nicht erlaubt"))
        assertTrue(assertFailsWith<MathInputException> { normalizeMathInput("x^101") }.message!!.contains("Exponenten"))
        assertEquals("2*x-3/4", normalizeMathInput("2×x − 3÷4"))
        assertEquals("pi*r^2", normalizeMathInput("π·r^2"))
        assertEquals("sqrt(16)", normalizeMathInput("√16"))
        assertEquals("Der ausgewählte mathematische Ausdruck ist leer.", assertFailsWith<MathInputException> { normalizeMathInput("  ") }.message)
        assertTrue(assertFailsWith<MathInputException> { normalizeMathInput("(x+1") }.message!!.contains("Klammerung"))
        assertTrue(assertFailsWith<MathInputException> { normalizeMathInput("x ≤ 2") }.message!!.contains("Zeichen"))
        val inspection = inspectMathInputSyntax("b*y + a*x + B = sin(x)")
        assertEquals(listOf("x", "a", "b", "B", "y"), inspection.variables)
        assertTrue(inspection.isEquation)
        assertEquals(listOf<String>(), inspectMathInputSyntax("2+pi+e").variables)
        assertTrue(assertFailsWith<MathInputException> { inspectMathInputSyntax("a+b+c+d+f+g+h+j+k") }.message!!.contains("zu viele"))
    }

    @Test
    fun transcriptPlanFollowsUpdateHiddenTranscript() {
        assertEquals(TranscriptPlan(0, replace = true), transcriptPlan(current = 40, previous = 0, needsFullRebuild = true))
        assertEquals(TranscriptPlan(16, replace = false), transcriptPlan(current = 50, previous = 40, needsFullRebuild = false))
        assertEquals(TranscriptPlan(0, replace = false), transcriptPlan(current = 10, previous = 0, needsFullRebuild = false))
        assertEquals(TranscriptPlan(0, replace = true), transcriptPlan(current = 30, previous = 40, needsFullRebuild = false))
        assertEquals(TranscriptPlan(160, replace = false), transcriptPlan(current = 400, previous = 420, needsFullRebuild = false))
        assertEquals(TranscriptPlan(376, replace = false), transcriptPlan(current = 420, previous = 400, needsFullRebuild = false))
    }

    @Test
    fun transcriptMergeKeepsAnchorsAndDropsRepeatedLines() {
        val existing = "0.1000\tHallo Welt\n0.3000\tzweite Zeile"
        val merged = mergeTranscript(existing, listOf(TranscriptEntry(0.31, "Zweite  Zeile", "text"), TranscriptEntry(0.5, "x^2", "math")), replace = false)
        assertEquals("0.1000\tHallo Welt\n0.3100\tZweite Zeile\n0.5000\tx^2", merged)
        assertEquals("0.5000\tneu", mergeTranscript(existing, listOf(TranscriptEntry(0.5, "neu", "text")), replace = true))
        assertEquals(existing, mergeTranscript(existing, emptyList(), replace = false))
        val many = (0 until 2_100).map { TranscriptEntry(0.5, "Zeile $it", "text") }
        val capped = mergeTranscript("", many, replace = true).split('\n')
        assertEquals(TRANSCRIPT_MAX_LINES, capped.size)
        assertEquals("0.5000\tZeile 2099", capped.last())
        assertEquals("0.2000\tErste\n0.2000\tZweite", transcriptAfterInsert("Erste\n\nZweite", 0.2))
        // The margin and search read what is written.
        assertEquals(0.31, ch.fasrv.fanotes.desk.inkAnchorForQuery(merged, "zweite"))
    }

    @Test
    fun prefixSignatureNoticesEditsBeforeTheIndexedCount() {
        val a = stroke(0.1 to 0.1, 0.2 to 0.1)
        val b = stroke(0.3 to 0.3, 0.4 to 0.3)
        val c = stroke(0.5 to 0.5, 0.6 to 0.5)
        val before = strokePrefixSignature(listOf(a, b), 2)
        assertEquals(before, strokePrefixSignature(listOf(a, b, c), 2))
        assertTrue(before != strokePrefixSignature(listOf(a, c), 2))
        assertTrue(before != strokePrefixSignature(listOf(a, b.copy(points = b.points.map { it.copy(x = it.x + 0.01) })), 2))
    }

    @Test
    fun conversionAndSolverOutputMatchTheDesktop() {
        assertEquals("\$x^2+1\$", conversionMarkdown("  \$x^2+1\$ ", "math"))
        assertEquals("Hallo", conversionMarkdown(" Hallo ", "text"))
        assertEquals("", conversionMarkdown("$$", "math"))
        assertEquals("Text\n\nHallo\n", appendMarkdownBlock("Text\n\n", "Hallo"))
        assertEquals("Hallo\n", appendMarkdownBlock("", "Hallo"))
        val solved = parseSolverResult(hostValue(recorded("solveLinear")))
        assertEquals("2·x=4\nx=2", solverContinuationText(solved, SolverPlacement.SAME_LINE))
        val simplified = parseSolverResult(hostValue(recorded("solveSimplify")))
        assertEquals("= ${simplified.steps.last().display}", solverContinuationText(simplified, SolverPlacement.SAME_LINE))
        val sample = { label: String, id: String -> ch.fasrv.fanotes.ink.GlyphSample(id, label, id, "s", listOf(0.0, 0.0, 1.0, 1.0), 10.0, 10.0, emptyList()) }
        assertEquals("2x", adaptMathTextToSamples("2·x", emptyList()))
        assertEquals("2×x", adaptMathTextToSamples("2·x", listOf(sample("×", "operator_multiply"))))
        assertEquals("2·sqrt(4)", adaptMathTextToSamples("2·√(4)", listOf(sample("·", "operator_dot"))))
        val rect = NormalizedRect(0.1, 0.2, 0.2, 0.03)
        val layout = solverLayout(simplified, rect, 900.0, 1273.0)
        assertEquals(SolverPlacement.SAME_LINE, layout.placement)
        assertEquals(0.3 * 900 + 14, layout.marginLeft, 1e-9)
        assertEquals(SolverPlacement.NEXT_LINE, solverLayout(solved, rect, 900.0, 1273.0).placement)
        assertEquals(26.0 / 0.73, solverLayout(solved, NormalizedRect(0.1, 0.2, 0.1, 0.001), 900.0, 1273.0).fontSize, 1e-9)
        assertNull(strokesRect(emptyList()))
        assertEquals(NormalizedRect(0.1, 0.1, 0.5, 0.4), strokesRect(listOf(stroke(0.1 to 0.1, 0.6 to 0.5))))
    }

    @Test
    fun glyphCaptureUsesDesktopIdsAndPadSpace() {
        val all = GLYPH_CATEGORIES.flatMap { it.labels }
        assertEquals(all.size, all.map { it.id }.toSet().size)
        assertTrue(all.any { it.id == "latin_lower_a" && it.char == "a" })
        assertTrue(all.any { it.id == "latin_upper_Z" && it.char == "Z" })
        assertTrue(all.any { it.id == "digit_7" })
        assertTrue(all.any { it.id == "german_eszett" && it.char == "ß" })
        assertTrue(all.any { it.id == "operator_multiply" && it.char == "×" })
        val pad = listOf(listOf(PadPoint(50.0, 40.0, 0.0, 0.4, 0.0, 0.0, "pen"), PadPoint(150.0, 160.0, 16.0, 1.4, 0.0, 0.0, "pen")))
        val label = GLYPH_CATEGORIES.first().labels.first()
        val sample = captureGlyphSample(label, pad, 200.0, 200.0, 2.6, true, "tablet-1", "glyphenwerk-tablet")
        assertEquals("a", sample.label)
        assertEquals("latin_lower_a", sample.labelId)
        assertEquals(listOf(0.25, 0.2, 0.5, 0.6000000000000001), sample.bbox)
        assertEquals(1.0, sample.strokes.single().points.last().pressure)
        assertEquals(200.0, sample.sourceWidth)
        assertFailsWith<GlyphCaptureException> { captureGlyphSample(label, emptyList(), 200.0, 200.0, 2.6, true, "x", "s") }
        assertFailsWith<GlyphCaptureException> {
            captureGlyphSample(label, listOf(listOf(PadPoint(5.0, 5.0, 0.0, 0.5, 0.0, 0.0, "pen"))), 200.0, 200.0, 2.6, true, "x", "s")
        }
        val lower = GLYPH_CATEGORIES.first()
        assertEquals("latin_lower_a", nextGlyphToCapture(lower, emptyList())?.id)
        assertEquals("latin_lower_b", nextGlyphToCapture(lower, List(3) { sample })?.id)
        // A captured sample goes through the same library codec as an imported one.
        val decoded = ch.fasrv.fanotes.ink.decodeGlyphLibrary(ch.fasrv.fanotes.ink.encodeGlyphLibrary(listOf(sample))).single()
        assertEquals(sample.labelId, decoded.labelId)
        assertEquals(sample.strokes.single().points.size, decoded.strokes.single().points.size)
    }

    @Test
    fun preferenceAndLanguageDefaults() {
        assertEquals(RecognitionPreference.AUTO, recognitionPreference(null))
        assertEquals(RecognitionPreference.MATH, recognitionPreference("math"))
        assertEquals("de", recognitionLanguage(null))
        assertEquals("en", recognitionLanguage("fr"))
        assertEquals("Grosses A", recognitionUi("Großes A"))
        val language = ch.fasrv.fanotes.desk.ChromeText.language
        val catalog = ch.fasrv.fanotes.desk.ChromeText.catalog
        try {
            ch.fasrv.fanotes.desk.ChromeText.language = "en"
            ch.fasrv.fanotes.desk.ChromeText.catalog = mapOf("Schließen" to "Close", "Laden" to "Download")
            assertEquals("Close", recognitionUi("Schliessen"))
            assertEquals("Download", recognitionUi("Laden"))
            assertEquals("Klasse", recognitionUi("Klasse"))
        } finally {
            ch.fasrv.fanotes.desk.ChromeText.language = language
            ch.fasrv.fanotes.desk.ChromeText.catalog = catalog
        }
    }
}
