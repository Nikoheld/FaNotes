package ch.fasrv.fanotes.sync

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.parseJson
import java.nio.charset.StandardCharsets
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

const val SYNC_ORIGIN = "https://fanotes.fasrv.ch"
const val SYNC_API_PATH = "/api/v1/sync"

data class SyncSession(val accountId: String, val deviceId: String, val token: String, val expiresAt: String, val email: String)

data class SyncRemoteEntry(
    val id: String,
    val revision: Long,
    val deleted: Boolean,
    val size: Long,
    val sha256: String?,
    val meta: String?,
    val updatedAt: String?,
    val deviceId: String?,
)

data class SyncChangesPage(val revision: Long, val entries: List<SyncRemoteEntry>, val more: Boolean, val nextSince: Long)

data class SyncDevice(
    val id: String,
    val name: String,
    val platform: String,
    val current: Boolean,
    val lastSeenAt: String = "",
)

private val SYNC_SEEN = DateTimeFormatter.ofPattern("d. MMM yyyy, HH:mm", Locale.GERMAN)

/** Desktop `formatWhen` for a device's last activity. */
fun syncDeviceSeenLabel(iso: String?, zone: ZoneId = ZoneId.systemDefault()): String {
    if (iso.isNullOrBlank()) return "noch nie"
    val instant = runCatching { Instant.parse(iso) }.getOrNull() ?: return "unbekannt"
    return SYNC_SEEN.format(instant.atZone(zone))
}

fun syncDeviceTitle(name: String, current: Boolean) = if (current) "$name$SYNC_DEVICE_MARK" else name

/** The signed-in device stays. Every other device can be signed out. */
fun syncDeviceCanSignOut(current: Boolean) = !current

fun syncDeviceIsPhone(platform: String) = platform == "web" || platform == "browser-preview"

/** Web sessions use the phone glyph. Every other platform uses the laptop glyph. */
fun syncDeviceGlyph(platform: String) = if (syncDeviceIsPhone(platform)) "phone" else "laptop"

const val SYNC_DEVICE_ICON_DP = 13
const val SYNC_DEVICE_ICON_GAP_DP = 6
const val SYNC_DEVICE_MARK = " · dieses Gerät"
const val SYNC_DEVICE_MARK_SP = 12
const val SYNC_DEVICE_MARK_WEIGHT = 600

data class SyncAccountInfo(
    val accountId: String,
    val email: String,
    val revision: Long,
    val files: Int,
    val bytes: Long,
    val quotaBytes: Long,
    val devices: List<SyncDevice>,
)

class SyncApiError(val status: Int, message: String, val entry: SyncRemoteEntry? = null) : Exception(message) {
    val unauthorized get() = status == 401
    val conflict get() = status == 409
    val offline get() = status == 0
}

data class SyncHttpRequest(val method: String, val url: String, val headers: Map<String, String>, val body: ByteArray?)
data class SyncHttpResponse(val status: Int, val headers: Map<String, String>, val body: ByteArray)

fun interface SyncTransport {
    suspend fun execute(request: SyncHttpRequest): SyncHttpResponse
}

