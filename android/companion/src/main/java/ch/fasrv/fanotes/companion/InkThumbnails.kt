package ch.fasrv.fanotes.companion

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.util.LruCache
import ch.fasrv.fanotes.ink.InkDocument
import ch.fasrv.fanotes.ink.InkStroke
import ch.fasrv.fanotes.ink.pressureWidth
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import kotlin.math.max

/** Decoded images and ink list thumbnails. Previews never redraw every stroke on the UI thread. */
object CompanionImageCache {
    private val bitmaps = object : LruCache<String, Bitmap>(12 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Bitmap) = value.byteCount.coerceAtLeast(1)
    }

    fun ink(key: String, width: Int, height: Int): Bitmap? =
        synchronized(bitmaps) { bitmaps.get("ink:$key:${width}x$height") }

    fun putInk(key: String, width: Int, height: Int, bitmap: Bitmap) {
        synchronized(bitmaps) { bitmaps.put("ink:$key:${width}x$height", bitmap) }
    }

    fun image(path: String, modifiedAt: Long): Bitmap? =
        synchronized(bitmaps) { bitmaps.get("img:$path:$modifiedAt") }

    fun putImage(path: String, modifiedAt: Long, bitmap: Bitmap) {
        synchronized(bitmaps) { bitmaps.put("img:$path:$modifiedAt", bitmap) }
    }
}

suspend fun rasterizeInkThumbnail(document: InkDocument, widthPx: Int, heightPx: Int): Bitmap = withContext(Dispatchers.Default) {
    val width = widthPx.coerceAtLeast(1)
    val height = heightPx.coerceAtLeast(1)
    val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    val scale = width / document.sourceWidth.toFloat().coerceAtLeast(1f)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
    document.strokes.take(400).forEach { stroke -> drawThumbnailStroke(canvas, document, stroke, scale, paint) }
    bitmap
}

suspend fun decodeNoteImage(file: File): Bitmap? = withContext(Dispatchers.IO) {
    val cached = CompanionImageCache.image(file.path, file.lastModified())
    if (cached != null) return@withContext cached
    val bitmap = runCatching {
        val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.path, options)
        var sample = 1
        while (options.outWidth / sample > 1600 || options.outHeight / sample > 2400) sample *= 2
        BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample })
    }.getOrNull()
    if (bitmap != null) CompanionImageCache.putImage(file.path, file.lastModified(), bitmap)
    bitmap
}

private fun drawThumbnailStroke(canvas: Canvas, document: InkDocument, stroke: InkStroke, scale: Float, paint: Paint) {
    val points = stroke.points
    if (points.isEmpty()) return
    paint.color = runCatching { android.graphics.Color.parseColor(stroke.color) }.getOrDefault(0xFF202333.toInt())
    paint.alpha = ((stroke.opacity ?: 1.0) * 255).toInt().coerceIn(0, 255)
    val stride = (points.size / 200).coerceAtLeast(1)
    var i = stride
    while (i < points.size) {
        val a = points[i - stride]
        val b = points[i]
        paint.strokeWidth = (pressureWidth(stroke.baseWidth, b.pressure, stroke.pressureEnabled) * scale).toFloat().coerceAtLeast(0.6f)
        canvas.drawLine(
            (a.x * document.sourceWidth * scale).toFloat(),
            (a.y * document.sourceHeight * scale).toFloat(),
            (b.x * document.sourceWidth * scale).toFloat(),
            (b.y * document.sourceHeight * scale).toFloat(),
            paint,
        )
        i += stride
    }
    if (points.size == 1) {
        val point = points.first()
        paint.style = Paint.Style.FILL
        canvas.drawCircle(
            (point.x * document.sourceWidth * scale).toFloat(),
            (point.y * document.sourceHeight * scale).toFloat(),
            max(1f, (stroke.baseWidth * scale).toFloat() / 2),
            paint,
        )
        paint.style = Paint.Style.STROKE
    }
}
