package ch.fasrv.fanotes

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import android.util.LruCache
import ch.fasrv.fanotes.study.StudyImage
import java.util.concurrent.Executors

/**
 * Reference images of study annotations. The note stores them as `data:image/...;base64,...`
 * strings (up to 1.6 MB each); drawing one on every frame would decode it every time. This
 * decodes once per size bucket, off the UI thread, downsampled to what the page shows, and
 * keeps the bitmaps in a byte-bounded LRU.
 */
class StudyImageCache(private val onReady: () -> Unit) {
    private val cache = object : LruCache<String, Bitmap>(CACHE_BYTES) {
        override fun sizeOf(key: String, value: Bitmap) = value.byteCount
    }
    private val pending = HashSet<String>()
    private val failed = HashSet<String>()
    private val pool = Executors.newSingleThreadExecutor { r -> Thread(r, "study-images").apply { isDaemon = true } }

    /** The bitmap for [image] sized for [targetPx] on screen, or null while it decodes (a redraw follows). */
    fun get(image: StudyImage, targetPx: Int): Bitmap? {
        val bucket = bucketOf(targetPx)
        val key = keyOf(image, bucket)
        cache.get(key)?.let { return it }
        // Any larger or smaller decode of the same image beats a blank frame while the right one loads.
        val fallback = (MIN_BUCKET..MAX_BUCKET step BUCKET_STEP).firstNotNullOfOrNull { cache.get(keyOf(image, it)) }
        if (key in failed) return fallback
        synchronized(pending) {
            if (!pending.add(key)) return fallback
        }
        val src = image.src
        pool.execute {
            val bitmap = try { decode(src, bucket) } catch (_: Throwable) { null }
            synchronized(pending) { pending.remove(key) }
            if (bitmap != null) cache.put(key, bitmap) else synchronized(failed) { failed.add(key) }
            onReady()
        }
        return fallback
    }

    fun clear() {
        cache.evictAll()
        synchronized(failed) { failed.clear() }
    }

    fun shutdown() {
        pool.shutdownNow()
        cache.evictAll()
    }

    private fun keyOf(image: StudyImage, bucket: Int) = "${image.id}|${image.src.length}|${image.src.hashCode()}|$bucket"

    companion object {
        private const val CACHE_BYTES = 32 * 1024 * 1024
        private const val MIN_BUCKET = 256
        private const val MAX_BUCKET = 2048
        private const val BUCKET_STEP = 256

        fun bucketOf(targetPx: Int): Int {
            val clamped = targetPx.coerceIn(MIN_BUCKET, MAX_BUCKET)
            return ((clamped + BUCKET_STEP - 1) / BUCKET_STEP) * BUCKET_STEP
        }

        /** Decodes the data URL with `inSampleSize` so the long edge is at most [maxEdge]. */
        fun decode(dataUrl: String, maxEdge: Int): Bitmap? {
            val comma = dataUrl.indexOf(',')
            if (comma < 0) return null
            val bytes = Base64.decode(dataUrl.substring(comma + 1), Base64.DEFAULT)
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
            var sample = 1
            while (max(bounds.outWidth, bounds.outHeight) / (sample * 2) >= maxEdge) sample *= 2
            val options = BitmapFactory.Options().apply {
                inSampleSize = sample
                inPreferredConfig = Bitmap.Config.ARGB_8888
            }
            return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
        }

        private fun max(a: Int, b: Int) = if (a > b) a else b
    }
}
