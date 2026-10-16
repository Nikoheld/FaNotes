package ch.fasrv.fanotes.ink

import java.io.ByteArrayOutputStream
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class TextToHandwritingTest {
    @Test
    fun theSeedMatchesTheDesktopGenerator() {
        val random = handwritingRandom(7)
        assertEquals(0.011704753153026104, random(), 1e-15)
        assertEquals(0.061958257574588060, random(), 1e-15)
        assertEquals(0.97690763277933002, random(), 1e-15)
        assertEquals(0.69902870571240783, random(), 1e-15)
        assertEquals(0.52144526853226125, random(), 1e-15)
    }

    @Test
    fun sharpSFoldsBeforeTheGlyphsAreChosen() {
        val result = synthesize( "Straße", variation = 0.0)
        assertEquals("Strasse", result.normalizedText)
        assertEquals(7, result.glyphCount)
        assertTrue(result.missingCharacters.isEmpty())
        assertTrue(result.strokes.isNotEmpty())
    }

    @Test
    fun anUmlautUsesTheBaseLetterAndTwoDots() {
        val plain = synthesize("a", variation = 0.0)
        val umlaut = synthesize("ä", variation = 0.0)
        assertEquals(plain.strokes.size + 2, umlaut.strokes.size)
        assertTrue(umlaut.usedSampleIds.contains("school-a"))
    }

    @Test
    fun variationZeroKeepsRepeatedLettersTheSameHeight() {
        val result = synthesize("aa", variation = 0.0, connect = false)
        val heights = result.strokes.map { stroke ->
            val ys = stroke.points.map { it.y }
            ys.max() - ys.min()
        }
        assertEquals(heights[0], heights[2], 1e-9)
        assertEquals(heights[1], heights[3], 1e-9)
    }

    @Test
    fun aMissingCharacterBlocksTheInsert() {
        val result = synthesize("a€", variation = 0.0)
        assertEquals(listOf("€"), result.missingCharacters)
        assertEquals(1, result.glyphCount)
    }

    @Test
    fun joinedLettersAddAConnector() {
        val result = synthesize("ab", variation = 0.0, connect = true)
        assertTrue(result.connectionCount >= 1)
        assertTrue(result.strokes.size > 2)
    }

    @Test
    fun aTallTextGrowsThePageUpToTheWriteCap() {
        val result = synthesize("Zeile\n".repeat(80), variation = 0.0, fontSize = 42.0)
        assertTrue(result.pageHeight >= PAGE_START_HEIGHT)
        assertTrue(result.pageHeight <= WRITE_CAP_HEIGHT)
    }

    @Test
    fun personalSamplesReplaceTheSchoolScript() {
        val personal = schoolScript().first { it.label == "a" }.copy(id = "mine-a", sessionId = "import")
        val mixed = glyphsForSynthesis(listOf(personal))
        assertEquals(1, mixed.count { it.label == "a" })
        assertEquals("mine-a", mixed.first { it.label == "a" }.id)
        val result = synthesizeHandwriting("a", mixed, options(0.0), clockStart = 0.0)
        assertEquals(listOf("mine-a"), result.usedSampleIds)
    }

    @Test
    fun insertingKeepsExistingInkOnTheSamePixelsAndIndexesTheText() {
        val mark = InkStroke(
            points = listOf(StrokePoint(0.25, 0.4, 0.0, 0.5, 0.0, 0.0, "pen")),
            baseWidth = 3.0,
            pressureEnabled = true,
            color = "#202333",
        )
        val session = InkSession(newInkDocument("Notiz", "dots", "2026-01-01T00:00:00Z").copy(strokes = listOf(mark)))
        val before = session.document
        val result = synthesize("Hallo", variation = 0.62, fontSize = 42.0)
        assertTrue(session.insertSynthesized(result, "2026-01-01T00:00:01Z"))
        val kept = session.document.strokes.first().points.first()
        assertEquals(keepMarkOnPage(0.25, before.sourceWidth, session.document.sourceWidth), kept.x, 1e-9)
        assertEquals(keepMarkOnPage(0.4, before.sourceHeight, session.document.sourceHeight), kept.y, 1e-9)
        assertTrue(session.document.strokes.size > 1)
        assertTrue(session.document.extras.string("searchTranscript").orEmpty().contains("Hallo"))
        assertTrue(session.undo())
        assertEquals(1, session.document.strokes.size)
    }

    @Test
    fun aGlyphenWerkZipRoundTripsWithoutThePreviewImage() {
        val line = """{"label_id":"custom-q","unicode":"q","strokes":[{"points":[{"x":0.2,"y":0.3,"pressure":0.4},{"x":0.6,"y":0.8}],"baseWidth":2.5}],"bbox_normalized":[0.2,0.3,0.4,0.5],"source_canvas":{"width":200,"height":80}}"""
        val zip = ByteArrayOutputStream().use { buffer ->
            ZipOutputStream(buffer).use { archive ->
                archive.putNextEntry(ZipEntry("training/manifest.jsonl"))
                archive.write(line.toByteArray())
                archive.closeEntry()
            }
            buffer.toByteArray()
        }
        val imported = importGlyphArchive(zip)
        assertEquals("q", imported.samples.single().label)
        assertEquals(200.0, imported.samples.single().sourceWidth)
        val stored = decodeGlyphLibrary(encodeGlyphLibrary(imported.samples))
        assertEquals(imported.samples.single().strokes.single().points.size, stored.single().strokes.single().points.size)
        assertEquals(imported.samples.single().bbox, stored.single().bbox)
    }

    @Test
    fun twoManifestsInOneZipAreRejected() {
        val zip = ByteArrayOutputStream().use { buffer ->
            ZipOutputStream(buffer).use { archive ->
                archive.putNextEntry(ZipEntry("a/manifest.jsonl"))
                archive.write("{}\n".toByteArray())
                archive.closeEntry()
                archive.putNextEntry(ZipEntry("b/manifest.jsonl"))
                archive.write("{}\n".toByteArray())
                archive.closeEntry()
            }
            buffer.toByteArray()
        }
        assertFailsWith<GlyphImportException> { importGlyphArchive(zip) }
    }

    private fun synthesize(
        text: String,
        variation: Double,
        connect: Boolean = true,
        fontSize: Double = 42.0,
        startY: Double? = null,
    ) = synthesizeHandwriting(
        text,
        schoolScript(),
        options(variation, connect, fontSize, startY),
        clockStart = 1_000.0,
    )

    private fun options(variation: Double, connect: Boolean = true, fontSize: Double = 42.0, startY: Double? = null) =
        HandwritingSynthesisOptions(
            fontSize = fontSize,
            lineSpacing = 1.42,
            variation = variation,
            connectLetters = connect,
            color = "#202333",
            baseWidth = 3.5,
            pressureEnabled = true,
            seed = 7,
            startY = startY,
        )
}
