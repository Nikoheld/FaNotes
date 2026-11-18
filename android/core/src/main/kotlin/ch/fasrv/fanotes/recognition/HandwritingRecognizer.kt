package ch.fasrv.fanotes.recognition

import ch.fasrv.fanotes.ink.InkStroke

/**
 * Plain text recognition of a list of strokes.
 *
 * The tablet runs the desktop recognizers themselves: the app's `WebInkRecognizer` hosts
 * `fanotes/src/recognitionHost` (GlyphenWerk glyph recognizer, FaNotes ink recognizer with its
 * WASM decoder, math solver and step checker) in a headless WebView and runs the desktop's ONNX
 * line model in ONNX Runtime for Android. [InkRecognitionEngine] is the full interface;
 * [EngineHandwritingRecognizer] adapts it to this one. Stroke points stay the shared
 * `StrokePoint` shape (x, y, t, pressure, tiltX, tiltY, pointerType in 0–1 page space).
 */
interface HandwritingRecognizer {
    val available: Boolean
    suspend fun recognize(strokes: List<InkStroke>): String
}

/** Builds without the web bundle (no Node at build time) have no recognizer. */
object UnavailableHandwritingRecognizer : HandwritingRecognizer {
    override val available = false
    override suspend fun recognize(strokes: List<InkStroke>): String {
        throw UnsupportedOperationException("Die Handschrifterkennung ist in diesem Build nicht enthalten.")
    }
}

/** Text conversion of [strokes] on a `width × height` page through [engine]. */
class EngineHandwritingRecognizer(
    private val engine: InkRecognitionEngine,
    private val width: Double,
    private val height: Double,
    private val language: String,
) : HandwritingRecognizer {
    override val available = true
    override suspend fun recognize(strokes: List<InkStroke>): String =
        engine.recognize(RecognitionPage(strokes, width, height, language, engine.neuralInstalled), RecognitionPreference.TEXT, "text").value
}