class SyncApi(
    private val transport: SyncTransport,
    private val origin: String = SYNC_ORIGIN,
) {
    suspend fun prelogin(email: String): SyncKdf {
        val json = post("/prelogin", """{"email":${ch.fasrv.fanotes.json.escapeJson(email)}}""", retry = true)
        val kdf = (json as JsonValue.Obj).obj("kdf") ?: throw SyncApiError(500, "The server sent no key parameters.")
        return SyncKdf(
            kdf.string("algorithm") ?: "",
            kdf.double("iterations")?.toInt() ?: 0,
            kdf.string("salt") ?: "",
        )
    }

    suspend fun register(email: String, authKey: String, kdf: SyncKdf, wrap: SyncKeyWrap, deviceName: String, platform: String): RegisterResult {
        val body = """{"email":${ch.fasrv.fanotes.json.escapeJson(email)},"authKey":${ch.fasrv.fanotes.json.escapeJson(authKey)},"kdf":{"algorithm":"$KDF_ALGORITHM","iterations":${kdf.iterations},"salt":${ch.fasrv.fanotes.json.escapeJson(kdf.salt)}},"vaultKeyWrap":{"iv":${ch.fasrv.fanotes.json.escapeJson(wrap.iv)},"data":${ch.fasrv.fanotes.json.escapeJson(wrap.data)}},"device":{"name":${ch.fasrv.fanotes.json.escapeJson(deviceName)},"platform":${ch.fasrv.fanotes.json.escapeJson(platform)}}}"""
        val json = post("/register", body) as JsonValue.Obj
        return RegisterResult(
            json.string("accountId") ?: error("accountId"),
            json.string("deviceId") ?: error("deviceId"),
            json.string("token") ?: error("token"),
            json.string("expiresAt") ?: "",
            json.double("revision")?.toLong() ?: 0L,
        )
    }

    suspend fun login(email: String, authKey: String, deviceName: String, platform: String): LoginResult {
        val body = """{"email":${ch.fasrv.fanotes.json.escapeJson(email)},"authKey":${ch.fasrv.fanotes.json.escapeJson(authKey)},"device":{"name":${ch.fasrv.fanotes.json.escapeJson(deviceName)},"platform":${ch.fasrv.fanotes.json.escapeJson(platform)}}}"""
        val json = post("/login", body) as JsonValue.Obj
        val kdf = json.obj("kdf")
        val wrap = json.obj("vaultKeyWrap")
        return LoginResult(
            accountId = json.string("accountId") ?: error("accountId"),
            deviceId = json.string("deviceId") ?: error("deviceId"),
            token = json.string("token") ?: error("token"),
            expiresAt = json.string("expiresAt") ?: "",
            kdf = SyncKdf(kdf?.string("algorithm") ?: "", kdf?.double("iterations")?.toInt() ?: 0, kdf?.string("salt") ?: ""),
            vaultKeyWrap = SyncKeyWrap(wrap?.string("iv") ?: "", wrap?.string("data") ?: ""),
            revision = json.double("revision")?.toLong() ?: 0L,
        )
    }

    suspend fun account(session: SyncSession): SyncAccountInfo {
        val json = request("GET", "/account", session) as JsonValue.Obj
        val usage = json.obj("usage")
        val devices = json.array("devices")?.items.orEmpty().mapNotNull { item ->
            val obj = item as? JsonValue.Obj ?: return@mapNotNull null
            SyncDevice(
                obj.string("id") ?: return@mapNotNull null,
                obj.string("name") ?: "",
                obj.string("platform") ?: "",
                obj.bool("current") == true,
                obj.string("lastSeenAt").orEmpty(),
            )
        }
        return SyncAccountInfo(
            json.string("accountId") ?: session.accountId,
            json.string("email") ?: session.email,
            json.double("revision")?.toLong() ?: 0L,
            usage?.double("files")?.toInt() ?: 0,
            usage?.double("bytes")?.toLong() ?: 0L,
            usage?.double("quotaBytes")?.toLong() ?: 0L,
            devices,
        )
    }

    suspend fun logout(session: SyncSession) {
        request("POST", "/logout", session)
    }

    suspend fun removeDevice(session: SyncSession, deviceId: String) {
        request("DELETE", "/devices/$deviceId", session)
    }

    suspend fun changePassword(session: SyncSession, currentAuth: String, newAuth: String, kdf: SyncKdf, wrap: SyncKeyWrap) {
        val body = """{"authKey":${ch.fasrv.fanotes.json.escapeJson(currentAuth)},"newAuthKey":${ch.fasrv.fanotes.json.escapeJson(newAuth)},"kdf":{"algorithm":${ch.fasrv.fanotes.json.escapeJson(kdf.algorithm)},"iterations":${kdf.iterations},"salt":${ch.fasrv.fanotes.json.escapeJson(kdf.salt)}},"vaultKeyWrap":{"iv":${ch.fasrv.fanotes.json.escapeJson(wrap.iv)},"data":${ch.fasrv.fanotes.json.escapeJson(wrap.data)}}}"""
        post("/password", body, session)
    }

    suspend fun deleteAccount(session: SyncSession, authKey: String) {
        raw(
            "DELETE",
            "/account",
            session,
            """{"authKey":${ch.fasrv.fanotes.json.escapeJson(authKey)}}""".toByteArray(StandardCharsets.UTF_8),
            mapOf("Content-Type" to "application/json"),
        )
    }

    suspend fun changes(session: SyncSession, since: Long): SyncChangesPage {
        val json = request("GET", "/changes?since=$since", session) as JsonValue.Obj
        val entries = json.array("entries")?.items.orEmpty().mapNotNull { (it as? JsonValue.Obj)?.toEntry() }
        return SyncChangesPage(
            json.double("revision")?.toLong() ?: since,
            entries,
            json.bool("more") == true,
            json.double("nextSince")?.toLong() ?: since,
        )
    }

    suspend fun download(session: SyncSession, fileId: String): DownloadResult {
        val response = raw("GET", "/files/$fileId", session)
        val headers = response.headers
        val revision = header(headers, "x-fanotes-revision")?.toLongOrNull() ?: 0L
        if (response.status == 204 || header(headers, "x-fanotes-deleted") == "1") return DownloadResult.Deleted(revision)
        return DownloadResult.Blob(
            revision,
            header(headers, "x-fanotes-meta") ?: "",
            header(headers, "x-fanotes-sha256") ?: "",
            response.body,
        )
    }

    suspend fun upload(session: SyncSession, fileId: String, baseRevision: Long, meta: String, sha256: String, blob: ByteArray): Long {
        val response = raw(
            "PUT",
            "/files/$fileId",
            session,
            blob,
            mapOf(
                "Content-Type" to "application/octet-stream",
                "If-Match" to baseRevision.toString(),
                "X-FaNotes-Meta" to meta,
                "X-FaNotes-Sha256" to sha256,
            ),
        )
        val json = parseJson(response.body.toString(StandardCharsets.UTF_8)) as JsonValue.Obj
        return json.double("revision")?.toLong() ?: error("revision")
    }

    suspend fun remove(session: SyncSession, fileId: String, baseRevision: Long): Long {
        val response = raw("DELETE", "/files/$fileId", session, headers = mapOf("If-Match" to baseRevision.toString()))
        if (response.body.isEmpty()) return baseRevision
        val json = parseJson(response.body.toString(StandardCharsets.UTF_8)) as? JsonValue.Obj
        return json?.double("revision")?.toLong() ?: baseRevision
    }

    private suspend fun post(path: String, body: String, session: SyncSession? = null, retry: Boolean = false): JsonValue {
        val response = raw("POST", path, session, body.toByteArray(StandardCharsets.UTF_8), mapOf("Content-Type" to "application/json"), retry)
        if (response.body.isEmpty()) return JsonValue.Obj()
        return parseJson(response.body.toString(StandardCharsets.UTF_8))
    }

    private suspend fun request(method: String, path: String, session: SyncSession): JsonValue {
        val response = raw(method, path, session)
        if (response.status == 204 || response.body.isEmpty()) return JsonValue.Obj()
        return parseJson(response.body.toString(StandardCharsets.UTF_8))
    }

    private suspend fun raw(
        method: String,
        path: String,
        session: SyncSession?,
        body: ByteArray? = null,
        headers: Map<String, String> = emptyMap(),
        retry: Boolean = method == "GET",
    ): SyncHttpResponse {
        val all = headers.toMutableMap()
        if (session != null) {
            all["Authorization"] = "Bearer ${session.token}"
            all["X-FaNotes-Account"] = session.accountId
        }
        val request = SyncHttpRequest(method, "$origin$SYNC_API_PATH$path", all, body)
        var last: Exception? = null
        val attempts = if (retry) 2 else 1
        for (attempt in 0 until attempts) {
            try {
                val response = transport.execute(request)
                if (response.status in 200..299) return response
                throw parseError(response)
            } catch (error: SyncApiError) {
                throw error
            } catch (error: Exception) {
                last = error
                if (attempt + 1 < attempts) continue
            }
        }
        throw SyncApiError(0, "The sync server is unreachable.", null).also { it.initCause(last) }
    }
}

