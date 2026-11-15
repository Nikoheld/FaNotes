package ch.fasrv.fanotes

import android.content.SharedPreferences
import ch.fasrv.fanotes.desk.DiagnosticsStorage
import ch.fasrv.fanotes.desk.DiagnosticsTransport
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

class PrefsDiagnosticsStorage(private val prefs: SharedPreferences) : DiagnosticsStorage {
    override fun get(key: String): String? = prefs.getString(key, null)
    override fun put(key: String, value: String?) {
        prefs.edit().apply { if (value == null) remove(key) else putString(key, value) }.apply()
    }
}

/**
 * Diagnostics go to the FaNotes host only, with no cookies, no credentials and no referrer. The
 * default OkHttp client keeps no cookies and sends no `Referer` on its own.
 */
class OkHttpDiagnosticsTransport(
    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .writeTimeout(20, TimeUnit.SECONDS)
        .build(),
) : DiagnosticsTransport {
    override suspend fun post(url: String, json: String): Boolean = withContext(Dispatchers.IO) {
        val request = Request.Builder().url(url)
            .header("Cache-Control", "no-store")
            .post(json.toByteArray().toRequestBody("application/json".toMediaType()))
            .build()
        client.newCall(request).execute().use { it.isSuccessful }
    }

    override suspend fun delete(url: String): Boolean = withContext(Dispatchers.IO) {
        val request = Request.Builder().url(url).header("Cache-Control", "no-store").delete().build()
        client.newCall(request).execute().use { it.isSuccessful }
    }
}
