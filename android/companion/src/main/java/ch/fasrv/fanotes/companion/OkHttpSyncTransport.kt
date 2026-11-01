package ch.fasrv.fanotes.companion

import ch.fasrv.fanotes.sync.SyncHttpRequest
import ch.fasrv.fanotes.sync.SyncHttpResponse
import ch.fasrv.fanotes.sync.SyncTransport
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

class OkHttpSyncTransport(
    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .build(),
) : SyncTransport {
    override suspend fun execute(request: SyncHttpRequest): SyncHttpResponse = suspendCancellableCoroutine { continuation ->
        val body = when (request.method) {
            "GET", "HEAD" -> null
            else -> (request.body ?: ByteArray(0)).toRequestBody("application/octet-stream".toMediaType())
        }
        val builder = Request.Builder().url(request.url).method(request.method, body)
        request.headers.forEach { (name, value) -> builder.header(name, value) }
        val call = client.newCall(builder.build())
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(object : okhttp3.Callback {
            override fun onFailure(call: okhttp3.Call, e: java.io.IOException) {
                if (continuation.isActive) continuation.resumeWithException(e)
            }

            override fun onResponse(call: okhttp3.Call, response: okhttp3.Response) {
                response.use {
                    val headers = linkedMapOf<String, String>()
                    for (index in 0 until it.headers.size) headers[it.headers.name(index)] = it.headers.value(index)
                    val bytes = it.body?.bytes() ?: ByteArray(0)
                    if (continuation.isActive) continuation.resume(SyncHttpResponse(it.code, headers, bytes))
                }
            }
        })
    }
}
