package ch.fasrv.fanotes.companion

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.util.LruCache
import ch.fasrv.fanotes.ink.InkDocument
import ch.fasrv.fanotes.ink.InkStroke
import ch.fasrv.fanotes.ink.PdfInkPage
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

private fun drawThumbnailStroke(canvas: Canvas, document: InkDocument, stroke: InkStroke, scale: Float, paint: Paint) =
    drawInkStroke(canvas, document, stroke, scale, scale, 0.0, paint, maxSegments = 200)

/**
 * Draws one stroke. Ink x runs 0..[InkDocument.sourceWidth] and is multiplied by [scaleX]; ink y is shifted up by [offsetY]
 * ink units and multiplied by [scaleY]. A thumbnail passes a [maxSegments] limit, a page of a PDF draws every segment (0).
 */
private fun drawInkStroke(canvas: Canvas, document: InkDocument, stroke: InkStroke, scaleX: Float, scaleY: Float, offsetY: Double, paint: Paint, maxSegments: Int) {
    val points = stroke.points
    if (points.isEmpty()) return
    paint.style = Paint.Style.STROKE
    paint.color = runCatching { android.graphics.Color.parseColor(stroke.color) }.getOrDefault(0xFF202333.toInt())
    paint.alpha = ((stroke.opacity ?: 1.0) * 255).toInt().coerceIn(0, 255)
    val stride = if (maxSegments > 0) (points.size / maxSegments).coerceAtLeast(1) else 1
    fun px(x: Double) = (x * document.sourceWidth * scaleX).toFloat()
    fun py(y: Double) = ((y * document.sourceHeight - offsetY) * scaleY).toFloat()
    var i = stride
    while (i < points.size) {
        val a = points[i - stride]
        val b = points[i]
        paint.strokeWidth = (pressureWidth(stroke.baseWidth, b.pressure, stroke.pressureEnabled) * scaleX).toFloat().coerceAtLeast(0.6f)
        canvas.drawLine(px(a.x), py(a.y), px(b.x), py(b.y), paint)
        i += stride
    }
    if (points.size == 1) {
        val point = points.first()
        paint.style = Paint.Style.FILL
        canvas.drawCircle(px(point.x), py(point.y), max(1f, (stroke.baseWidth * scaleX).toFloat() / 2), paint)
        paint.style = Paint.Style.STROKE
    }
}

/**
 * Draws the strokes of [document] that lie on [page] (see [pdfInkPages]) into [bitmap], which holds that page
 * rendered at any resolution. The mapping is the one the FaNotes Android app uses for the desktop's handwriting.
 */
fun drawInkOnPdfPage(bitmap: Bitmap, document: InkDocument, page: PdfInkPage) {
    if (document.strokes.isEmpty() || page.height <= 0.0 || page.width <= 0.0) return
    val canvas = Canvas(bitmap)
    val scaleX = bitmap.width / page.width.toFloat()
    val scaleY = bitmap.height / page.height.toFloat()
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
    val bottom = page.top + page.height
    document.strokes.forEach { stroke ->
        var low = Double.MAX_VALUE
        var high = -Double.MAX_VALUE
        for (point in stroke.points) { val y = point.y * document.sourceHeight; if (y < low) low = y; if (y > high) high = y }
        val margin = stroke.baseWidth * 2
        if (stroke.points.isNotEmpty() && high + margin >= page.top && low - margin <= bottom) {
            drawInkStroke(canvas, document, stroke, scaleX, scaleY, page.top, paint, maxSegments = 0)
        }
    }
}

/**
 * The whole page of [document] for the read view, [widthPx] wide, shrunk so the bitmap stays within [maxBytes]
 * (a long handwritten page would otherwise need a bitmap many screens tall). Null when even that does not fit.
 */
suspend fun rasterizeInkPage(document: InkDocument, widthPx: Int, maxBytes: Long = 16L * 1024 * 1024): Bitmap? = withContext(Dispatchers.Default) {
    val ratio = (document.sourceHeight / document.sourceWidth.coerceAtLeast(1.0)).coerceIn(0.05, 400.0)
    var width = widthPx.coerceAtLeast(1)
    while (width > 64 && width.toLong() * (width * ratio).toLong() * 4L > maxBytes) width = (width * 0.8).toInt()
    val height = (width * ratio).toInt().coerceIn(1, 32_000)
    try {
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        val scale = width / document.sourceWidth.toFloat().coerceAtLeast(1f)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
        document.strokes.forEach { stroke -> drawInkStroke(canvas, document, stroke, scale, scale, 0.0, paint, maxSegments = 0) }
        bitmap
    } catch (_: OutOfMemoryError) { null }
}

/** The power-of-two `inSampleSize` that brings an image of [width] x [height] within [maxSide] pixels on its longest side and [maxBytes] of ARGB_8888. */
fun imageSampleSize(width: Int, height: Int, maxSide: Int = 4096, maxBytes: Long = 24L * 1024 * 1024): Int {
    if (width <= 0 || height <= 0) return 1
    var sample = 1
    while ((max(width, height) / sample > maxSide || (width / sample).toLong() * (height / sample) * 4L > maxBytes) && sample < 1 shl 16) sample *= 2
    return sample
}

/** A list thumbnail of an image file, sampled down while decoding and cached like the ink thumbnails. Null when it cannot be decoded. */
suspend fun decodeFileThumbnail(file: File, widthPx: Int, heightPx: Int): Bitmap? = withContext(Dispatchers.IO) {
    val key = "thumb:${file.path}:${widthPx}x$heightPx"
    val modified = file.lastModified()
    CompanionImageCache.image(key, modified)?.let { return@withContext it }
    try {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.path, bounds)
        var sample = 1
        // Keep at least the tile size, so the crop stays sharp.
        while (bounds.outWidth / (sample * 2) >= widthPx && bounds.outHeight / (sample * 2) >= heightPx) sample *= 2
        val decoded = BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = max(sample, imageSampleSize(bounds.outWidth, bounds.outHeight)) })
        decoded?.also { CompanionImageCache.putImage(key, modified, it) }
    } catch (_: Exception) { null } catch (_: OutOfMemoryError) { null }
}
