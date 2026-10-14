package ch.fasrv.fanotes.recognition

import ch.fasrv.fanotes.ink.InkStroke

/**
 * Handwriting recognition stays behind this interface so the Android client
 * can later load the same GlyphenWerk engine the desktop uses.
 *
 * The desktop recognizer lives in the Rust crates compiled to WASM
 * (`fanotes/src/lib/recogWasm`) and in the native OCR workers. A future build
 * can compile that crate with the Android NDK and implement this interface
 * over JNI. Stroke points are already the shared `StrokePoint` shape
 * (x, y, t, pressure, tiltX, tiltY, pointerType in 0–1 page space), so a
 * native port does not need a second ink format.
 */
interface HandwritingRecognizer {
    val available: Boolean
    suspend fun recognize(strokes: List<InkStroke>): String
}

object UnavailableHandwritingRecognizer : HandwritingRecognizer {
    override val available = false
    override suspend fun recognize(strokes: List<InkStroke>): String {
        throw UnsupportedOperationException("GlyphenWerk recognition is not bundled in this build.")
    }
}