private fun parseError(response: SyncHttpResponse): SyncApiError {
    var message = "The sync server responded with ${response.status}."
    var entry: SyncRemoteEntry? = null
    try {
        val body = parseJson(response.body.toString(StandardCharsets.UTF_8)) as? JsonValue.Obj
        if (body != null) {
            body.string("error")?.let { message = it }
            entry = body.obj("entry")?.toEntry()
        }
    } catch (_: Exception) {
        // Not JSON.
    }
    return SyncApiError(response.status, message, entry)
}

private fun JsonValue.Obj.toEntry(): SyncRemoteEntry = SyncRemoteEntry(
    id = string("id") ?: "",
    revision = double("revision")?.toLong() ?: 0L,
    deleted = bool("deleted") == true,
    size = double("size")?.toLong() ?: 0L,
    sha256 = string("sha256"),
    meta = string("meta"),
    updatedAt = string("updatedAt"),
    deviceId = string("deviceId"),
)

private fun header(headers: Map<String, String>, name: String): String? =
    headers.entries.firstOrNull { it.key.equals(name, ignoreCase = true) }?.value

data class RegisterResult(val accountId: String, val deviceId: String, val token: String, val expiresAt: String, val revision: Long)
data class LoginResult(
    val accountId: String,
    val deviceId: String,
    val token: String,
    val expiresAt: String,
    val kdf: SyncKdf,
    val vaultKeyWrap: SyncKeyWrap,
    val revision: Long,
)

sealed class DownloadResult {
    data class Deleted(val revision: Long) : DownloadResult()
    data class Blob(val revision: Long, val meta: String, val sha256: String, val bytes: ByteArray) : DownloadResult()
}
