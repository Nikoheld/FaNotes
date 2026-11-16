package ch.fasrv.fanotes

import ch.fasrv.fanotes.desk.WorkRequestsTransport
import ch.fasrv.fanotes.desk.WorkStreamResult
import ch.fasrv.fanotes.sync.SyncHttpRequest
import ch.fasrv.fanotes.sync.SyncHttpResponse
import ch.fasrv.fanotes.sync.SyncTransport
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.Job
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit
import kotlin.coroutines.coroutineContext

/** Plain calls reuse the sync transport; the event stream is read with OkHttp streaming (no read timeout). */
class OkHttpWorkRequestsTransport(
    private val calls: SyncTransport = OkHttpSyncTransport(),
    private val streaming: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build(),
) : WorkRequestsTransport {
    override suspend fun execute(request: SyncHttpRequest): SyncHttpResponse = calls.execute(request)

    override suspend fun stream(request: SyncHttpRequest, onText: suspend (String) -> Unit): WorkStreamResult {
        val builder = Request.Builder().url(request.url).get()
        request.headers.forEach { (name, value) -> builder.header(name, value) }
        val call = streaming.newCall(builder.build())
        return withContext(Dispatchers.IO) {
            // Closing the call unblocks the read when the observer is cancelled.
            val watcher = coroutineContext[Job]?.invokeOnCompletion { call.cancel() }
            try {
            call.execute().use { response ->
                val result = WorkStreamResult(response.code, response.header("Content-Type"))
                if (!response.isSuccessful) return@use result
                val source = response.body?.source() ?: return@use result
                val bytes = ByteArray(4096)
                var carry = ByteArray(0)
                val stream = source.inputStream()
                while (true) {
                    coroutineContext.ensureActive()
                    val count = stream.read(bytes)
                    if (count < 0) break
                    val joined = carry + bytes.copyOf(count)
                    // Keep an incomplete trailing UTF-8 sequence for the next read.
                    var cut = joined.size
                    var back = 0
                    while (back < 3 && cut - 1 - back >= 0 && (joined[cut - 1 - back].toInt() and 0xC0) == 0x80) back += 1
                    if (cut - 1 - back >= 0 && back < 3) {
                        val lead = joined[cut - 1 - back].toInt() and 0xFF
                        val need = when { lead >= 0xF0 -> 4; lead >= 0xE0 -> 3; lead >= 0xC0 -> 2; else -> 1 }
                        if (need > back + 1) cut = cut - 1 - back
                    }
                    carry = joined.copyOfRange(cut, joined.size)
                    if (cut > 0) onText(String(joined, 0, cut, Charsets.UTF_8))
                }
                result
            }
            } finally {
                watcher?.dispose()
            }
        }
    }
}
