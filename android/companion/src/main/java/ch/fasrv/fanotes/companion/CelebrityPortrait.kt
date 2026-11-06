package ch.fasrv.fanotes.companion

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

private val portraitClient: OkHttpClient = OkHttpClient.Builder()
    .callTimeout(4, TimeUnit.SECONDS)
    .followRedirects(false)
    .followSslRedirects(false)
    .build()

private const val PORTRAIT_CAP = 2_000_000

/**
 * Loads one Commons portrait. Redirects may land only on https Commons or
 * upload.wikimedia.org. A failure returns null so the caller can retry
 * or pick another person of the same age, never a different picture.
 * [maxEdge] keeps the decoded bitmap small enough for a notification.
 */
fun fetchCelebrityPortrait(pageUrl: String, maxEdge: Int = 960): Bitmap? {
    if (!pageUrl.startsWith("https://commons.wikimedia.org/wiki/Special:FilePath/")) return null
    return try {
        loadPortrait(pageUrl, maxEdge.coerceIn(64, 960))
    } catch (_: Exception) {
        null
    }
}

private fun loadPortrait(pageUrl: String, maxEdge: Int): Bitmap? {
    var url = pageUrl
    repeat(4) {
        val request = Request.Builder().url(url).header("User-Agent", "KantiPlus/celebrity-portrait").build()
        portraitClient.newCall(request).execute().use { response ->
            if (response.code in 300..399) {
                val location = response.header("Location") ?: return null
                val next = response.request.url.resolve(location) ?: return null
                if (next.scheme != "https") return null
                val host = next.host.lowercase()
                if (host != "upload.wikimedia.org" && host != "commons.wikimedia.org") return null
                url = next.toString()
            } else if (!response.isSuccessful) {
                return null
            } else {
                val host = response.request.url.host.lowercase()
                if (host != "upload.wikimedia.org" && host != "commons.wikimedia.org") return null
                val body = response.body ?: return null
                val declared = body.contentLength()
                if (declared > PORTRAIT_CAP) return null
                val bytes = readCapped(body) ?: return null
                return decodePortrait(bytes, maxEdge)
            }
        }
    }
    return null
}

private fun readCapped(body: okhttp3.ResponseBody): ByteArray? {
    body.byteStream().use { input ->
        val out = java.io.ByteArrayOutputStream()
        val buf = ByteArray(8192)
        var total = 0
        while (true) {
            val n = input.read(buf)
            if (n < 0) break
            total += n
            if (total > PORTRAIT_CAP) return null
            out.write(buf, 0, n)
        }
        if (total < 1) return null
        return out.toByteArray()
    }
}

private fun decodePortrait(bytes: ByteArray, maxEdge: Int): Bitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    var sample = 1
    while (sample < 64 && (bounds.outWidth / sample > maxEdge || bounds.outHeight / sample > maxEdge)) sample *= 2
    if (bounds.outWidth / sample > maxEdge || bounds.outHeight / sample > maxEdge) return null
    val options = BitmapFactory.Options().apply { inSampleSize = sample }
    return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
}
