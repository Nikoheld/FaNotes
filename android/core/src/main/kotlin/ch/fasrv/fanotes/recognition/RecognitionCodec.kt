package ch.fasrv.fanotes.recognition

import ch.fasrv.fanotes.ink.InkStroke
import ch.fasrv.fanotes.json.escapeJson
import ch.fasrv.fanotes.json.jsNumber
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Base64

/**
 * What crosses the JavaScript bridge of the recognition host (`fanotes/src/recognitionHost`).
 * Float arrays travel as base64 of their little-endian bytes (`codec.ts`), strokes as the
 * desktop `Stroke` JSON in normalized page coordinates.
 */
object RecognitionCodec {
    fun floatsToBase64(values: FloatArray): String {
        val buffer = ByteBuffer.allocate(values.size * 4).order(ByteOrder.LITTLE_ENDIAN)
        buffer.asFloatBuffer().put(values)
        return Base64.getEncoder().encodeToString(buffer.array())
    }

    fun base64ToFloats(encoded: String): FloatArray {
        val bytes = Base64.getDecoder().decode(encoded)
        require(bytes.size % 4 == 0) { "Das Linienbild ist unvollständig." }
        val out = FloatArray(bytes.size / 4)
        ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer().get(out)
        return out
    }
}

/**
 * Strokes the recognizers read: everything except drawing-mode art (`isHandwritingStroke`), and
 * nothing with a non-finite sample (`usableStrokeIndexes` in `inkRecognition.ts` skips those too).
 */
fun handwritingStrokes(strokes: List<InkStroke>): List<InkStroke> = strokes.filter { stroke ->
    stroke.purpose != "art" && stroke.points.isNotEmpty() && stroke.points.all {
        it.x.isFinite() && it.y.isFinite() && it.t.isFinite() && it.pressure.isFinite() && it.tiltX.isFinite() && it.tiltY.isFinite()
    }
}

/** The desktop engine's `Stroke[]` (`src/types.ts`), written directly: a page can hold 100k points. */
fun strokesJson(strokes: List<InkStroke>): String = buildString(strokes.sumOf { it.points.size } * 64 + 16) {
    append('[')
    strokes.forEachIndexed { index, stroke ->
        if (index > 0) append(',')
        append("{\"baseWidth\":").append(jsNumber(stroke.baseWidth))
        append(",\"pressureEnabled\":").append(stroke.pressureEnabled)
        append(",\"points\":[")
        stroke.points.forEachIndexed { pointIndex, point ->
            if (pointIndex > 0) append(',')
            append("{\"x\":").append(jsNumber(point.x))
            append(",\"y\":").append(jsNumber(point.y))
            append(",\"t\":").append(jsNumber(point.t))
            append(",\"pressure\":").append(jsNumber(point.pressure))
            append(",\"tiltX\":").append(jsNumber(point.tiltX))
            append(",\"tiltY\":").append(jsNumber(point.tiltY))
            append(",\"pointerType\":").append(escapeJson(point.pointerType))
            append('}')
        }
        append("]}")
    }
    append(']')
}
