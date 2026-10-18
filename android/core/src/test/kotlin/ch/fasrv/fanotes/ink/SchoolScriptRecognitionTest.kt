package ch.fasrv.fanotes.ink

import ch.fasrv.fanotes.desk.searchTranscriptHits
import ch.fasrv.fanotes.recognition.SchoolScriptHandwritingRecognizer
import ch.fasrv.fanotes.recognition.recognizeSchoolScript
import ch.fasrv.fanotes.vault.DirectoryVault
import ch.fasrv.fanotes.vault.NoteStore
import java.nio.file.Files
import java.util.Locale
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking

class SchoolScriptRecognitionTest {
    @Test
    fun placedSchoolScriptRoundTripsFromStrokesAlone() {
        for (phrase in listOf("am See", "der Mond")) {
            val strokes = place(phrase).strokes
            assertEquals(fold(phrase), fold(recognizeSchoolScript(strokes)))
            val throughTheSeam = runBlocking { SchoolScriptHandwritingRecognizer.recognize(strokes) }
            assertEquals(fold(phrase), fold(throughTheSeam))
        }
    }

    @Test
    fun aStraightLineOrSnappedShapeYieldsNoWords() {
        val line = (0..30).map { index ->
            val t = index / 30.0
            StrokePoint(0.18 + 0.64 * t, 0.46, index.toDouble(), 0.5, 0.0, 0.0, "pen")
        }
        assertEquals("", recognizeSchoolScript(listOf(ink(line))))

        val rough = (0..64).map { index ->
            val angle = -PI / 2 + PI * 2 * index / 64
            val radius = 120.0
            StrokePoint(
                x = 0.5 + cos(angle) * radius / PAGE_START_WIDTH,
                y = 0.42 + sin(angle) * radius / PAGE_START_HEIGHT,
                t = index.toDouble(),
                pressure = 0.55,
                tiltX = 0.0,
                tiltY = 0.0,
                pointerType = "pen",
            )
        }
        val snapped = snapStrokeToShape(rough, PAGE_START_WIDTH, PAGE_START_HEIGHT)
        assertNotNull(snapped)
        assertEquals("", recognizeSchoolScript(listOf(ink(snapped.points))))
    }

    @Test
    fun committingRecognizedHandwritingMakesTheWordsSearchable() {
        val phrase = "am See"
        val strokes = place(phrase).strokes
        val root = Files.createTempDirectory("fanotes-school-script")
        val store = NoteStore(DirectoryVault(root))
        val path = store.createMarkdown("Schule", "Blatt")
        val note = store.readNote(path)
        val session = InkSession(note.document)
        val recognized = session.commitHandwriting(strokes, "2026-10-18T12:00:00Z")
        assertEquals(fold(phrase), fold(recognized))
        store.save(note, session.document, note.markdown, "2026-10-18T12:00:00Z")
        val saved = store.readNote(path)
        val transcript = saved.document.extras.string("searchTranscript").orEmpty()
        assertTrue(Regex("""\d+\.\d{4}\t""").containsMatchIn(transcript))
        val hits = searchTranscriptHits(listOf(path to transcript), phrase)
        assertEquals(1, hits.size)
        assertEquals(fold(phrase), fold(hits.single().text))
        assertTrue(hits.single().text.any { it.isLetter() })
    }

    private fun place(phrase: String) = synthesizeHandwriting(
        phrase,
        schoolScript(),
        HandwritingSynthesisOptions(
            fontSize = 42.0,
            lineSpacing = 1.42,
            variation = 0.0,
            connectLetters = true,
            color = "#202333",
            baseWidth = 3.5,
            pressureEnabled = true,
            seed = 7,
        ),
        clockStart = 1_000.0,
    )

    private fun ink(points: List<StrokePoint>) = InkStroke(
        points = points,
        baseWidth = 3.5,
        pressureEnabled = true,
        color = "#202333",
        purpose = "handwriting",
        brush = "fineliner",
        opacity = 1.0,
        colorEffect = "solid",
    )

    private fun fold(value: String) = value.trim().replace(Regex("""\s+"""), " ").lowercase(Locale.GERMAN)
}
