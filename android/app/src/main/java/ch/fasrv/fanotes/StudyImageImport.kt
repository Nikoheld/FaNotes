package ch.fasrv.fanotes

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.media.ExifInterface
import android.util.Base64
import ch.fasrv.fanotes.study.ANNOTATION_IMAGE_TARGET_CHARS
import ch.fasrv.fanotes.study.fitWithin
import ch.fasrv.fanotes.study.studyEncodeSteps
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream

/** A picked image turned into what a study annotation stores: a small data URL and its aspect ratio. */
data class StudyImagePayload(val dataUrl: String, val aspect: Double)

/** The image could not be squeezed under the per-image size cap. */
class StudyImageTooLarge : Exception("Das Bild ist zu groß.")

object StudyImageImport {
    /**
     * Re-encodes to a small data URL like desktop `encodeImage`: long edge 1200, PNG only if it stays
     * under [ANNOTATION_IMAGE_TARGET_CHARS] (line art), else JPEG at stepped-down quality, shrinking
     * the edge by 22 % per round. Returns null when [bytes] is not an image; throws [StudyImageTooLarge]
     * when nothing fits.
     */
    fun encode(bytes: ByteArray, mime: String): StudyImagePayload? {
        val png = mime.equals("image/png", true)
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= 2400) sample *= 2
        val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample }) ?: return null
        val upright = rotated(decoded, orientation(bytes))
        var flat: Bitmap? = null
        var flatEdge = -1.0
        try {
            for (step in studyEncodeSteps(png)) {
                if (step.edge != flatEdge) {
                    flat?.recycle()
                    val (w, h) = fitWithin(upright.width, upright.height, step.edge)
                    flat = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888).also { bitmap ->
                        Canvas(bitmap).apply {
                            drawColor(Color.WHITE)
                            drawBitmap(upright, null, android.graphics.Rect(0, 0, w, h), android.graphics.Paint(android.graphics.Paint.FILTER_BITMAP_FLAG))
                        }
                    }
                    flatEdge = step.edge
                }
                val bitmap = flat ?: continue
                val out = ByteArrayOutputStream()
                bitmap.compress(if (step.png) Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG, step.quality, out)
                val url = (if (step.png) "data:image/png;base64," else "data:image/jpeg;base64,") + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
                if (url.length <= ANNOTATION_IMAGE_TARGET_CHARS) return StudyImagePayload(url, bitmap.width.toDouble() / bitmap.height)
            }
        } finally {
            flat?.recycle()
        }
        throw StudyImageTooLarge()
    }

    private fun orientation(bytes: ByteArray): Int = try {
        ExifInterface(ByteArrayInputStream(bytes)).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
    } catch (_: Exception) {
        ExifInterface.ORIENTATION_NORMAL
    }

    private fun rotated(source: Bitmap, orientation: Int): Bitmap {
        val matrix = Matrix()
        when (orientation) {
            ExifInterface.ORIENTATION_ROTATE_90 -> matrix.postRotate(90f)
            ExifInterface.ORIENTATION_ROTATE_180 -> matrix.postRotate(180f)
            ExifInterface.ORIENTATION_ROTATE_270 -> matrix.postRotate(270f)
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.postScale(-1f, 1f)
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> matrix.postScale(1f, -1f)
            else -> return source
        }
        return Bitmap.createBitmap(source, 0, 0, source.width, source.height, matrix, true)
    }
}
